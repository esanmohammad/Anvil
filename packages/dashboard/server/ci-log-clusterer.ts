/**
 * CI Triage Phase 3 — Log clusterer.
 *
 * Ingests raw CI log text, scans error-ish lines, classifies each one against
 * the pattern library (`ci-log-patterns.ts`), and returns a sorted cluster
 * report. The algorithm is deliberately linear and dependency-free so it can
 * run in-process on dashboard requests or from the CLI.
 *
 * Algorithm:
 *   1. Iterate lines. A line is an "error line" if it matches the coarse
 *      `/error|fail|panic|fatal|exception|assert/i` filter.
 *   2. For each error line, run the pattern library top-down. First match wins.
 *      Unmatched error lines are collected into `unknownExcerpt` (capped).
 *   3. Group matches by `pattern`; compute count, first/last line, 3 examples,
 *      and confidence = clamp(count/3, 0..1) + 0.2 bonus for `critical`.
 *   4. Sort clusters by severity desc, then count desc.
 *
 * The clusterer is pure: no I/O, no global state.
 */

import {
  DEFAULT_PATTERN_LIBRARY,
  type CiFailurePattern,
  type CiFailureSeverity,
  type PatternRule,
} from './ci-log-patterns.js';

// ── Public types ────────────────────────────────────────────────────────

export interface CiFailureCluster {
  pattern: CiFailurePattern;
  severity: CiFailureSeverity;
  count: number;
  firstLine: number;
  lastLine: number;
  examples: string[];
  suggestedFix: string;
  confidence: number;
}

export interface CiTriageReport {
  logSource: string;
  totalLines: number;
  errorLines: number;
  clusters: CiFailureCluster[];
  unknownExcerpt: string[];
  computedAt: string;
}

export interface ClusterInput {
  logText: string;
  logSource?: string;
  extraPatterns?: PatternRule[];
}

// ── Internal helpers ────────────────────────────────────────────────────

const ERROR_LINE_FILTER = /error|fail|panic|fatal|exception|assert/i;
const MAX_EXAMPLES_PER_CLUSTER = 3;
const MAX_UNKNOWN_EXCERPT = 10;
const MAX_EXAMPLE_LEN = 400;

const SEVERITY_WEIGHT: Record<CiFailureSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

interface ClusterAccumulator {
  pattern: CiFailurePattern;
  severity: CiFailureSeverity;
  count: number;
  firstLine: number;
  lastLine: number;
  examples: string[];
  suggestedFix: string;
  description: string;
}

function truncateLine(line: string): string {
  const stripped = line.replace(/\r$/, '');
  if (stripped.length <= MAX_EXAMPLE_LEN) return stripped;
  return stripped.slice(0, MAX_EXAMPLE_LEN - 1) + '…';
}

/** Run the pattern library against a line. First match wins. */
function classifyLine(line: string, rules: PatternRule[]): PatternRule | null {
  for (const rule of rules) {
    if (rule.matcher.test(line)) return rule;
  }
  return null;
}

/**
 * Compute confidence for a cluster. Base is `min(1, count / 3)`; criticals
 * get a +0.2 bonus to reflect that even a single OOM line is high-signal.
 */
function computeConfidence(count: number, severity: CiFailureSeverity): number {
  const base = Math.min(1, count / 3);
  const bonus = severity === 'critical' ? 0.2 : 0;
  const raw = base + bonus;
  // Clamp into [0, 1] and round to 3 decimals so JSON output stays clean.
  const clamped = Math.max(0, Math.min(1, raw));
  return Math.round(clamped * 1000) / 1000;
}

/** Sort: severity desc, then count desc, then pattern name for stability. */
function compareClusters(a: CiFailureCluster, b: CiFailureCluster): number {
  const sevDelta = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
  if (sevDelta !== 0) return sevDelta;
  if (b.count !== a.count) return b.count - a.count;
  return a.pattern.localeCompare(b.pattern);
}

/**
 * Merge `extraPatterns` ahead of the defaults so team-provided rules take
 * precedence. We do not deduplicate — a team override with the same regex
 * simply wins by being first.
 */
