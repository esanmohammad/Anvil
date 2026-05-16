/**
 * Service → socket.io room bridge.
 *
 * The canonical fan-out path after Phase 8 (raw-WS deletion). For every
 * service emission this bridge:
 *   1. Builds a typed envelope (id, ts, topics).
 *   2. Appends it to the replay ring buffer (backfill on reconnect).
 *   3. Translates to the legacy `<verb>-<noun>` slug via
 *      `wire-translate.ts` and emits to the relevant socket.io rooms.
 *
 * The legacy slug stays as the wire vocabulary so the frontend reducer's
 * `wireToEvent` adapter keeps working unchanged; a future cleanup pass
 * can flip both sides to typed kind names.
 */
import type { Server as SocketIoServer } from 'socket.io';
import type { DashboardServices } from '../services/index.js';
import type { EventReplay } from './replay.js';
export interface ServicesBridgeOpts {
    services: DashboardServices;
    io: SocketIoServer;
    replay: EventReplay;
    now?: () => number;
}
/**
 * Attach the socket.io bridge. Returns a detach fn so tests + shutdown
 * paths can unwire it cleanly.
 */
export declare function bridgeServicesToRooms(opts: ServicesBridgeOpts): () => void;
//# sourceMappingURL=services-bridge.d.ts.map