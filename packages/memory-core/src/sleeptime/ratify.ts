/**
 * `ratify.ts` — proposal-resolution decision logic (Phase 10).
 *
 * Each pending proposal resolves to one of four decisions:
 *
 *   - `'add'`         → write to durable memory store, mark `'ratified'`
 *   - `'merge-into'`  → bump the target memory's confidence + strength,
 *                       mark proposal `'merged-into'`, no new row
 *   - `'reject'`      → mark `'rejected'` with a reason, no change to
 *                       durable store
 *   - `'supersede'`   → write the new memory, soft-invalidate the
 *                       target (Phase 5), mark `'ratified'` with
 *                       `links: [{ targetId, relation: SUPERSEDES }]`
 *
 * Callers supply a `RatificationDecision` per proposal. The simple
 * default policy (`defaultDecide`) is an `'add'` unless `findNearestDuplicate`
 * reports an exact content-digest match — in which case it switches to
 * `'merge-into'`. LLM-driven decisions plug in by replacing this function.
 */

import {
  HybridMemoryStore,
} from '../storage/hybrid-store.js';
import { findNearestDuplicate } from './dedupe.js';
import { ProposalQueue } from './proposal-queue.js';
import { MEMORY_LINK_RELATIONS, type Memory, type Proposal } from '../types.js';

export type RatificationKind = 'add' | 'merge-into' | 'reject' | 'supersede';

export interface RatificationDecision {
  kind: RatificationKind;
  /** For 'merge-into' / 'supersede' — the durable memory id. */
  targetId?: string;
  /** For 'reject' — a human-readable reason stored on the proposal row. */
  reason?: string;
}

export interface RatifyArgs {
  store: HybridMemoryStore;
  queue: ProposalQueue;
  proposal: Proposal;
  decision: RatificationDecision;
  /** Stamped on `prov_ratified_at` / `decided_at`. */
  now?: string;
  /** Run id for provenance.invalidatedBy.runId on supersede. */
  runId?: string;
}

export interface RatifyOutcome {
  kind: RatificationKind;
  durableMemoryId?: string;
}

export function ratifyProposal(args: RatifyArgs): RatifyOutcome {
  const now = args.now ?? new Date().toISOString();

  switch (args.decision.kind) {
    case 'reject': {
      args.queue.updateStatus(args.proposal.id, 'rejected', {
        rejectedReason: args.decision.reason ?? 'rejected by ratification policy',
        decidedAt: now,
      });
      return { kind: 'reject' };
    }

    case 'merge-into': {
      const targetId = args.decision.targetId;
      if (!targetId) throw new Error("merge-into requires decision.targetId");
      const target = args.store.findById(targetId);
      if (!target) {
        // Target gone — fall back to ADD so we don't lose the signal.
        return performAdd(args, now);
      }
      const merged: Memory = {
        ...target,
        confidence: clamp(target.confidence + 5, 0, 100),
        decay: {
          ...target.decay,
          strength: clamp(target.decay.strength + 5, 0, 100),
          rehearseCount: target.decay.rehearseCount + 1,
          lastAccessed: now,
        },
      };
      args.store.add(merged);
      args.queue.updateStatus(args.proposal.id, 'merged-into', {
        ratifiedTo: target.id,
        decidedAt: now,
      });
      return { kind: 'merge-into', durableMemoryId: target.id };
    }

    case 'supersede': {
      const targetId = args.decision.targetId;
      if (!targetId) throw new Error("supersede requires decision.targetId");
      const candidate = withSupersedesLink(args.proposal.candidate, targetId, now);
      const stamped = stampRatified(candidate, now);
      args.store.add(stamped);
      args.store.invalidate(
        targetId,
        now,
        `superseded-by:${stamped.id}`,
        args.runId,
      );
      args.queue.updateStatus(args.proposal.id, 'ratified', {
        ratifiedTo: stamped.id,
        decidedAt: now,
      });
      return { kind: 'supersede', durableMemoryId: stamped.id };
    }

    case 'add':
    default:
      return performAdd(args, now);
  }
}

function performAdd(args: RatifyArgs, now: string): RatifyOutcome {
  const stamped = stampRatified(args.proposal.candidate, now);
  args.store.add(stamped);
  args.queue.updateStatus(args.proposal.id, 'ratified', {
    ratifiedTo: stamped.id,
    decidedAt: now,
  });
  return { kind: 'add', durableMemoryId: stamped.id };
}

function stampRatified(m: Memory, now: string): Memory {
  return {
    ...m,
    provenance: {
      ...m.provenance,
      ratifiedAt: now,
    },
  };
}

function withSupersedesLink(m: Memory, targetId: string, now: string): Memory {
  const existing = m.links ?? [];
  return {
    ...m,
    links: [
      ...existing,
      { targetId, relation: MEMORY_LINK_RELATIONS.SUPERSEDES, weight: 1 },
    ],
    bitemporal: m.bitemporal.validAt ? m.bitemporal : { ...m.bitemporal, validAt: now },
  };
}

/** Default decision: ADD, or MERGE-INTO if an exact content-digest twin exists. */
export function defaultDecide(
  store: HybridMemoryStore,
  proposal: Proposal,
): RatificationDecision {
  const dup = findNearestDuplicate(store, proposal.candidate);
  if (dup?.exact) {
    return { kind: 'merge-into', targetId: dup.memory.id };
  }
  return { kind: 'add' };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
