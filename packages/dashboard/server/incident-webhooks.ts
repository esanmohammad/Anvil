/**
 * incident-webhooks — HTTP webhook receivers for Anvil's bug-to-test replay
 * feature (Phase 2).
 *
 * Exposes three endpoints:
 *   - POST /api/incidents/webhook/sentry       (X-Sentry-Hook-Signature, HMAC-SHA256)
 *   - POST /api/incidents/webhook/incidentio   (X-Incident-Signature-V1,   HMAC-SHA256)
 *   - POST /api/incidents/webhook/generic      (X-Anvil-Signature,         HMAC-SHA256)
 *
 * Each handler:
 *   1. Reads the raw JSON body (415 on wrong content-type).
 *   2. Verifies the HMAC-SHA256 of that raw body against a shared secret read
 *      from disk (~/.anvil/secrets/...), using `crypto.timingSafeEqual` on
 *      equal-length buffers. 401 on mismatch.
 *   3. Parses the payload with the matching per-source parser (400 on failure).
 *   4. Invokes `ctx.onIncident(parsed, autoReplay)` so the caller can persist
 *      + enqueue a replay job.
 *   5. Responds 202 `{ ok: true, incidentId }` on accept.
 *
 * Signature-header encodings accepted:
 *   - Hex digest
 *   - Base64 / base64url digest
 *   - "sha256=<hex>" prefix (the common GitHub / incident.io convention)
 *
 * The project is resolved from `?project=<name>` or `X-Anvil-Project`. The
 * dispatcher wires that resolution through `ctx.resolveProject(url)`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { parseSentryEvent } from './incident-parsers/sentry-parser.js';
import { parseIncidentIoEvent } from './incident-parsers/incidentio-parser.js';
import type { ParsedIncident } from './incident-parsers/types.js';

// ── Public types ─────────────────────────────────────────────────────────

export interface WebhookContext {
  anvilHome: string;
  project: string;
  onIncident: (parsed: ParsedIncident, autoReplay: boolean) => Promise<void>;
}

export interface DispatcherContext {
  anvilHome: string;
  onIncident: (parsed: ParsedIncident, autoReplay: boolean) => Promise<void>;
  resolveProject: (url: URL) => string | null;
}

// ── URL routing ──────────────────────────────────────────────────────────

const SENTRY_PATH = '/api/incidents/webhook/sentry';
const INCIDENTIO_PATH = '/api/incidents/webhook/incidentio';
const GENERIC_PATH = '/api/incidents/webhook/generic';

/**
 * Routes a webhook request to the correct handler. Returns `true` if this
 * dispatcher handled the request (success OR error response), `false` if the
 * URL did not match any webhook endpoint and the caller should keep routing.
 */
export async function dispatchIncidentWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DispatcherContext,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (path !== SENTRY_PATH && path !== INCIDENTIO_PATH && path !== GENERIC_PATH) {
    return false;
  }
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    writeJson(res, 405, { error: 'Method not allowed — use POST' });
    return true;
  }

  const project = ctx.resolveProject(url);
  if (!project) {
    writeJson(res, 400, { error: 'Missing project (use ?project=<name> or X-Anvil-Project header)' });
    return true;
  }

  const handlerCtx: WebhookContext = {
    anvilHome: ctx.anvilHome,
    project,
    onIncident: ctx.onIncident,
  };

  if (path === SENTRY_PATH) return handleSentryWebhook(req, res, handlerCtx);
  if (path === INCIDENTIO_PATH) return handleIncidentIoWebhook(req, res, handlerCtx);
  return handleGenericWebhook(req, res, handlerCtx);
}

/**
 * Default helper for dispatchers: resolves project from `?project=<name>` or
 * `X-Anvil-Project` header. Returns `null` if neither is present / non-empty.
 */
export function resolveProjectFromRequest(
  req: IncomingMessage,
  url: URL,
): string | null {
  const fromQuery = url.searchParams.get('project');
  if (fromQuery && fromQuery.trim()) return fromQuery.trim();
  const hdr = req.headers['x-anvil-project'];
  if (typeof hdr === 'string' && hdr.trim()) return hdr.trim();
  if (Array.isArray(hdr) && hdr[0] && hdr[0].trim()) return hdr[0].trim();
  return null;
}

// ── Sentry ───────────────────────────────────────────────────────────────

export async function handleSentryWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: WebhookContext,
): Promise<boolean> {
  return runWebhook(req, res, ctx, {
    signatureHeader: 'x-sentry-hook-signature',
    secretPath: join(ctx.anvilHome, 'secrets', 'sentry-webhook-secret'),
    parse: parseSentryEvent,
  });
}

// ── incident.io ──────────────────────────────────────────────────────────

