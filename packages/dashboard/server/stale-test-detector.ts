/**
 * stale-test-detector — flag tests that have not caught anything in a long
 * streak of runs, despite continued churn in the code they exercise.
 *
 * A stale test is a maintenance burden: it costs CI time, review time, and
 * attention, but provides no bug-detection value. Common causes:
 *   - Assertions drifted until they became tautologies
 *   - The code under test was deleted/refactored but the test still "passes"
 *     because it exercises a now-trivial branch
 *   - Low mutation score + no failures → test is structurally weak
 *
 * This module surfaces candidates; it does NOT delete anything. Human review
 * is the gate. Heuristics:
 *   - `runsWithoutFailure >= minNonFailRuns` is the base trigger
 *   - SUT churn (git commits touching inferred SUT files) escalates confidence
 *   - Low mutation score on the test's file is the second escalation signal
 *
 * Note: the TestCase type does not carry a reference to its Behavior's
 * ground.files, so when a repo path is provided we approximate the SUT files
 * by parsing ES-module `import … from '…'` statements out of the test source
 * and resolving same-project relative paths.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { TestRun, TestCase } from './test-types.js';

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────────

export interface StaleCandidate {
  caseId: string;
  filePath: string;
  runsWithoutFailure: number;
  /** git commits touching inferred SUT files in the last 30 days. */
  sutChurn: number;
  reason: 'never-fails' | 'low-mutation-score' | 'both';
  confidence: 'high' | 'med' | 'low';
}

export interface StaleOptions {
  /** Number of recent runs to inspect. Default 20. */
  runsWindow?: number;
  /** Flag after N consecutive non-failures. Default 15. */
  minNonFailRuns?: number;
  /** Repo root — enables git churn lookups. */
  repoLocalPath?: string;
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_RUNS_WINDOW = 20;
const DEFAULT_MIN_NON_FAIL = 15;
const CHURN_WINDOW = '30 days ago';
const LOW_MUTATION_THRESHOLD = 0.5;
const HIGH_CONFIDENCE_CHURN = 3;

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Parse ES-module static imports out of a test's source code. Best-effort —
 * we only need likely SUT file paths for git churn lookups, not a full AST.
 */
function extractImportSpecifiers(source: string): string[] {
  const out: string[] = [];
  // import ... from "..."  |  import "..."  |  export ... from "..."
  const re = /(?:import|export)(?:[^'"`;]*?from)?\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Resolve an import specifier relative to the test file, restricted to
 * project-local paths (no node_modules, no bare specifiers). Returns the
 * absolute file path if one plausibly exists; null otherwise.
 */
function resolveSutCandidate(
  spec: string,
  testFileAbs: string,
  repoRoot: string,
): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const base = isAbsolute(spec) ? spec : resolve(dirname(testFileAbs), spec);
  // Try exact + common TS/JS extensions.
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && c.startsWith(repoRoot)) return c;
  }
  // Even if we cannot verify existence, keep a plausible path for git log —
  // git log on a missing path just returns nothing, which is fine.
  if (base.startsWith(repoRoot)) return base;
  return null;
}

async function countGitCommits(repoRoot: string, paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--oneline', `--since=${CHURN_WINDOW}`, '--', ...paths],
      { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024 },
    );
    if (!stdout) return 0;
    return stdout.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Count consecutive non-failures for a case in the given runs (newest-first).
 * Runs where the case did not execute are skipped (do not break the streak,
 * do not count toward it). The streak ends at the first observed failure.
 */
function nonFailStreak(caseId: string, runs: TestRun[]): number {
  let streak = 0;
  for (const run of runs) {
    const res = run.results.find((r) => r.caseId === caseId);
    if (!res) continue; // case did not run this time — skip
    if (res.pass) {
      streak++;
      continue;
    }
    break; // a fail breaks the streak
  }
  return streak;
}

function confidenceOf(reason: StaleCandidate['reason'], churn: number): StaleCandidate['confidence'] {
  if (reason === 'both' && churn > HIGH_CONFIDENCE_CHURN) return 'high';
  if (reason === 'both') return 'med';
  if (reason === 'low-mutation-score') return 'med';
  return 'low'; // 'never-fails' only
}

const CONFIDENCE_WEIGHT: Record<StaleCandidate['confidence'], number> = {
  high: 3,
  med: 2,
  low: 1,
};

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Identify stale-test candidates from recent runs. Resolution is async because
 * SUT-churn lookups shell out to `git log`.
 */
export async function detectStaleTests(
  runs: TestRun[],
  cases: TestCase[],
  opts: StaleOptions = {},
): Promise<StaleCandidate[]> {
  const runsWindow = opts.runsWindow ?? DEFAULT_RUNS_WINDOW;
  const minNonFailRuns = opts.minNonFailRuns ?? DEFAULT_MIN_NON_FAIL;
  const repoRoot = opts.repoLocalPath ? resolve(opts.repoLocalPath) : null;

  const sortedRuns = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const window = sortedRuns.slice(0, runsWindow);
  const latest: TestRun | undefined = window[0];

  const candidates: StaleCandidate[] = [];

  for (const c of cases) {
    const streak = nonFailStreak(c.id, window);
    if (streak < minNonFailRuns) continue;

    // SUT churn ----------------------------------------------------------
    let sutChurn = 0;
    if (repoRoot) {
      try {
        const testAbs = isAbsolute(c.filePath) ? c.filePath : resolve(repoRoot, c.filePath);
        const specs = extractImportSpecifiers(c.code ?? '');
        const resolved = new Set<string>();
        for (const s of specs) {
          const r = resolveSutCandidate(s, testAbs, repoRoot);
          if (r) resolved.add(r);
        }
        if (resolved.size > 0) {
          sutChurn = await countGitCommits(repoRoot, [...resolved]);
        }
      } catch {
        sutChurn = 0;
      }
    }

    // Mutation signal ----------------------------------------------------
    let lowMutation = false;
    const byFile = latest?.mutationScore?.byFile;
    if (byFile && Object.prototype.hasOwnProperty.call(byFile, c.filePath)) {
      const score = byFile[c.filePath];
      if (typeof score === 'number' && score < LOW_MUTATION_THRESHOLD) {
        lowMutation = true;
      }
    }

    const reason: StaleCandidate['reason'] = lowMutation ? 'both' : 'never-fails';
    const confidence = confidenceOf(reason, sutChurn);

    candidates.push({
      caseId: c.id,
      filePath: c.filePath,
      runsWithoutFailure: streak,
      sutChurn,
      reason,
      confidence,
    });
  }

  candidates.sort((a, b) => {
    const cw = CONFIDENCE_WEIGHT[b.confidence] - CONFIDENCE_WEIGHT[a.confidence];
    if (cw !== 0) return cw;
    return b.runsWithoutFailure - a.runsWithoutFailure;
  });

  return candidates;
}
