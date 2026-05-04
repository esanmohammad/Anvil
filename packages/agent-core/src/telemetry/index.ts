/**
 * Public telemetry barrel for `@anvil/agent-core`.
 *
 * Consumers import the GenAi attribute constants and (optionally) the tracer
 * accessor. The wrapper that emits spans (Phase 2) is not yet exposed —
 * instrumentation is applied internally at the registry seam.
 */

export { getTracer, resetTracer, shutdownTracer, getTelemetryConfig } from './tracer.js';
export { recordGenAiCall, shutdownMetrics } from './metrics.js';
export type { GenAiCallMetrics } from './metrics.js';
export { loadTelemetryConfig } from './config.js';
export type { TelemetryConfig } from './config.js';
export { GenAi } from './attributes.js';
export type { GenAiAttribute } from './attributes.js';
