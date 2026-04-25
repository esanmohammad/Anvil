/**
 * datadog-parser — normalize Datadog monitor/alert payloads and APM span
 * payloads into ParsedIncidents.
 *
 * Two entry points:
 *   - `parseDatadogAlert` consumes the monitor/alert webhook body.
 *   - `parseDatadogSpan`  consumes an APM span (as returned by the events
 *     API or emitted by the Datadog tracer).
 *
 * No new dependencies — regex + structural type guards only.
 */
import { type ParsedIncident } from './types.js';
export declare function parseDatadogAlert(raw: unknown): ParsedIncident;
export declare function parseDatadogSpan(raw: unknown): ParsedIncident;
//# sourceMappingURL=datadog-parser.d.ts.map