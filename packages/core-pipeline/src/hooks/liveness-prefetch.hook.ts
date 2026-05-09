/**
 * Liveness prefetch hook — runs a caller-supplied `probe()` once on
 * `pipeline:started` so the chain walker has fresh provider liveness
 * data before the first stage spawns.
 *
 * Why a hook (and not an inline call from the runner): Phase A6 of the
 * dashboard pipeline-consolidation. Both cli + dashboard need the same
 * "warm caches before stage 0" behavior, but only one of them owns the
 * provider-liveness module today. The hook keeps `core-pipeline` free
 * of agent-core imports — callers pass the probe.
 *
 * The probe is fire-and-forget by default: failures are caught and
 * surfaced via `onError`, never cause the pipeline to fail. If a caller
 * wants to BLOCK pipeline:started until the probe completes, set
 * `await: true` — the listener returns the probe's promise so
 * `bus.emit('pipeline:started', ...)` awaits it.
 */

import type { EventBus, EventListener, PipelineEvent } from '../types.js';

export interface LivenessPrefetchHookOptions {
  /**
   * Caller-injected probe. Typically wraps
   * `prefetchProviderLiveness()` from agent-core. Must be idempotent
   * since restart / rewind flows may re-fire `pipeline:started`.
   */
  probe: () => Promise<void> | void;
  /**
   * If true, `bus.emit('pipeline:started', ...)` awaits the probe
   * before returning. Use only when callers genuinely need the cache
   * warm before stage 0 starts. Default false (fire-and-forget).
   */
  await?: boolean;
  /** Override priority. Default 95 (just below audit=100). */
  priority?: number;
  /** Called when the probe throws / rejects. Defaults to swallow. */
  onError?: (err: unknown) => void;
}

export interface LivenessPrefetchHookHandle {
  unsubscribe: () => void;
  /** True once the probe has completed (success or failure). */
  readonly didProbe: boolean;
  /** Most recent probe error, if any. */
  readonly lastError: unknown;
}

export function attachLivenessPrefetchHook(
  bus: EventBus,
  opts: LivenessPrefetchHookOptions,
): LivenessPrefetchHookHandle {
  const priority = opts.priority ?? 95;
  let didProbe = false;
  let lastError: unknown;

  const runProbe = async (): Promise<void> => {
    try {
      await opts.probe();
    } catch (err) {
      lastError = err;
      opts.onError?.(err);
    } finally {
      didProbe = true;
    }
  };

  const listener: EventListener = (event: PipelineEvent) => {
    if (event.hook !== 'pipeline:started') return undefined;
    if (didProbe) return undefined; // idempotent across rewind/restart re-fires
    if (opts.await) {
      return runProbe();
    }
    void runProbe();
    return undefined;
  };

  const off = bus.on('pipeline:started', listener, { priority });
  return {
    unsubscribe: off,
    get didProbe() { return didProbe; },
    get lastError() { return lastError; },
  };
}
