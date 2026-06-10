/**
 * Effect runtime — implements `ctx.effect` / `ctx.now` / `ctx.uuid` /
 * `ctx.random` / `ctx.sleep` / `ctx.waitForSignal` against a
 * `DurableStore`.
 *
 * Each step body sees an `EffectRuntime` constructed once per
 * `step.run(ctx)` invocation. The runtime owns:
 *   - the per-step monotonic effect counter (`idx`)
 *   - the cursor over already-recorded effect events (replay frontier)
 *   - the `DurableStore` handle
 *
 * On every `ctx.effect(name, fn)` call:
 *   1. Increment `idx`.
 *   2. Look up the next un-replayed effect for this step in the log.
 *   3. If the next effect has the same `(name, idx)` and an
 *      `effect:completed` row → return the recorded result.
 *   4. If `(name, idx)` matches but only `effect:started` is in the
 *      log → the engine crashed mid-effect; re-run `fn()` and
 *      replace.
 *   5. If `(name, idx)` doesn't match the next replayed event →
 *      `DeterminismViolationError`.
 *   6. If we've passed the replay frontier → live execution: write
 *      `effect:started`, run `fn()`, write `effect:completed` with
 *      result.
 *
 * The same logic governs `ctx.now() / uuid / random / sleep`. Each
 * is recorded as a synthetic effect with a stable name
 * (`__anvil_now`, `__anvil_uuid`, `__anvil_random`, `__anvil_sleep`).
 */

import { randomUUID } from 'node:crypto';

import type { DurableStore } from './store.js';
import {
  DeterminismViolationError,
  EffectResultNotSerialisableError,
  type EffectEventPair,
} from './types.js';
import type { EffectOptions, StepRetryPolicy } from '../types.js';

const SYS_NOW = '__anvil_now';
const SYS_UUID = '__anvil_uuid';
const SYS_RANDOM = '__anvil_random';
const SYS_SLEEP = '__anvil_sleep';

export interface EffectRuntimeDeps {
  store: DurableStore;
  runId: string;
  stepId: string;
  /** Pre-loaded effect events for this step. Populated on construction. */
  recordedEffects: EffectEventPair[];
  /**
   * Optional predicate restricting which recordedEffects this runtime
   * will replay. Used by per-repo fanout: the walker constructs one
   * EffectRuntime per repo iteration with the *same* events array
   * (all repos share `stepId`), but each runtime needs to see only
   * its own repo's effects to keep the per-step `idx` counter in
   * sync. Default: pass-all.
   *
   * Phase F6 — fixes a per-repo replay bug where parallel runtimes
   * cross-pollinated each other's recorded effect cursor.
   */
  effectFilter?: (pair: EffectEventPair) => boolean;
  /** Real wall clock — used to derive a timestamp for live effects. */
  realNow?: () => number;
  /** Test seam — replace `setTimeout`. */
  realSleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export class EffectRuntime {
  private idx = 0;
  /** Position in `filtered` we are about to replay (inclusive). */
  private cursor = 0;
  /** Filtered view of recordedEffects, scoped via deps.effectFilter. */
  private readonly filtered: EffectEventPair[];
  private readonly realNow: () => number;
  private readonly realSleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: EffectRuntimeDeps) {
    this.realNow = deps.realNow ?? Date.now;
    this.realSleep = deps.realSleep ?? defaultSleep;
    this.filtered = deps.effectFilter
      ? deps.recordedEffects.filter(deps.effectFilter)
      : deps.recordedEffects;
  }

  async effect<T>(name: string, fn: () => Promise<T>, opts: EffectOptions = {}): Promise<T> {
    return this.runEffect(name, fn, opts);
  }

  /**
   * H3 replay-skip seam (used by the turn-recorder via the structural
   * `EffectRuntimeLike.peekRecorded`). Returns the recorded
   * `effect:completed` payload for `name` within this step, or
   * undefined if no completed row exists yet. PURE READ: it does NOT
   * touch `idx` or `cursor`, so the normal (name, idx) replay sequence
   * is unaffected — the caller still issues the real `effect()` calls
   * in order to advance the cursor.
   *
   * Scans the same `filtered` view the replay path uses, so per-repo
   * fanout (effectFilter) stays correctly scoped. Matches the FIRST
   * completed pair for the name (effect keys like `turn:N:assistant-end`
   * are unique per step, so first == only).
   */
  peekRecorded<T = unknown>(name: string): T | undefined {
    for (const pair of this.filtered) {
      if (pair.started.effectKey === name && pair.completed) {
        return pair.completed.payload as T;
      }
    }
    return undefined;
  }