export async function handleIncidentIoWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: WebhookContext,
): Promise<boolean> {
  return runWebhook(req, res, ctx, {
    signatureHeader: 'x-incident-signature-v1',
    secretPath: join(ctx.anvilHome, 'secrets', 'incidentio-webhook-secret'),
    parse: parseIncidentIoEvent,
  });
}

// ── Generic ──────────────────────────────────────────────────────────────

export async function handleGenericWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: WebhookContext,
): Promise<boolean> {
  return runWebhook(req, res, ctx, {
    signatureHeader: 'x-anvil-signature',
    secretPath: join(
      ctx.anvilHome,
      'secrets',
      `generic-webhook-secret-${sanitizeProject(ctx.project)}`,
    ),
    parse: parseGenericEvent,
  });
}

// ── Internals ────────────────────────────────────────────────────────────

interface RunWebhookOpts {
  signatureHeader: string;
  secretPath: string;
  parse: (raw: unknown) => ParsedIncident;
}

async function runWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: WebhookContext,
  opts: RunWebhookOpts,
): Promise<boolean> {
  // 1. Content-Type must be JSON (415 otherwise).
  if (!isJsonContentType(req)) {
    writeJson(res, 415, { error: 'Unsupported Media Type — expected application/json' });
    return true;
  }

  // 2. Read raw body (we HMAC over the bytes, not the parsed JSON).
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    writeJson(res, 400, { error: err instanceof Error ? err.message : 'Body read failure' });
    return true;
  }

  // 3. Verify HMAC-SHA256 signature, timing-safe.
  const providedSig = headerString(req.headers[opts.signatureHeader]);
  const secret = readOrCreateSecret(opts.secretPath);
  if (!providedSig || !verifyHmacSha256(rawBody, secret, providedSig)) {
    writeJson(res, 401, { error: 'Invalid or missing signature' });
    return true;
  }

  // 4. Parse JSON + per-source normalization (400 on failure).
  let parsed: ParsedIncident;
  try {
    const json = JSON.parse(rawBody.toString('utf-8')) as unknown;
    parsed = opts.parse(json);
  } catch (err) {
    writeJson(res, 400, { error: err instanceof Error ? err.message : 'Parse failure' });
    return true;
  }

  // 5. Extract auto-replay preference (header overrides query overrides default).
  const autoReplay = extractAutoReplayFlag(req);

  // 6. Dispatch to the caller-supplied handler.
  try {
    await ctx.onIncident(parsed, autoReplay);
  } catch (err) {
    writeJson(res, 500, { error: err instanceof Error ? err.message : 'onIncident failed' });
    return true;
  }

  // 7. 202 accepted. Caller is responsible for the incidentId; we echo the
  //    externalId so the sender can correlate.
  writeJson(res, 202, { ok: true, incidentId: parsed.externalId });
  return true;
}

function isJsonContentType(req: IncomingMessage): boolean {
  const ct = req.headers['content-type'];
  const s = Array.isArray(ct) ? ct[0] : ct;
  if (!s) return false;
  return /^application\/(?:[\w.+-]+\+)?json\b/i.test(s);
}

function headerString(h: string | string[] | undefined): string | undefined {
  if (typeof h === 'string') return h;
  if (Array.isArray(h) && h.length > 0) return h[0];
  return undefined;
}

function extractAutoReplayFlag(req: IncomingMessage): boolean {
  const hdr = headerString(req.headers['x-anvil-auto-replay']);
  if (hdr !== undefined) return isTruthy(hdr);
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const q = url.searchParams.get('autoReplay');
  if (q !== null) return isTruthy(q);
  return false;
}

