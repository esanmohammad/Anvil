/**
 * Exporter factory — produces an OTel SpanExporter from a TelemetryConfig.
 *
 * The 'noop' branch is intentionally unreachable here: callers gate on
 * config.enabled before constructing an exporter (see tracer.ts).
 */

import { ConsoleSpanExporter, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { TelemetryConfig } from './config.js';

/**
 * Normalize an OTLP HTTP endpoint to include the `/v1/traces` signal path.
 *
 * The OTel JS SDK only auto-appends `/v1/traces` when reading the endpoint
 * from the `OTEL_EXPORTER_OTLP_ENDPOINT` env var directly — not when the URL
 * is passed via the exporter constructor. So `http://localhost:4318`
 * silently 404s against any OTLP HTTP receiver. We append the suffix
 * ourselves when the URL has no path component.
 */
function normalizeOtlpEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) return endpoint;
  try {
    const url = new URL(endpoint);
    if (url.pathname === '' || url.pathname === '/') {
      url.pathname = '/v1/traces';
      return url.toString();
    }
    return endpoint;
  } catch {
    return endpoint;
  }
}

export function buildExporter(config: TelemetryConfig): SpanExporter {
  switch (config.exporterMode) {
    case 'console':
      return new ConsoleSpanExporter();
    case 'otlp':
      return new OTLPTraceExporter({
        url: normalizeOtlpEndpoint(config.endpoint),
        headers: config.headers,
      });
    case 'noop':
      throw new Error('buildExporter called with noop mode — callers must gate on config.enabled');
  }
}
