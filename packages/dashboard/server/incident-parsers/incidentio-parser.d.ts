/**
 * incidentio-parser — normalize an incident.io incident payload into a
 * ParsedIncident. Accepts the REST API shape
 * (`GET /v2/incidents/{id}`) as well as webhook envelopes that nest the
 * incident under `data.incident` or `incident`.
 *
 * incident.io does not provide structured stack traces, so we do not attempt
 * stack-trace or failing-symbol extraction here. A linked PR is best-effort
 * harvested from the summary/description/custom_fields blob.
 *
 * No new dependencies — regex + structural type guards only.
 */
import { type ParsedIncident } from './types.js';
export declare function parseIncidentIoEvent(raw: unknown): ParsedIncident;
//# sourceMappingURL=incidentio-parser.d.ts.map