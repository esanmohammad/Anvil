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

import type { IncidentSeverity } from '../incident-types.js';
import {
  asNumber,
  asString,
  isObject,
  toIso,
  type ParsedIncident,
} from './types.js';

// ── Public API ──────────────────────────────────────────────────────────

export function parseIncidentIoEvent(raw: unknown): ParsedIncident {
  if (!isObject(raw)) {
    throw new Error('parseIncidentIoEvent: payload is not an object');
  }

  const incident = pickIncident(raw);
  if (!isObject(incident)) {
    throw new Error('parseIncidentIoEvent: no incident body found');
  }

  const externalId = asString(incident.id);
  if (!externalId) {
    throw new Error('parseIncidentIoEvent: missing incident id');
  }

  const url =
    asString(incident.permalink) ??
    asString(incident.url) ??
    asString(incident.reference_url) ??
    '';

  const title =
    asString(incident.name) ??
    asString(incident.summary) ??
    asString(incident.reference) ??
    'Untitled incident.io incident';

  const severity = mapSeverity(resolveSeverityLabel(incident));

  const occurredAt =
    toIso(incident.reported_at) ??
    toIso(incident.created_at) ??
    toIso(incident.started_at) ??
    new Date(0).toISOString();

  const resolvedAt = toIso(incident.resolved_at) ?? toIso(incident.closed_at);

  const summary =
    asString(incident.summary) ??
    asString(incident.description) ??
    title;

  const searchCorpus = buildSearchCorpus(incident);
  const linkedPrUrl = findPrUrl(searchCorpus);

  const tags = extractTags(incident);
  const affectedUsers = resolveAffectedUsers(incident);

  return {
    externalId,
    source: 'incident.io',
    url,
    title,
    severity,
    occurredAt,
    resolvedAt,
    summary,
    linkedPrUrl,
    tags,
    affectedUsers,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function pickIncident(raw: Record<string, unknown>): unknown {
  if (isObject(raw.data) && isObject((raw.data as Record<string, unknown>).incident)) {
    return (raw.data as Record<string, unknown>).incident;
  }
  if (isObject(raw.incident)) return raw.incident;
  return raw;
}

function resolveSeverityLabel(incident: Record<string, unknown>): string | undefined {
  // Severity may appear as a bare string, or nested under `severity.name` /
  // `severity.rank` in the v2 API.
  const sev = incident.severity;
  if (typeof sev === 'string') return sev;
  if (isObject(sev)) {
    return (
      asString((sev as Record<string, unknown>).name) ??
      asString((sev as Record<string, unknown>).slug) ??
      asString((sev as Record<string, unknown>).label)
    );
  }
  return undefined;
}

function mapSeverity(label: string | undefined): IncidentSeverity {
  switch ((label ?? '').toLowerCase()) {
    case 'critical':
    case 'major':
      return 'p1';
    case 'minor':
      return 'p2';
    case 'informational':
    case 'info':
      return 'p3';
    default:
      return 'unknown';
  }
}

function buildSearchCorpus(incident: Record<string, unknown>): string {
  const parts: string[] = [];
  const summary = asString(incident.summary);
  if (summary) parts.push(summary);
  const description = asString(incident.description);
  if (description) parts.push(description);

  const customFields =
    incident.custom_field_entries ??
    incident.custom_fields ??
    incident.customFields;
  if (Array.isArray(customFields)) {
    for (const entry of customFields) {
      if (!isObject(entry)) continue;
      // v2 shape: { custom_field: {...}, values: [{ value_text, value_link, value_option:{value} }] }
      const values = (entry as Record<string, unknown>).values;
      if (Array.isArray(values)) {
        for (const v of values) {
          if (!isObject(v)) continue;
          const vv = v as Record<string, unknown>;
          const txt =
            asString(vv.value_text) ??
            asString(vv.value_link) ??
            asString(vv.value);
          if (txt) parts.push(txt);
          if (isObject(vv.value_option)) {
            const opt = asString((vv.value_option as Record<string, unknown>).value);
            if (opt) parts.push(opt);
          }
        }
      }
      // Flat shape: { key, value }
      const flat = asString((entry as Record<string, unknown>).value);
      if (flat) parts.push(flat);
    }
  }
  return parts.join('\n');
}

function findPrUrl(text: string): string | undefined {
  if (!text) return undefined;
  const re = /github\.com\/[\w-]+\/[\w-]+\/pull\/\d+/i;
  const m = re.exec(text);
  if (!m) return undefined;
  // Respect an explicit scheme if the preceding chars include one; otherwise
  // synthesize https://.
  const start = m.index;
  const leading = text.slice(Math.max(0, start - 8), start);
  const schemeMatch = /(https?:\/\/)$/i.exec(leading);
  return schemeMatch ? `${schemeMatch[1]}${m[0]}` : `https://${m[0]}`;
}

function extractTags(incident: Record<string, unknown>): string[] | undefined {
  const entries =
    incident.custom_field_entries ??
    incident.custom_fields ??
    incident.customFields;
  if (!Array.isArray(entries)) return undefined;

  const out: string[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const e = entry as Record<string, unknown>;

    // Resolve the key: prefer custom_field.name, fall back to `key`/`name`.
    let key: string | undefined;
    if (isObject(e.custom_field)) {
      key =
        asString((e.custom_field as Record<string, unknown>).name) ??
        asString((e.custom_field as Record<string, unknown>).key);
    }
    key = key ?? asString(e.name) ?? asString(e.key);
    if (!key) continue;

    // Resolve the value: v2 `values[]` array, or a flat `value` string.
    const vals: string[] = [];
    const values = e.values;
    if (Array.isArray(values)) {
      for (const v of values) {
        if (!isObject(v)) continue;
        const vv = v as Record<string, unknown>;
        const t =
          asString(vv.value_text) ??
          asString(vv.value_link) ??
          asString(vv.value) ??
          asString(vv.value_numeric);
        if (t) {
          vals.push(t);
          continue;
        }
        if (isObject(vv.value_option)) {
          const opt = asString((vv.value_option as Record<string, unknown>).value);
          if (opt) vals.push(opt);
        }
      }
    }
    const flat = asString(e.value);
    if (flat) vals.push(flat);

    if (vals.length === 0) continue;
    for (const v of vals) out.push(`${key}:${v}`);
  }
  return out.length > 0 ? out : undefined;
}

function resolveAffectedUsers(incident: Record<string, unknown>): number | undefined {
  return (
    asNumber(incident.affected_users) ??
    asNumber(incident.affectedUsers) ??
    asNumber(incident.impacted_users)
  );
}
