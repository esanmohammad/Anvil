/**
 * incident-stats — pure aggregation helper for Anvil's bug-to-test replay
 * feature. Takes a list of IncidentRecord + ReplayAttempt values (plus a
 * scalar count of currently-bound tests, since bound-tests live in a
 * separate store) and produces a single `IncidentStats` snapshot suitable
 * for rendering in the CLI or dashboard.
 *
 * No I/O, no side effects — the function is deterministic modulo the
 * "now" reference used for the 30/90-day windows, which the caller can
 * inject for testing.
 */

import type { IncidentRecord, ReplayAttempt } from './incident-types.js';

// ── Public types ─────────────────────────────────────────────────────────

export interface IncidentStats {
  total: number;
  bySource: Record<string, number>;
  bySeverity: Record<string, number>;
  replayed: number;
  bound: number;
  confidenceHistogram: Record<string, number>;
  last30Days: number;
  last90Days: number;
  topCategories: Array<{ category: string; count: number }>;
}

/**
 * Buckets we always surface in the confidence histogram, even when their
 * count is zero. Keeps the output shape stable across runs.
 */
const CONFIDENCE_BUCKETS = ['high', 'med', 'low'] as const;

/** Max categories to return in the `topCategories` list. */
const TOP_CATEGORIES_LIMIT = 10;

/** Max number of tags, per incident, that contribute to the category histogram. */
const TAGS_PER_INCIDENT = 3;

// ── computeIncidentStats ─────────────────────────────────────────────────

export function computeIncidentStats(
  incidents: IncidentRecord[],
  replays: ReplayAttempt[],
  boundCount: number,
  nowMs: number = Date.now(),
): IncidentStats {
  const bySource: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const confidenceHistogram: Record<string, number> = {};
  for (const b of CONFIDENCE_BUCKETS) confidenceHistogram[b] = 0;

  const categoryCounts = new Map<string, number>();

  const windowMs30 = 30 * 24 * 60 * 60 * 1000;
  const windowMs90 = 90 * 24 * 60 * 60 * 1000;
  const cutoff30 = nowMs - windowMs30;
  const cutoff90 = nowMs - windowMs90;

  let last30Days = 0;
  let last90Days = 0;

  for (const inc of incidents) {
    if (!inc) continue;

    // by-source
    const source = typeof inc.source === 'string' ? inc.source : 'unknown';
    bySource[source] = (bySource[source] ?? 0) + 1;

    // by-severity
    const severity = typeof inc.severity === 'string' ? inc.severity : 'unknown';
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;

    // recency windows — guard against unparseable timestamps
    const occurredMs = parseIsoMs(inc.occurredAt);
    if (occurredMs !== null) {
      if (occurredMs >= cutoff30) last30Days++;
      if (occurredMs >= cutoff90) last90Days++;
    }

    // category histogram from first N tags
    if (Array.isArray(inc.tags)) {
      const seenForIncident = new Set<string>();
      let added = 0;
      for (const raw of inc.tags) {
        if (added >= TAGS_PER_INCIDENT) break;
        if (typeof raw !== 'string') continue;
        const tag = raw.trim().toLowerCase();
        if (tag.length === 0) continue;
        if (seenForIncident.has(tag)) continue;
        seenForIncident.add(tag);
        categoryCounts.set(tag, (categoryCounts.get(tag) ?? 0) + 1);
        added++;
      }
    }
  }

  // Replays — count how many incidents had at least one replay attempt, and
  // accumulate the confidence histogram off the replays themselves.
  const incidentsWithReplay = new Set<string>();
  for (const r of replays) {
    if (!r) continue;
    if (typeof r.incidentId === 'string' && r.incidentId.length > 0) {
      incidentsWithReplay.add(r.incidentId);
    }
    const confidence = typeof r.confidence === 'string' ? r.confidence : 'low';
    confidenceHistogram[confidence] = (confidenceHistogram[confidence] ?? 0) + 1;
  }

  const topCategories: Array<{ category: string; count: number }> = Array.from(
    categoryCounts.entries(),
  )
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.category.localeCompare(b.category);
    })
    .slice(0, TOP_CATEGORIES_LIMIT);

  return {
    total: incidents.length,
    bySource,
    bySeverity,
    replayed: incidentsWithReplay.size,
    bound: Math.max(0, Math.trunc(boundCount)),
    confidenceHistogram,
    last30Days,
    last90Days,
    topCategories,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function parseIsoMs(s: string | undefined): number | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
