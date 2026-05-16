/**
 * Synchronous typed emitter — base class for the dashboard services.
 *
 * Emittery is the obvious choice but its listeners are always
 * dispatched on a microtask (it wraps every callback in a promise).
 * That reorders the bridge's legacy `broadcast(...)` call against
 * any synchronous broadcasts emitted by the same handler — see
 * `stop-run` (dashboard-server.ts:2120) where `run-stopped` → active-runs →
 * kill-chain must arrive in that exact order.
 *
 * We don't need async dispatch during Phase 3 migration. SyncEmitter
 * runs every listener in-line during `emit()` so the wire format
 * is identical to today's direct `broadcast(...)` call sites. Phase 4
 * keeps it — socket.io's `io.to(...).emit(...)` is itself sync and
 * the bridge stays sync end-to-end.
 *
 * API mirrors Emittery's `on` / `off` / `onAny` so swapping later (if
 * we ever need async dispatch) is a one-line change.
 */

export type SyncListener<P> = (payload: P) => void;
export type SyncAnyListener = (kind: string, payload: unknown) => void;

// Generic parameter constraint is `object` — TypeScript interface types
// don't satisfy `Record<string, unknown>` (interfaces are open) so a
// looser bound lets services type their event maps as named interfaces.
// The keys are still strings at runtime; we coerce via `String(kind)`.
export class SyncEmitter<EventMap extends object = Record<string, unknown>> {
  private readonly listeners = new Map<keyof EventMap, Set<SyncListener<unknown>>>();
  private readonly anyListeners = new Set<SyncAnyListener>();

  on<K extends keyof EventMap>(kind: K, fn: SyncListener<EventMap[K]>): () => void {
    let set = this.listeners.get(kind);
    if (!set) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    set.add(fn as SyncListener<unknown>);
    return () => this.off(kind, fn);
  }

  off<K extends keyof EventMap>(kind: K, fn: SyncListener<EventMap[K]>): void {
    this.listeners.get(kind)?.delete(fn as SyncListener<unknown>);
  }

  onAny(fn: SyncAnyListener): () => void {
    this.anyListeners.add(fn);
    return () => { this.anyListeners.delete(fn); };
  }

  emit<K extends keyof EventMap>(kind: K, payload: EventMap[K]): void {
    // Per-kind listeners first, then onAny (matches Emittery's order).
    const kindListeners = this.listeners.get(kind);
    if (kindListeners) {
      for (const fn of kindListeners) {
        try { fn(payload); } catch (err) {
          // Listener errors must NEVER break sibling listeners or the
          // calling site. Log and continue.
          console.warn(`[SyncEmitter] listener for ${String(kind)} threw:`, err);
        }
      }
    }
    for (const fn of this.anyListeners) {
      try { fn(String(kind), payload); } catch (err) {
        console.warn(`[SyncEmitter] onAny listener threw on ${String(kind)}:`, err);
      }
    }
  }

  /** Test/debug — current listener counts. */
  listenerStats(): { perKind: Map<string, number>; any: number } {
    const perKind = new Map<string, number>();
    for (const [k, set] of this.listeners.entries()) {
      perKind.set(String(k), set.size);
    }
    return { perKind, any: this.anyListeners.size };
  }
}
