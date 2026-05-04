/**
 * Tests for plan-share module.
 *
 * Uses node:test + node:assert (built-in test runner), matching the style of
 * the other tests in this directory.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';

import {
  SHARE_TOKEN_TTL_MS,
  getOrCreateShareSecret,
  signShareToken,
  verifyShareToken,
} from '../plan-share.js';
import type { SharePayload } from '../plan-share.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const SECRET = 'test-secret-do-not-use-in-prod';

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-share-'));
}

function makePayload(overrides: Partial<SharePayload> = {}): SharePayload {
  return {
    project: 'my-project',
    slug: 'my-plan',
    version: 3,
    expiresAt: Date.now() + SHARE_TOKEN_TTL_MS,
    ...overrides,
  };
}

// ── sign / verify round trip ─────────────────────────────────────────────

describe('signShareToken / verifyShareToken', () => {
  it('round-trips: sign then verify returns the same payload', () => {
    const payload = makePayload();
    const token = signShareToken(payload, SECRET);
    assert.ok(typeof token === 'string' && token.length > 0);
    assert.ok(token.includes('.'), 'token must contain a dot separator');

    const verified = verifyShareToken(token, SECRET);
    assert.ok(verified !== null, 'verification should succeed');
    assert.deepStrictEqual(verified, payload);
  });

  it('fails verification when the payload has been tampered with', () => {
    const payload = makePayload();
    const token = signShareToken(payload, SECRET);

    // Craft a tampered payload and splice it in with the original signature.
    const [, sigPart] = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...payload, slug: 'hacked' }),
      'utf-8',
    ).toString('base64url');
    const tamperedToken = `${tamperedPayload}.${sigPart}`;

    const verified = verifyShareToken(tamperedToken, SECRET);
    assert.equal(verified, null, 'tampered payload must fail');
  });

  it('fails verification when the signature has been tampered with', () => {
    const payload = makePayload();
    const token = signShareToken(payload, SECRET);
    const [payloadPart] = token.split('.');

    // Flip bits in the signature by replacing it with another HMAC over a
    // different secret.
    const wrongSigToken = signShareToken(payload, 'other-secret').split('.')[1];
    const tamperedToken = `${payloadPart}.${wrongSigToken}`;

    const verified = verifyShareToken(tamperedToken, SECRET);
    assert.equal(verified, null, 'tampered signature must fail');
  });

  it('fails verification when the signature is not valid base64url', () => {
    const payload = makePayload();
    const token = signShareToken(payload, SECRET);
    const [payloadPart] = token.split('.');
    const malformed = `${payloadPart}.!!!not-base64!!!`;
    assert.equal(verifyShareToken(malformed, SECRET), null);
  });

  it('fails verification when the token is expired', () => {
    const expiredPayload = makePayload({ expiresAt: Date.now() - 1_000 });
    const token = signShareToken(expiredPayload, SECRET);
    const verified = verifyShareToken(token, SECRET);
    assert.equal(verified, null, 'expired token must fail');
  });

  it('fails verification with a different secret', () => {
    const token = signShareToken(makePayload(), SECRET);
    assert.equal(verifyShareToken(token, 'different-secret'), null);
  });

  it('returns null for malformed tokens', () => {
    assert.equal(verifyShareToken('', SECRET), null);
    assert.equal(verifyShareToken('no-dot-here', SECRET), null);
    assert.equal(verifyShareToken('too.many.dots', SECRET), null);
  });

  it('exports a 7-day default TTL', () => {
    assert.equal(SHARE_TOKEN_TTL_MS, 7 * 24 * 3600 * 1000);
  });
});

// ── getOrCreateShareSecret ───────────────────────────────────────────────

describe('getOrCreateShareSecret', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = createTmpDir();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('creates a new 64-char hex secret when absent', () => {
    const secretPath = join(tmpHome, '.share-secret');
    assert.equal(existsSync(secretPath), false);

    const secret = getOrCreateShareSecret(tmpHome);
    assert.equal(typeof secret, 'string');
    assert.equal(secret.length, 64, '32 random bytes => 64 hex chars');
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.equal(existsSync(secretPath), true);
    assert.equal(readFileSync(secretPath, 'utf-8').trim(), secret);
  });

  it('is idempotent — returns the same secret on subsequent calls', () => {
    const first = getOrCreateShareSecret(tmpHome);
    const second = getOrCreateShareSecret(tmpHome);
    assert.equal(first, second);
  });

  it('writes the secret file with mode 0600 (POSIX only)', () => {
    if (platform() === 'win32') return; // POSIX perms don't apply
    getOrCreateShareSecret(tmpHome);
    const st = statSync(join(tmpHome, '.share-secret'));
    // Mask to permission bits.
    assert.equal(st.mode & 0o777, 0o600);
  });
});
