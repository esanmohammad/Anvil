/**
 * Cost-bridge — keeps dashboard's NDJSON `CostLedger` and agent-core's SQLite
 * `SpendLedger` in sync.
 *
 * Phase 3 of the dashboard consolidation. See DASHBOARD-CONSOLIDATION-PLAN.md
 * §3 / D4.
 *
 * Storage layouts deliberately stay separate (NDJSON for dashboard UI reads,
 * SQLite for cli `anvil-loc cost summary` reads). The bridge mirrors writes:
 * each `CostLedger.record()` produces a matching `SpendRow` so both stores
 * agree to within USD rounding.
 *
 * Mirror writes are best-effort — a SpendLedger failure is logged once and
 * never propagates to the caller, so the dashboard's UI cost path is never
 * blocked by a router-side issue (corrupt sqlite, locked file, etc).
 *
 * Field mapping:
 *
 *   CostEntry.runId         → SpendRow.runId
 *   CostEntry.project       → SpendRow.project
 *   CostEntry.stage         → SpendRow.tag         (e.g. 'plan' / 'implement')
 *   CostEntry.model         → SpendRow.model
 *   inferProvider(model)    → SpendRow.provider
 *   CostEntry.tokensIn      → SpendRow.inputTokens
 *   CostEntry.tokensOut     → SpendRow.outputTokens
 *   CostEntry.cacheRead     → SpendRow.cacheReadTokens
 *   CostEntry.cacheWrite    → SpendRow.cacheWriteTokens
 *   CostEntry.usd           → SpendRow.costUsd
 *   CostEntry.at            → SpendRow.ts
 *   (newly minted)          → SpendRow.id          (no shared keyspace)
 *   0                       → durationMs / fallbackIndex
 *   1                       → attemptCount
 *   undefined               → user / errorClass / traceId
 *
 * IDs are NOT shared between the two stores — dashboard generates
 * `${ts36}-${rand}`; SpendLedger keeps its own surrogate. Consumers that need
 * to correlate join on `(runId, project, ts, model)` instead.
 */

import { SpendLedger, type SpendRow } from '@anvil/agent-core';

import { CostLedger, type CostRecordInput } from './cost-ledger.js';
import type { CostEntry } from './cost-types.js';

// ── Provider inference ───────────────────────────────────────────────────

/**
 * Map a model id to a coarse provider name for the SpendRow. The router's
 * existing `provider` column groups across families (anthropic / openai / ...),
 * matching agent-core's `ProviderRegistry` keys. Unknown models fall back to
 * `'unknown'` — better than silently lumping them into a real provider.
 */
export function inferProvider(model: string): string {
  const id = model.toLowerCase();
  if (id.startsWith('claude-')) return 'anthropic';
  if (id.startsWith('gpt-') || /^o[134](-|$)/.test(id)) return 'openai';
  if (id.startsWith('gemini-')) return 'google';
  if (id.startsWith('llama') || id.startsWith('mistral') || id.startsWith('qwen') || id.startsWith('phi')) return 'ollama';
  return 'unknown';
}

// ── Bridge id generator ──────────────────────────────────────────────────

let bridgeIdCounter = 0;

/**
 * Surrogate id for the SpendRow — independent of dashboard's `${ts}-${rand}`
 * because the router historically used ULIDs and we don't want to assume a
 * shared keyspace (per plan §3.4 risk).
 */
function makeSpendId(): string {
  bridgeIdCounter = (bridgeIdCounter + 1) % 1_000_000;
  return `cb-${Date.now().toString(36)}-${bridgeIdCounter.toString(36).padStart(4, '0')}`;
}

// ── Mapping ──────────────────────────────────────────────────────────────

export function costEntryToSpendRow(entry: CostEntry): SpendRow {
  return {
    id: makeSpendId(),
    ts: entry.at,
    runId: entry.runId,
    project: entry.project,
    tag: entry.stage,
    provider: inferProvider(entry.model),
    model: entry.model,
    inputTokens: entry.tokensIn,
    outputTokens: entry.tokensOut,
    cacheReadTokens: entry.cacheReadTokens ?? 0,
    cacheWriteTokens: entry.cacheWriteTokens ?? 0,
    costUsd: entry.usd,
    durationMs: 0,
    fallbackIndex: 0,
    attemptCount: 1,
  };
}

// ── BridgedCostLedger ────────────────────────────────────────────────────

export interface BridgedCostLedgerOptions {
  /**
   * Optional override — defaults to the router's standard
   * `~/.anvil/router/spend.sqlite`. Tests pass an explicit path.
   */
  spendLedger?: SpendLedger;
  /**
   * Hook for tests + observability. Fires after a successful mirror write.
   */
  onMirror?: (entry: CostEntry, row: SpendRow) => void;
  /**
   * Hook for tests + observability. Fires once per failed mirror write.
   */
  onMirrorError?: (entry: CostEntry, error: unknown) => void;
}

let warnedMirrorFailure = false;

/**
 * `CostLedger` whose `record()` also writes a matching `SpendRow` to
 * `agent-core`'s `SpendLedger`. Subclasses so `instanceof CostLedger` and the
 * existing `BreachHandlerOptions.ledger: CostLedger` typing both still hold.
 */
export class BridgedCostLedger extends CostLedger {
  private readonly spendLedger: SpendLedger;
  private readonly onMirror?: (entry: CostEntry, row: SpendRow) => void;
  private readonly onMirrorError?: (entry: CostEntry, error: unknown) => void;

  constructor(anvilHome: string, opts: BridgedCostLedgerOptions = {}) {
    super(anvilHome);
    this.spendLedger = opts.spendLedger ?? new SpendLedger();
    this.onMirror = opts.onMirror;
    this.onMirrorError = opts.onMirrorError;
  }

  override record(input: CostRecordInput): CostEntry {
    const entry = super.record(input);
    try {
      const row = costEntryToSpendRow(entry);
      this.spendLedger.record(row);
      this.onMirror?.(entry, row);
    } catch (error) {
      if (!warnedMirrorFailure) {
        warnedMirrorFailure = true;
        // eslint-disable-next-line no-console
        console.warn(
          '[cost-bridge] SpendLedger mirror failed — dashboard cost ledger continues, '
            + 'router spend ledger may be stale until the underlying issue is resolved.',
          error,
        );
      }
      this.onMirrorError?.(entry, error);
    }
    return entry;
  }

  /** Exposed for tests + a future cli-side cross-check. */
  getSpendLedger(): SpendLedger {
    return this.spendLedger;
  }
}

/** Test seam — reset the once-warned flag. */
export function __resetCostBridgeWarnedForTests(): void {
  warnedMirrorFailure = false;
}
