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

import type { FailingSymbol, IncidentSeverity } from '../incident-types.js';
import {
  asNumber,
  asString,
  isObject,
  toIso,
  type ParsedIncident,
} from './types.js';

// ── parseDatadogAlert ───────────────────────────────────────────────────

export function parseDatadogAlert(raw: unknown): ParsedIncident {
  if (!isObject(raw)) {
    throw new Error('parseDatadogAlert: payload is not an object');
  }

  const alert = pickAlert(raw);
  if (!isObject(alert)) {
    throw new Error('parseDatadogAlert: no alert body found');
  }

  const externalId =
    asString(alert.id) ??
    asString(alert.alert_id) ??
    asString(alert.event_id) ??
    asString(alert.monitor_id);
  if (!externalId) {
    throw new Error('parseDatadogAlert: missing alert id');
  }

  const title = asString(alert.title) ?? asString(alert.alert_title) ?? 'Untitled Datadog alert';
  const severity = mapPriority(asNumber(alert.priority) ?? asNumber(alert.alert_priority));
  const occurredAt =
    toIso(alert.created_at) ??
    toIso(alert.date_happened) ??
    toIso(alert.timestamp) ??
    new Date(0).toISOString();
  const summary = asString(alert.text) ?? asString(alert.message) ?? title;
  const url = asString(alert.url) ?? asString(alert.link) ?? '';

  const { env, tags } = extractTagList(alert.tags);

  return {
    externalId,
    source: 'datadog',
    url,
    title,
    severity,
    occurredAt,
    summary,
    env,
    tags,
  };
}

function pickAlert(raw: Record<string, unknown>): unknown {
  if (isObject(raw.alert)) return raw.alert;
  if (isObject(raw.data) && isObject((raw.data as Record<string, unknown>).alert)) {
    return (raw.data as Record<string, unknown>).alert;
  }
  return raw;
}

function mapPriority(priority: number | undefined): IncidentSeverity {
  switch (priority) {
    case 1:
      return 'p1';
    case 2:
      return 'p2';
    case 3:
      return 'p3';
    case 4:
      return 'p4';
    default:
      return 'p3';
  }
}

// ── parseDatadogSpan ────────────────────────────────────────────────────

export function parseDatadogSpan(raw: unknown): ParsedIncident {
  if (!isObject(raw)) {
    throw new Error('parseDatadogSpan: payload is not an object');
  }

  const span = pickSpan(raw);
  if (!isObject(span)) {
    throw new Error('parseDatadogSpan: no span body found');
  }

  const externalId =
    asString(span.trace_id) ??
    asString(span.traceId) ??
    asString(span.span_id) ??
    asString(span.id);
  if (!externalId) {
    throw new Error('parseDatadogSpan: missing trace/span id');
  }

  const meta = isObject(span.meta) ? (span.meta as Record<string, unknown>) : {};

  const resourceName =
    asString(span.resource_name) ??
    asString(span.resource) ??
    asString(span.name);
  const serviceName = asString(span.service) ?? asString(meta['service.name']);

  const title =
    asString(meta['error.type']) ??
    asString(meta['error.message']) ??
    resourceName ??
    serviceName ??
    'Untitled Datadog span';

  const summary =
    asString(meta['error.message']) ??
    asString(meta['error.msg']) ??
    asString(span.text) ??
    title;

  const stackTrace = asString(meta['error.stack']) ?? asString(meta['error.stacktrace']);

  const failingSymbol = stackTrace
    ? buildFailingSymbol(stackTrace, resourceName)
    : undefined;

  const requestPayload = buildRequestPayload(meta);
  const { env, tags } = extractTagList(span.tags);

  const occurredAt =
    toIso(span.start) ??
    toIso(span.start_time) ??
    toIso(span.timestamp) ??
    new Date(0).toISOString();

  const url =
    asString(span.url) ??
    asString(meta['dd.trace_url']) ??
    (externalId ? `https://app.datadoghq.com/apm/trace/${externalId}` : '');

  return {
    externalId,
    source: 'datadog',
    url,
    title,
    severity: 'p3',
    occurredAt,
    summary,
    stackTrace,
    failingSymbol,
    requestPayload,
    env,
    tags,
  };
}

