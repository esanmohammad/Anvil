/**
 * Flakiness cluster analyzer — groups flaky-failure samples by root cause.
 * Pure, side-effect-free; consumes FlakyFailureSample[] (exposed by
 * TestLearningsStore in a future integration step) and emits FlakyCluster[].
 */

// ── Public types ─────────────────────────────────────────────────────────

export type FlakyRootCause =
  | 'timing-sensitive'
  | 'order-dependent'
  | 'data-dependent'
  | 'env-dependent'
  | 'unknown';

export interface FlakyFailureSample {
  testId: string;
  runAt: string;                  // ISO timestamp
  passedOnRetry: boolean;
  suiteOrderIndex?: number;       // position in the suite when it ran
  priorFailedTests?: string[];    // tests that failed before this one in the same run
  envFingerprint?: string;        // OS/machine/node-version hash
  failureMessage?: string;
}

export interface FlakyCluster {
  testId: string;
  samples: number;
  failureRate: number;            // 0..1
  rootCause: FlakyRootCause;
  confidence: number;             // 0..1
  evidence: string[];             // human-readable bullet list
}

// ── Tuning constants ─────────────────────────────────────────────────────
//
// Chi-square with df=2 (three buckets: morning/afternoon/night) — the 90th
// percentile critical value is ~4.61. Using 4.6 as the threshold means we
// require bucket skew at roughly p<0.1 before labelling a cluster
// timing-sensitive. A lower bar than traditional p<0.05 because sample sizes
// are typically small (10–50) and we WANT to over-surface candidates rather
// than under-surface them — the user sees the evidence and can override.
const CHI2_TIMING_THRESHOLD = 4.6;

// Minimum samples to assign anything other than `unknown` — without this we'd
// claim a single flake is "order-dependent" just because it happened to run
// at index 0. 4 is the smallest run where a binomial-style correlation is
// interesting.
const MIN_SAMPLES_FOR_CAUSE = 4;

// Ratio of same-prior-test co-occurrences required to call it order-dependent
// via prior-test correlation. 0.8 = 4 of every 5 failures share a prior test.
const PRIOR_TEST_CORRELATION = 0.8;

// Suite-order bucket thresholds: first 20% / last 20%.
const SUITE_ORDER_EDGE_RATIO = 0.2;

// Env-fingerprint correlation: >=75% of failures on a single env hash.
const ENV_FINGERPRINT_RATIO = 0.75;

// Data-mutating prior test regex (intent: any `create|delete|seed|reset`
// named test preceding the flaky one suggests residual-state flakiness).
const DATA_MUTATING_REGEX = /(create|delete|seed|reset).*/i;

// ── Main entry ───────────────────────────────────────────────────────────

export function analyzeFlakiness(samples: FlakyFailureSample[]): FlakyCluster[] {
  if (!samples.length) return [];

  const byTest = groupByTestId(samples);
  const clusters: FlakyCluster[] = [];

  for (const [testId, group] of byTest.entries()) {
    clusters.push(classifyGroup(testId, group));
  }

  // Sort by failureRate desc — callers typically render top offenders first.
  clusters.sort((a, b) => b.failureRate - a.failureRate);
  return clusters;
}

// ── Classification ───────────────────────────────────────────────────────

function classifyGroup(testId: string, group: FlakyFailureSample[]): FlakyCluster {
  const samples = group.length;
  // Every sample IS a recorded failure event; what varies is whether it
  // passed on retry. A "true flake" is a failure that passed on retry — those
  // are the flaky-rate numerator. Non-flaky samples are hard failures.
  const flakyCount = group.filter((s) => s.passedOnRetry).length;
  const failureRate = samples === 0 ? 0 : flakyCount / samples;

  if (samples < MIN_SAMPLES_FOR_CAUSE) {
    return {
      testId,
      samples,
      failureRate,
      rootCause: 'unknown',
      confidence: Math.min(0.3, samples / 10),
      evidence: [
        `Only ${samples} sample${samples === 1 ? '' : 's'} — insufficient signal to cluster (need ≥${MIN_SAMPLES_FOR_CAUSE}).`,
      ],
    };
  }

  // Evaluate each hypothesis; keep the highest-confidence match.
  const candidates: Array<{ cause: FlakyRootCause; confidence: number; evidence: string[] }> = [];

  candidates.push(scoreTiming(group));
  candidates.push(scoreOrderByPrior(group));
  candidates.push(scoreOrderBySuiteEdge(group));
  candidates.push(scoreEnv(group));
  candidates.push(scoreData(group));

  // Pick best candidate; if all below a floor, fall back to unknown.
  const best = candidates
    .filter((c) => c.cause !== 'unknown')
    .sort((a, b) => b.confidence - a.confidence)[0];

  if (!best || best.confidence < 0.35) {
    return {
      testId,
      samples,
      failureRate,
      rootCause: 'unknown',
      confidence: Math.min(0.4, samples / 20),
      evidence: best?.evidence ?? ['No single root-cause heuristic crossed the confidence floor.'],
    };
  }

  // Confidence grows with sample size (capped).
  const sizeBoost = Math.min(1, samples / 20);
  const finalConfidence = clamp(best.confidence * (0.6 + 0.4 * sizeBoost), 0, 1);

  return {
    testId,
    samples,
    failureRate,
    rootCause: best.cause,
    confidence: Number(finalConfidence.toFixed(3)),
    evidence: best.evidence,
  };
}

