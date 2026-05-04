/**
 * parallelization-planner — compute a balanced CI shard plan from historical
 * TestRun timings, and emit runner-specific matrix snippets.
 *
 * We use median per-case duration across the most recent runs (default 10) to
 * resist outliers from flaky or cold-start runs. Cases without timing data are
 * surfaced as `unassigned` so the caller can either sprinkle them across
 * shards or run them in a catch-all lane.
 *
 * Greedy longest-processing-time (LPT) bin packing is used: cases are sorted
 * descending by duration, and each case is placed in the currently-lightest
 * bin. LPT is within 4/3 of optimal makespan and is enough for CI planning.
 */

import type { TestRun, TestCase } from './test-types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface ParallelPlan {
  shardCount: number;
  /** Estimated duration of the worst (longest) shard, in ms. */
  estimatedShardDurationMs: number;
  shards: Array<{
    index: number;
    caseIds: string[];
    filePaths: string[];
    estimatedMs: number;
  }>;
  /** Case ids with no historical timing data. */
  unassigned: string[];
}

export interface PlanOptions {
  /** Target wall-clock per shard. Default 60_000 ms. */
  targetShardDurationMs?: number;
  /** Upper bound on shard count. Default 8. */
  maxShards?: number;
  /** Lower bound on shard count. Default 1. */
  minShards?: number;
}

export interface CIMatrixConfig {
  github?: string;
  gitlab?: string;
  jest?: string;
  vitest?: string;
}

type Runner = 'vitest' | 'jest' | 'pytest' | 'go-test' | 'mocha' | 'unknown';

// ── Internal helpers ─────────────────────────────────────────────────────

const DEFAULT_TARGET_MS = 60_000;
const DEFAULT_MAX_SHARDS = 8;
const DEFAULT_MIN_SHARDS = 1;
const RECENT_RUNS_WINDOW = 10;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Build a per-case median-duration map from up to the last N runs. A case is
 * only included if at least one run observed it passing — cases that are
 * always failing or flaky aren't representative timing samples.
 */
function caseMedianDurations(runs: TestRun[]): Map<string, number> {
  const sortedRuns = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const window = sortedRuns.slice(0, RECENT_RUNS_WINDOW);

  const samples = new Map<string, number[]>();
  for (const run of window) {
    for (const r of run.results) {
      if (!r.pass) continue; // skip failing/flaky rows
      if (typeof r.durationMs !== 'number' || !Number.isFinite(r.durationMs)) continue;
      const list = samples.get(r.caseId);
      if (list) list.push(r.durationMs);
      else samples.set(r.caseId, [r.durationMs]);
    }
  }

  const out = new Map<string, number>();
  for (const [caseId, vals] of samples) {
    if (vals.length === 0) continue;
    out.set(caseId, median(vals));
  }
  return out;
}

