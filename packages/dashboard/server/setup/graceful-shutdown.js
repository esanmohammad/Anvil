/**
 * Graceful-shutdown registrar (Phase 3 round-7 extraction from
 * `dashboard-server.ts`).
 *
 * `registerGracefulShutdown(deps)` hooks SIGINT + SIGTERM and runs
 * the shutdown sequence:
 *   1. Kill every running agent (`agentManager.killAll()`).
 *   2. Kill the active pipeline child if present.
 *   3. `server.close()` then `process.exit(0)`.
 *   4. Force-exit fallback after 3s if graceful close hangs.
 *
 * The handlers are registered once per call; safe to invoke from the
 * boot sequence even though no `unregister` is exposed (signal
 * handlers are kept for the lifetime of the process).
 */
export function registerGracefulShutdown(deps) {
    const forceExitMs = deps.forceExitTimeoutMs ?? 3000;
    const gracefulShutdown = (signal) => {
        console.log(`\n[dashboard] ${signal} received — shutting down...`);
        // Kill all agent processes
        const killed = deps.agentManager.killAll();
        if (killed > 0)
            console.log(`[dashboard] Killed ${killed} running agent(s)`);
        // Kill active pipeline child
        const child = deps.getActiveChild();
        if (child) {
            try {
                child.kill('SIGTERM');
            }
            catch { /* already dead */ }
            deps.setActiveChild(null);
            console.log('[dashboard] Killed active pipeline process');
        }
        // Disconnect socket.io clients (was: wss.clients.forEach). The
        // engine.io close is driven by `socketHandle.stop()` in the normal
        // stop path; here we just let `server.close()` tear them down.
        // Close HTTP server
        deps.server.close(() => {
            console.log('[dashboard] Server closed');
            process.exit(0);
        });
        // Force exit after Nms if graceful close hangs
        setTimeout(() => {
            console.log('[dashboard] Force exit after timeout');
            process.exit(1);
        }, forceExitMs).unref();
    };
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}
//# sourceMappingURL=graceful-shutdown.js.map