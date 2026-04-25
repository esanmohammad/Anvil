/**
 * sentry-parser — normalize a Sentry event payload into a ParsedIncident.
 *
 * Accepts either the REST API shape (`GET /api/0/issues/{id}/events/latest/`)
 * or the issue-alert webhook shape. Tolerates missing fields; throws a
 * clear Error on fundamentally malformed input so the caller can surface
 * the failure.
 *
 * No new dependencies — regex + structural type guards only.
 */
import { type ParsedIncident } from './types.js';
export declare function parseSentryEvent(raw: unknown): ParsedIncident;
//# sourceMappingURL=sentry-parser.d.ts.map