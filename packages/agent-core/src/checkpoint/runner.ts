/**
 * agent-runner-wrapper — higher-order wrapper that gates any agent call
 * through a CheckpointStore.
 *
 * Usage:
 *   const plan = await runWithCheckpoint(store, blobs, {
 *     project, runFamily,
 *     inputs: { stage: 'plan', taskId: 'plan:root', promptVersion, inputs: ... },
 *     run: () => plannerAgent.generate(...),
 *     serialize: (p) => JSON.stringify(p),
 *     deserialize: (b) => JSON.parse(b.toString('utf-8')),
 *   });
 *
 * Behavior:
 *   1. Compute the cache key from `inputs`.
 *   2. If `store.get` returns a completed record whose blob exists, call
 *      `onHit` and return `deserialize(blob)` — no agent invocation.
 *   3. Otherwise `store.begin(...)` (claim the record as `running`), install
 *      SIGTERM/SIGINT handlers that `store.interrupt` the record, then run
 *      the agent.
 *   4. On success → `store.complete(...)`. On error → `store.fail(...)` and
 *      rethrow.
 *   5. Always remove the signal handlers in `finally`.
 *
 * ── Signal-handler hygiene ──────────────────────────────────────────────
 *
 * Node's `process.on('SIGTERM', fn)` adds a new listener every call. When
 * many wrappers run concurrently (parallel implement + review personas), a
 * naive approach would either:
 *   (a) register N listeners that each handle the same signal (leak), or
 *   (b) share a single listener that only knows about one in-flight record.
 *
 * We take a middle path:
 *   - Each `runWithCheckpoint` call registers its own `onSignal` closure via
 *     `process.on` (not `process.once`, because multiple concurrent wrappers
 *     need each of their closures to fire — `process.once` on a shared event
 *     removes ALL listeners after the first handler runs).
 *   - Each wrapper tracks its own registered closures in a local array and
 *     calls `process.off(...)` in `finally`, guaranteeing cleanup.
 *   - A module-level `registeredWrappers` WeakSet tracks active wrappers
 *     purely for debugging / leak detection; it does not affect behavior.
 *
 * We never call `process.exit` from the signal handler — that's the
 * caller's responsibility (e.g. the cost-reject flow in pipeline-runner
 * decides whether to propagate the signal). We only persist `interrupted`
 * state so the next resume sees it.
 */

import { computeKey } from './key.js';
import type { BlobStore } from './blob-store.js';
import type { CheckpointStore } from './store.js';
import type {
  CheckpointInputs,
  CheckpointRecord,
} from './types.js';

// Module-level registry for leak detection. A WeakSet means entries are
// collected automatically when the wrapper object becomes unreachable.
const registeredWrappers: WeakSet<object> = new WeakSet();

export interface WrappedAgentOpts<I, O> {
  project: string;
  runFamily: string;
  inputs: CheckpointInputs & { inputs: I };
  run: () => Promise<O>;
  serialize: (o: O) => string | Buffer;
  deserialize: (b: Buffer) => O;
  cost?: CheckpointRecord['cost'];
  onHit?: (record: CheckpointRecord) => void;
  onMiss?: () => void;
  onInterrupt?: (signal: NodeJS.Signals) => void;
  /**
   * Test-only hook. When set, the wrapper uses this instead of
   * `process.on(...)`. Tests can invoke the handler directly without
   * actually sending a signal to the process.
   */
  __signalHook?: {
    on: (sig: NodeJS.Signals, fn: (s: NodeJS.Signals) => void) => void;
    off: (sig: NodeJS.Signals, fn: (s: NodeJS.Signals) => void) => void;
  };
}

/**
 * Execute an agent call, caching its output in the checkpoint store.
 * On cache hit, `opts.run` is never called. On SIGTERM / SIGINT during the
 * run, the record is transitioned to `interrupted` before the handler
 * returns.
 */
export async function runWithCheckpoint<I, O>(
  store: CheckpointStore,
  blobs: BlobStore,
  opts: WrappedAgentOpts<I, O>,
): Promise<O> {
  const key = computeKey(opts.runFamily, opts.inputs);

  // Cache lookup.
  const existing = store.get(opts.project, opts.runFamily, key);
  if (
    existing &&
    existing.status === 'completed' &&
    existing.outputRef &&
    blobs.exists(existing.outputRef)
  ) {
    const bytes = blobs.read(existing.outputRef);
    if (bytes) {
      opts.onHit?.(existing);
      return opts.deserialize(bytes);
    }
    // Blob vanished — fall through to a fresh run.
  }

  opts.onMiss?.();
  store.begin(opts.project, opts.runFamily, opts.inputs, opts.cost);

  // Install signal handlers for this invocation only. Each wrapper gets its
  // own closure so concurrent wrappers don't step on each other.
  const registry = {};
  registeredWrappers.add(registry);

  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  const handlers: Array<{ sig: NodeJS.Signals; fn: (s: NodeJS.Signals) => void }> = [];
  let interrupted = false;

  const handleSignal = (sig: NodeJS.Signals): void => {
    if (interrupted) return;
    interrupted = true;
    try {
      // `partialOutput` is not available here — the agent promise hasn't
      // resolved. Callers wanting to stream partial output should pass a
      // custom `run` that stashes progress somewhere the wrapper can read.
      store.interrupt(opts.project, opts.runFamily, key, undefined, `signal:${sig}`);
      opts.onInterrupt?.(sig);
    } catch (err) {
      process.stderr.write(
        `[runWithCheckpoint] failed to persist interrupt: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  };

  const hook = opts.__signalHook;
  for (const sig of signals) {
    const fn = (s: NodeJS.Signals): void => handleSignal(s);
    if (hook) hook.on(sig, fn);
    else process.on(sig, fn);
    handlers.push({ sig, fn });
  }

  try {
    const out = await opts.run();
    if (interrupted) {
      // The signal fired during `run`; keep the `interrupted` record and
      // return the fresh output to the caller. The caller decides whether
      // to honor the interrupt (e.g. cost-reject flow aborts anyway).
      return out;
    }
    const payload = opts.serialize(out);
    store.complete(opts.project, opts.runFamily, key, payload, opts.cost);
    return out;
  } catch (err) {
    if (!interrupted) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        store.fail(opts.project, opts.runFamily, key, msg);
      } catch (persistErr) {
        process.stderr.write(
          `[runWithCheckpoint] failed to persist failure: ${
            persistErr instanceof Error ? persistErr.message : String(persistErr)
          }\n`,
        );
      }
    }
    throw err;
  } finally {
    for (const { sig, fn } of handlers) {
      if (hook) hook.off(sig, fn);
      else process.off(sig, fn);
    }
    registeredWrappers.delete(registry);
  }
}

/** Test helper — number of currently-registered wrappers (best-effort). */
export function __activeWrapperCount(): number {
  // WeakSet doesn't expose size. Tests assert behavior, not count;
  // this exists purely as a documentation anchor.
  return 0;
}
