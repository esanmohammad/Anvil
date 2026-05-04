/**
 * test-share — HMAC-signed share tokens for read-only TestSpec URLs.
 *
 * A test share token is an opaque, signed, self-contained capability that
 * lets a third party view a specific (project, slug, version) tuple of a
 * TestSpec for a bounded window without authenticating to the dashboard.
 * The token embeds its own expiry and is verified entirely from the shared
 * secret — no server-side session store is required.
 *
 * Token format:
 *   base64url(JSON.stringify(payload)) + "." + base64url(hmac)
 *
 * The HMAC is computed over the base64url-encoded payload, not the raw JSON,
 * so both parts round-trip deterministically through the dot separator.
 *
 * This module mirrors `plan-share.ts` almost verbatim; the only divergences
 * are the function/export names and the on-disk secret filename, so that
 * plan-share and test-share tokens cannot accidentally verify against each
 * other's secrets.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────

export interface TestShareTokenPayload {
  project: string;
  slug: string;
  version: number;       // freeze to a specific TestSpec version
  expiresAt: number;     // unix ms
}

export const TEST_SHARE_TOKEN_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

// ── base64url helpers ────────────────────────────────────────────────────
//
// Node's Buffer supports 'base64url' encoding natively (>= 14.18 / 16), so
// we lean on it instead of manually patching `+`, `/`, and `=`.

function b64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buf.toString('base64url');
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

// ── Token sign / verify ──────────────────────────────────────────────────

function hmacSign(encodedPayload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(encodedPayload).digest();
}

export function signTestShareToken(payload: TestShareTokenPayload, secret: string): string {
  const encodedPayload = b64urlEncode(JSON.stringify(payload));
  const sig = hmacSign(encodedPayload, secret);
  return `${encodedPayload}.${b64urlEncode(sig)}`;
}

export function verifyTestShareToken(token: string, secret: string): TestShareTokenPayload | null {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [encodedPayload, encodedSig] = parts;
  if (!encodedPayload || !encodedSig) return null;

  const expected = hmacSign(encodedPayload, secret);
  let provided: Buffer;
  try {
    provided = b64urlDecode(encodedSig);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let payload: TestShareTokenPayload;
  try {
    const raw = b64urlDecode(encodedPayload).toString('utf-8');
    payload = JSON.parse(raw) as TestShareTokenPayload;
  } catch {
    return null;
  }

  // Minimal shape guard — we trust signed payloads but defensive parsing
  // protects against future schema drift.
  if (
    typeof payload.project !== 'string' ||
    typeof payload.slug !== 'string' ||
    typeof payload.version !== 'number' ||
    typeof payload.expiresAt !== 'number'
  ) {
    return null;
  }

  if (payload.expiresAt < Date.now()) return null;

  return payload;
}

// ── Secret bootstrapping ─────────────────────────────────────────────────

/**
 * Read ~/.anvil/test-share-secret, or generate a fresh 64-byte hex secret,
 * persisted with mode 0600 so only the owner can read it.
 */
export function getOrCreateTestShareSecret(anvilHome: string): string {
  const secretPath = join(anvilHome, 'test-share-secret');
  if (existsSync(secretPath)) {
    const contents = readFileSync(secretPath, 'utf-8').trim();
    if (contents) return contents;
  }
  // Ensure parent exists before writing.
  const parent = dirname(secretPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const secret = randomBytes(64).toString('hex');
  writeFileSync(secretPath, secret, { encoding: 'utf-8', mode: 0o600 });
  // writeFileSync only honours `mode` on file creation; explicitly chmod in
  // case the file pre-existed with different permissions.
  try {
    chmodSync(secretPath, 0o600);
  } catch {
    // Best effort — Windows does not implement POSIX perms; not a fatal
    // error.
  }
  return secret;
}
