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
import type { Topic } from '../events/types.js';
import { bridgeServicesToRooms } from '../events/services-bridge.js';

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

interface SubscribeMsg {
  rooms?: Topic[];
  since?: Record<string, string>;
}

export function mountSocketServer(opts: SocketServerOpts): SocketServerHandle {
  const path = opts.path ?? '/socket.io';
  const ioOpts = {
    path,
    cors: {
      origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
        if (!origin || opts.allowedOrigins.includes(origin)) cb(null, true);
        else cb(new Error(`origin ${origin} not allowed`));
      },
      credentials: false,
    },
    maxHttpBufferSize: 1_000_000,
  };

  // Construction modes:
  //   - default (legacy): pass the http server, socket.io's `attach()`
  //     re-installs the request listener. Fine for tests that use only
  //     socket.io as the WS transport.
  //   - coexistWithRawWs: `noServer: true` plus a manual upgrade-router
  //     so raw WebSocketServer keeps owning `/ws` upgrades. The router
  //     filters by path and lets non-`/socket.io/` requests fall through
  //     to the raw-WS listener.
  let io: Server;
  // Reserved for cleanup parity with the pre-unified upgrade-router approach.
  // Currently always null because the dashboard owns the upgrade dispatcher.
  const unrouteUpgrade: (() => void) | null = null;

  // socket.io always attaches to the http server so its engine is
  // created and its HTTP polling endpoints are wired. When the dashboard
  // also runs a raw `WebSocketServer({ path:'/ws' })`, both are mounted
  // here — the dashboard's WSS is constructed `noServer:true` and shares
  // a single explicit `server.on('upgrade')` dispatcher with socket.io
  // so they don't race for upgrades. `coexistWithRawWs` is kept on the
  // opts type for documentation but no longer changes mount behavior.
  io = new Server(opts.server, ioOpts);
  void opts.coexistWithRawWs;

  const detachBridge = bridgeServicesToRooms({
    services: opts.services,
    io,
    replay: opts.replay,
  });

  io.on('connection', async (socket) => {
    // Default subscription — lossless transition from the firehose era.
    // UI routes layer additional `socket.emit('subscribe', { rooms })`
    // calls in their useEffect mounts.
    socket.join('global');

    if (opts.sendInit) {
      try { await opts.sendInit(socket); } catch (err) {
        console.warn('[socket] sendInit failed:', err);
      }
    }

    socket.on('subscribe', ({ rooms, since }: SubscribeMsg) => {
      if (rooms) for (const r of rooms) socket.join(r);
      if (since) {
        for (const [room, sinceId] of Object.entries(since)) {
          const backfill = opts.replay.since(room as Topic, sinceId);
          for (const ev of backfill) {
            // Use the legacy wire type for now (matches the bridge).
            socket.emit(`replay:${ev.kind}`, ev.payload);
          }
        }
      }
    });

    socket.on('unsubscribe', ({ rooms }: { rooms?: Topic[] }) => {
      if (rooms) for (const r of rooms) socket.leave(r);
    });

    if (opts.onAction) {
      socket.on('action', async (msg: unknown) => {
        try { await opts.onAction!(socket, msg); }
        catch (err) { console.warn('[socket] onAction failed:', err); }
      });
    }

    socket.on('disconnect', () => { /* socket.io tears down rooms automatically */ });
  });

  const stop = async (): Promise<void> => {
    try { detachBridge(); } catch { /* ok */ }
    if (unrouteUpgrade) try { (unrouteUpgrade as () => void)(); } catch { /* ok */ }
    await new Promise<void>((r) => io.close(() => r()));
  };

  // socket.io now attaches to the http server normally, so its own
  // engine.io upgrade listener handles `/socket.io/*` upgrades without
  // any help from the dashboard's dispatcher. `handleUpgrade` is no
  // longer needed — kept off the handle for that reason.
  return { io, stop };
}
