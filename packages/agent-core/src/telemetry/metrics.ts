/**
 * GenAI metrics — emits OTel metrics on every adapter call alongside the
 * existing trace span. Mirrors the OTel GenAI semconv counters/histograms
 * so dashboards built against any compliant collector keep working.
 *
 * Instruments:
 *   - gen_ai.client.token.usage   (counter, by io_type ∈ input|output|cache_read|cache_write|reasoning)
 *   - gen_ai.client.cost_usd      (counter, by component ∈ input|output|cache_read|cache_write|total)
 *   - gen_ai.client.operation.duration  (histogram, ms)
 *   - gen_ai.cache.hit_ratio      (gauge per call, 0–1)
 *
 * All instruments inherit the shared resource (service.name, anvil.run_id,
 * etc.) registered in tracer.ts. Metrics shipping is gated on the same
 * TelemetryConfig as traces — disabled telemetry produces no-op meters.
 */

import {
  metrics,
  diag,
  type Meter,
  type Counter,
  type Histogram,
  type Gauge,
  type Attributes,
} from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  OTLPMetricExporter,
  AggregationTemporalityPreference,
} from '@opentelemetry/exporter-metrics-otlp-http';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { hostname } from 'node:os';
import { loadTelemetryConfig, type TelemetryConfig } from './config.js';
import { VERSION } from '../version.js';

const METER_NAME = 'anvil.agent-core';
const EXPORT_INTERVAL_MS = 5_000;

let _meter: Meter | null = null;
let _provider: MeterProvider | null = null;
let _reader: MetricReader | null = null;

let _tokenCounter: Counter | null = null;
let _costCounter: Counter | null = null;
let _durationHist: Histogram | null = null;
let _cacheHitGauge: Gauge | null = null;

function buildResourceAttrs(config: TelemetryConfig): Attributes {
  const host = hostname();
  return {
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: VERSION,
    'service.namespace': 'anvil',
    'service.instance.id':
      process.env.ANVIL_INSTANCE_ID ?? `${host}-${process.pid}`,
    'host.name': host,
    'deployment.environment':
      process.env.ANVIL_ENV ?? process.env.DEPLOYMENT_ENVIRONMENT ?? 'local',
  };
}

function normalizeMetricsEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) return endpoint;
  try {
    const url = new URL(endpoint);
    if (url.pathname === '' || url.pathname === '/') {
      url.pathname = '/v1/metrics';
      return url.toString();
    }
    return endpoint;
  } catch {
    return endpoint;
  }
}

function ensureMeter(): Meter {
  if (_meter) return _meter;

  const config = loadTelemetryConfig();
  // ANVIL_OTEL_METRICS_DISABLED=1 → keep traces but skip metrics export.
  // Useful when the OTLP backend is traces-only (e.g. Langfuse), where
  // POSTing metrics produces a periodic AggregateError every export tick.
  const metricsDisabled = process.env.ANVIL_OTEL_METRICS_DISABLED === '1';
  if (!config.enabled || config.exporterMode !== 'otlp' || metricsDisabled) {
    // Use the global no-op MeterProvider when telemetry is disabled or in
    // console mode (no metrics console exporter wired today).
    _meter = metrics.getMeter(METER_NAME, VERSION);
    return _meter;
  }

  // Prometheus only accepts CUMULATIVE temporality. The SDK's default
  // (LOWMEMORY) emits histograms as DELTA, which Prometheus rejects with
  // "invalid temporality and type combination".
  const exporter = new OTLPMetricExporter({
    url: normalizeMetricsEndpoint(config.endpoint),
    headers: config.headers,
    temporalityPreference: AggregationTemporalityPreference.CUMULATIVE,
  });
  _reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: EXPORT_INTERVAL_MS,
  });

  _provider = new MeterProvider({
    resource: resourceFromAttributes(buildResourceAttrs(config)),
    readers: [_reader],
  });
  metrics.setGlobalMeterProvider(_provider);
  _meter = _provider.getMeter(METER_NAME, VERSION);

  diag.debug(
    `[telemetry] meter initialised — endpoint=${config.endpoint ?? 'n/a'} `
    + `interval=${EXPORT_INTERVAL_MS}ms`,
  );
  return _meter;
}

