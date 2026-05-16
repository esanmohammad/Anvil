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
import type { Server as HttpServer } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
export interface GracefulShutdownDeps {
    server: HttpServer;
    agentManager: AgentManager;
    getActiveChild: () => ChildProcess | null;
    setActiveChild: (child: ChildProcess | null) => void;
    /** Override the force-exit timeout (default 3000ms). */
    forceExitTimeoutMs?: number;
}
export declare function registerGracefulShutdown(deps: GracefulShutdownDeps): void;
//# sourceMappingURL=graceful-shutdown.d.ts.map