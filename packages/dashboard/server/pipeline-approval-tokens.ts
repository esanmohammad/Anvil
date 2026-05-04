/**
 * pipeline-approval-tokens — HMAC-signed, TTL-bound capability tokens for
 * one-click approve/reject links embedded in pipeline-pause notifications.
 *
 * Token format:  base64url(JSON.stringify({runId, action, exp})) + "." + base64url(hmac)
 * The HMAC is SHA-256 over the encoded payload. Verification uses
 * `crypto.timingSafeEqual` so signature checks are constant-time, and expired
 * or malformed tokens return `null` rather than throwing — callers treat null
 * uniformly as "deny".
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────

export type ApprovalAction = 'approve' | 'reject';

export interface ApprovalPayload {
  runId: string;
  action: ApprovalAction;
  /** Expiry — unix ms. */
  exp: number;
}

export const APPROVAL_DEFAULT_TTL_HOURS = 24;

// ── base64url helpers ────────────────────────────────────────────────────

function b64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buf.toString('base64url');
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

// ── Secret bootstrap ─────────────────────────────────────────────────────

/**
 * Read `<anvilHome>/secrets/pipeline-approval-secret`, or generate a fresh
 * 32-byte hex secret, persisted with mode 0600. Windows has no POSIX perms,
 * so `chmod` failures there are swallowed.
 */
export function getOrCreateApprovalSecret(anvilHome: string): string {
  const secretDir = join(anvilHome, 'secrets');
  const secretPath = join(secretDir, 'pipeline-approval-secret');

  if (existsSync(secretPath)) {
    const contents = readFileSync(secretPath, 'utf-8').trim();
    if (contents) return contents;
  }

  if (!existsSync(secretDir)) mkdirSync(secretDir, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretPath, secret, { encoding: 'utf-8', mode: 0o600 });
  // writeFileSync only honours `mode` on file creation; explicitly chmod in
  // case the file pre-existed or the umask masked the mode bits.
  try {
    chmodSync(secretPath, 0o600);
  } catch {
    /* best-effort on platforms without POSIX perms */
  }
  // Also tighten the parent directory (best-effort) so a stray world-read
  // on the parent doesn't leak the secret on shared hosts.
  try {
    chmodSync(secretDir, 0o700);
  } catch {
    /* best-effort */
  }
  return secret;
}

// ── Sign / verify ────────────────────────────────────────────────────────

function hmacSign(encodedPayload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(encodedPayload).digest();
}

/**
 * Create a signed approval token. `ttlHours` defaults to 24 — short enough
 * that leaked tokens expire before most incident reviews, long enough that a
 * reviewer returning from vacation can still act.
 */
export function createApprovalToken(
  runId: string,
  action: ApprovalAction,
  secret: string,
  ttlHours: number = APPROVAL_DEFAULT_TTL_HOURS,
): string {
  const exp = Date.now() + ttlHours * 3600 * 1000;
  const payload: ApprovalPayload = { runId, action, exp };
  const encodedPayload = b64urlEncode(JSON.stringify(payload));
  const sig = hmacSign(encodedPayload, secret);
  return `${encodedPayload}.${b64urlEncode(sig)}`;
}

/**
 * Verify a token. Returns the decoded payload on success, `null` on any
 * failure — malformed, bad signature, expired. Signature compare is
 * constant-time.
 */
export function verifyApprovalToken(token: string, secret: string): ApprovalPayload | null {
  if (typeof token !== 'string' || !token) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encodedPayload, encodedSig] = parts;
  if (!encodedPayload || !encodedSig) return null;

  let provided: Buffer;
  try {
    provided = b64urlDecode(encodedSig);
  } catch {
    return null;
  }
  const expected = hmacSign(encodedPayload, secret);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let payload: ApprovalPayload;
  try {
    const raw = b64urlDecode(encodedPayload).toString('utf-8');
    payload = JSON.parse(raw) as ApprovalPayload;
  } catch {
    return null;
  }

  if (
    typeof payload.runId !== 'string' ||
    (payload.action !== 'approve' && payload.action !== 'reject') ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }

  if (payload.exp < Date.now()) return null;

  return payload;
}
