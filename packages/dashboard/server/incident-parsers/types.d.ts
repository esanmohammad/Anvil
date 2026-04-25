/**
 * incident-parsers/types — shared types for the per-source incident parsers.
 *
 * Each parser normalizes a raw payload (Sentry event, incident.io webhook,
 * Datadog alert/span, or a manually pasted stack trace) into a
 * `ParsedIncident`. The store layer is responsible for assigning `id`,
 * `project`, and `capturedAt` — all other `IncidentRecord` fields originate
 * here.
 */
import type { FailingSymbol, IncidentSeverity, IncidentSource } from '../incident-types.js';
/**
 * The subset of `IncidentRecord` that an incident parser is expected to
 * produce. Equivalent to `Omit<IncidentRecord, 'id' | 'project' | 'capturedAt'>`
 * but spelled out so it's obvious at a glance.
 */
export interface ParsedIncident {
    externalId: string;
    source: IncidentSource;
    url: string;
    title: string;
    severity: IncidentSeverity;
    occurredAt: string;
    resolvedAt?: string;
    summary: string;
    stackTrace?: string;
    failingSymbol?: FailingSymbol;
    requestPayload?: unknown;
    env?: Record<string, string>;
    fixCommit?: string;
    parentCommit?: string;
    linkedPrUrl?: string;
    affectedUsers?: number;
    tags?: string[];
}
export interface GenericInput {
    stackTrace: string;
    title?: string;
    url?: string;
    summary?: string;
    requestPayload?: unknown;
    severity?: IncidentSeverity;
}
export declare function isObject(v: unknown): v is Record<string, unknown>;
export declare function asString(v: unknown): string | undefined;
export declare function asNumber(v: unknown): number | undefined;
/**
 * Normalize a date-ish value to an ISO 8601 string. Accepts ISO strings,
 * unix seconds, and unix milliseconds. Returns `undefined` if the input
 * cannot be interpreted as a valid date.
 */
export declare function toIso(v: unknown): string | undefined;
/** First GitHub PR URL anywhere in a free-text string. */
export declare function findGithubPrUrl(text: string): string | undefined;
//# sourceMappingURL=types.d.ts.map