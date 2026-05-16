/**
 * Service → legacy-broadcast bridge.
 *
 * During Phase 3 migration tranches, services emit typed events but the
 * frontend still consumes the legacy `{type,payload}` wire shape. This
 * bridge subscribes to every service's `onAny` and translates each
 * typed emission back into the legacy shape that `broadcast(...)` understands.
 *
 * After Phase 4 lands socket.io rooms, this bridge is replaced by
 * `bridgeServicesToRooms` (which fans events to `io.to(rooms).emit`)
 * and the legacy translator is deleted.
 *
 * Two side-effects per emit:
 *   1. `broadcast(legacy)` — keeps today's wire format alive during migration.
 *   2. `replay.append(typed)` — populates the ring buffer for Phase 4
 *      reconnect-with-`since` backfill. Even though clients can't
 *      subscribe to topics yet (Phase 4 work), the buffer fills correctly
 *      from day one so the cutover is data-ready.
 *
 * Translation table — kept exhaustive via `ts-pattern.match(...).exhaustive()`.
 * Missing a kind is a compile-time error.
 */
import type { DashboardEvent } from './types.js';
import type { EventReplay } from './replay.js';
import type { DashboardServices } from '../services/index.js';
/**
 * Legacy wire shape — what the WS frontend currently consumes.
 * Identical to `ServerMessage` in dashboard-server.ts but redefined here
 * so this module doesn't import the world.
 */
export interface LegacyMessage {
    type: string;
    payload: unknown;
}
export interface BridgeOpts {
    services: DashboardServices;
    broadcast: (msg: LegacyMessage) => void;
    replay: EventReplay;
    /** Test seam — clock used for envelope ids. Defaults to `Date.now`. */
    now?: () => number;
}
/**
 * Translate a typed event into the dashboard's legacy `{type,payload}`
 * wire shape. Returns `null` if the typed event is purely internal and
 * shouldn't fan out to clients during migration.
 *
 * Exhaustive on `DashboardEvent['kind']` — adding a new kind without
 * a case here is a compile error.
 *
 * Takes the full envelope (not just kind+payload) so ts-pattern sees a
 * proper `DashboardEvent` discriminated union and narrows correctly
 * across 40+ kinds. The caller in `attachLegacyBridge` constructs the
 * envelope once and passes it both here and to `replay.append`.
 */
export declare function toLegacyWire(ev: DashboardEvent): LegacyMessage | null;
/**
 * Attach the bridge — subscribes to every service's `onAny` and side-effects:
 *   - calls `broadcast(legacy)` so today's frontend sees the same wire.
 *   - calls `replay.append(typed)` so the ring buffer is ready for
 *     Phase 4 backfill.
 *
 * Returns an unsubscribe fn so tests + the server's shutdown path can
 * detach cleanly.
 */
export declare function attachLegacyBridge(opts: BridgeOpts): () => void;
//# sourceMappingURL=bridge.d.ts.map