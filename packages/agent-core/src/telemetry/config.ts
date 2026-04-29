/**
 * Telemetry configuration — resolved from environment variables.
 *
 * Resolution order:
 * 1. ANVIL_OTEL_DISABLED=1            → disabled (kill-switch wins)
 * 2. OTEL_EXPORTER_OTLP_ENDPOINT set  → otlp mode, enabled
 * 3. ANVIL_OTEL_CONSOLE=1             → console mode, enabled
 * 4. otherwise                         → noop mode, disabled
 *
 * Prompt content recording is OFF by default — opt in via
 * ANVIL_OTEL_RECORD_CONTENT=1 (decision O5).
 */

export interface TelemetryConfig {
  /** True when at least one exporter is wired up. */
  enabled: boolean;
  /** Which exporter the tracer should install. */
  exporterMode: 'noop' | 'console' | 'otlp';
  /** OTLP endpoint URL. Only meaningful when exporterMode === 'otlp'. */
  endpoint?: string;
  /** Headers parsed from OTEL_EXPORTER_OTLP_HEADERS (key=value pairs, comma separated). */
  headers?: Record<string, string>;
  /** When true, prompt + completion text are attached to spans. Default false. */
  recordContent: boolean;
  /** Resource attribute service.name. */
  serviceName: string;
  /** Optional sampler hint (mirrors OTEL_TRACES_SAMPLER); the SDK reads this env var natively. */
  sampler?: string;
}

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function loadTelemetryConfig(): TelemetryConfig {
  const disabled = process.env.ANVIL_OTEL_DISABLED === '1';
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const consoleFlag = process.env.ANVIL_OTEL_CONSOLE === '1';
  const recordContent = process.env.ANVIL_OTEL_RECORD_CONTENT === '1';
  const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || 'anvil-agent-core';
  const sampler = process.env.OTEL_TRACES_SAMPLER?.trim() || undefined;

  if (disabled) {
    return { enabled: false, exporterMode: 'noop', recordContent: false, serviceName, sampler };
  }
  if (endpoint) {
    return {
      enabled: true,
      exporterMode: 'otlp',
      endpoint,
      headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
      recordContent,
      serviceName,
      sampler,
    };
  }
  if (consoleFlag) {
    return { enabled: true, exporterMode: 'console', recordContent, serviceName, sampler };
  }
  return { enabled: false, exporterMode: 'noop', recordContent, serviceName, sampler };
}
