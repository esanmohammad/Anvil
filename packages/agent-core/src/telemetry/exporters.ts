/**
 * Exporter factory — produces an OTel SpanExporter from a TelemetryConfig.
 *
 * The 'noop' branch is intentionally unreachable here: callers gate on
 * config.enabled before constructing an exporter (see tracer.ts).
 */

import { ConsoleSpanExporter, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { TelemetryConfig } from './config.js';

export function buildExporter(config: TelemetryConfig): SpanExporter {
  switch (config.exporterMode) {
    case 'console':
      return new ConsoleSpanExporter();
    case 'otlp':
      return new OTLPTraceExporter({
        url: config.endpoint,
        headers: config.headers,
      });
    case 'noop':
      throw new Error('buildExporter called with noop mode — callers must gate on config.enabled');
  }
}