function pickSpan(raw: Record<string, unknown>): unknown {
  if (isObject(raw.span)) return raw.span;
  if (isObject(raw.data) && isObject((raw.data as Record<string, unknown>).span)) {
    return (raw.data as Record<string, unknown>).span;
  }
  if (isObject(raw.attributes)) {
    // Events API shape: { attributes: { ... span fields ... } }
    return raw.attributes;
  }
  return raw;
}

function buildFailingSymbol(
  stackTrace: string,
  resourceName: string | undefined,
): FailingSymbol | undefined {
  const firstFrame = parseFirstStackFrame(stackTrace);
  if (!firstFrame) {
    if (resourceName) {
      return { file: '<unknown>', function: resourceName, line: 0 };
    }
    return undefined;
  }
  return {
    file: firstFrame.file,
    function: resourceName ?? firstFrame.function,
    line: firstFrame.line,
  };
}

function parseFirstStackFrame(
  stackTrace: string,
): { file: string; function: string; line: number } | undefined {
  for (const rawLine of stackTrace.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // v8: at fn (file:line:col)
    let m = /^at\s+(.+?)\s+\((.+?):(\d+)(?::\d+)?\)$/.exec(line);
    if (m) return { function: m[1]!, file: m[2]!, line: Number(m[3]) };

    // v8 without function: at file:line:col
    m = /^at\s+(.+?):(\d+)(?::\d+)?$/.exec(line);
    if (m) return { function: '<anonymous>', file: m[1]!, line: Number(m[2]) };

    // Python: File "file", line N, in fn
    m = /^File\s+"(.+?)",\s+line\s+(\d+),\s+in\s+(.+)$/.exec(line);
    if (m) return { file: m[1]!, line: Number(m[2]), function: m[3]! };

    // Java: at class.method(File.java:line)
    m = /^at\s+([\w.$<>]+)\((.+?):(\d+)\)$/.exec(line);
    if (m) return { function: m[1]!, file: m[2]!, line: Number(m[3]) };
  }
  return undefined;
}

function buildRequestPayload(meta: Record<string, unknown>): unknown {
  const method = asString(meta['http.method']);
  const url = asString(meta['http.url']);
  const status = asNumber(meta['http.status_code']) ?? asString(meta['http.status_code']);
  const route = asString(meta['http.route']);
  const userAgent = asString(meta['http.useragent']);

  const out: Record<string, unknown> = {};
  if (method !== undefined) out.method = method;
  if (url !== undefined) out.url = url;
  if (status !== undefined) out.statusCode = status;
  if (route !== undefined) out.route = route;
  if (userAgent !== undefined) out.userAgent = userAgent;
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── Shared ──────────────────────────────────────────────────────────────

/**
 * Datadog tag lists arrive as either `["env:prod", "service:api"]` or
 * (rarely) as an object map. We emit both an `env` record and a `tags`
 * passthrough list so downstream consumers can pick either.
 */
function extractTagList(raw: unknown): {
  env?: Record<string, string>;
  tags?: string[];
} {
  if (!raw) return {};
  const env: Record<string, string> = {};
  const tags: string[] = [];

  const pushPair = (key: string, value: string): void => {
    env[key] = value;
    tags.push(`${key}:${value}`);
  };

  const pushRaw = (s: string): void => {
    const idx = s.indexOf(':');
    if (idx > 0) {
      const k = s.slice(0, idx);
      const v = s.slice(idx + 1);
      pushPair(k, v);
    } else {
      tags.push(s);
    }
  };

  if (Array.isArray(raw)) {
    for (const t of raw) {
      if (typeof t === 'string') pushRaw(t);
      else if (isObject(t)) {
        const k = asString((t as Record<string, unknown>).key);
        const v = asString((t as Record<string, unknown>).value);
        if (k && v !== undefined) pushPair(k, v);
      }
    }
  } else if (isObject(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      const vv = asString(v);
      if (vv !== undefined) pushPair(k, vv);
    }
  }

  return {
    env: Object.keys(env).length > 0 ? env : undefined,
    tags: tags.length > 0 ? tags : undefined,
  };
}
