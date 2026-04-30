/**
 * EventBus request/response primitive — Phase 1 of core-pipeline
 * consolidation.
 *
 * Adds a typed `request()` / `respond()` / `onRequest()` channel layer to
 * `InMemoryEventBus`. Used by human-in-the-loop steps:
 *   - clarify Q&A (step issues `request('clarify:answers', ...)`, cli/dashboard
 *     wires a responder)
 *   - approval gate (step issues `request('approval:gate', stageIndex)`,
 *     cli/dashboard responds 'approved' | 'rejected')
 *
 * Coexists with the lifecycle event surface (on/off/emit) — requests use
 * a separate registry keyed by channel string, so adding new request
 * channels does not pollute the closed `StepHookPoint` union.
 */

import type {
  BusRequest,
  BusRequestListener,
  BusRequestOptions,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — matches legacy waitForApproval

export class BusRequestTimeoutError extends Error {
  override readonly name = 'BusRequestTimeoutError';
  constructor(public readonly channel: string, public readonly timeoutMs: number) {
    super(`Bus request on channel "${channel}" timed out after ${timeoutMs}ms`);
  }
}

export class BusRequestAbortedError extends Error {
  override readonly name = 'BusRequestAbortedError';
  constructor(public readonly channel: string) {
    super(`Bus request on channel "${channel}" was aborted`);
  }
}

interface PendingEntry {
  channel: string;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  signalCleanup: (() => void) | undefined;
}

/**
 * Stateful request/response registry. `InMemoryEventBus` composes one of
 * these to satisfy the request/response part of the `EventBus` contract.
 * Kept separate so the lifecycle bus stays focused on pipeline events.
 */
export class BusRequestRegistry {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly listeners = new Map<string, BusRequestListener<unknown>[]>();
  private idCounter = 0;

  request<P, R>(channel: string, payload: P, opts: BusRequestOptions = {}): Promise<R> {
    const requestId = this.nextId();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<R>((resolve, reject) => {
      const entry: PendingEntry = {
        channel,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: undefined,
        signalCleanup: undefined,
      };

      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        entry.timer = setTimeout(() => {
          this.pending.delete(requestId);
          entry.signalCleanup?.();
          reject(new BusRequestTimeoutError(channel, timeoutMs));
        }, timeoutMs);
      }

      if (opts.signal) {
        if (opts.signal.aborted) {
          if (entry.timer) clearTimeout(entry.timer);
          reject(new BusRequestAbortedError(channel));
          return;
        }
        const onAbort = (): void => {
          this.pending.delete(requestId);
          if (entry.timer) clearTimeout(entry.timer);
          reject(new BusRequestAbortedError(channel));
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
        entry.signalCleanup = (): void => {
          opts.signal?.removeEventListener('abort', onAbort);
        };
      }

      this.pending.set(requestId, entry);

      // Notify responders synchronously after registering the entry, so
      // a responder that calls `respond()` synchronously inside its
      // listener resolves the promise correctly.
      const listeners = this.listeners.get(channel);
      if (!listeners || listeners.length === 0) {
        // No responder; let the timeout fire (or the caller abort).
        return;
      }
      const req: BusRequest<P> = { requestId, payload };
      for (const listener of listeners.slice()) {
        try {
          const ret = listener(req);
          if (ret && typeof (ret as Promise<void>).then === 'function') {
            (ret as Promise<void>).catch(() => {
              /* swallow — a responder error doesn't reject the request;
                 the request times out if no respond() comes through */
            });
          }
        } catch {
          /* same as above */
        }
      }
    });
  }

  respond<R>(channel: string, requestId: string, response: R): void {
    const entry = this.pending.get(requestId);
    if (!entry) return; // Late response or unknown id; silently drop.
    if (entry.channel !== channel) {
      // Channel mismatch — protect against cross-channel ID collisions.
      return;
    }
    this.pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.signalCleanup?.();
    entry.resolve(response);
  }

  onRequest<P>(channel: string, listener: BusRequestListener<P>): () => void {
    const arr = this.listeners.get(channel) ?? [];
    arr.push(listener as BusRequestListener<unknown>);
    this.listeners.set(channel, arr);
    return () => {
      const current = this.listeners.get(channel);
      if (!current) return;
      const idx = current.findIndex((l) => l === listener);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  /** Test/inspection helper: number of pending requests. */
  pendingCount(): number {
    return this.pending.size;
  }

  private nextId(): string {
    this.idCounter += 1;
    return `req-${Date.now().toString(36)}-${this.idCounter}`;
  }
}
