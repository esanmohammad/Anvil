/**
 * Flakiness fix suggester — maps a FlakyCluster's root cause onto canned
 * remediation guidance (plus an optional TS/JS code-patch stub where the fix
 * has an obvious mechanical shape).
 */

import type { FlakyCluster, FlakyRootCause } from './flakiness-cluster-analyzer.js';

// ── Public types ─────────────────────────────────────────────────────────

export interface FlakyFixSuggestion {
  testId: string;
  rootCause: FlakyRootCause;
  suggestion: string;            // 1–2 sentence fix guidance
  codePatch?: string;             // optional stub code snippet the user can paste
  confidence: number;
}

// ── Canned catalogue ─────────────────────────────────────────────────────

interface SuggestionTemplate {
  suggestion: string;
  codePatch?: string;
}

const TEMPLATES: Record<FlakyRootCause, SuggestionTemplate> = {
  'timing-sensitive': {
    suggestion:
      'Use fakeTimers / freezeTime (vi.useFakeTimers() or jest.useFakeTimers()) and replace any `setTimeout` / wall-clock assertions with deterministic advances.',
    codePatch: [
      '// Replace real timers with fake ones so the test is deterministic.',
      'import { vi, beforeEach, afterEach } from \'vitest\';',
      '',
      'beforeEach(() => {',
      '  vi.useFakeTimers();',
      '  vi.setSystemTime(new Date(\'2025-01-01T00:00:00Z\'));',
      '});',
      '',
      'afterEach(() => {',
      '  vi.useRealTimers();',
      '});',
      '',
      '// Inside the test, drive time explicitly instead of awaiting setTimeout:',
      '// await vi.advanceTimersByTimeAsync(1000);',
    ].join('\n'),
  },

  'order-dependent': {
    suggestion:
      'Reset shared state between tests: add `beforeEach(resetDB)` (or equivalent), and run with `--randomize-tests=false` temporarily to confirm the ordering hypothesis before committing the fix.',
    codePatch: [
      '// Add an isolation hook so residual state from prior tests cannot bleed in.',
      'import { beforeEach } from \'vitest\';',
      'import { resetDB } from \'./test-utils.js\';',
      '',
      'beforeEach(async () => {',
      '  await resetDB();',
      '});',
      '',
      '// To verify, run once with shuffling disabled:',
      '//   vitest --sequence.shuffle=false --sequence.concurrent=false',
    ].join('\n'),
  },

  'data-dependent': {
    suggestion:
      'Use fresh fixtures per test and wrap each case in a transaction that rolls back on teardown, so no test leaves residue behind.',
    codePatch: [
      '// Wrap every test in a rolled-back transaction so fixtures stay isolated.',
      'import { beforeEach, afterEach } from \'vitest\';',
      'import { db } from \'./db.js\';',
      '',
      'let tx;',
      '',
      'beforeEach(async () => {',
      '  tx = await db.transaction();',
      '});',
      '',
      'afterEach(async () => {',
      '  await tx.rollback();',
      '});',
    ].join('\n'),
  },

  'env-dependent': {
    suggestion:
      'Pin environmental knobs (`NODE_ENV`, `TZ`, locale) at the container level and assert them at test start; don\'t rely on host defaults.',
    codePatch: [
      '// Pin env at the process boundary so the test is reproducible across CI hosts.',
      '// In package.json (test script):',
      '//   "test": "TZ=UTC LC_ALL=C NODE_ENV=test vitest"',
      '',
      '// And defensively, at the top of the test file:',
      'if (process.env.TZ !== \'UTC\') {',
      '  throw new Error(\'Test must run with TZ=UTC for determinism\');',
      '}',
    ].join('\n'),
  },

  unknown: {
    suggestion:
      'Bisect the flake: run with `--test.retry=3 --test.shuffle=false` and inspect the full failure message of each retry to identify the next hypothesis to test.',
    // No codePatch — we genuinely don't know the shape of the fix.
  },
};

// ── Entry point ──────────────────────────────────────────────────────────

export function suggestFlakyFixes(clusters: FlakyCluster[]): FlakyFixSuggestion[] {
  const out: FlakyFixSuggestion[] = [];
  for (const c of clusters) {
    out.push(buildSuggestion(c));
  }
  return out;
}

function buildSuggestion(cluster: FlakyCluster): FlakyFixSuggestion {
  const tmpl = TEMPLATES[cluster.rootCause] ?? TEMPLATES.unknown;
  // The suggester's confidence is bounded above by the cluster's own
  // confidence — we never claim to know the fix more surely than we know
  // the cause.
  const confidence = Number(
    Math.min(cluster.confidence, confidenceCeiling(cluster.rootCause)).toFixed(3),
  );

  const suggestion: FlakyFixSuggestion = {
    testId: cluster.testId,
    rootCause: cluster.rootCause,
    suggestion: tmpl.suggestion,
    confidence,
  };
  if (tmpl.codePatch) {
    suggestion.codePatch = tmpl.codePatch;
  }
  return suggestion;
}

function confidenceCeiling(cause: FlakyRootCause): number {
  // 'unknown' fixes are generic — cap their suggested confidence sharply so
  // they don't outrank a real categorized suggestion in UI ordering.
  if (cause === 'unknown') return 0.3;
  return 1;
}