function isTruthy(v: string): boolean {
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB safety cap
    req.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk;
      total += buf.length;
      if (total > MAX_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ── Signature verification ───────────────────────────────────────────────

/**
 * Compute HMAC-SHA256(secret, body) and timing-safe compare against `provided`.
 * Accepts hex, base64, base64url, and "sha256=<...>" prefixed encodings.
 * All comparisons use `timingSafeEqual` on equal-length buffers.
 */
export function verifyHmacSha256(body: Buffer, secret: string, provided: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest(); // 32 bytes
  const decoded = decodeSignature(provided);
  if (!decoded) return false;

  // Pad shorter buffer to the same length so timingSafeEqual can be called.
  // If lengths differ the comparison will always fail, but we still want
  // timing-safety so attackers cannot distinguish "wrong length" from
  // "wrong bytes".
  const maxLen = Math.max(expected.length, decoded.length);
  const padA = Buffer.alloc(maxLen, 0);
  const padB = Buffer.alloc(maxLen, 0);
  expected.copy(padA);
  decoded.copy(padB);
  const equalPad = timingSafeEqual(padA, padB);
  return equalPad && expected.length === decoded.length;
}

function decodeSignature(raw: string): Buffer | null {
  let s = raw.trim();
  // Accept the "sha256=<...>" prefix used by GitHub / incident.io.
  const eqIdx = s.indexOf('=');
  if (s.toLowerCase().startsWith('sha256=') || s.toLowerCase().startsWith('sha256 ')) {
    s = s.slice(7).trim();
  } else if (eqIdx === s.length - 1) {
    // trailing '=' means base64 padding — leave as-is
  } else if (
    eqIdx > 0 &&
    /^[a-z0-9_-]+$/i.test(s.slice(0, eqIdx)) &&
    s.slice(0, eqIdx).toLowerCase() !== 'sha256'
  ) {
    // Some formats are "<algo>=<sig>" with a non-sha256 algo; reject.
    return null;
  }
  // Try hex first (most common, deterministic length).
  if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) {
    try {
      return Buffer.from(s, 'hex');
    } catch {
      /* fall through */
    }
  }
  // Then base64 / base64url.
  if (/^[A-Za-z0-9+/_-]+=*$/.test(s)) {
    try {
      // base64url tolerates both encodings in Node.
      return Buffer.from(s, 'base64url');
    } catch {
      /* fall through */
    }
    try {
      return Buffer.from(s, 'base64');
    } catch {
      /* fall through */
    }
  }
  return null;
}

// ── Generic parser ───────────────────────────────────────────────────────

/**
 * Parse a generic webhook payload. The expected shape is a `ParsedIncident`
 * with at least `externalId`, `title`, and `occurredAt`. Unknown fields are
 * dropped silently; missing required fields throw.
 */
export function parseGenericEvent(raw: unknown): ParsedIncident {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('parseGenericEvent: payload is not an object');
  }
  const obj = raw as Record<string, unknown>;
  const externalId = typeof obj.externalId === 'string' ? obj.externalId : undefined;
  const title = typeof obj.title === 'string' ? obj.title : undefined;
  if (!externalId) throw new Error('parseGenericEvent: missing externalId');
  if (!title) throw new Error('parseGenericEvent: missing title');

  const occurredAt =
    typeof obj.occurredAt === 'string' && obj.occurredAt
      ? obj.occurredAt
      : new Date().toISOString();

  return {
    externalId,
    source: 'manual',
    url: typeof obj.url === 'string' ? obj.url : '',
    title,
    severity: isSeverity(obj.severity) ? obj.severity : 'unknown',
    occurredAt,
    resolvedAt: typeof obj.resolvedAt === 'string' ? obj.resolvedAt : undefined,
    summary: typeof obj.summary === 'string' ? obj.summary : title,
    stackTrace: typeof obj.stackTrace === 'string' ? obj.stackTrace : undefined,
    failingSymbol: isFailingSymbol(obj.failingSymbol) ? obj.failingSymbol : undefined,
    requestPayload: obj.requestPayload,
    env: isStringRecord(obj.env) ? obj.env : undefined,
    fixCommit: typeof obj.fixCommit === 'string' ? obj.fixCommit : undefined,
    parentCommit: typeof obj.parentCommit === 'string' ? obj.parentCommit : undefined,
    linkedPrUrl: typeof obj.linkedPrUrl === 'string' ? obj.linkedPrUrl : undefined,
    affectedUsers: typeof obj.affectedUsers === 'number' ? obj.affectedUsers : undefined,
    tags: Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === 'string') : undefined,
  };
}

function isSeverity(v: unknown): v is ParsedIncident['severity'] {
  return v === 'p1' || v === 'p2' || v === 'p3' || v === 'p4' || v === 'unknown';
}

function isFailingSymbol(v: unknown): v is ParsedIncident['failingSymbol'] {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.file === 'string' &&
    typeof r.function === 'string' &&
    typeof r.line === 'number'
  );
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return false;
  }
  return true;
}

// ── Secret management ────────────────────────────────────────────────────

/**
 * Read the secret at `secretPath` if it exists and is non-empty; otherwise
 * generate a fresh 32-byte hex secret, write it atomically with mode 0600, and
 * return it. Idempotent across concurrent callers modulo races on first
 * creation (worst case: a secret is overwritten once, before any webhook has
 * been registered upstream).
 */
export function readOrCreateSecret(secretPath: string): string {
  if (existsSync(secretPath)) {
    const contents = readFileSync(secretPath, 'utf-8').trim();
    if (contents) return contents;
  }
  const parent = dirname(secretPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  // Atomic write via temp-file + rename to avoid a partial file if the process
  // dies mid-write.
  const tmp = `${secretPath}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, secret, { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows: POSIX perms unsupported — best effort */
  }
  renameSync(tmp, secretPath);
  try {
    chmodSync(secretPath, 0o600);
  } catch {
    /* best effort */
  }
  return secret;
}

function sanitizeProject(project: string): string {
  // Keep path separators + control chars out of the secret filename.
  return project.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'default';
}
