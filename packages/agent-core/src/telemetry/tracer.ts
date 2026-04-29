/**
 * Tracer initialization — lazily registers an OTel TracerProvider on first
 * call. When telemetry is disabled, returns the API's no-op tracer (zero
 * overhead, no global state mutation).
 *
 * Note (Phase 1 deviation from plan §1.4): the plan code targeted OTel SDK
 * 1.x, where TracerProvider exposed `addSpanProcessor()` and `Resource` was
 * a constructor. SDK 2.x moved span processors into the provider config and
 * replaced `new Resource()` with `resourceFromAttributes()`. This file uses
 * the 2.x API. See AGENT-OBSERVABILITY-ADR.md §5 + §9 Phase 1.
 */

import { trace, type Tracer } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { loadTelemetryConfig, type TelemetryConfig } from './config.js';
import { buildExporter } from './exporters.js';
import { VERSION } from '../version.js';

const TRACER_NAME = 'anvil.agent-core';

let _tracer: Tracer | null = null;
let _provider: NodeTracerProvider | null = null;

export function getTracer(): Tracer {
  if (_tracer) return _tracer;

  const config = loadTelemetryConfig();
  if (!config.enabled) {
    _tracer = trace.getTracer(TRACER_NAME, VERSION);
    return _tracer;
  }

  const processors: SpanProcessor[] = [
    new BatchSpanProcessor(buildExporter(config)),
  ];

  _provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: VERSION,
    }),
    spanProcessors: processors,
  });
  _provider.register();
  _tracer = trace.getTracer(TRACER_NAME, VERSION);
  return _tracer;
}

/** Test seam — clears the cached tracer + shuts down the provider so the
 * next getTracer() call rebuilds from a fresh config. Awaitable so tests
 * can ensure all spans flush before assertion. */
export async function resetTracer(): Promise<void> {
  if (_provider) {
    try {
      await _provider.forceFlush();
      await _provider.shutdown();
    } catch {
      // ignore — best effort
    }
    _provider = null;
  }
  _tracer = null;
  trace.disable();
}

/** Diagnostic — exposes the active TelemetryConfig used at registration time. */
export function getTelemetryConfig(): TelemetryConfig {
  return loadTelemetryConfig();
}
