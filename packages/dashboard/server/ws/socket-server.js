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
import { Server } from 'socket.io';
import { bridgeServicesToRooms } from '../events/services-bridge.js';
export function mountSocketServer(opts) {
    const path = opts.path ?? '/socket.io';
    const ioOpts = {
        path,
        cors: {
            origin: (origin, cb) => {
                if (!origin || opts.allowedOrigins.includes(origin))
                    cb(null, true);
                else
                    cb(new Error(`origin ${origin} not allowed`));
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
    let io;
    // Reserved for cleanup parity with the pre-unified upgrade-router approach.
    // Currently always null because the dashboard owns the upgrade dispatcher.
    const unrouteUpgrade = null;
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
            try {
                await opts.sendInit(socket);
            }
            catch (err) {
                console.warn('[socket] sendInit failed:', err);
            }
        }
        socket.on('subscribe', ({ rooms, since }) => {
            if (rooms)
                for (const r of rooms)
                    socket.join(r);
            if (since) {
                for (const [room, sinceId] of Object.entries(since)) {
                    const backfill = opts.replay.since(room, sinceId);
                    for (const ev of backfill) {
                        // Use the legacy wire type for now (matches the bridge).
                        socket.emit(`replay:${ev.kind}`, ev.payload);
                    }
                }
            }
        });
        socket.on('unsubscribe', ({ rooms }) => {
            if (rooms)
                for (const r of rooms)
                    socket.leave(r);
        });
        if (opts.onAction) {
            socket.on('action', async (msg) => {
                try {
                    await opts.onAction(socket, msg);
                }
                catch (err) {
                    console.warn('[socket] onAction failed:', err);
                }
            });
        }
        socket.on('disconnect', () => { });
    });
    const stop = async () => {
        try {
            detachBridge();
        }
        catch { /* ok */ }
        if (unrouteUpgrade)
            try {
                unrouteUpgrade();
            }
            catch { /* ok */ }
        await new Promise((r) => io.close(() => r()));
    };
    // socket.io now attaches to the http server normally, so its own
    // engine.io upgrade listener handles `/socket.io/*` upgrades without
    // any help from the dashboard's dispatcher. `handleUpgrade` is no
    // longer needed — kept off the handle for that reason.
    return { io, stop };
}
//# sourceMappingURL=socket-server.js.map