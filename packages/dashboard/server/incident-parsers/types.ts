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

// ── Small shared helpers ────────────────────────────────────────────────

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Normalize a date-ish value to an ISO 8601 string. Accepts ISO strings,
 * unix seconds, and unix milliseconds. Returns `undefined` if the input
 * cannot be interpreted as a valid date.
 */
export function toIso(v: unknown): string | undefined {
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
export function findGithubPrUrl(text: string): string | undefined {
  const m = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i.exec(text);
  if (m) return m[0];
  const bare = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i.exec(text);
  return bare ? `https://${bare[0]}` : undefined;
}
