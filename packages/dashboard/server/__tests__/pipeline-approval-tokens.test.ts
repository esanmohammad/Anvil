/**
 * Tests for pipeline-approval-tokens.
 * Uses node:test + node:assert, matching sibling tests in this directory.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  createApprovalToken,
  verifyApprovalToken,
} from '../pipeline-approval-tokens.js';

const SECRET = 'test-approval-secret-do-not-use-in-prod';

describe('createApprovalToken / verifyApprovalToken', () => {
  it('round-trips a signed token', () => {
    const token = createApprovalToken('run-123', 'approve', SECRET, 1);
    assert.ok(typeof token === 'string' && token.includes('.'));

    const verified = verifyApprovalToken(token, SECRET);
    assert.ok(verified !== null);
    assert.strictEqual(verified.runId, 'run-123');
    assert.strictEqual(verified.action, 'approve');
    assert.ok(verified.exp > Date.now(), 'exp should be in the future');
  });

  it('rejects a token whose signature has been tampered', () => {
    const token = createApprovalToken('run-xyz', 'reject', SECRET, 1);
    const [payload, sig] = token.split('.');
    // Flip one character in the signature — still valid base64url alphabet.
    const flipped = sig.startsWith('a') ? `b${sig.slice(1)}` : `a${sig.slice(1)}`;
    const tampered = `${payload}.${flipped}`;

    assert.strictEqual(verifyApprovalToken(tampered, SECRET), null);
  });

  it('rejects an expired token', () => {
    // TTL of 0 hours → exp is exactly "now", which is not in the future.
    const token = createApprovalToken('run-old', 'approve', SECRET, 0);
    // Small sleep substitute: bump the clock by advancing via a second token
    // generated after a microtask. In practice `exp < Date.now()` on the very
    // next tick because TTL=0 yields exp === createTime.
    // Deterministic check: craft a token with explicitly-past exp.
    const payload = Buffer.from(
      JSON.stringify({ runId: 'run-old', action: 'approve', exp: Date.now() - 1000 }),
    ).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(payload).digest().toString('base64url');
    const expired = `${payload}.${sig}`;

    assert.strictEqual(verifyApprovalToken(expired, SECRET), null);
    // Also sanity-check the TTL=0 token is either already-expired or about to.
    const maybeExpired = verifyApprovalToken(token, SECRET);
    if (maybeExpired !== null) {
      assert.ok(maybeExpired.exp <= Date.now() + 5);
    }
  });

  it('returns null for malformed tokens', () => {
    assert.strictEqual(verifyApprovalToken('', SECRET), null);
    assert.strictEqual(verifyApprovalToken('no-dot-here', SECRET), null);
    assert.strictEqual(verifyApprovalToken('too.many.dots', SECRET), null);
    assert.strictEqual(verifyApprovalToken('.onlyonepart', SECRET), null);
    assert.strictEqual(verifyApprovalToken('onlypart.', SECRET), null);
    // Valid shape, garbage signature bytes.
    assert.strictEqual(verifyApprovalToken('aaaa.bbbb', SECRET), null);
  });
});
