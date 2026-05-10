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
  /** Real wall clock — used to derive a timestamp for live effects. */
  realNow?: () => number;
  /** Test seam — replace `setTimeout`. */
  realSleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export class EffectRuntime {
  private idx = 0;
  /** Position in `recordedEffects` we are about to replay (inclusive). */
  private cursor = 0;
  private readonly realNow: () => number;
  private readonly realSleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: EffectRuntimeDeps) {
    this.realNow = deps.realNow ?? Date.now;
    this.realSleep = deps.realSleep ?? defaultSleep;
  }

  async effect<T>(name: string, fn: () => Promise<T>, opts: EffectOptions = {}): Promise<T> {
    return this.runEffect(name, fn, opts);
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
    if (this.cursor < this.deps.recordedEffects.length) {
      const next = this.deps.recordedEffects[this.cursor];
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
        throw new Error('Run cancelled while waiting for signal');
      }
      const payload = await this.deps.store.consumeSignal(this.deps.runId, channel);
      if (payload !== null) {
        await this.deps.store.appendEvent({
          runId: this.deps.runId,
          kind: 'effect:completed',
          stepId: this.deps.stepId,
          effectKey: `__signal:${channel}`,
          effectIdx: idx,
          payload,
        });
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
    if (this.cursor < this.deps.recordedEffects.length) {
      const next = this.deps.recordedEffects[this.cursor];
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
        const err = (next.failed.payload as { message?: string } | null)?.message ?? 'effect failed';
        throw new ReplayedEffectError(err);
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
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.store.appendEvent({
        runId: this.deps.runId,
        kind: 'effect:failed',
        stepId: this.deps.stepId,
        effectKey: name,
        effectIdx: idx,
        payload: { message, completedAt: new Date(this.realNow()).toISOString() },
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

export class ReplayedEffectError extends Error {
  constructor(message: string) {
    super(`[replayed effect failure] ${message}`);
    this.name = 'ReplayedEffectError';
  }
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
