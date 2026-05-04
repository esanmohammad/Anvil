/**
 * test-grounder — validates Behaviors against the repo on disk.
 *
 * For each Behavior we try to resolve:
 *   • `target.file` against the repo's local path (falling back to basename grep).
 *   • `target.symbol` via a definition-flavored grep in the resolved file,
 *     then across the repo as a last resort.
 *   • `resolvedTypes` — nearby `interface`/`type`/`class` names (TS/JS only).
 *
 * The plan-validator.ts next door validates against the KB (graph.json);
 * that file does NOT export file-level resolvers, so this module implements
 * lightweight disk-based fallbacks rather than trying to import non-existent
 * helpers.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import type { Behavior } from './test-types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface GroundingResult {
  behavior: Behavior;
  grounded: boolean;
  resolvedFile?: string;
  resolvedTypes?: string[];
  issues: string[];
}

// ── Constants ────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.next', 'out',
  '.turbo', '.cache', 'coverage', '.venv', 'venv', '__pycache__',
]);

const MAX_WALK_ENTRIES = 20_000;
const MAX_FILES_TO_GREP = 400;
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php',
]);

// ── Filesystem walk ──────────────────────────────────────────────────────

async function* walkRepo(root: string): AsyncGenerator<string> {
  let entriesVisited = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true }) as unknown as Array<{
        name: string; isFile: () => boolean; isDirectory: () => boolean;
      }>;
    } catch {
      continue;
    }
    for (const e of entries) {
      entriesVisited++;
      if (entriesVisited > MAX_WALK_ENTRIES) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        stack.push(join(dir, e.name));
      } else if (e.isFile()) {
        yield join(dir, e.name);
      }
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function safeReadFile(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf-8');
  } catch {
    return null;
  }
}

function hasTextExt(p: string): boolean {
  const i = p.lastIndexOf('.');
  if (i < 0) return false;
  return TEXT_EXTENSIONS.has(p.slice(i).toLowerCase());
}

// ── Resolution helpers ───────────────────────────────────────────────────

async function resolveFile(
  repoRoot: string,
  target: string,
): Promise<string | undefined> {
  if (!target) return undefined;
  const direct = join(repoRoot, target);
  if (await pathExists(direct)) return direct;

  // Fallback: basename grep across the repo.
  const needle = basename(target).toLowerCase();
  let count = 0;
  for await (const abs of walkRepo(repoRoot)) {
    if (++count > MAX_FILES_TO_GREP) break;
    if (basename(abs).toLowerCase() === needle) return abs;
  }
  return undefined;
}

function buildSymbolDefinitionRegex(symbol: string): RegExp {
  const s = symbol.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  // function foo | const foo | class foo | def foo | func foo | type foo | interface foo | let foo | var foo | export default (function|class) foo
  return new RegExp(
    `\\b(?:function|const|let|var|class|def|func|interface|type)\\s+${s}\\b|\\bexport\\s+(?:default\\s+)?(?:async\\s+)?(?:function|class|const|let|var)\\s+${s}\\b`,
  );
}

function findSymbolInText(symbol: string, text: string): boolean {
  return buildSymbolDefinitionRegex(symbol).test(text);
}

async function symbolInRepo(
  repoRoot: string,
  symbol: string,
): Promise<string | undefined> {
  const re = buildSymbolDefinitionRegex(symbol);
  let count = 0;
  for await (const abs of walkRepo(repoRoot)) {
    if (++count > MAX_FILES_TO_GREP) break;
    if (!hasTextExt(abs)) continue;
    const text = await safeReadFile(abs);
    if (text && re.test(text)) return abs;
  }
  return undefined;
}

/**
 * Surrounding types: scan up to ~40 lines around the symbol definition for
 * `interface Foo`, `type Foo`, `class Foo`. Language-agnostic good-enough.
 */