// ── Heuristic: timing-sensitive (χ² on hour buckets) ─────────────────────

function scoreTiming(group: FlakyFailureSample[]): {
  cause: FlakyRootCause;
  confidence: number;
  evidence: string[];
} {
  const buckets = [0, 0, 0]; // morning, afternoon, night
  for (const s of group) {
    const h = parseHour(s.runAt);
    if (h === null) continue;
    if (h >= 5 && h < 12) buckets[0]!++;
    else if (h >= 12 && h < 20) buckets[1]!++;
    else buckets[2]!++;
  }
  const total = buckets[0]! + buckets[1]! + buckets[2]!;
  if (total < MIN_SAMPLES_FOR_CAUSE) {
    return { cause: 'unknown', confidence: 0, evidence: [] };
  }
  const expected = total / 3;
  const chi2 =
    Math.pow(buckets[0]! - expected, 2) / expected +
    Math.pow(buckets[1]! - expected, 2) / expected +
    Math.pow(buckets[2]! - expected, 2) / expected;

  if (chi2 < CHI2_TIMING_THRESHOLD) {
    return { cause: 'unknown', confidence: 0, evidence: [] };
  }

  const bucketNames = ['morning', 'afternoon', 'night'];
  const dominantIdx = buckets.indexOf(Math.max(...buckets));
  const dominantPct = Math.round((buckets[dominantIdx]! / total) * 100);
  // Map chi² (unbounded) into 0..1 via a soft saturation.
  const confidence = clamp(chi2 / (chi2 + 6), 0.3, 0.95);

  return {
    cause: 'timing-sensitive',
    confidence,
    evidence: [
      `${dominantPct}% of flaky failures occurred in the ${bucketNames[dominantIdx]} window (χ²=${chi2.toFixed(2)} > ${CHI2_TIMING_THRESHOLD}).`,
      `Bucket distribution — morning:${buckets[0]} afternoon:${buckets[1]} night:${buckets[2]}.`,
    ],
  };
}

// ── Heuristic: order-dependent via repeated prior test ───────────────────

function scoreOrderByPrior(group: FlakyFailureSample[]): {
  cause: FlakyRootCause;
  confidence: number;
  evidence: string[];
} {
  const priorCounts = new Map<string, number>();
  let samplesWithPrior = 0;
  for (const s of group) {
    if (!s.priorFailedTests || s.priorFailedTests.length === 0) continue;
    samplesWithPrior++;
    for (const p of s.priorFailedTests) {
      priorCounts.set(p, (priorCounts.get(p) ?? 0) + 1);
    }
  }
  if (samplesWithPrior < MIN_SAMPLES_FOR_CAUSE) {
    return { cause: 'unknown', confidence: 0, evidence: [] };
  }

  let topPrior: string | null = null;
  let topCount = 0;
  for (const [k, v] of priorCounts.entries()) {
    if (v > topCount) {
      topCount = v;
      topPrior = k;
    }
  }

  if (!topPrior) return { cause: 'unknown', confidence: 0, evidence: [] };
  const ratio = topCount / samplesWithPrior;
  if (ratio < PRIOR_TEST_CORRELATION) {
    return { cause: 'unknown', confidence: 0, evidence: [] };
  }

  return {
    cause: 'order-dependent',
    confidence: clamp(0.4 + ratio * 0.5, 0, 0.95),
    evidence: [
      `\`${topPrior}\` ran immediately before ${topCount}/${samplesWithPrior} flaky failures (${Math.round(ratio * 100)}%).`,
      `State leakage from the prior test is the most likely cause.`,
    ],
  };
}

// ── Heuristic: order-dependent via suite-edge concentration ──────────────