function instruments(): {
  tokens: Counter;
  cost: Counter;
  duration: Histogram;
  cacheHit: Gauge;
} {
  const meter = ensureMeter();
  if (!_tokenCounter) {
    _tokenCounter = meter.createCounter('gen_ai.client.token.usage', {
      description: 'Tokens consumed by GenAI calls, broken down by io_type',
      unit: '{token}',
    });
  }
  if (!_costCounter) {
    _costCounter = meter.createCounter('gen_ai.client.cost_usd', {
      description: 'Estimated USD cost of GenAI calls, by component',
      unit: 'USD',
    });
  }
  if (!_durationHist) {
    _durationHist = meter.createHistogram('gen_ai.client.operation.duration', {
      description: 'Wall-clock duration of GenAI client operations',
      unit: 'ms',
    });
  }
  if (!_cacheHitGauge) {
    _cacheHitGauge = meter.createGauge('gen_ai.cache.hit_ratio', {
      description: 'Per-call prompt-cache hit ratio (0..1)',
      unit: '1',
    });
  }
  return {
    tokens: _tokenCounter,
    cost: _costCounter,
    duration: _durationHist,
    cacheHit: _cacheHitGauge,
  };
}

// ── Public surface ──────────────────────────────────────────────────────

export interface GenAiCallMetrics {
  /** OTel `gen_ai.system` (provider) — e.g. 'claude', 'gemini'. */
  system: string;
  /** Model identifier sent in the request. */
  requestModel: string;
  /** Model identifier returned in the response (often resolved/aliased). */
  responseModel?: string;
  /** Anvil-specific labels — kept on metric attributes for slicing. */
  stage?: string;
  persona?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  /** USD cost broken into components — every field is a delta to add. */
  costInputUsd: number;
  costOutputUsd: number;
  costCacheReadUsd: number;
  costCacheWriteUsd: number;
  costTotalUsd: number;
  /** Wall-clock duration of the call. */
  durationMs: number;
}

/** Record one adapter call — emits all 4 instruments with consistent labels.
 * Safe to call when telemetry is disabled (no-op meter eats the writes). */
export function recordGenAiCall(m: GenAiCallMetrics): void {
  const inst = instruments();
  const baseAttrs: Attributes = {
    'gen_ai.system': m.system,
    'gen_ai.request.model': m.requestModel,
  };
  if (m.responseModel) baseAttrs['gen_ai.response.model'] = m.responseModel;
  if (m.stage) baseAttrs['anvil.stage'] = m.stage;
  if (m.persona) baseAttrs['anvil.persona'] = m.persona;

  // Tokens — one data point per io_type so dashboards can slice.
  inst.tokens.add(m.inputTokens, { ...baseAttrs, io_type: 'input' });
  inst.tokens.add(m.outputTokens, { ...baseAttrs, io_type: 'output' });
  if (m.cacheReadTokens > 0) {
    inst.tokens.add(m.cacheReadTokens, { ...baseAttrs, io_type: 'cache_read' });
  }
  if (m.cacheWriteTokens > 0) {
    inst.tokens.add(m.cacheWriteTokens, { ...baseAttrs, io_type: 'cache_write' });
  }
  if (m.reasoningTokens && m.reasoningTokens > 0) {
    inst.tokens.add(m.reasoningTokens, { ...baseAttrs, io_type: 'reasoning' });
  }

  // Cost — separated per component so dashboards can stack a cost graph.
  inst.cost.add(m.costInputUsd, { ...baseAttrs, component: 'input' });
  inst.cost.add(m.costOutputUsd, { ...baseAttrs, component: 'output' });
  inst.cost.add(m.costCacheReadUsd, { ...baseAttrs, component: 'cache_read' });
  inst.cost.add(m.costCacheWriteUsd, { ...baseAttrs, component: 'cache_write' });
  inst.cost.add(m.costTotalUsd, { ...baseAttrs, component: 'total' });

  // Latency.
  inst.duration.record(m.durationMs, baseAttrs);

  // Cache hit ratio — denominator is input + cache_read tokens.
  const denom = m.inputTokens + m.cacheReadTokens;
  if (denom > 0) {
    inst.cacheHit.record(m.cacheReadTokens / denom, baseAttrs);
  }
}

/** Force-flush any pending metric data and tear down the provider. */
export async function shutdownMetrics(): Promise<void> {
  if (!_provider) return;
  try {
    await _provider.forceFlush();
    await _provider.shutdown();
  } finally {
    _provider = null;
    _reader = null;
    _meter = null;
    _tokenCounter = null;
    _costCounter = null;
    _durationHist = null;
    _cacheHitGauge = null;
  }
}
