/**
 * Server-listen + socket.io mount (Phase 3 round-7 extraction from
 * `dashboard-server.ts`).
 *
 * `listenAndReturnHandle(deps)` is the terminal block of the
 * dashboard boot sequence: it calls `server.listen(port)`, mounts the
 * socket.io transport (unless `ANVIL_DISABLE_SOCKET_IO=1`), opens a
 * browser if `opts.open`, and returns the `DashboardServerHandle`
 * with a `stop()` that drains the registered `stopHandlers` array
 * (each handler races a 2s timeout so a hung handler can't block the
 * test runner).
 *
 * The `fauxWsForSocket` adapter shape stays here because both
 * `sendInit` and `handleClientMessage` close over it, and the same
 * adapter is used by the `mountSocketServer({ sendInit, onAction })`
 * callbacks.
 */
import type { Server as HttpServer } from 'node:http';
import { type SocketServerHandle } from '../ws/socket-server.js';
import type { DashboardServices } from '../services/index.js';
import type { EventReplay } from '../events/replay.js';
import { type WsClient } from './ws-client.js';
import type { SendInitFn } from './init-payload.js';
import type { ClientMessage, DashboardServerHandle } from '../dashboard-server.js';
export interface ListenDeps {
    server: HttpServer;
    port: number;
    services: DashboardServices;
    replay: EventReplay;
    open: boolean;
    sendInit: SendInitFn;
    handleClientMessage: (ws: WsClient, msg: ClientMessage) => Promise<void>;
    /**
     * Mutable handle slot — the boot scope kept a `let socketHandle` so
     * the original `stopHandlers.push(async () => { if (socketHandle)
     * await socketHandle.stop(); })` worked. The setter lets us assign
     * the handle into that slot once `mountSocketServer` returns.
     */
    setSocketHandle: (h: SocketServerHandle | null) => void;
    stopHandlers: Array<() => void | Promise<void>>;
}
export declare function listenAndReturnHandle(deps: ListenDeps): Promise<DashboardServerHandle>;
//# sourceMappingURL=server-listen.d.ts.map