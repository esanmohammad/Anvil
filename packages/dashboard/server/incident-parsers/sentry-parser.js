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
import { asNumber, asString, isObject, toIso, } from './types.js';
// ── Public API ──────────────────────────────────────────────────────────
export function parseSentryEvent(raw) {
    if (!isObject(raw)) {
        throw new Error('parseSentryEvent: payload is not an object');
    }
    // Some webhook shapes nest the event under `data.event` or `event`.
    const event = pickEvent(raw);
    if (!isObject(event)) {
        throw new Error('parseSentryEvent: no event body found');
    }
    const externalId = asString(event.id) ??
        asString(event.eventID) ??
        asString(event.event_id);
    if (!externalId) {
        throw new Error('parseSentryEvent: missing event id');
    }
    const url = resolveUrl(event);
    const title = resolveTitle(event);
    const severity = mapSeverity(asString(event.level));
    const occurredAt = toIso(event.dateCreated) ??
        toIso(event.datetime) ??
        toIso(event.received) ??
        toIso(event.timestamp) ??
        new Date(0).toISOString();
    const { stackTrace, failingSymbol } = extractStack(event);
    const requestPayload = extractRequest(event);
    const { env, tags } = extractTags(event);
    const affectedUsers = resolveAffectedUsers(event);
    const summary = asString(event.culprit) ?? title;
    return {
        externalId,
        source: 'sentry',
        url,
        title,
        severity,
        occurredAt,
        summary,
        stackTrace,
        failingSymbol,
        requestPayload,
        env,
        tags,
        affectedUsers,
    };
}
// ── Helpers ─────────────────────────────────────────────────────────────
function pickEvent(raw) {
    // Webhook: { action, data: { event: {...} } } or { event: {...} }
    if (isObject(raw.data) && isObject(raw.data.event)) {
        return raw.data.event;
    }
    if (isObject(raw.event))
        return raw.event;
    return raw;
}
function resolveUrl(event) {
    const webUrl = asString(event.web_url) ?? asString(event.webUrl);
    if (webUrl)
        return webUrl;
    const groupId = asString(event.groupID) ?? asString(event.group_id);
    const project = asString(event.projectSlug) ?? asString(event.project);
    if (groupId && project) {
        return `https://sentry.io/organizations/sentry/issues/${groupId}/?project=${project}`;
    }
    if (groupId)
        return `https://sentry.io/issues/${groupId}/`;
    return '';
}
function resolveTitle(event) {
    const t = asString(event.title);
    if (t)
        return t;
    if (isObject(event.metadata)) {
        const meta = event.metadata;
        const val = asString(meta.value);
        const type = asString(meta.type);
        if (val && type)
            return `${type}: ${val}`;
        if (val)
            return val;
        if (type)
            return type;
    }
    const msg = asString(event.message);
    return msg ?? 'Untitled Sentry event';
}
function mapSeverity(level) {
    switch ((level ?? '').toLowerCase()) {
        case 'fatal':
            return 'p1';
        case 'error':
            return 'p2';
        case 'warning':
            return 'p3';
        case 'info':
        case 'debug':
            return 'p4';
        default:
            return 'unknown';
    }
}
function extractStack(event) {
    const frames = findFrames(event);
    if (!frames || frames.length === 0)
        return {};
    // Sentry stores frames oldest-first; most-recent call is the last one.
    // Render "most-recent-call-last" — top of the printed trace is innermost.
    // The spec says top is innermost — which in stdout convention means the
    // innermost (deepest) frame appears first. To match that we print
    // reversed: deepest (last element) first, outermost last.
    const lines = [];
    for (let i = frames.length - 1; i >= 0; i--) {
        const f = frames[i];
        const fn = f.function || '<anonymous>';
        const file = f.filename || f.absPath || '<unknown>';
        const ln = typeof f.lineNo === 'number' ? f.lineNo : 0;
        lines.push(`    at ${fn} (${file}:${ln})`);
    }
    const stackTrace = lines.join('\n');
    // Failing symbol: first in_app frame (walking deepest-first), else
    // fall back to the deepest frame.
    let chosen;
    for (let i = frames.length - 1; i >= 0; i--) {
        const f = frames[i];
        if (f.inApp === true) {
            chosen = f;
            break;
        }
    }
    if (!chosen)
        chosen = frames[frames.length - 1];
    const failingSymbol = chosen
        ? {
            file: chosen.filename || chosen.absPath || '<unknown>',
            function: chosen.function || '<anonymous>',
            line: typeof chosen.lineNo === 'number' ? chosen.lineNo : 0,
        }
        : undefined;
    return { stackTrace, failingSymbol };
}
function findFrames(event) {
    // event.exception.values[0].stacktrace.frames[]
    const exception = event.exception;
    if (!isObject(exception))
        return undefined;
    const values = exception.values;
    if (!Array.isArray(values) || values.length === 0)
        return undefined;
    const first = values[0];
    if (!isObject(first))
        return undefined;
    const stack = first.stacktrace;
    if (!isObject(stack))
        return undefined;
    const frames = stack.frames;
    if (!Array.isArray(frames))
        return undefined;
    const out = [];
    for (const f of frames) {
        if (!isObject(f))
            continue;
        out.push({
            function: asString(f.function),
            filename: asString(f.filename),
            absPath: asString(f.abs_path) ?? asString(f.absPath),
            lineNo: asNumber(f.lineno) ??
                asNumber(f.lineNo) ??
                asNumber(f.line_no),
            inApp: typeof f.in_app === 'boolean'
                ? f.in_app
                : typeof f.inApp === 'boolean'
                    ? f.inApp
                    : undefined,
        });
    }
    return out;
}
function extractRequest(event) {
    const req = event.request;
    if (!isObject(req))
        return undefined;
    // Preserve the native structure but normalize common keys.
    const r = req;
    const method = asString(r.method);
    const url = asString(r.url);
    const data = r.data;
    const headers = r.headers;
    const queryString = r.query_string ?? r.queryString;
    const cookies = r.cookies;
    const out = {};
    if (method !== undefined)
        out.method = method;
    if (url !== undefined)
        out.url = url;
    if (data !== undefined)
        out.data = data;
    if (headers !== undefined)
        out.headers = headers;
    if (queryString !== undefined)
        out.queryString = queryString;
    if (cookies !== undefined)
        out.cookies = cookies;
    return Object.keys(out).length > 0 ? out : undefined;
}
function extractTags(event) {
    const raw = event.tags;
    if (!Array.isArray(raw) || raw.length === 0)
        return {};
    const env = {};
    const tags = [];
    for (const t of raw) {
        // Sentry tags come as [key, value] or {key, value}.
        let key;
        let value;
        if (Array.isArray(t) && t.length >= 2) {
            key = asString(t[0]);
            value = asString(t[1]);
        }
        else if (isObject(t)) {
            key = asString(t.key);
            value = asString(t.value);
        }
        if (!key || value === undefined)
            continue;
        env[key] = value;
        tags.push(`${key}:${value}`);
    }
    return {
        env: Object.keys(env).length > 0 ? env : undefined,
        tags: tags.length > 0 ? tags : undefined,
    };
}
function resolveAffectedUsers(event) {
    const direct = asNumber(event.userCount) ?? asNumber(event.user_count);
    if (direct !== undefined)
        return direct;
    if (isObject(event.count)) {
        const c = asNumber(event.count.users);
        if (c !== undefined)
            return c;
    }
    return undefined;
}
//# sourceMappingURL=sentry-parser.js.map