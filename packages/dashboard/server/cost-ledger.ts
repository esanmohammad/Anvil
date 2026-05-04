/**
 * CostLedger — append-only NDJSON storage for LLM cost entries.
 *
 * Layout under `<anvilHome>/cost-ledger/`:
 *
 *   <project>/<runId>.ndjson          — per-run ledger (one CostEntry per line)
 *   <project>/daily/<YYYY-MM-DD>.ndjson — per-project daily ledger
 *
 * We deliberately use NDJSON (not JSON arrays): each `record()` call is a
 * single `appendFileSync` and can't corrupt earlier lines. On read we parse
 * line-by-line and silently skip malformed entries, so a crash mid-write
 * can at worst leave one partial tail line.
 *
 * The ledger is agnostic to the breach state machine — it just stores and
 * summarizes. `CostBreachHandler` sits on top and consumes `summarize()`.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';

import type { CostEntry, CostStage, RunCostSummary } from './cost-types.js';
import { priceUsd } from './cost-pricing.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function isoDay(iso: string): string {
  // `YYYY-MM-DD` slice is safe for valid ISO strings; fall back to today.
  if (iso && iso.length >= 10) return iso.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function makeId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}-${rand}`;
}

/** Read an NDJSON file and yield parsed entries, skipping malformed lines. */
function readNdjson(filePath: string): CostEntry[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf-8');
  const out: CostEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as CostEntry;
      if (parsed && typeof parsed.runId === 'string' && typeof parsed.usd === 'number') {
        out.push(parsed);
      }
    } catch {
      // malformed line — skip (e.g. partial tail from a prior crash)
    }
  }
  return out;
}

// ── CostLedger ───────────────────────────────────────────────────────────

export type CostRecordInput = Omit<CostEntry, 'id' | 'usd' | 'at'> & { at?: string };

class CostLedger {
  private baseDir: string;

  constructor(anvilHome: string) {
    this.baseDir = join(anvilHome, 'cost-ledger');
    ensureDir(this.baseDir);
  }

  // ── Path helpers ──────────────────────────────────────────────────────

  private projectDir(project: string): string {
    return join(this.baseDir, project);
  }

  private runFile(project: string, runId: string): string {
    return join(this.projectDir(project), `${runId}.ndjson`);
  }

  private dailyFile(project: string, day: string): string {
    return join(this.projectDir(project), 'daily', `${day}.ndjson`);
  }

  // ── Mutations ─────────────────────────────────────────────────────────

  /**
   * Record a cost entry for an LLM call. Computes `usd` via the pricing
   * table, assigns an id + timestamp, and appends to both the per-run and
   * per-day ledger files.
   */
  record(input: CostRecordInput): CostEntry {
    const at = input.at ?? new Date().toISOString();
    const usd = priceUsd(input.model, input.tokensIn, input.tokensOut);
    const entry: CostEntry = {
      id: makeId(),
      runId: input.runId,
      project: input.project,
      stage: input.stage,
      agent: input.agent,
      model: input.model,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      usd,
      at,
    };

    ensureDir(this.projectDir(entry.project));
    ensureDir(join(this.projectDir(entry.project), 'daily'));

    const line = JSON.stringify(entry) + '\n';
    appendFileSync(this.runFile(entry.project, entry.runId), line, 'utf-8');
    appendFileSync(this.dailyFile(entry.project, isoDay(at)), line, 'utf-8');

    return entry;
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  /**
   * Fold all entries in a run into totals. Returns zeroed totals if the
   * run has no entries (useful for brand-new runs the UI wants to display).
   */
  summarize(runId: string, project?: string): RunCostSummary {
    const entries = this.loadRunEntries(runId, project);
    const summary: RunCostSummary = {
      runId,
      project: project ?? entries[0]?.project ?? '',
      totalUsd: 0,
      totalTokensIn: 0,
      totalTokensOut: 0,
      cacheHitRatio: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      byStage: { plan: 0, implement: 0, review: 0, test: 0, ship: 0, other: 0 },
      byModel: {},
      byAgent: {},
    };
    if (entries.length === 0) return summary;

    for (const e of entries) {
      summary.totalUsd += e.usd;
      summary.totalTokensIn += e.tokensIn;
      summary.totalTokensOut += e.tokensOut;
      summary.totalCacheReadTokens += e.cacheReadTokens ?? 0;
      summary.totalCacheWriteTokens += e.cacheWriteTokens ?? 0;
      summary.byStage[e.stage] = (summary.byStage[e.stage] ?? 0) + e.usd;
      summary.byModel[e.model] = (summary.byModel[e.model] ?? 0) + e.usd;
      const agentKey = e.agent || '(unspecified)';
      summary.byAgent[agentKey] = (summary.byAgent[agentKey] ?? 0) + e.usd;
    }
    // Round 6dp to stabilise float arithmetic across summaries.
    summary.totalUsd = Math.round(summary.totalUsd * 1_000_000) / 1_000_000;
    // Phase 1 KPI: cache hit ratio = cacheRead / (tokensIn + cacheRead).
    // Denominator excludes cache writes — those are paid full price.
    const cacheDen = summary.totalTokensIn + summary.totalCacheReadTokens;
    summary.cacheHitRatio = cacheDen > 0
      ? Math.round((summary.totalCacheReadTokens / cacheDen) * 10_000) / 10_000
      : 0;
    summary.startedAt = entries[0]?.at;
    summary.lastAt = entries[entries.length - 1]?.at;
    return summary;
  }

  /**
   * Sum of USD spent today (or the given YYYY-MM-DD) across all runs of the
   * project. Used to enforce `perProjectDaily` limits.
   */
  projectDailyTotal(project: string, date?: string): number {
    const day = date ?? new Date().toISOString().slice(0, 10);
    const entries = readNdjson(this.dailyFile(project, day));
    let total = 0;
    for (const e of entries) total += e.usd;
    return Math.round(total * 1_000_000) / 1_000_000;
  }

  /** Most recent N entries for a run, newest-last. */
  recentEntries(project: string, runId: string, limit = 50): CostEntry[] {
    const entries = readNdjson(this.runFile(project, runId));
    if (entries.length <= limit) return entries;
    return entries.slice(entries.length - limit);
  }

  /**
   * Top N spending stages for a run. Used in breach notifications so the
   * user sees where the money went at a glance.
   */
  topSpenders(runId: string, topN = 3): Array<{ stage: CostStage; usd: number }> {
    const summary = this.summarize(runId);
    const rows: Array<{ stage: CostStage; usd: number }> = (
      Object.entries(summary.byStage) as Array<[CostStage, number]>
    ).map(([stage, usd]) => ({ stage, usd }));
    rows.sort((a, b) => b.usd - a.usd);
    return rows.filter((r) => r.usd > 0).slice(0, topN);
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * Load a run's entries. If the project is unknown we scan project dirs
   * for a matching file — slow path, but avoids requiring callers to
   * remember the project when summarizing by runId only.
   */
  private loadRunEntries(runId: string, project?: string): CostEntry[] {
    if (project) return readNdjson(this.runFile(project, runId));
    if (!existsSync(this.baseDir)) return [];
    for (const entry of readdirSync(this.baseDir)) {
      const candidate = join(this.baseDir, entry, `${runId}.ndjson`);
      if (existsSync(candidate)) return readNdjson(candidate);
    }
    return [];
  }
}

export { CostLedger };
