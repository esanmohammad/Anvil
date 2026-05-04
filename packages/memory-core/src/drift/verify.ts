/**
 * `verifyCodeBindings` — sleeptime-style drift sweep (Phase 6 — plan §6.2).
 *
 * For every memory in a namespace whose `codeBinding` is set, this:
 *   1. Re-checks the file via `checkCodeBindingDrift`.
 *   2. Stamps `lastVerifiedAt = now` regardless of outcome (so the next
 *      sweep can skip recently-verified memories via `staleAfterDays`).
 *   3. Applies a configurable policy to drifted / missing memories:
 *      - `'downweight'`: scales `decay.strength` by `downweightFactor`
 *        (default 0.5). The memory stays visible but ranks lower.
 *      - `'invalidate'`: calls `HybridMemoryStore.invalidate(...)` so the
 *        row drops out of default queries (Phase 5 soft-delete). The
 *        invalidation reason is namespaced (`code-drift:<file>` or
 *        `code-missing:<file>`) so audits can grep them.
 *
 * The function never throws on a single broken file — it logs to stderr
 * and continues so a long sweep doesn't abort on a transient I/O error.
 */

import { checkCodeBindingDrift } from './drift-detector.js';
import type { HybridMemoryStore } from '../storage/hybrid-store.js';
import type { Memory, MemoryNamespace } from '../types.js';

export type DriftPolicy = 'downweight' | 'invalidate';

export interface VerifyCodeBindingsOptions {
  /** Required: workspace root used when `binding.filePath` is relative. */
  workspaceRoot: string;
  /**
   * Policy applied when a binding has drifted (structural hash changed).
   * Default: `'downweight'`.
   */
  driftPolicy?: DriftPolicy;
  /**
   * Policy applied when the bound file is missing entirely.
   * Default: `'invalidate'` — a deleted file is a hard signal.
   */
  missingPolicy?: DriftPolicy;
  /**
   * Multiplier applied to `decay.strength` when downweighting. Capped
   * to >= 0. Default 0.5 (50% as plan §6.2.3).
   */
  downweightFactor?: number;
  /** Run id stored on `provenance.invalidatedBy.runId` for invalidations. */
  runId?: string;
  /**
   * Skip memories whose `codeBinding.lastVerifiedAt` is fresher than
   * `now - staleAfterDays * 86400_000`. Default 0 (verify every memory).
   * Plan §6.2.4 sleeptime cadence is "older than 7 days".
   */
  staleAfterDays?: number;
  /** ISO-8601 to use as "now"; defaults to `new Date().toISOString()`. */
  now?: string;
}

export interface VerifyCodeBindingsResult {
  fresh: number;
  drifted: number;
  missing: number;
  /** Memories scanned but skipped because they have no `codeBinding`. */
  noBinding: number;
  /** Memories whose `lastVerifiedAt` was within `staleAfterDays`. */
  skippedFresh: number;
  /** Ids of memories that were touched (drift policy applied). */
  touchedIds: string[];
}

export function verifyCodeBindings(
  store: HybridMemoryStore,
  namespace: MemoryNamespace,
  opts: VerifyCodeBindingsOptions,
): VerifyCodeBindingsResult {
  const now = opts.now ?? new Date().toISOString();
  const driftPolicy = opts.driftPolicy ?? 'downweight';
  const missingPolicy = opts.missingPolicy ?? 'invalidate';
  const downweightFactor = Math.max(0, opts.downweightFactor ?? 0.5);
  const staleCutoff =
    opts.staleAfterDays && opts.staleAfterDays > 0
      ? new Date(Date.parse(now) - opts.staleAfterDays * 86_400_000).toISOString()
      : null;

  const result: VerifyCodeBindingsResult = {
    fresh: 0,
    drifted: 0,
    missing: 0,
    noBinding: 0,
    skippedFresh: 0,
    touchedIds: [],
  };

  // We want every memory in the namespace, including invalidated rows
  // (so we can verify their bindings too — useful for migration audits).
  const memories = store.query(namespace, { includeInvalidated: true });

  for (const m of memories) {
    if (!m.codeBinding) {
      result.noBinding += 1;
      continue;
    }
    if (staleCutoff && m.codeBinding.lastVerifiedAt > staleCutoff) {
      result.skippedFresh += 1;
      continue;
    }

    let outcome;
    try {
      outcome = checkCodeBindingDrift(m.codeBinding, {
        workspaceRoot: opts.workspaceRoot,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[anvil-memory] drift-verify error on ${m.codeBinding.filePath}: ${reason}\n`,
      );
      continue;
    }

    if (outcome.status === 'fresh') {
      result.fresh += 1;
      stampLastVerified(store, m, now, outcome.currentHash);
      continue;
    }

    if (outcome.status === 'drifted') {
      result.drifted += 1;
      result.touchedIds.push(m.id);
      applyDriftPolicy(store, m, driftPolicy, {
        now,
        downweightFactor,
        runId: opts.runId,
        currentHash: outcome.currentHash,
        reason: `code-drift:${m.codeBinding.filePath}`,
      });
      continue;
    }

    // 'missing'
    result.missing += 1;
    result.touchedIds.push(m.id);
    applyDriftPolicy(store, m, missingPolicy, {
      now,
      downweightFactor,
      runId: opts.runId,
      reason: `code-missing:${m.codeBinding.filePath}`,
    });
  }

  return result;
}

interface ApplyDriftPolicyArgs {
  now: string;
  downweightFactor: number;
  runId?: string;
  currentHash?: string;
  reason: string;
}

function applyDriftPolicy(
  store: HybridMemoryStore,
  memory: Memory,
  policy: DriftPolicy,
  args: ApplyDriftPolicyArgs,
): void {
  if (policy === 'invalidate') {
    store.invalidate(memory.id, args.now, args.reason, args.runId);
    return;
  }
  // 'downweight'
  const updated: Memory = {
    ...memory,
    decay: {
      ...memory.decay,
      strength: Math.max(0, Math.round(memory.decay.strength * args.downweightFactor)),
    },
    codeBinding: memory.codeBinding && {
      ...memory.codeBinding,
      lastVerifiedAt: args.now,
    },
  };
  store.add(updated);
}

function stampLastVerified(
  store: HybridMemoryStore,
  memory: Memory,
  now: string,
  currentHash?: string,
): void {
  if (!memory.codeBinding) return;
  const updated: Memory = {
    ...memory,
    codeBinding: {
      ...memory.codeBinding,
      lastVerifiedAt: now,
      structuralHash: currentHash ?? memory.codeBinding.structuralHash,
    },
  };
  store.add(updated);
}
