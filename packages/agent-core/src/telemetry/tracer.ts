/**
 * Tracer initialization — lazily registers an OTel TracerProvider on first
 * call. When telemetry is disabled, returns the API's no-op tracer (zero
 * overhead, no global state mutation).
 *
 * Resource enrichment:
 *   - service.name / service.version from TelemetryConfig
 *   - service.namespace = "anvil"
 *   - service.instance.id = `${hostname}-${pid}` (overridable)
 *   - host.name from os.hostname()
 *   - process.pid / process.runtime.{name,version}
 *   - deployment.environment from ANVIL_ENV (default "local")
 *   - extra attrs parsed from OTEL_RESOURCE_ATTRIBUTES (k1=v1,k2=v2)
 *
 * Graceful shutdown: SIGINT/SIGTERM/beforeExit hooks call `forceFlush()`
 * + `shutdown()` so trailing spans/metrics aren't lost on `pkill`.
 */

import {
  trace,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  type Attributes,
  type Tracer,
} from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { hostname } from 'node:os';
import { loadTelemetryConfig, type TelemetryConfig } from './config.js';
import { buildExporter } from './exporters.js';
import { shutdownMetrics } from './metrics.js';
import { VERSION } from '../version.js';

const TRACER_NAME = 'anvil.agent-core';

let _tracer: Tracer | null = null;
let _provider: NodeTracerProvider | null = null;
let _shutdownHooked = false;

function parseResourceAttrs(raw: string | undefined): Attributes {
  if (!raw) return {};
  const out: Attributes = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function buildResource(config: TelemetryConfig): Attributes {
  const host = hostname();
  const pid = process.pid;
  const env = process.env.ANVIL_ENV ?? process.env.DEPLOYMENT_ENVIRONMENT ?? 'local';
  return {
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: VERSION,
    'service.namespace': 'anvil',
    'service.instance.id':
      process.env.ANVIL_INSTANCE_ID ?? `${host}-${pid}`,
    'host.name': host,
    'process.pid': pid,
    'process.runtime.name': 'nodejs',
    'process.runtime.version': process.versions.node,
    'deployment.environment': env,
    ...parseResourceAttrs(process.env.OTEL_RESOURCE_ATTRIBUTES),
  };
}

function installShutdownHook(): void {
  if (_shutdownHooked) return;
  _shutdownHooked = true;

  const flush = async (): Promise<void> => {
    try {
      if (_provider) {
        await _provider.forceFlush();
        await _provider.shutdown();
      }
      await shutdownMetrics();
    } catch (err) {
      diag.warn(
        `[telemetry] shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // beforeExit fires when the event loop empties — best place for clean
  // shutdown. SIGINT/SIGTERM cover ctrl-c and pkill.
  process.once('beforeExit', () => { void flush(); });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      void flush().finally(() => {
        // Re-raise the signal so the process actually exits with the
        // right code instead of hanging on a successful flush.
        process.kill(process.pid, sig);
      });
    });
  }
}

export function getTracer(): Tracer {
  if (_tracer) return _tracer;

  const config = loadTelemetryConfig();
  if (!config.enabled) {
    _tracer = trace.getTracer(TRACER_NAME, VERSION);
    return _tracer;
  }

  // OTEL_LOG_LEVEL surfaces SDK errors (OTLP POST failures etc.) at the
  // requested level. ERROR is the right default for steady-state ops;
  // bump to DEBUG/INFO when diagnosing.
  const logLevel = (process.env.OTEL_LOG_LEVEL ?? 'ERROR').toUpperCase() as keyof typeof DiagLogLevel;
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel[logLevel] ?? DiagLogLevel.ERROR);

  // SimpleSpanProcessor ships per-span (instant Jaeger/Tempo arrival) for
  // dev. Production should set ANVIL_OTEL_BATCH=1 to amortise network IO.
  const exporter = buildExporter(config);
  const processor: SpanProcessor = process.env.ANVIL_OTEL_BATCH === '1'
    ? new BatchSpanProcessor(exporter)
    : new SimpleSpanProcessor(exporter);

  _provider = new NodeTracerProvider({
    resource: resourceFromAttributes(buildResource(config)),
    spanProcessors: [processor],
  });
  _provider.register();
  _tracer = trace.getTracer(TRACER_NAME, VERSION);

  installShutdownHook();

  diag.debug(
    `[telemetry] tracer initialised — service=${config.serviceName} `
    + `mode=${config.exporterMode} endpoint=${config.endpoint ?? 'n/a'}`,
  );
  return _tracer;
}

/** Force-flush any pending spans and tear down the provider. Call once at
 * graceful shutdown if you can't rely on the auto-installed hooks (e.g.
 * Lambda runtimes, bespoke shutdown sequences). Also drains the metrics
 * pipeline so per-run cost/token counters land before exit. Safe to call
 * multiple times. */
export async function shutdownTracer(): Promise<void> {
  try {
    if (_provider) {
      await _provider.forceFlush();
      await _provider.shutdown();
    }
    await shutdownMetrics();
  } finally {
    _provider = null;
    _tracer = null;
  }
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
