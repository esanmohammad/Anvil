/**
 * test-code-emitter — deterministic Behavior + ConventionFingerprint → TestCase.
 *
 * Phase 1: no LLM. Emits a compilable scaffold whose assertions are TODOs.
 * Fixtures / mocks arrays are always empty at this stage.
 */

import { randomBytes } from 'node:crypto';
import { basename, dirname, extname, posix } from 'node:path';

import type {
  Behavior,
  ConventionFingerprint,
  Runner,
  Runtime,
  TestCase,
} from './test-types.js';

// ── Options ──────────────────────────────────────────────────────────────

export interface EmitOptions {
  specSlug: string;
  specVersion: number;
  projectSlug: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function posixify(p: string): string {
  return p.replace(/\\/g, '/');
}

function snakeCase(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .join('_') || 'behavior';
}

function pascalCase(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('') || 'Behavior';
}

function shorten(intent: string, maxWords = 6): string {
  return intent.split(/\s+/).slice(0, maxWords).join(' ');
}

function chooseExtensionForRunner(runner: Runner, targetFile: string): string {
  const ext = extname(targetFile).toLowerCase();
  if (runner === 'pytest') return '.py';
  if (runner === 'go-test') return '_test.go';
  // TS/JS runners: preserve .ts / .tsx / .js / .jsx / .mjs / .cjs
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return ext;
  return '.ts';
}

function testBasenameFor(
  sourceBase: string,
  runner: Runner,
  namingPattern: string,
): string {
  // Strip original extension so we can construct a runner-appropriate test name.
  const ext = chooseExtensionForRunner(runner, sourceBase);
  const stem = sourceBase.replace(/\.(tsx?|jsx?|mjs|cjs|py|go)$/i, '');

  if (runner === 'go-test') return `${stem}_test.go`;
  if (runner === 'pytest') return `test_${stem}.py`;

  // Honor the fingerprint's naming pattern for TS/JS runners when possible.
  const style = namingPattern.includes('.spec.') ? 'spec' : 'test';
  return `${stem}.${style}${ext}`;
}

function deriveFilePath(
  behavior: Behavior,
  conventions: ConventionFingerprint,
): string {
  const targetFile = posixify(behavior.target.file || '');
  const runner = effectiveRunner(conventions.runner, targetFile);
  const dir = targetFile ? posixify(dirname(targetFile)) : '';
  const base = targetFile ? basename(targetFile) : '';
  const testBase = testBasenameFor(base || behavior.target.symbol || 'unknown', runner, conventions.namingPattern);

  switch (conventions.fileLayout) {
    case '__tests__':
      return posix.join(dir || '.', '__tests__', testBase);
    case 'tests-root': {
      // Mirror the target dir under `tests/`.
      const mirrored = dir ? posix.join('tests', dir) : 'tests';
      return posix.join(mirrored, testBase);
    }
    case 'colocated':
    case 'unknown':
    default:
      return posix.join(dir || '.', testBase);
  }
}

function effectiveRunner(runner: Runner, targetFile: string): Runner {
  if (runner !== 'unknown') return runner;
  const ext = extname(targetFile).toLowerCase();
  if (ext === '.py') return 'pytest';
  if (ext === '.go') return 'go-test';
  return 'vitest';
}

function relativeImportPath(testFilePath: string, targetFile: string): string {
  if (!targetFile) return './target';
  const testDir = posix.dirname(posixify(testFilePath));
  const targetNoExt = posixify(targetFile).replace(/\.(tsx?|jsx?|mjs|cjs)$/i, '');
  const rel = posix.relative(testDir, targetNoExt) || './' + posix.basename(targetNoExt);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function importSpecifierFor(runner: Runner, imports: Record<string, string>): string {
  // Use the most common module seen for describe/it/expect when available.
  const fromImport = imports['describe'] || imports['it'] || imports['expect'];
  if (fromImport) return fromImport;
  if (runner === 'jest') return '@jest/globals';
  if (runner === 'mocha') return 'mocha';
  return 'vitest';
}

function pyModuleFromFile(file: string): string {
  const noExt = posixify(file).replace(/\.py$/i, '');
  // Convert path segments to dotted module form, trimming any leading ./
  return noExt.replace(/^\.?\//, '').split('/').filter(Boolean).join('.') || 'target';
}

function goPackageFromFile(file: string): string {
  const dir = posix.dirname(posixify(file));
  if (!dir || dir === '.' || dir === '/') return 'main';
  const seg = dir.split('/').filter(Boolean).pop();
  return seg ? seg.replace(/[^a-zA-Z0-9_]/g, '') || 'main' : 'main';
}

// ── Runtime / estimate ──────────────────────────────────────────────────

function chooseRuntime(targetFile: string): Runtime {
  const lower = posixify(targetFile).toLowerCase();
  if (lower.includes('src/components/')) return 'jsdom';
  // Imports of React imply jsdom — we only have the file path here, so this is
  // a best-effort. `node` is the safe default.
  return 'node';
}

function estimateFor(kind: Behavior['kind']): number {
  if (kind === 'contract') return 500;
  if (kind === 'integration' || kind === 'e2e') return 200;
  return 50;
}

// ── Templates ───────────────────────────────────────────────────────────

function emitTsCode(
  runner: Runner,
  behavior: Behavior,
  conventions: ConventionFingerprint,
  testFilePath: string,
): string {
  const spec = importSpecifierFor(runner, conventions.imports);
  const importPath = relativeImportPath(testFilePath, behavior.target.file);
  const symbol = behavior.target.symbol || 'subject';
  const intent = behavior.intent.replace(/`/g, "'");
  const expectedDesc = behavior.expected.description.replace(/`/g, "'");
  const assertion = behavior.expected.assertion.replace(/`/g, "'");

  const importLine = symbol === 'subject'
    ? ''
    : `import { ${symbol} } from '${importPath}';\n`;

  return (
    `import { describe, it, expect } from '${spec}';\n` +
    importLine +
    `\n` +
    `describe('${symbol}', () => {\n` +
    `  it('${intent}', () => {\n` +
    `    // Arrange\n` +
    `    // Act\n` +
    `    // Assert — ${expectedDesc}\n` +
    `    expect(true).toBe(true); // TODO: implement assertion for ${assertion}\n` +
    `  });\n` +
    `});\n`
  );
}

function emitPyCode(behavior: Behavior): string {
  const symbol = behavior.target.symbol || 'subject';
  const module = behavior.target.file ? pyModuleFromFile(behavior.target.file) : 'target';
  const expectedDesc = behavior.expected.description.replace(/"""/g, "'''");
  const assertion = behavior.expected.assertion.replace(/"""/g, "'''");
  const testName = snakeCase(behavior.intent);

  return (
    `from ${module} import ${symbol}\n\n` +
    `def test_${testName}():\n` +
    `    # ${expectedDesc}\n` +
    `    assert True  # TODO: ${assertion}\n`
  );
}

function emitGoCode(behavior: Behavior): string {
  const pkg = goPackageFromFile(behavior.target.file);
  const symbol = behavior.target.symbol || 'Subject';
  const expectedDesc = behavior.expected.description.replace(/\*\//g, '* /');
  const assertion = behavior.expected.assertion.replace(/\*\//g, '* /');
  const testName = `Test${pascalCase(symbol)}_${pascalCase(shorten(behavior.intent))}`;

  return (
    `package ${pkg}\n\n` +
    `import "testing"\n\n` +
    `func ${testName}(t *testing.T) {\n` +
    `    // ${expectedDesc}\n` +
    `    // TODO: ${assertion}\n` +
    `    _ = t\n` +
    `}\n`
  );
}

// ── Public entry point ──────────────────────────────────────────────────

export function emitTestCase(
  behavior: Behavior,
  conventions: ConventionFingerprint,
  opts: EmitOptions,
): TestCase {
  const runner = effectiveRunner(conventions.runner, behavior.target.file);
  const filePath = deriveFilePath(behavior, { ...conventions, runner });

  let code: string;
  if (runner === 'pytest') {
    code = emitPyCode(behavior);
  } else if (runner === 'go-test') {
    code = emitGoCode(behavior);
  } else {
    code = emitTsCode(runner, behavior, conventions, filePath);
  }

  const id = `tc-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

  return {
    id,
    behaviorId: behavior.id,
    specSlug: opts.specSlug,
    specVersion: opts.specVersion,
    framework: runner,
    filePath,
    code,
    fixtures: [],
    mocks: [],
    runtime: chooseRuntime(behavior.target.file),
    estimatedMs: estimateFor(behavior.kind),
    createdAt: new Date().toISOString(),
  };
}