  async now(): Promise<number> {
    return this.runEffect(SYS_NOW, async () => this.realNow(), { smallResult: true });
  }

  async uuid(): Promise<string> {
    return this.runEffect(SYS_UUID, async () => randomUUID(), { smallResult: true });
  }

  async random(): Promise<number> {
    return this.runEffect(SYS_RANDOM, async () => Math.random(), { smallResult: true });
  }

  async sleep(ms: number): Promise<void> {
    await this.runEffect(
      SYS_SLEEP,
      async () => {
        await this.realSleep(ms);
        return null;
      },
      { smallResult: true },
    );
  }

  async waitForSignal<T = unknown>(channel: string): Promise<T> {
    // Signals are NOT subject to the effect counter — they're always
    // either present in the log (replay) or pulled from the durable
    // signal queue (live). Recording a `signal:received` event marks
    // the consumption point.
    const idx = this.idx++;
    if (this.cursor < this.filtered.length) {
      const next = this.filtered[this.cursor];
      const expectedKey = `__signal:${channel}`;
      if (next.started.effectKey === expectedKey && next.started.effectIdx === idx) {
        this.cursor++;
        if (next.completed) {
          return next.completed.payload as T;
        }
        // Crashed mid-wait — fall through to live wait + record.
      } else {
        throw new DeterminismViolationError(
          this.deps.runId,
          this.deps.stepId,
          'effect-name-mismatch',
          `expected ${next.started.effectKey} idx=${next.started.effectIdx}; got __signal:${channel} idx=${idx}`,
        );
      }
    }

    // Live: poll the signal queue. Signals are durable; if one was
    // already enqueued before we started waiting, we consume
    // immediately.
    await this.deps.store.appendEvent({
      runId: this.deps.runId,
      kind: 'effect:started',
      stepId: this.deps.stepId,
      effectKey: `__signal:${channel}`,
      effectIdx: idx,
      payload: { channel },
    });
    while (true) {
      if (this.deps.signal?.aborted) {
        // finding 4 — cancellation breaks the poll. The dashboard's
        // dual-path race resolves its in-process resolver with '' on
        // cancel (PipelineRunner.cancel drains stageInputResolvers), so
        // this rejection lands on the already-settled losing branch and
        // is swallowed by `deferToResolver`. Tag the error so callers can
        // match on a property instead of the message text.
        const err = new Error('Run cancelled while waiting for signal');
        (err as Error & { __anvilSignalCancelled?: boolean }).__anvilSignalCancelled = true;
        throw err;
      }
      // finding 5 — atomic consume + effect:completed receipt in one
      // transaction. Closes the crash-between-consume-and-record window
      // that consumed the signal, failed to record it, and then hung the
      // wait forever on replay (effect:started with no completion, queue
      // already empty).
      const payload = await this.deps.store.consumeSignalAndRecord(this.deps.runId, channel, {
        stepId: this.deps.stepId,
        effectKey: `__signal:${channel}`,
        effectIdx: idx,
      });
      if (payload !== null) {
        return payload as T;
      }
      await this.realSleep(250);
    }
  }

  private async runEffect<T>(
    name: string,
    fn: () => Promise<T>,
    opts: EffectOptions,
  ): Promise<T> {
    const idx = this.idx++;

    // Replay path — does the log already have this call?
    if (this.cursor < this.filtered.length) {
      const next = this.filtered[this.cursor];
      if (next.started.effectIdx !== idx) {
        throw new DeterminismViolationError(
          this.deps.runId,
          this.deps.stepId,
          'effect-idx-mismatch',
          `expected idx=${next.started.effectIdx}; got idx=${idx}`,
        );
      }
      if (next.started.effectKey !== name) {
        throw new DeterminismViolationError(
          this.deps.runId,
          this.deps.stepId,
          'effect-name-mismatch',
          `expected effect "${next.started.effectKey}" at idx=${idx}; got "${name}"`,
        );
      }
      if (opts.idempotencyKey !== undefined) {
        const recordedKey = (next.started.payload as { idempotencyKey?: string } | null)?.idempotencyKey;
        if (recordedKey !== undefined && recordedKey !== opts.idempotencyKey) {
          throw new DeterminismViolationError(
            this.deps.runId,
            this.deps.stepId,
            'effect-input-hash-mismatch',
            `effect "${name}" idx=${idx} replay sees different idempotencyKey (${recordedKey} vs ${opts.idempotencyKey})`,
          );
        }
      }
      this.cursor++;

      if (next.completed) {
        return next.completed.payload as T;
      }
      if (next.failed) {
        // Phase G2: reconstruct the original error shape so chain-
        // fallback / retry policies behave correctly on replay.
        // ReplayedEffectError stays the *type* (so callers that want
        // to detect "this is a replay" still can via instanceof) but
        // we copy `name`, `retryable`, `status`, `cause` from the
        // recorded payload so duck-typed checks (e.g. the canonical
        // `err.name === 'UpstreamError' && err.retryable === true`
        // chain-fallback predicate) still work.
        throw reconstructErrorFromPayload(next.failed.payload);
      }
      // Started but never completed — crashed mid-effect, fall through
      // to live execution. Note: we do NOT re-record `effect:started`
      // because one already exists; we just record `effect:completed`
      // (or `effect:failed`) on the same `(name, idx)` tuple.
      return this.executeAndComplete(name, idx, fn, opts, /* alreadyStarted */ true);
    }

    // Past the replay frontier — pure live execution.
    return this.executeAndComplete(name, idx, fn, opts, /* alreadyStarted */ false);
  }

