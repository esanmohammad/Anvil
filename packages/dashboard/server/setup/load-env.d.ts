/**
 * `.env` loader + telemetry auto-detect (Phase 3 round-12 extraction
 * from `dashboard-server.ts`).
 *
 * Runs once at module-load time:
 *   1. `loadAnvilEnv(anvilHome)` — read `<anvilHome>/.env` and copy
 *      every recognised `KEY=value` line into `process.env`, but only
 *      for keys in `ALLOWED_ENV_KEYS` (prevents env injection of
 *      PATH, NODE_OPTIONS, etc.) and only when the key isn't already
 *      set in the environment.
 *   2. `autoDetectTelemetry()` — probe `localhost:3000` for the
 *      canonical local Langfuse stack; if reachable AND the user
 *      hasn't set `OTEL_EXPORTER_OTLP_ENDPOINT`, wire the exporter
 *      automatically. Silent when telemetry is off (the expected
 *      default).
 *
 * Both functions are side-effecting. The dashboard boot calls
 * `loadAnvilEnv(ANVIL_HOME)` synchronously and fires
 * `autoDetectTelemetry()` fire-and-forget; the actual OTel SDK
 * initialises lazily on the first agent call.
 */
/**
 * Keys allowed to flow from `<anvilHome>/.env` into `process.env`.
 * Strictly enumerated to prevent .env injection of system vars
 * (PATH, NODE_OPTIONS, LD_PRELOAD, etc.).
 */
export declare const ALLOWED_ENV_KEYS: ReadonlySet<string>;
/** Read `<anvilHome>/.env` and seed `process.env` with allowed keys. */
export declare function loadAnvilEnv(anvilHome: string): void;
/**
 * Probe `localhost:3000` for the canonical local Langfuse stack
 * (infra/observability/docker-compose.yml). If reachable AND the
 * user hasn't explicitly set `OTEL_EXPORTER_OTLP_ENDPOINT`, point
 * the exporter at it. Silent on probe failure / closed Langfuse —
 * that's the expected default.
 */
export declare function autoDetectTelemetry(): Promise<void>;
/**
 * Default OTel SDK log level to NONE so a misconfigured/unreachable
 * exporter doesn't spam the terminal. Override with OTEL_LOG_LEVEL=ERROR
 * to debug.
 */
export declare function ensureQuietOtelLogs(): void;
//# sourceMappingURL=load-env.d.ts.map