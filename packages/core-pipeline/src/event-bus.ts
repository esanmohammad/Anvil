/**
 * In-process EventBus — Phase 2 mature impl.
 *
 * Properties:
 *   - `on(hook, listener, opts?)` — returns unsubscribe handle; supports priority
 *   - `once(hook, listener, opts?)` — auto-unsubscribes after first emit
 *   - `off(hook, listener)` — explicit removal
 *   - `emit(event)` — awaits all listeners (back-pressure honored). Listener
 *     errors are isolated: every listener runs even if one throws; emit
 *     rejects with an AggregateError after all complete.
 *   - `emitFireAndForget(event)` — sync return; listener errors swallowed.
 *
 * Listener invocation order: descending priority, then registration order.
 * Default priority = 0. Higher priority runs first. Examples:
 *   - audit-log hook   → priority 100 (must persist before learners read it)
 *   - learners hook    → priority 50
 *   - dashboard state  → priority 10
 */

import type {
  BusRequestListener,
  BusRequestOptions,
  EventBus,
  EventListener,
  EventListenerOptions,
  PipelineEvent,
  StepHookPoint,
} from './types.js';
import { BusRequestRegistry } from './bus-request.js';

interface Entry {
  listener: EventListener;
  priority: number;
  /** Monotonic seq for FIFO tie-break at equal priority. */
  seq: number;
}

export class InMemoryEventBus implements EventBus {
  private readonly entries = new Map<StepHookPoint, Entry[]>();
  private seqCounter = 0;
  private readonly requests = new BusRequestRegistry();

  on(hook: StepHookPoint, listener: EventListener, opts: EventListenerOptions = {}): () => void {
    const arr = this.entries.get(hook) ?? [];
    arr.push({ listener, priority: opts.priority ?? 0, seq: this.seqCounter++ });
    arr.sort(comparePriority);
    this.entries.set(hook, arr);
    return () => this.off(hook, listener);
  }

  once(hook: StepHookPoint, listener: EventListener, opts: EventListenerOptions = {}): () => void {
    const wrapped: EventListener = async (e) => {
      this.off(hook, wrapped);
      await listener(e);
    };
    return this.on(hook, wrapped, opts);
  }

  off(hook: StepHookPoint, listener: EventListener): void {
    const arr = this.entries.get(hook);
    if (!arr) return;
    const idx = arr.findIndex((entry) => entry.listener === listener);
    if (idx >= 0) arr.splice(idx, 1);
  }

  async emit(event: PipelineEvent): Promise<void> {
    const arr = this.entries.get(event.hook);
    if (!arr || arr.length === 0) return;
    const snapshot = arr.slice();
    const errors: unknown[] = [];
    for (const { listener } of snapshot) {
      try {
        await listener(event);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `EventBus: ${errors.length} listener(s) failed for ${event.hook}`);
    }
  }

  emitFireAndForget(event: PipelineEvent): void {
    const arr = this.entries.get(event.hook);
    if (!arr || arr.length === 0) return;
    for (const { listener } of arr.slice()) {
      try {
        const ret = listener(event);
        if (ret && typeof (ret as Promise<void>).then === 'function') {
          (ret as Promise<void>).catch(() => {
            /* swallow — fire-and-forget */
          });
        }
      } catch {
        /* swallow — fire-and-forget */
      }
    }
  }

  request<P, R>(channel: string, payload: P, opts?: BusRequestOptions): Promise<R> {
    return this.requests.request<P, R>(channel, payload, opts);
  }

  respond<R>(channel: string, requestId: string, response: R): void {
    this.requests.respond<R>(channel, requestId, response);
  }

  onRequest<P>(channel: string, listener: BusRequestListener<P>): () => void {
    return this.requests.onRequest<P>(channel, listener);
  }

  /** Test-only: number of pending requests waiting for a respond(). */
  pendingRequestCount(): number {
    return this.requests.pendingCount();
  }
}

function comparePriority(a: Entry, b: Entry): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.seq - b.seq;
}