function buildRuleset(extra: PatternRule[] | undefined): PatternRule[] {
  if (!extra || extra.length === 0) return DEFAULT_PATTERN_LIBRARY;
  return [...extra, ...DEFAULT_PATTERN_LIBRARY];
}

function finalizeCluster(acc: ClusterAccumulator): CiFailureCluster {
  return {
    pattern: acc.pattern,
    severity: acc.severity,
    count: acc.count,
    firstLine: acc.firstLine,
    lastLine: acc.lastLine,
    examples: acc.examples.slice(0, MAX_EXAMPLES_PER_CLUSTER),
    suggestedFix: acc.suggestedFix,
    confidence: computeConfidence(acc.count, acc.severity),
  };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Cluster an unbounded CI log into failure buckets. Returns a sorted report
 * suitable for rendering in the triage panel or printing from the CLI.
 */
export function clusterCiLog(input: ClusterInput): CiTriageReport {
  const ruleset = buildRuleset(input.extraPatterns);
  const lines = input.logText.split(/\r?\n/);

  const accumulators = new Map<CiFailurePattern, ClusterAccumulator>();
  const unknown: string[] = [];
  let errorLineCount = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw) continue;
    if (!ERROR_LINE_FILTER.test(raw)) continue;

    errorLineCount += 1;

    const matched = classifyLine(raw, ruleset);
    if (!matched) {
      if (unknown.length < MAX_UNKNOWN_EXCERPT) {
        unknown.push(truncateLine(raw));
      }
      continue;
    }

    const lineNumber = i + 1; // 1-indexed for human display
    const existing = accumulators.get(matched.pattern);
    if (!existing) {
      accumulators.set(matched.pattern, {
        pattern: matched.pattern,
        severity: matched.severity,
        count: 1,
        firstLine: lineNumber,
        lastLine: lineNumber,
        examples: [truncateLine(raw)],
        suggestedFix: matched.suggestedFix,
        description: matched.description,
      });
      continue;
    }

    existing.count += 1;
    existing.lastLine = lineNumber;
    if (existing.examples.length < MAX_EXAMPLES_PER_CLUSTER) {
      existing.examples.push(truncateLine(raw));
    }
    // Upgrade severity if a later match for the same bucket is more severe
    // (e.g. two compile-error rules where one is critical and one is high).
    if (SEVERITY_WEIGHT[matched.severity] > SEVERITY_WEIGHT[existing.severity]) {
      existing.severity = matched.severity;
      existing.suggestedFix = matched.suggestedFix;
      existing.description = matched.description;
    }
  }

  const clusters = Array.from(accumulators.values())
    .map(finalizeCluster)
    .sort(compareClusters);

  return {
    logSource: input.logSource || 'pasted',
    totalLines: lines.length,
    errorLines: errorLineCount,
    clusters,
    unknownExcerpt: unknown,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Convenience: compute a compact one-line summary of a report, useful for
 * CLI headers and Slack notifications.
 */
export function summarizeReport(report: CiTriageReport): string {
  if (report.clusters.length === 0) {
    return `No known failure patterns detected across ${report.errorLines} error lines.`;
  }
  const top = report.clusters[0];
  return `Top cluster: ${top.pattern} (${top.severity}, ${top.count}x, confidence ${top.confidence.toFixed(2)}).`;
}

/**
 * Convenience: bucket-by-bucket summary string. Separated from
 * `summarizeReport` so the CLI's verbose mode can use it without reprinting
 * the report header.
 */
export function describeClusters(report: CiTriageReport): string[] {
  return report.clusters.map((cluster) =>
    `${cluster.pattern} [${cluster.severity}] x${cluster.count} — confidence ${cluster.confidence.toFixed(2)}`,
  );
}

/**
 * Return the unique set of pattern buckets touched by the report. Used by
 * the store's `learnedSuggestions` logic.
 */
export function clusterPatterns(report: CiTriageReport): CiFailurePattern[] {
  return report.clusters.map((cluster) => cluster.pattern);
}

// Re-export pattern types for downstream consumers that only import from the
// clusterer.
export type { CiFailurePattern, CiFailureSeverity, PatternRule };
