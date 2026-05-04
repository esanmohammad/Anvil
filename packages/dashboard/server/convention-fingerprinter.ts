/**
 * convention-fingerprinter — scans a repo and returns a ConventionFingerprint
 * describing its test runner, layout, assertion style, imports, and mocks.
 *
 * Heuristic / zero-dependency. Reads only disk; never spawns processes.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';

import type { ConventionFingerprint } from './test-types.js';

// ── Constants ────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.next',
  'out',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
]);

const MAX_TEST_FILES = 20;
const MAX_WALK_ENTRIES = 10_000;     // safety cap on directory traversal

// Test-file glob detection (we resolve via extension + name, not real globs).
const TS_JS_TEST_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

interface ScanState {
  files: string[];              // absolute paths of matched test files
  entriesVisited: number;
}

// ── Filesystem helpers ───────────────────────────────────────────────────

function safeReadFile(p: string): string | null {
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function safeReaddir(dir: string): Array<{ name: string; isDir: boolean; isFile: boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
      isFile: e.isFile(),
    }));
  } catch {
    return [];
  }
}

function isTestFile(rel: string): boolean {
  const lower = rel.toLowerCase();
  const base = basename(lower);
  const ext = extname(base);

  // Go tests: *_test.go
  if (base.endsWith('_test.go')) return true;
  // Python tests: test_*.py or *_test.py
  if (ext === '.py' && (base.startsWith('test_') || base.endsWith('_test.py'))) return true;
  // JS/TS tests
  if (TS_JS_TEST_EXT.has(ext)) {
    if (base.includes('.test.') || base.includes('.spec.')) return true;
    // __tests__/ directory
    if (lower.split('/').includes('__tests__')) return true;
  }
  return false;
}

function walk(root: string, state: ScanState): void {
  const stack: string[] = [root];
  while (stack.length > 0 && state.files.length < MAX_TEST_FILES && state.entriesVisited < MAX_WALK_ENTRIES) {
    const dir = stack.pop()!;
    for (const entry of safeReaddir(dir)) {
      state.entriesVisited++;
      if (state.entriesVisited >= MAX_WALK_ENTRIES) break;

      if (entry.isDir) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        stack.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile) continue;

      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (isTestFile(rel)) {
        state.files.push(abs);
        if (state.files.length >= MAX_TEST_FILES) return;
      }
    }
  }
}

// ── Runner / package.json detection ──────────────────────────────────────

interface PkgJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

function readPackageJson(repoRoot: string): PkgJson | null {
  const p = join(repoRoot, 'package.json');
  if (!existsSync(p)) return null;
  const raw = safeReadFile(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PkgJson;
  } catch {
    return null;
  }
}

function hasAnyConfig(repoRoot: string, patterns: string[]): boolean {
  for (const name of patterns) {
    if (existsSync(join(repoRoot, name))) return true;
  }
  return false;
}

function detectRunner(repoRoot: string, pkg: PkgJson | null): ConventionFingerprint['runner'] {
  // Node-based runners: config files first, then devDeps.
  const vitestConfig = hasAnyConfig(repoRoot, [
    'vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs', 'vitest.config.mts',
  ]);
  if (vitestConfig) return 'vitest';
  const jestConfig = hasAnyConfig(repoRoot, [
    'jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.json',
  ]);
  if (jestConfig) return 'jest';
  const mochaConfig = hasAnyConfig(repoRoot, [
    '.mocharc', '.mocharc.js', '.mocharc.cjs', '.mocharc.json', '.mocharc.yml', '.mocharc.yaml',
  ]);
  if (mochaConfig) return 'mocha';

  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (deps['vitest']) return 'vitest';
  if (deps['jest'] || deps['@jest/globals'] || deps['ts-jest']) return 'jest';
  if (deps['mocha']) return 'mocha';
  if (pkg?.scripts) {
    const s = Object.values(pkg.scripts).join(' ');
    if (/\bvitest\b/.test(s)) return 'vitest';
    if (/\bjest\b/.test(s)) return 'jest';
    if (/\bmocha\b/.test(s)) return 'mocha';
  }

  // pytest
  if (existsSync(join(repoRoot, 'pytest.ini'))) return 'pytest';
  const pyproject = safeReadFile(join(repoRoot, 'pyproject.toml'));
  if (pyproject && /\[tool\.pytest/i.test(pyproject)) return 'pytest';

  // go
  if (existsSync(join(repoRoot, 'go.mod'))) {
    // Even without *_test.go on disk, the presence of go.mod implies go-test.
    return 'go-test';
  }

  return 'unknown';
}

// ── Per-file analysis ────────────────────────────────────────────────────

interface FileSignals {
  path: string;
  assertion: ConventionFingerprint['assertionStyle'];
  mockStyle?: ConventionFingerprint['mockStyle'];
  imports: Record<string, string>;     // symbol -> module
  layoutHint: ConventionFingerprint['fileLayout'];
  namingPattern: string;               // e.g. "*.test.ts"
  setupPattern?: string;
  fixtureStyle?: ConventionFingerprint['fixtureStyle'];
}

function analyzeAssertion(text: string): FileSignals['assertion'] {
  if (/\bexpect\s*\(/.test(text)) return 'expect';
  if (/\bassert\.(?:equal|ok|deepEqual|strictEqual)/.test(text) || /\bassert\s+/.test(text)) return 'assert';
  if (/\.should\b/.test(text) || /should\.(?:exist|equal)/.test(text)) return 'should';
  if (/\*testing\.T\b/.test(text)) return 'testing.T';
  return 'unknown';
}

function analyzeMockStyle(text: string): FileSignals['mockStyle'] | undefined {
  if (/\bvi\.mock\s*\(/.test(text) || /\bvi\.fn\s*\(/.test(text)) return 'vi.mock';
  if (/\bjest\.mock\s*\(/.test(text) || /\bjest\.fn\s*\(/.test(text)) return 'jest.mock';
  if (/\bsinon\.(?:stub|spy|mock)/.test(text)) return 'sinon';
  if (/\bmocker\.(?:patch|patch\.object)/.test(text)) return 'mocker';
  return undefined;
}

function analyzeImports(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // ES import { a, b, c } from 'mod';
  const reNamed = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = reNamed.exec(text)) !== null) {
    const mod = m[2];
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    for (const n of names) {
      if (!(n in out)) out[n] = mod;
    }
  }
  // Python: from X import Y, Z
  const rePy = /from\s+([\w.]+)\s+import\s+([\w, ]+)/g;
  while ((m = rePy.exec(text)) !== null) {
    const mod = m[1];
    for (const n of m[2].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!(n in out)) out[n] = mod;
    }
  }
  return out;
}

function analyzeFixtureStyle(text: string, path: string): FileSignals['fixtureStyle'] | undefined {
  const lower = path.toLowerCase();
  if (lower.includes('/fixtures/') || /fixtures?\//.test(lower)) return 'files';
  if (lower.includes('/factories/') || /factories?\//.test(lower)) return 'factories';
  if (/\b(build|make|create)\w*Factory\s*\(/.test(text)) return 'factories';
  if (/\bconst\s+\w+\s*=\s*\{[^}]*\}\s*;/.test(text)) return 'inline';
  return undefined;
}

function namingPatternFor(path: string): string {
  const base = basename(path).toLowerCase();
  if (base.endsWith('_test.go')) return '*_test.go';
  if (base.startsWith('test_') && base.endsWith('.py')) return 'test_*.py';
  if (base.endsWith('_test.py')) return '*_test.py';
  for (const ext of ['.test.ts', '.test.tsx', '.test.js', '.test.jsx', '.spec.ts', '.spec.tsx', '.spec.js', '.spec.jsx']) {
    if (base.endsWith(ext)) return `*${ext}`;
  }
  return base;
}

function layoutHintFor(repoRoot: string, absPath: string): ConventionFingerprint['fileLayout'] {
  const rel = relative(repoRoot, absPath).split(sep).join('/').toLowerCase();
  const parts = rel.split('/');
  if (parts.includes('__tests__')) return '__tests__';
  if (parts[0] === 'tests' || parts[0] === 'test') return 'tests-root';
  // Co-located heuristic: base filename minus `.test`/`.spec` exists as a sibling source file.
  const dir = dirname(absPath);
  const base = basename(absPath);
  const stripped = base
    .replace(/\.test\.(tsx?|jsx?|mjs|cjs)$/i, '.$1')
    .replace(/\.spec\.(tsx?|jsx?|mjs|cjs)$/i, '.$1');
  if (stripped !== base) {
    try {
      if (existsSync(join(dir, stripped))) return 'colocated';
    } catch {
      /* ignore */
    }
  }
  // Go/Py: co-located is the default if not nested under tests/.
  if (base.endsWith('_test.go') || base.endsWith('.py')) return 'colocated';
  return 'unknown';
}

