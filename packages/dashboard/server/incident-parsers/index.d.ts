/**
 * incident-parsers — per-source normalizers that turn raw external payloads
 * into the `ParsedIncident` shape consumed by `IncidentStore.ingest`.
 *
 * Each parser is pure and synchronous: no I/O, no network, no dependencies
 * beyond the Node standard library. Malformed input throws an `Error` so
 * the caller can surface the failure verbatim.
 */
export type { ParsedIncident, GenericInput } from './types.js';
export { parseSentryEvent } from './sentry-parser.js';
export { parseIncidentIoEvent } from './incidentio-parser.js';
export { parseDatadogAlert, parseDatadogSpan } from './datadog-parser.js';
export { parseGenericStackTrace, extractFailingSymbol } from './generic-parser.js';
//# sourceMappingURL=index.d.ts.map