function extractNearbyTypes(text: string, symbol: string): string[] {
  const lines = text.split(/\r?\n/);
  let anchor = -1;
  const defRe = buildSymbolDefinitionRegex(symbol);
  for (let i = 0; i < lines.length; i++) {
    if (defRe.test(lines[i])) {
      anchor = i;
      break;
    }
  }
  const from = anchor === -1 ? 0 : Math.max(0, anchor - 40);
  const to = anchor === -1 ? Math.min(lines.length, 40) : Math.min(lines.length, anchor + 40);

  const typeRe = /\b(?:interface|type|class)\s+(\w+)/g;
  const names = new Set<string>();
  for (let i = from; i < to; i++) {
    let m: RegExpExecArray | null;
    while ((m = typeRe.exec(lines[i])) !== null) {
      names.add(m[1]);
    }
    typeRe.lastIndex = 0;
  }
  return [...names];
}

// ── Public entry point ──────────────────────────────────────────────────

export async function groundBehaviors(
  behaviors: Behavior[],
  repoLocalPaths: Record<string, string>,
): Promise<GroundingResult[]> {
  const results: GroundingResult[] = [];

  // Build helper lookups.
  const repoEntries = Object.entries(repoLocalPaths);

  for (const behavior of behaviors) {
    const issues: string[] = [];
    const { file, symbol } = behavior.target;

    let resolvedFile: string | undefined;
    const tryRepos: Array<[string, string]> = repoEntries;

    // 1. Resolve file — try all repo roots since Behavior doesn't encode repo.
    if (file) {
      for (const [, root] of tryRepos) {
        const hit = await resolveFile(root, file);
        if (hit) {
          resolvedFile = hit;
          break;
        }
      }
      if (!resolvedFile) {
        issues.push(`File '${file}' not found in any repo`);
      }
    }

    // 2. Resolve symbol — prefer the resolved file; else scan repos.
    let symbolResolved = false;
    const resolvedTypes: string[] = [];
    if (symbol) {
      if (resolvedFile) {
        const text = await safeReadFile(resolvedFile);
        if (text && findSymbolInText(symbol, text)) {
          symbolResolved = true;
          for (const t of extractNearbyTypes(text, symbol)) resolvedTypes.push(t);
        }
      }
      if (!symbolResolved) {
        // Walk each repo root until we find a definition.
        let found: string | undefined;
        for (const [, root] of tryRepos) {
          found = await symbolInRepo(root, symbol);
          if (found) break;
        }
        if (found) {
          symbolResolved = true;
          if (!resolvedFile) resolvedFile = found;
          const text = await safeReadFile(found);
          if (text) {
            for (const t of extractNearbyTypes(text, symbol)) resolvedTypes.push(t);
          }
        } else {
          issues.push(`Symbol '${symbol}' not found in any repo`);
        }
      }
    } else if (!file) {
      // Nothing to ground (e.g. a risk-derived regression Behavior).
      issues.push('Behavior has no target file or symbol to ground');
    }

    const grounded = !!resolvedFile && (!!symbol ? symbolResolved : true);
    const confidence = grounded ? 1.0 : resolvedFile ? 0.5 : 0;

    // Update behavior.ground in place per the spec.
    behavior.ground = {
      files: resolvedFile ? [resolvedFile] : [],
      typesSeen: resolvedTypes,
      confidence,
    };

    const result: GroundingResult = { behavior, grounded, issues };
    if (resolvedFile) result.resolvedFile = resolvedFile;
    if (resolvedTypes.length) result.resolvedTypes = resolvedTypes;
    results.push(result);
  }

  return results;
}

// ── Re-exports for consumers that want to resolve without behaviors ──────

export const __test = { resolveFile, symbolInRepo, findSymbolInText, extractNearbyTypes };

// Silence unused-`relative`/`sep` warnings under strict TS by exporting them
// as a no-op utility; keeps imports honest without extra noise.
export function _relativeFrom(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}