function detectSetupPattern(text: string): string | undefined {
  if (/\bbeforeAll\s*\(/.test(text)) return 'beforeAll';
  if (/\bbeforeEach\s*\(/.test(text)) return 'beforeEach';
  if (/@pytest\.fixture\b/.test(text)) return 'pytest.fixture';
  if (/\bsetUp\s*\(/.test(text)) return 'setUp';
  if (/\bTestMain\b/.test(text)) return 'TestMain';
  return undefined;
}

function analyzeFile(repoRoot: string, absPath: string): FileSignals | null {
  const text = safeReadFile(absPath);
  if (text === null) return null;
  const rel = relative(repoRoot, absPath).split(sep).join('/');
  const signals: FileSignals = {
    path: rel,
    assertion: analyzeAssertion(text),
    imports: analyzeImports(text),
    layoutHint: layoutHintFor(repoRoot, absPath),
    namingPattern: namingPatternFor(rel),
  };
  const mockStyle = analyzeMockStyle(text);
  if (mockStyle) signals.mockStyle = mockStyle;
  const fixtureStyle = analyzeFixtureStyle(text, rel);
  if (fixtureStyle) signals.fixtureStyle = fixtureStyle;
  const setupPattern = detectSetupPattern(text);
  if (setupPattern) signals.setupPattern = setupPattern;
  return signals;
}

// ── Aggregation helpers ──────────────────────────────────────────────────

function mode<T extends string>(values: T[]): T | undefined {
  if (!values.length) return undefined;
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      best = v;
    }
  }
  return best;
}

function defaultImportsForRunner(runner: ConventionFingerprint['runner']): Record<string, string> {
  switch (runner) {
    case 'vitest': return { describe: 'vitest', it: 'vitest', expect: 'vitest' };
    case 'jest': return { describe: '@jest/globals', it: '@jest/globals', expect: '@jest/globals' };
    case 'mocha': return { describe: 'mocha', it: 'mocha' };
    case 'pytest': return { pytest: 'pytest' };
    case 'go-test': return { testing: 'testing' };
    default: return {};
  }
}

function defaultAssertionFor(runner: ConventionFingerprint['runner']): ConventionFingerprint['assertionStyle'] {
  switch (runner) {
    case 'vitest':
    case 'jest':
    case 'mocha':
      return 'expect';
    case 'pytest':
      return 'assert';
    case 'go-test':
      return 'testing.T';
    default:
      return 'unknown';
  }
}

function defaultNamingFor(runner: ConventionFingerprint['runner']): string {
  switch (runner) {
    case 'vitest':
    case 'jest':
      return '*.test.ts';
    case 'mocha':
      return '*.spec.ts';
    case 'pytest':
      return 'test_*.py';
    case 'go-test':
      return '*_test.go';
    default:
      return '*.test.ts';
  }
}

// ── Public entry point ──────────────────────────────────────────────────

export async function fingerprintConventions(repoLocalPath: string): Promise<ConventionFingerprint> {
  // Light guards — never throw from here.
  let rootExists = false;
  try {
    rootExists = existsSync(repoLocalPath) && statSync(repoLocalPath).isDirectory();
  } catch {
    rootExists = false;
  }

  const pkg = rootExists ? readPackageJson(repoLocalPath) : null;
  const runner = rootExists ? detectRunner(repoLocalPath, pkg) : 'unknown';

  // Default skeleton (used when nothing on disk).
  const fallback: ConventionFingerprint = {
    runner,
    assertionStyle: defaultAssertionFor(runner),
    fileLayout: 'unknown',
    namingPattern: defaultNamingFor(runner),
    imports: defaultImportsForRunner(runner),
    examples: [],
  };
  if (!rootExists) return fallback;

  // Walk for up to MAX_TEST_FILES test files.
  const state: ScanState = { files: [], entriesVisited: 0 };
  walk(repoLocalPath, state);

  const signals: FileSignals[] = [];
  for (const abs of state.files) {
    const s = analyzeFile(repoLocalPath, abs);
    if (s) signals.push(s);
  }

  if (!signals.length) {
    // Nothing usable: return fallback tuned by package.json.
    return fallback;
  }

  // Aggregate.
  const assertionStyle = mode(signals.map((s) => s.assertion)) ?? fallback.assertionStyle;
  const fileLayout = mode(signals.map((s) => s.layoutHint)) ?? 'unknown';
  const namingPattern = mode(signals.map((s) => s.namingPattern)) ?? fallback.namingPattern;
  const mockStyle = mode(signals.map((s) => s.mockStyle).filter((v): v is NonNullable<typeof v> => !!v));
  const fixtureStyle = mode(signals.map((s) => s.fixtureStyle).filter((v): v is NonNullable<typeof v> => !!v));
  const setupPattern = mode(signals.map((s) => s.setupPattern).filter((v): v is string => !!v));

  // Merge imports — prefer the most common module per symbol.
  const importCounts = new Map<string, Map<string, number>>();
  for (const s of signals) {
    for (const [sym, mod] of Object.entries(s.imports)) {
      if (!importCounts.has(sym)) importCounts.set(sym, new Map());
      const byMod = importCounts.get(sym)!;
      byMod.set(mod, (byMod.get(mod) ?? 0) + 1);
    }
  }
  const imports: Record<string, string> = {};
  for (const [sym, byMod] of importCounts) {
    let bestMod = '';
    let bestCount = -1;
    for (const [mod, c] of byMod) {
      if (c > bestCount) {
        bestMod = mod;
        bestCount = c;
      }
    }
    if (bestMod) imports[sym] = bestMod;
  }
  // Seed defaults for the runner when no imports were captured.
  if (Object.keys(imports).length === 0) {
    Object.assign(imports, defaultImportsForRunner(runner));
  }

  const examples = signals.slice(0, 3).map((s) => s.path);

  const fp: ConventionFingerprint = {
    runner,
    assertionStyle,
    fileLayout,
    namingPattern,
    imports,
    examples,
  };
  if (setupPattern) fp.setupPattern = setupPattern;
  if (mockStyle) fp.mockStyle = mockStyle;
  if (fixtureStyle) fp.fixtureStyle = fixtureStyle;
  return fp;
}
