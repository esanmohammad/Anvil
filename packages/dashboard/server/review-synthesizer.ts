/**
 * Review Phase R9 — Verdict synthesizer.
 *
 * Takes a filtered list of review findings (after all other review phases
 * have run) and produces a single `ReviewVerdict`.
 *
 * Rules:
 *   - level = 'blocker'       if any finding has severity === 'blocker' OR immutable === true.
 *   - level = 'needs-changes' if any finding has severity in {'high', 'medium'}.
 *   - level = 'approve'       otherwise (polish-only findings are tucked behind a disclosure).
 *
 * Sorting for `mainFindings`:
 *   blocker > high > medium — ties broken by `calibratedConfidence` desc.
 *   Capped at 5 entries.
 *
 * Polish bucket:
 *   Any finding with severity in {'low', 'info'} OR demoted === true.
 *
 * Headlines (banner copy):
 *   blocker        → "⛔ Must fix before merge — <N> blocker(s)."
 *   needs-changes  → "⚠ <N> thing(s) to address."
 *   approve        → "✓ Looks clean." (even if polish[] is non-empty)
 *
 * No third-party deps. Findings are treated structurally as `unknown` values;
 * this module does not import `ReviewFinding` so it stays decoupled from the
 * store schema.
 */

import type { ReviewVerdict, VerdictLevel } from './review-verdict-types.js';

// ── Internal structural view of a finding ────────────────────────────────

/**
 * Severities the synthesizer understands. The wider `ReviewFinding.severity`
 * union ('blocker' | 'error' | 'warn' | 'info' | 'nit') is normalised into
 * this space so the caller does not need to pre-translate.
 */
type NormalisedSeverity = 'blocker' | 'high' | 'medium' | 'low' | 'info';

interface StructuredFinding {
  severity?: unknown;
  immutable?: unknown;
  demoted?: unknown;
  calibratedConfidence?: unknown;
  statedConfidence?: unknown;
  persona?: unknown;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function asRecord(value: unknown): StructuredFinding {
  if (value && typeof value === 'object') {
    return value as StructuredFinding;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normaliseSeverity(raw: unknown): NormalisedSeverity {
  const s = asString(raw);
  if (s === 'blocker') return 'blocker';
  if (s === 'high' || s === 'error') return 'high';
  if (s === 'medium' || s === 'warn') return 'medium';
  if (s === 'low' || s === 'nit') return 'low';
  // default bucket for unknown / 'info'
  return 'info';
}

const SEVERITY_RANK: Record<NormalisedSeverity, number> = {
  blocker: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function isPolish(finding: StructuredFinding): boolean {
  if (finding.demoted === true) return true;
  const sev = normaliseSeverity(finding.severity);
  return sev === 'low' || sev === 'info';
}

function isBlocker(finding: StructuredFinding): boolean {
  if (finding.immutable === true) return true;
  return normaliseSeverity(finding.severity) === 'blocker';
}

function isMain(finding: StructuredFinding): boolean {
  if (isPolish(finding)) return false;
  const sev = normaliseSeverity(finding.severity);
  return sev === 'blocker' || sev === 'high' || sev === 'medium';
}

function confidenceOf(finding: StructuredFinding): number {
  const cal = asNumber(finding.calibratedConfidence);
  if (cal !== undefined) return cal;
  const stated = asNumber(finding.statedConfidence);
  if (stated !== undefined) return stated;
  return 0;
}

function compareForMainRank(a: unknown, b: unknown): number {
  const ra = asRecord(a);
  const rb = asRecord(b);
  const sevDelta = SEVERITY_RANK[normaliseSeverity(rb.severity)] - SEVERITY_RANK[normaliseSeverity(ra.severity)];
  if (sevDelta !== 0) return sevDelta;
  // ties broken by calibratedConfidence desc
  return confidenceOf(rb) - confidenceOf(ra);
}

function pluralise(count: number): string {
  return count === 1 ? '' : 's';
}

function buildHeadline(level: VerdictLevel, blockerCount: number, mainCount: number): string {
  if (level === 'blocker') {
    return `⛔ Must fix before merge — ${blockerCount} blocker${pluralise(blockerCount)}.`;
  }
  if (level === 'needs-changes') {
    return `⚠ ${mainCount} thing${pluralise(mainCount)} to address.`;
  }
  return '✓ Looks clean.';
}

function summarise(findings: unknown[]): ReviewVerdict['summary'] {
  const bySeverity: Record<string, number> = {};
  const byPersona: Record<string, number> = {};

  for (const f of findings) {
    const r = asRecord(f);
    const sev = normaliseSeverity(r.severity);
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;

    const persona = asString(r.persona);
    if (persona) {
      byPersona[persona] = (byPersona[persona] ?? 0) + 1;
    }
  }

  return {
    totalFindings: findings.length,
    bySeverity,
    byPersona,
  };
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Collapse a filtered finding list into a single verdict.
 *
 * The input is treated as immutable: the returned arrays are fresh instances
 * containing the same finding references.
 */
export function synthesizeVerdict(findings: unknown[]): ReviewVerdict {
  const safeInput = Array.isArray(findings) ? findings : [];

  const blockers: unknown[] = [];
  const mains: unknown[] = [];
  const polish: unknown[] = [];
  let immutableBlockerCount = 0;

  for (const finding of safeInput) {
    const r = asRecord(finding);

    if (isBlocker(r)) {
      blockers.push(finding);
      if (r.immutable === true) immutableBlockerCount += 1;
      continue;
    }

    if (isPolish(r)) {
      polish.push(finding);
      continue;
    }

    if (isMain(r)) {
      mains.push(finding);
      continue;
    }

    // Fallback: treat anything else as polish so we never lose a finding.
    polish.push(finding);
  }

  // Sort blockers too so the banner can cite the "worst" one deterministically.
  const sortedBlockers = [...blockers].sort(compareForMainRank);
  const sortedMainPool = [...mains].sort(compareForMainRank);

  // `mainFindings` shown under `needs-changes`: top 5 by severity, then confidence.
  // Under `blocker`, the UI primarily surfaces `blockers`; still include top
  // non-blocker mains so reviewers see the full "address list" too (capped at 5).
  const mainFindings = sortedMainPool.slice(0, 5);

  let level: VerdictLevel;
  if (sortedBlockers.length > 0) {
    level = 'blocker';
  } else if (sortedMainPool.length > 0) {
    level = 'needs-changes';
  } else {
    level = 'approve';
  }

  const headline = buildHeadline(level, sortedBlockers.length, sortedMainPool.length);

  return {
    level,
    headline,
    blockers: sortedBlockers,
    mainFindings,
    polish,
    computedAt: new Date().toISOString(),
    immutableBlockerCount,
    summary: summarise(safeInput),
  };
}
