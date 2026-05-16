/**
 * socket.io transport for the dashboard.
 *
 * Phase 4 — mounts socket.io alongside the existing raw WebSocket server
 * (different path, same HTTP server). The harness flips to
 * `socket.io-client` for scenario tests; the React frontend keeps using
 * raw WS until Phase 5 swaps the hook.
 *
 * Capabilities (all socket.io-built-in unless noted):
 *   - Per-client subscriptions via rooms (`socket.join(...)`).
 *   - Backpressure + reconnection.
 *   - Backfill on reconnect via our EventReplay (custom 'subscribe'
 *     handler with `since` cursors).
 *   - Origin validation matches the raw-WS behavior — bound port +
 *     localhost variants are allowed; everything else is rejected.
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Server, type Socket } from 'socket.io';
import type { DashboardServices } from '../services/index.js';
import type { EventReplay } from '../events/replay.js';
export interface SocketServerOpts {
    /** Underlying HTTP server — shared with the static + raw-WS pipeline. */
    server: HttpServer;
    /** Mount path for socket.io's engine.io endpoint. */
    path?: string;
    services: DashboardServices;
    replay: EventReplay;
    /** Allowed Origin headers — passed through to the cors config. */
    allowedOrigins: string[];
    /** Optional initial-state sender (mirror of raw-WS sendInit). */
    sendInit?: (socket: Socket) => Promise<void>;
    /**
     * Optional handler invoked for every `'action'` event the client emits.
     * The dashboard wires this to `handleClientMessage(fauxWs, msg)` so the
     * existing ~150 action handlers serve socket.io clients without any
     * per-action refactor. The handler is responsible for parsing `msg`
     * defensively — the wire shape is `{ action: string, ...args }`.
     */
    onAction?: (socket: Socket, msg: unknown) => Promise<void> | void;
    /**
     * When true, socket.io is constructed with `noServer:true` and we register
     * an upgrade-route handler manually on the http server. Other listeners
     * (e.g. a raw `WebSocketServer({ path: '/ws' })`) handle non-socket.io
     * upgrades. Use this whenever the http server also hosts raw WS so the
     * two don't contend for upgrade events. Default: false (legacy attach).
     */
    coexistWithRawWs?: boolean;
}
export interface SocketServerHandle {
    io: Server;
    stop: () => Promise<void>;
    /**
     * Forward an http upgrade event into engine.io. Only valid when the
     * server was constructed with `coexistWithRawWs: true`; the dashboard's
     * single `server.on('upgrade')` dispatcher calls this for requests
     * targeting the socket.io path.
     */
    handleUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}
export declare function mountSocketServer(opts: SocketServerOpts): SocketServerHandle;
//# sourceMappingURL=socket-server.d.ts.map