function scoreOrderBySuiteEdge(group: FlakyFailureSample[]): {
  cause: FlakyRootCause;
  confidence: number;
  evidence: string[];
} {
  const indexed = group.filter((s) => typeof s.suiteOrderIndex === 'number');
  if (indexed.length < MIN_SAMPLES_FOR_CAUSE) {
    return { cause: 'unknown', confidence: 0, evidence: [] };
  }
  // We don't know the max suite size directly — infer from max index observed.
  const maxIdx = Math.max(...indexed.map((s) => s.suiteOrderIndex!));
  if (maxIdx <= 0) return { cause: 'unknown', confidence: 0, evidence: [] };

  const firstEdge = Math.floor(maxIdx * SUITE_ORDER_EDGE_RATIO);
  const lastEdge = Math.ceil(maxIdx * (1 - SUITE_ORDER_EDGE_RATIO));
  const inFirst = indexed.filter((s) => s.suiteOrderIndex! <= firstEdge).length;
  const inLast = indexed.filter((s) => s.suiteOrderIndex! >= lastEdge).length;
  const edgeCount = inFirst + inLast;
  const ratio = edgeCount / indexed.length;

  // If >=70% of failures concentrate in the first OR last 20% of the suite,
  // that's a strong order-dependency signal.
  if (ratio < 0.7) return { cause: 'unknown', confidence: 0, evidence: [] };

  const where = inFirst > inLast ? 'first 20%' : 'last 20%';
  return {
    cause: 'order-dependent',
    confidence: clamp(0.35 + ratio * 0.45, 0, 0.9),
    evidence: [
      `${Math.round(ratio * 100)}% of flaky failures cluster in the ${where} of the suite.`,
      `Tests at suite edges commonly see initialization or teardown races.`,
    ],
  };
}

// ── Heuristic: env-dependent via fingerprint correlation ─────────────────

function scoreEnv(group: FlakyFailureSample[]): {
  cause: FlakyRootCause;
  confidence: number;
  evidence: string[];
} {
  const envCounts = new Map<string, number>();
  let withEnv = 0;
  for (const s of group) {
    if (!s.envFingerprint) continue;
    withEnv++;
    envCounts.set(s.envFingerprint, (envCounts.get(s.envFingerprint) ?? 0) + 1);
  }
  if (withEnv < MIN_SAMPLES_FOR_CAUSE) {
    return { cause: 'unknown', confidence: 0, evidence: [] };
  }

  let topEnv: string | null = null;
  let topCount = 0;
  for (const [k, v] of envCounts.entries()) {
    if (v > topCount) {
      topCount = v;
      topEnv = k;
    }
  }

  if (!topEnv || envCounts.size < 2) {
    // Only one env hash seen: we can't claim env-dependence (nothing to compare).
    return { cause: 'unknown', confidence: 0, evidence: [] };
  }

  const ratio = topCount / withEnv;
  if (ratio < ENV_FINGERPRINT_RATIO) {
    return { cause: 'unknown', confidence: 0, evidence: [] };
  }

  return {
    cause: 'env-dependent',
    confidence: clamp(0.4 + ratio * 0.45, 0, 0.95),
    evidence: [
      `${Math.round(ratio * 100)}% of flaky failures are pinned to env fingerprint \`${topEnv.slice(0, 16)}${topEnv.length > 16 ? '…' : ''}\`.`,
      `Across ${envCounts.size} distinct environments observed, one dominates — timezone, OS, or Node version drift suspected.`,
    ],
  };
}

// ── Heuristic: data-dependent via mutating-prior-test regex ──────────────

function scoreData(group: FlakyFailureSample[]): {
  cause: FlakyRootCause;
  confidence: number;
  evidence: string[];
} {
  let matching = 0;
  let withPrior = 0;
  const hitExamples: string[] = [];
  for (const s of group) {
    if (!s.priorFailedTests || s.priorFailedTests.length === 0) continue;
    withPrior++;
    const firstHit = s.priorFailedTests.find((p) => DATA_MUTATING_REGEX.test(p));
    if (firstHit) {
      matching++;
      if (hitExamples.length < 3) hitExamples.push(firstHit);
    }
  }
  if (withPrior < MIN_SAMPLES_FOR_CAUSE) {
    return { cause: 'unknown', confidence: 0, evidence: [] };
  }

  const ratio = matching / withPrior;
  if (ratio < 0.6) return { cause: 'unknown', confidence: 0, evidence: [] };

  return {
    cause: 'data-dependent',
    confidence: clamp(0.35 + ratio * 0.5, 0, 0.92),
    evidence: [
      `${matching}/${withPrior} flaky runs followed a data-mutating test (create/delete/seed/reset).`,
      `Example priors: ${hitExamples.map((s) => `\`${s}\``).join(', ')}.`,
    ],
  };
}

// ── Utilities ────────────────────────────────────────────────────────────

function groupByTestId(samples: FlakyFailureSample[]): Map<string, FlakyFailureSample[]> {
  const out = new Map<string, FlakyFailureSample[]>();
  for (const s of samples) {
    const list = out.get(s.testId);
    if (list) list.push(s);
    else out.set(s.testId, [s]);
  }
  return out;
}

function parseHour(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCHours();
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
