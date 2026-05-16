/**
 * Shared dashboard server types (Phase 3 round-9 extraction from
 * `dashboard-server.ts`).
 *
 * These interfaces describe the wire-shape of the dashboard's HTTP +
 * WebSocket API. They're consumed by `setup/init-payload.ts`,
 * `runs/io.ts`, `pipeline/start-pipeline.ts`, the handler-registry
 * adapters, the broadcaster, AND the Vite frontend (`src/`) — so
 * they live in `shared/` instead of being trapped inside
 * `startDashboardServer`'s scope.
 *
 * `dashboard-server.ts` re-exports every interface here so existing
 * consumers' `import { ... } from './dashboard-server.js'` paths keep
 * working unchanged.
 */
export {};
//# sourceMappingURL=server-types.js.map