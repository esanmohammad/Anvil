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

// ── LLM-driven near-duplicate dedupe (plan tier 2.3) ─────────────────────

/**
 * Judge invoked when BM25's top hit has high token-level similarity to the
 * candidate but ISN'T an exact content-digest match. The judge decides
 * which of three relationships holds.
 *
 *   - `same`       → semantically identical; merge-into
 *   - `superseded` → candidate replaces existing; supersede + soft-invalidate
 *   - `unrelated`  → false positive; treat as a fresh add
 *
 * Implementation is caller-supplied so memory-core stays free of LLM SDK
 * dependencies (same pattern as `ReflectionInvoker`).
 */
export type DedupeJudgeVerdict = 'same' | 'superseded' | 'unrelated';

export interface DedupeJudgeRequest {
  candidate: Memory;
  existing: Memory;
  /** Token-level similarity (Jaccard); informational for the judge prompt. */
  similarity: number;
}

export type DedupeJudge = (
  req: DedupeJudgeRequest,
) => Promise<{ verdict: DedupeJudgeVerdict; reason: string }>;

export interface LlmDedupeOptions {
  /**
   * Cosine-equivalent token similarity threshold above which the judge is
   * invoked. Below this, the candidate is treated as distinct (add). The
   * default 0.55 is hand-tuned for short fix-pattern bodies.
   */
  similarityThreshold?: number;
}

/**
 * LLM-aware version of `defaultDecide`. Exact-digest match still
 * fast-paths to merge. Near-duplicates (similarity above threshold)
 * route to the judge. Everything else is an `add`.
 *
 * Cost discipline:
 *   - Hash-exact case: zero LLM calls.
 *   - No nearest duplicate at all: zero LLM calls.
 *   - Below-threshold similarity: zero LLM calls.
 *   - Above-threshold: one call. Bounded by ratification throughput
 *     (~5-10 / day / project in practice).
 */
export function llmDedupeDecide(
  store: HybridMemoryStore,
  proposal: Proposal,
  judge: DedupeJudge,
  opts: LlmDedupeOptions = {},
): Promise<RatificationDecision> {
  const threshold = opts.similarityThreshold ?? 0.55;
  const dup = findNearestDuplicate(store, proposal.candidate);
  if (!dup) return Promise.resolve({ kind: 'add' });
  if (dup.exact) {
    return Promise.resolve({ kind: 'merge-into', targetId: dup.memory.id });
  }
  if (dup.similarity < threshold) {
    return Promise.resolve({ kind: 'add' });
  }
  return judge({
    candidate: proposal.candidate,
    existing: dup.memory,
    similarity: dup.similarity,
  }).then(({ verdict, reason }) => {
    switch (verdict) {
      case 'same':
        return { kind: 'merge-into' as const, targetId: dup.memory.id };
      case 'superseded':
        return {
          kind: 'supersede' as const,
          targetId: dup.memory.id,
          reason: reason.slice(0, 200),
        };
      case 'unrelated':
      default:
        return { kind: 'add' as const };
    }
  }).catch((err) => {
    // Judge failure is non-fatal — degrade to hash-only behavior.
    console.warn('[memory-core] dedupe judge failed:', err);
    return { kind: 'add' as const };
  });
}

/**
 * Stock system prompt for dedupe judges. Callers can use this verbatim
 * or replace with their own. Returns strict JSON for parseability.
 */
export const DEDUPE_JUDGE_SYSTEM_PROMPT = `You judge whether two memory entries about the same project record the same lesson, contradict each other, or are independent observations.

Given a CANDIDATE memory (newly proposed) and an EXISTING memory (already stored), return STRICT JSON:

{"verdict": "same" | "superseded" | "unrelated", "reason": "<one sentence>"}

Verdicts:
- "same"       — both record the same lesson/fact in slightly different words. Merge.
- "superseded" — candidate REPLACES existing because the existing is now wrong, outdated, or describes a pattern we should no longer use. Old gets invalidated.
- "unrelated"  — token overlap is coincidental; they're distinct lessons. Add as a new memory.

Default to "unrelated" when uncertain. Only mark "same" when both clearly capture the same point. Only mark "superseded" when the new explicitly contradicts or replaces the old.`;

/** Parse the judge's response. Tolerant of surrounding prose. */
export function parseDedupeJudgeOutput(
  raw: string,
): { verdict: DedupeJudgeVerdict; reason: string } {
  // Find the first JSON object in the output.
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return { verdict: 'unrelated', reason: 'no JSON in judge output' };
  try {
    const parsed = JSON.parse(match[0]) as { verdict?: string; reason?: string };
    const verdict = (parsed.verdict ?? 'unrelated') as DedupeJudgeVerdict;
    if (!['same', 'superseded', 'unrelated'].includes(verdict)) {
      return { verdict: 'unrelated', reason: 'invalid verdict' };
    }
    return { verdict, reason: parsed.reason ?? '' };
  } catch {
    return { verdict: 'unrelated', reason: 'malformed JSON' };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
