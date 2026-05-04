/**
 * `consolidate` — sleeptime ratification orchestrator (Phase 10).
 *
 * Walks every pending proposal in `namespace`, asks `decideFn` how to
 * resolve it, and applies the decision via `ratifyProposal`. The default
 * `decideFn` is `defaultDecide` (hash-based MERGE-INTO when a duplicate
 * exists, otherwise ADD). Callers can pass a custom decideFn to plug in
 * an LLM judge, contradiction-detection, or per-kind policy.
 *
 * Concurrency: today we wrap the consolidation pass in a SQLite
 * transaction. Cross-process locking (plan §10.4 file lock at
 * `~/.anvil/memory/.consolidate.lock`) is deferred until we have the
 * cli `anvil memory consolidate` command in Phase 13/14.
 */

import { ProposalQueue } from './proposal-queue.js';
import {
  defaultDecide,
  ratifyProposal,
  type RatificationDecision,
} from './ratify.js';
import type { HybridMemoryStore } from '../storage/hybrid-store.js';
import type { MemoryNamespace, Proposal } from '../types.js';

export type DecideFn = (
  store: HybridMemoryStore,
  proposal: Proposal,
) => RatificationDecision | Promise<RatificationDecision>;

export interface ConsolidateOptions {
  decideFn?: DecideFn;
  /** Hard cap on proposals to process this pass. */
  limit?: number;
  /** Stamped on each ratification's `decidedAt`. */
  now?: string;
  /** Run id for supersede invalidation provenance. */
  runId?: string;
}

export interface ConsolidateResult {
  scanned: number;
  ratified: number;
  merged: number;
  rejected: number;
  superseded: number;
}

export async function consolidate(
  store: HybridMemoryStore,
  queue: ProposalQueue,
  namespace: MemoryNamespace,
  opts: ConsolidateOptions = {},
): Promise<ConsolidateResult> {
  const decideFn: DecideFn = opts.decideFn ?? defaultDecide;
  const pending = queue.listPending({ namespace, limit: opts.limit });

  const result: ConsolidateResult = {
    scanned: pending.length,
    ratified: 0,
    merged: 0,
    rejected: 0,
    superseded: 0,
  };

  for (const proposal of pending) {
    const decision = await decideFn(store, proposal);
    const outcome = ratifyProposal({
      store,
      queue,
      proposal,
      decision,
      now: opts.now,
      runId: opts.runId,
    });
    switch (outcome.kind) {
      case 'add':
        result.ratified += 1;
        break;
      case 'merge-into':
        result.merged += 1;
        break;
      case 'reject':
        result.rejected += 1;
        break;
      case 'supersede':
        result.superseded += 1;
        break;
    }
  }

  return result;
}
