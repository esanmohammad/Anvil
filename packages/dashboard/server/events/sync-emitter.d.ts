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
export declare class SyncEmitter<EventMap extends object = Record<string, unknown>> {
    private readonly listeners;
    private readonly anyListeners;
    on<K extends keyof EventMap>(kind: K, fn: SyncListener<EventMap[K]>): () => void;
    off<K extends keyof EventMap>(kind: K, fn: SyncListener<EventMap[K]>): void;
    onAny(fn: SyncAnyListener): () => void;
    emit<K extends keyof EventMap>(kind: K, payload: EventMap[K]): void;
    /** Test/debug — current listener counts. */
    listenerStats(): {
        perKind: Map<string, number>;
        any: number;
    };
}
//# sourceMappingURL=sync-emitter.d.ts.map