  private async executeAndComplete<T>(
    name: string,
    idx: number,
    fn: () => Promise<T>,
    opts: EffectOptions,
    alreadyStarted: boolean,
  ): Promise<T> {
    if (!alreadyStarted) {
      await this.deps.store.appendEvent({
        runId: this.deps.runId,
        kind: 'effect:started',
        stepId: this.deps.stepId,
        effectKey: name,
        effectIdx: idx,
        payload: {
          idempotencyKey: opts.idempotencyKey,
          startedAt: new Date(this.realNow()).toISOString(),
        },
      });
    }

    let result: T;
    try {
      result = await this.runWithRetry(fn, opts.retry);
    } catch (err) {
      // Phase G2: capture the full error shape so chain-fallback +
      // retry policies behave correctly on replay. Without
      // `name`/`retryable`/`status`, a previously-burned upstream
      // model would replay as a generic ReplayedEffectError and the
      // walker would treat it as terminal — defeating the whole
      // chain-fallback semantic.
      const errorPayload = serializeErrorForReplay(err);
      await this.deps.store.appendEvent({
        runId: this.deps.runId,
        kind: 'effect:failed',
        stepId: this.deps.stepId,
        effectKey: name,
        effectIdx: idx,
        payload: { ...errorPayload, completedAt: new Date(this.realNow()).toISOString() },
      });
      throw err;
    }

    let serialised: unknown;
    try {
      serialised = JSON.parse(JSON.stringify(result ?? null));
    } catch (err) {
      throw new EffectResultNotSerialisableError(name, err);
    }
    await this.deps.store.appendEvent({
      runId: this.deps.runId,
      kind: 'effect:completed',
      stepId: this.deps.stepId,
      effectKey: name,
      effectIdx: idx,
      payload: serialised,
    });
    return result;
  }

  private async runWithRetry<T>(fn: () => Promise<T>, retry: StepRetryPolicy | undefined): Promise<T> {
    if (!retry || retry.attempts <= 0) return fn();
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= retry.attempts) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        attempt += 1;
        const shouldRetry = retry.retryOn ? retry.retryOn(err) : true;
        if (!shouldRetry || attempt > retry.attempts) throw err;
        await this.realSleep(computeBackoff(retry, attempt));
      }
    }
    throw lastErr;
  }
}

/**
 * `ReplayedEffectError` — thrown on replay when the recorded effect
 * was a failure. Carries the same duck-typed properties the original
 * error had (`retryable`, `status`, `name`, `cause`) so callers that
 * pattern-match on these (chain-fallback's
 * `err.name === 'UpstreamError' && err.retryable === true` predicate,
 * for example) keep working on replay. Phase G2.
 */
export class ReplayedEffectError extends Error {
  // Index-signature so duck-typed checks like
  // `(err as { retryable?: boolean }).retryable` resolve at runtime.
  [key: string]: unknown;
  constructor(message: string, props?: Record<string, unknown>) {
    super(`[replayed effect failure] ${message}`);
    this.name = 'ReplayedEffectError';
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'message' || k === 'stack') continue;
        // Preserve `name` if recorded — overrides the default
        // 'ReplayedEffectError' so `err.name === 'UpstreamError'`
        // checks pass on replay.
        (this as Record<string, unknown>)[k] = v;
      }
    }
  }
}

/**
 * Capture the duck-typed surface of an Error for the durable log.
 * Includes the standard message/name/stack plus any enumerable
 * own properties (covers UpstreamError's `retryable` + `status`
 * shape used by the chain-fallback predicate).
 */
