/**
 * incident-parsers/types — shared types for the per-source incident parsers.
 *
 * Each parser normalizes a raw payload (Sentry event, incident.io webhook,
 * Datadog alert/span, or a manually pasted stack trace) into a
 * `ParsedIncident`. The store layer is responsible for assigning `id`,
 * `project`, and `capturedAt` — all other `IncidentRecord` fields originate
 * here.
 */
// ── Small shared helpers ────────────────────────────────────────────────
export function isObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function asString(v) {
    return typeof v === 'string' ? v : undefined;
}
export function asNumber(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
/**
 * Normalize a date-ish value to an ISO 8601 string. Accepts ISO strings,
 * unix seconds, and unix milliseconds. Returns `undefined` if the input
 * cannot be interpreted as a valid date.
 */
export function toIso(v) {
    if (typeof v === 'string') {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
        // Heuristic: values < 10^12 are seconds, otherwise ms.
        const ms = v < 1e12 ? v * 1000 : v;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    return undefined;
}
/** First GitHub PR URL anywhere in a free-text string. */
export function findGithubPrUrl(text) {
    const m = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i.exec(text);
    if (m)
        return m[0];
    const bare = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i.exec(text);
    return bare ? `https://${bare[0]}` : undefined;
}
//# sourceMappingURL=types.js.map