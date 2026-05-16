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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Keys allowed to flow from `<anvilHome>/.env` into `process.env`.
 * Strictly enumerated to prevent .env injection of system vars
 * (PATH, NODE_OPTIONS, LD_PRELOAD, etc.).
 */
export const ALLOWED_ENV_KEYS = new Set([
    'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
    'OPENROUTER_API_KEY', 'COHERE_API_KEY', 'VOYAGE_API_KEY',
    'MISTRAL_API_KEY', 'GITHUB_TOKEN', 'OLLAMA_HOST',
    'ANTHROPIC_API_KEY',
    // OpenCode Go subscription — agentic local-tier replacement for Ollama
    'OPENCODE_API_KEY', 'OPENCODE_BASE_URL',
    // Observability — OTel exporter wiring. ANVIL_OTEL_CONSOLE=1 dumps
    // spans to stdout for debugging (no collector required). Otherwise
    // setting OTEL_EXPORTER_OTLP_ENDPOINT enables the OTLP-HTTP exporter.
    'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS',
    'OTEL_SERVICE_NAME', 'OTEL_TRACES_SAMPLER',
    'OTEL_RESOURCE_ATTRIBUTES', 'ANVIL_OTEL_CONSOLE',
    'ANVIL_OTEL_DISABLED', 'ANVIL_OTEL_RECORD_CONTENT',
    'ANVIL_OTEL_METRICS_DISABLED', 'ANVIL_ENV',
]);
/** Read `<anvilHome>/.env` and seed `process.env` with allowed keys. */
export function loadAnvilEnv(anvilHome) {
    try {
        const envPath = join(anvilHome, '.env');
        if (!existsSync(envPath))
            return;
        const envContent = readFileSync(envPath, 'utf-8');
        let loaded = 0;
        for (const line of envContent.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#'))
                continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx < 1)
                continue;
            const key = trimmed.slice(0, eqIdx);
            const val = trimmed.slice(eqIdx + 1);
            if (ALLOWED_ENV_KEYS.has(key) && !process.env[key]) {
                process.env[key] = val;
                loaded++;
            }
        }
        if (loaded > 0)
            console.log(`[dashboard] Loaded ${loaded} API key(s) from ${envPath}`);
    }
    catch { /* ok — no .env file */ }
}
/**
 * Probe `localhost:3000` for the canonical local Langfuse stack
 * (infra/observability/docker-compose.yml). If reachable AND the
 * user hasn't explicitly set `OTEL_EXPORTER_OTLP_ENDPOINT`, point
 * the exporter at it. Silent on probe failure / closed Langfuse —
 * that's the expected default.
 */
export async function autoDetectTelemetry() {
    if (process.env.ANVIL_OTEL_DISABLED === '1')
        return;
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
        console.log(`[dashboard] OTel exporter → ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT} (configured)`);
        return;
    }
    if (process.env.ANVIL_OTEL_CONSOLE === '1') {
        console.log('[dashboard] OTel exporter → console (ANVIL_OTEL_CONSOLE=1)');
        return;
    }
    const host = 'http://localhost:3000';
    const otlpPath = '/api/public/otel/v1/traces';
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 800);
        const res = await fetch(`${host}/`, { method: 'HEAD', signal: ctrl.signal })
            .catch(() => null);
        clearTimeout(timer);
        if (res && res.status < 500) {
            process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `${host}${otlpPath}`;
            if (!process.env.OTEL_SERVICE_NAME)
                process.env.OTEL_SERVICE_NAME = 'anvil-dashboard';
            console.log(`[dashboard] Langfuse detected at ${host} — exporter enabled (service.name=${process.env.OTEL_SERVICE_NAME})`);
        }
        // No log when Langfuse isn't running — that's the expected default.
    }
    catch {
        // No log on probe failure — same reason.
    }
}
/**
 * Default OTel SDK log level to NONE so a misconfigured/unreachable
 * exporter doesn't spam the terminal. Override with OTEL_LOG_LEVEL=ERROR
 * to debug.
 */
export function ensureQuietOtelLogs() {
    if (!process.env.OTEL_LOG_LEVEL)
        process.env.OTEL_LOG_LEVEL = 'NONE';
}
//# sourceMappingURL=load-env.js.map