function serializeErrorForReplay(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }
  const out: Record<string, unknown> = {
    message: err.message,
    name: err.name,
  };
  // Capture enumerable own properties — e.g. UpstreamError's
  // `retryable: true`, `status: 503`, `cause`.
  for (const k of Object.keys(err)) {
    const v = (err as unknown as Record<string, unknown>)[k];
    // Skip non-serialisable shapes.
    if (typeof v === 'function') continue;
    try {
      JSON.stringify(v);
      out[k] = v;
    } catch {
      // Shape isn't JSON-clean; record a string fallback.
      out[k] = String(v);
    }
  }
  return out;
}

function reconstructErrorFromPayload(payload: unknown): ReplayedEffectError {
  if (!payload || typeof payload !== 'object') {
    return new ReplayedEffectError('effect failed');
  }
  const obj = payload as Record<string, unknown>;
  const message = typeof obj.message === 'string' ? obj.message : 'effect failed';
  return new ReplayedEffectError(message, obj);
}

/**
 * True when an effect key belongs to a given scope token, matched at
 * delimited boundaries (start/end or `-`/`:`). System effects
 * (`__anvil_*`, `__signal:*`) always match (they're scope-agnostic).
 *
 * Moved here from pipeline.ts so per-repo / per-task scoped runtimes
 * (H3 turn-level resume) and the walker's own fanout share ONE
 * definition. Re-exported by pipeline.ts for back-compat.
 */
export function effectKeyMatchesScope(key: string | null | undefined, scope: string): boolean {
  if (!key) return false;
  if (key.startsWith('__anvil_')) return true;
  if (key.startsWith('__signal:')) return true;
  let idx = key.indexOf(scope);
  while (idx >= 0) {
    const before = idx === 0 ? '' : key[idx - 1];
    const afterIdx = idx + scope.length;
    const after = afterIdx >= key.length ? '' : key[afterIdx];
    const isBoundary = (c: string) => c === '' || c === '-' || c === ':';
    if (isBoundary(before) && isBoundary(after)) return true;
    idx = key.indexOf(scope, idx + 1);
  }
  return false;
}

/**
 * H3 per-repo / per-task isolation (ADR §2.4). Build a fresh
 * `EffectRuntime` for ONE parallel unit (a repo, or a repo+task) within a
 * step that fans out concurrently. Each unit gets its own monotonic `idx`
 * sequence over ONLY the effects whose key carries ALL `scopeTokens`, so
 * racing units don't share an idx counter (which would make replay
 * non-deterministic). Reconstructed identically on replay (same
 * readEffectEvents + same filter) → deterministic per-unit replay.
 *
 * The caller MUST name every effect for this unit with the scope tokens
 * as an EXACT joined PREFIX (e.g. tokens [`service-a`] → keys start with
 * `service-a:`; tokens [`api`, `t3`] → keys start with `api:t3:`). The
 * filter matches by strict prefix — NOT the boundary-substring
 * `effectKeyMatchesScope` used by the walker's own fanout. Strict prefix
 * is required here so prefix-related repo names don't collide: scope
 * `api` must NOT admit `api-gateway:...` (`'api-gateway:'` does not start
 * with `'api:'`). This mirrors the turn-recorder's `effectPrefix`
 * (`scopeTokens.join(':') + ':'`) and `turn-resume`'s `matchTurn`, so all
 * three layers agree. With no scope tokens this is a plain runtime over
 * the whole step (single-stage path).
 */
export async function createScopedEffectRuntime(opts: {
  store: DurableStore;
  runId: string;
  stepId: string;
  /** Scope tokens forming the exact effect-key prefix (e.g. [repo] or [repo, taskId]). */
  scopeTokens?: readonly string[];
  signal?: AbortSignal;
}): Promise<EffectRuntime> {
  const recorded = await opts.store.readEffectEvents(opts.runId, opts.stepId);
  const tokens = opts.scopeTokens ?? [];
  const prefix = tokens.length ? `${tokens.join(':')}:` : '';
  return new EffectRuntime({
    store: opts.store,
    runId: opts.runId,
    stepId: opts.stepId,
    recordedEffects: recorded,
    ...(prefix
      ? { effectFilter: (pair) => (pair.started.effectKey ?? '').startsWith(prefix) }
      : {}),
    signal: opts.signal,
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function computeBackoff(policy: StepRetryPolicy, attempt: number): number {
  const base = policy.baseMs;
  let raw: number;
  switch (policy.backoff) {
    case 'exponential':
      raw = base * 2 ** (attempt - 1);
      break;
    case 'linear':
      raw = base * attempt;
      break;
    case 'constant':
    default:
      raw = base;
  }
  return policy.maxMs ? Math.min(raw, policy.maxMs) : raw;
}