interface Bin {
  index: number;
  caseIds: string[];
  filePaths: Set<string>;
  estimatedMs: number;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Compute a balanced shard plan for a set of test cases given historical runs.
 */
export function planParallelization(
  runs: TestRun[],
  cases: TestCase[],
  opts: PlanOptions = {},
): ParallelPlan {
  const targetShardDurationMs = opts.targetShardDurationMs ?? DEFAULT_TARGET_MS;
  const maxShards = Math.max(1, opts.maxShards ?? DEFAULT_MAX_SHARDS);
  const minShards = Math.max(1, Math.min(opts.minShards ?? DEFAULT_MIN_SHARDS, maxShards));

  const durations = caseMedianDurations(runs);

  type Timed = { caseId: string; filePath: string; ms: number };
  const timed: Timed[] = [];
  const unassigned: string[] = [];
  for (const c of cases) {
    const ms = durations.get(c.id);
    if (ms === undefined || ms <= 0) {
      unassigned.push(c.id);
      continue;
    }
    timed.push({ caseId: c.id, filePath: c.filePath, ms });
  }

  const totalMs = timed.reduce((sum, t) => sum + t.ms, 0);
  const desired = Math.ceil(totalMs / Math.max(1, targetShardDurationMs));
  const shardCount = clamp(desired || minShards, minShards, maxShards);

  // Initialise bins.
  const bins: Bin[] = Array.from({ length: shardCount }, (_, i) => ({
    index: i + 1,
    caseIds: [],
    filePaths: new Set<string>(),
    estimatedMs: 0,
  }));

  // Greedy LPT: sort desc by duration, place in lightest bin.
  timed.sort((a, b) => b.ms - a.ms);
  for (const t of timed) {
    let lightest = bins[0];
    for (let i = 1; i < bins.length; i++) {
      if (bins[i].estimatedMs < lightest.estimatedMs) lightest = bins[i];
    }
    lightest.caseIds.push(t.caseId);
    lightest.filePaths.add(t.filePath);
    lightest.estimatedMs += t.ms;
  }

  const shards = bins.map((b) => ({
    index: b.index,
    caseIds: b.caseIds,
    filePaths: [...b.filePaths].sort(),
    estimatedMs: Math.round(b.estimatedMs),
  }));

  const estimatedShardDurationMs = shards.reduce(
    (mx, s) => (s.estimatedMs > mx ? s.estimatedMs : mx),
    0,
  );

  return {
    shardCount,
    estimatedShardDurationMs,
    shards,
    unassigned,
  };
}

// ── Emitters ─────────────────────────────────────────────────────────────

function shardListYaml(n: number): string {
  const ids = Array.from({ length: n }, (_, i) => i + 1).join(', ');
  return `[${ids}]`;
}

function githubMatrixFor(plan: ParallelPlan, shardCmd: string): string {
  return [
    'strategy:',
    '  matrix:',
    `    shard: ${shardListYaml(plan.shardCount)}`,
    'steps:',
    `  - run: ${shardCmd}`,
  ].join('\n');
}

function gitlabParallelFor(plan: ParallelPlan, runnerNote: string): string {
  return [
    `parallel: ${plan.shardCount}`,
    'script:',
    `  # GitLab exposes CI_NODE_INDEX (1..N) and CI_NODE_TOTAL.`,
    `  # ${runnerNote}`,
    '  - echo "Running shard $CI_NODE_INDEX of $CI_NODE_TOTAL"',
  ].join('\n');
}

function commandTable(
  plan: ParallelPlan,
  makeCmd: (i: number, total: number) => string,
): string {
  const lines: string[] = [];
  lines.push('| shard | est. duration | command |');
  lines.push('| ----- | ------------- | ------- |');
  for (const s of plan.shards) {
    lines.push(`| ${s.index}/${plan.shardCount} | ${s.estimatedMs}ms | \`${makeCmd(s.index, plan.shardCount)}\` |`);
  }
  return lines.join('\n');
}

/**
 * Emit runner-specific CI configuration snippets from a computed plan. Unknown
 * runners get an explanatory string only — we don't guess CLI flags.
 */
export function emitCIMatrix(plan: ParallelPlan, runner: Runner): CIMatrixConfig {
  switch (runner) {
    case 'vitest': {
      const shardCmd =
        'npx vitest run --shard=${{ matrix.shard }}/${{ strategy.matrix.shard.length }}';
      return {
        github: githubMatrixFor(plan, shardCmd),
        gitlab: gitlabParallelFor(
          plan,
          'Vitest accepts --shard=N/M for split execution.',
        ) + '\n  - npx vitest run --shard=$CI_NODE_INDEX/$CI_NODE_TOTAL',
        vitest: commandTable(plan, (i, total) => `npx vitest run --shard=${i}/${total}`),
      };
    }
    case 'jest': {
      const shardCmd =
        'npx jest --shard=${{ matrix.shard }}/${{ strategy.matrix.shard.length }}';
      return {
        github: githubMatrixFor(plan, shardCmd),
        gitlab: gitlabParallelFor(
          plan,
          'Jest accepts --shard=N/M for split execution.',
        ) + '\n  - npx jest --shard=$CI_NODE_INDEX/$CI_NODE_TOTAL',
        jest: commandTable(plan, (i, total) => `npx jest --shard=${i}/${total}`),
      };
    }
    case 'pytest': {
      // pytest-split provides --splits/--group; most projects use that or
      // pytest-xdist. We avoid assuming either is installed.
      const note =
        `pytest does not support native sharding. Install pytest-split ` +
        `(https://github.com/jerry-git/pytest-split) and run ` +
        `"pytest --splits ${plan.shardCount} --group $SHARD_INDEX" ` +
        `with SHARD_INDEX 1..${plan.shardCount}.`;
      return { github: note, gitlab: note };
    }
    case 'go-test': {
      const note =
        `go test has no built-in sharding. Split by package at the CI level, ` +
        `e.g. distribute the ${plan.shardCount} shard file-lists from ` +
        `ParallelPlan.shards[i].filePaths across matrix jobs.`;
      return { github: note, gitlab: note };
    }
    case 'mocha': {
      const note =
        `Mocha has no native --shard. Use a runner like mocha-parallel-tests ` +
        `or distribute ParallelPlan.shards[i].filePaths across ${plan.shardCount} ` +
        `matrix jobs and pass them as positional args.`;
      return { github: note, gitlab: note };
    }
    case 'unknown':
    default: {
      const note =
        `Runner unknown: cannot emit runner-specific commands. ` +
        `Use ParallelPlan.shards[i].filePaths to drive your own CI matrix.`;
      return { github: note, gitlab: note };
    }
  }
}
