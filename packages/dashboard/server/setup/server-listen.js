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
import { spawn } from 'node:child_process';
import { mountSocketServer } from '../ws/socket-server.js';
import { WS_OPEN } from './ws-client.js';
export function listenAndReturnHandle(deps) {
    return new Promise((resolve) => {
        deps.server.listen(deps.port, () => {
            const addr = deps.server.address();
            const boundPort = (typeof addr === 'object' && addr !== null && 'port' in addr)
                ? addr.port
                : deps.port;
            const url = `http://localhost:${boundPort}`;
            console.log(`[dashboard] Serving at ${url}`);
            // ── socket.io transport mount (Phase 8: the only transport) ────
            // socket.io's `attach(server)` registers its own upgrade listener
            // for `/socket.io/*` and delegates other request paths to the
            // previous request listener (the static handler). Disable with
            // ANVIL_DISABLE_SOCKET_IO=1 only for boot diagnostics.
            if (process.env.ANVIL_DISABLE_SOCKET_IO !== '1') {
                // Adapter that exposes a socket.io Socket as the `WsClient`
                // shape so `sendInit` + every `handleClientMessage` branch
                // (each calling `ws.send(JSON.stringify(...))`) work unchanged.
                // Replies are parsed back out and re-emitted as
                // `socket.emit(type, payload)` so `socket.onAny` on the client
                // receives them in the same `{type, payload}` wire shape.
                const fauxWsForSocket = (socket) => ({
                    readyState: WS_OPEN,
                    send: (raw) => {
                        try {
                            const msg = JSON.parse(raw);
                            socket.emit(msg.type, msg.payload);
                        }
                        catch { /* ignore malformed */ }
                    },
                });
                const socketHandle = mountSocketServer({
                    server: deps.server,
                    services: deps.services,
                    replay: deps.replay,
                    allowedOrigins: [
                        `http://localhost:${boundPort}`,
                        `http://127.0.0.1:${boundPort}`,
                        'http://localhost:5173',
                        'http://127.0.0.1:5173',
                    ],
                    sendInit: async (socket) => {
                        await deps.sendInit(fauxWsForSocket(socket));
                    },
                    onAction: async (socket, msg) => {
                        if (msg && typeof msg === 'object') {
                            await deps.handleClientMessage(fauxWsForSocket(socket), msg);
                        }
                    },
                });
                deps.setSocketHandle(socketHandle);
            }
            if (deps.open) {
                const openCmd = process.platform === 'darwin' ? 'open'
                    : process.platform === 'win32' ? 'start'
                        : 'xdg-open';
                spawn(openCmd, [url], { shell: true, stdio: 'ignore' });
            }
            const stop = async () => {
                // Each handler races a 2 s timeout — io.close() from socket.io
                // can wait indefinitely on engine.io's polling-transport timers
                // in some test configurations. We prefer dropping cleanup over
                // hanging the test runner.
                for (let i = 0; i < deps.stopHandlers.length; i++) {
                    const fn = deps.stopHandlers[i];
                    if (process.env.ANVIL_WS_DIAG)
                        console.warn('[stop-diag] handler', i, 'start');
                    try {
                        await Promise.race([
                            Promise.resolve(fn()),
                            new Promise((r) => setTimeout(r, 2000).unref()),
                        ]);
                    }
                    catch { /* keep going */ }
                    if (process.env.ANVIL_WS_DIAG)
                        console.warn('[stop-diag] handler', i, 'done');
                }
                if (process.env.ANVIL_WS_DIAG)
                    console.warn('[stop-diag] closing connections');
                try {
                    deps.server.closeAllConnections?.();
                }
                catch { /* older Node */ }
                if (process.env.ANVIL_WS_DIAG)
                    console.warn('[stop-diag] server.close');
                await Promise.race([
                    new Promise((r) => deps.server.close(() => r())),
                    new Promise((r) => setTimeout(r, 2000).unref()),
                ]);
                if (process.env.ANVIL_WS_DIAG)
                    console.warn('[stop-diag] done');
            };
            resolve({ port: boundPort, stop });
        });
    });
}
//# sourceMappingURL=server-listen.js.map