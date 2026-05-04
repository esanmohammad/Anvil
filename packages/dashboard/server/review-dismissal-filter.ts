/**
 * review-dismissal-filter — applies dismissal-based auto-filtering to
 * the list of findings produced by reviewer personas.
 *
 * The caller passes an array of findings (typed as `unknown[]` since the
 * filter doesn't need the full review-store type graph). For each finding
 * we derive a DismissalKey from `(personaId, claimType, filePath)` and
 * ask the store whether this key has crossed the dismissal threshold.
 *
 * Two modes:
 *   - `demoteOnly: false` (default) — findings that match are moved from
 *     the `kept` list into `filtered`, annotated with the matching key.
 *   - `demoteOnly: true`           — findings stay in `kept` but are
 *     annotated `demoted: true` and their severity is dropped one step.
 *
 * Integration: see review-dismissal-filter-INTEGRATION.md — this runs
 * after the evidence gate, before verdict synthesis.
 */

import {
  derivePatternFromFile,
  type DismissalKey,
  type ReviewDismissalStore,
} from './review-dismissal-store.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface ApplyDismissalFilterOptions {
  threshold?: number;
  demoteOnly?: boolean;
}

export interface ApplyDismissalFilterResult {
  kept: unknown[];
  filtered: Array<{ finding: unknown; key: DismissalKey }>;
}

// ── Severity demotion ladder ────────────────────────────────────────────

const SEVERITY_ORDER: readonly string[] = ['blocker', 'error', 'warn', 'info', 'nit'] as const;

function demoteSeverity(severity: unknown): string | undefined {
  if (typeof severity !== 'string') return undefined;
  const idx = SEVERITY_ORDER.indexOf(severity);
  if (idx === -1) return severity;
  const nextIdx = Math.min(idx + 1, SEVERITY_ORDER.length - 1);
  return SEVERITY_ORDER[nextIdx];
}

// ── Key extraction ──────────────────────────────────────────────────────

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/**
 * Derive a DismissalKey from a finding-shaped object. We look at a small
 * set of field aliases so this works with both reviewer-produced findings
 * and normalised store shapes without forcing a shared type.
 */
export function dismissalKeyFromFinding(finding: unknown): DismissalKey | null {
  if (!finding || typeof finding !== 'object') return null;
  const f = finding as Record<string, unknown>;

  const personaId = pickString(f, ['personaId', 'persona']);
  const claimType = pickString(f, ['claimType', 'category', 'type']);
  const filePath = pickString(f, ['filePath', 'file', 'path']);

  if (!personaId || !claimType) return null;

  return {
    personaId,
    claimType,
    filePattern: derivePatternFromFile(filePath),
  };
}

// ── Main entry ──────────────────────────────────────────────────────────

export function applyDismissalFilter(
  findings: unknown[],
  project: string,
  store: ReviewDismissalStore,
  opts: ApplyDismissalFilterOptions = {},
): ApplyDismissalFilterResult {
  const { threshold, demoteOnly = false } = opts;

  const kept: unknown[] = [];
  const filtered: Array<{ finding: unknown; key: DismissalKey }> = [];

  if (!Array.isArray(findings)) {
    return { kept, filtered };
  }

  for (const finding of findings) {
    const key = dismissalKeyFromFinding(finding);
    if (!key) {
      kept.push(finding);
      continue;
    }

    const match = store.shouldFilter(project, key, threshold);
    if (!match) {
      kept.push(finding);
      continue;
    }

    if (demoteOnly) {
      kept.push(demoteFinding(finding, key));
    } else {
      filtered.push({ finding, key });
    }
  }

  return { kept, filtered };
}

function demoteFinding(finding: unknown, key: DismissalKey): unknown {
  if (!finding || typeof finding !== 'object') return finding;
  const copy: Record<string, unknown> = { ...(finding as Record<string, unknown>) };
  copy.demoted = true;
  copy.demotedBy = {
    personaId: key.personaId,
    claimType: key.claimType,
    filePattern: key.filePattern,
  };
  const nextSev = demoteSeverity(copy.severity);
  if (nextSev !== undefined) copy.severity = nextSev;
  return copy;
}
