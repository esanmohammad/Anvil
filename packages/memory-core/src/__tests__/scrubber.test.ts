/**
 * Phase 7 — PII/secret scrubber tests.
 *
 * Covers §7.4 acceptance:
 *   1. All HybridMemoryStore.add() paths go through scrubber
 *   2. Common secret patterns redacted by default
 *   3. Hard-reject path blocks writes
 *   4. ANVIL_MEMORY_SCRUB env switches behavior (off / regex)
 *   5. Optional scrubber override on a per-store basis
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';

import {
  HybridMemoryStore,
  HardRejectError,
  resolveScrubMode,
  scrub,
} from '../index.js';
import type { Memory, MemoryNamespace } from '../index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-memory-scrubber-'));
}

function fakeMemory(content: string, ns?: MemoryNamespace): Memory {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    namespace: ns ?? { scope: 'project', projectId: 'demo' },
    kind: 'semantic',
    subtype: 'fix-pattern',
    content,
    tags: [],
    confidence: 50,
    ttlDays: 30,
    expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString(),
    bitemporal: { validAt: now },
    decay: { lastAccessed: now, strength: 80, rehearseCount: 0 },
    provenance: { createdBy: 'auto-learner', createdAt: now },
  };
}

// ── unit: scrub() ────────────────────────────────────────────────────────

describe('scrub() — regex rules', () => {
  it('redacts an OpenAI key and reports the redaction', () => {
    const result = scrub('here is sk-abcdefghijklmnopqrstuvwxyz123 the key', {
      mode: 'regex',
    });
    assert.match(result.cleaned, /\[REDACTED:openai-api-key\]/);
    assert.equal(result.hardReject, true);
    const r = result.redactions.find((x) => x.rule === 'openai-api-key');
    assert.ok(r);
    assert.equal(r!.count, 1);
  });

  it('redacts an Anthropic key and hard-rejects', () => {
    const r = scrub('token sk-ant-api03-abcdef0123456789ABCDEF0123456789', {
      mode: 'regex',
    });
    assert.match(r.cleaned, /\[REDACTED:anthropic-api-key\]/);
    assert.equal(r.hardReject, true);
  });

  it('redacts AWS access key id', () => {
    const r = scrub('AKIA0123456789ABCDEF some context', { mode: 'regex' });
    assert.match(r.cleaned, /\[REDACTED:aws-access-key-id\]/);
    assert.equal(r.hardReject, true);
  });

  it('redacts an email without hard-rejecting', () => {
    const r = scrub('contact alice@example.com for details', { mode: 'regex' });
    assert.match(r.cleaned, /\[REDACTED:email\]/);
    assert.equal(r.hardReject, false);
    const email = r.redactions.find((x) => x.rule === 'email');
    assert.ok(email);
    assert.equal(email!.category, 'pii');
  });

  it('redacts an SSN', () => {
    const r = scrub('SSN: 123-45-6789', { mode: 'regex' });
    assert.match(r.cleaned, /\[REDACTED:ssn\]/);
  });

  it('redacts a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const r = scrub(`token=${jwt}`, { mode: 'regex' });
    assert.match(r.cleaned, /\[REDACTED:jwt\]/);
    assert.equal(r.hardReject, true);
  });

  it('mode=off passes input through unchanged', () => {
    const r = scrub('sk-shouldnotredact1234567890123', { mode: 'off' });
    assert.equal(r.cleaned, 'sk-shouldnotredact1234567890123');
    assert.equal(r.hardReject, false);
    assert.equal(r.redactions.length, 0);
    assert.equal(r.mode, 'off');
  });

  it('hardRejectOnCredential=false redacts but does not reject', () => {
    const r = scrub('sk-abcdefghijklmnopqrstuvwxyz123', {
      mode: 'regex',
      hardRejectOnCredential: false,
    });
    assert.match(r.cleaned, /\[REDACTED:openai-api-key\]/);
    assert.equal(r.hardReject, false);
  });

  it('clean input returns no redactions', () => {
    const r = scrub('refactor the kafka rebalance fix', { mode: 'regex' });
    assert.equal(r.redactions.length, 0);
    assert.equal(r.hardReject, false);
  });
});

// ── env resolution ───────────────────────────────────────────────────────

describe('resolveScrubMode', () => {
  it('returns regex by default', () => {
    assert.equal(resolveScrubMode({}), 'regex');
  });
  it('honors ANVIL_MEMORY_SCRUB=0 / off / false', () => {
    assert.equal(resolveScrubMode({ ANVIL_MEMORY_SCRUB: '0' }), 'off');
    assert.equal(resolveScrubMode({ ANVIL_MEMORY_SCRUB: 'off' }), 'off');
    assert.equal(resolveScrubMode({ ANVIL_MEMORY_SCRUB: 'false' }), 'off');
  });
  it('honors ANVIL_MEMORY_SCRUB=llm', () => {
    assert.equal(resolveScrubMode({ ANVIL_MEMORY_SCRUB: 'llm' }), 'llm');
  });
});

// ── HybridMemoryStore.add integration ────────────────────────────────────

describe('HybridMemoryStore.add — scrubber integration', () => {
  it('redacts PII before persisting (regex mode)', () => {
    const dir = tempDir();
    try {
      const store = HybridMemoryStore.open({
        jsonlPath: join(dir, 'memory.jsonl'),
        sqlitePath: join(dir, 'memory.sqlite'),
        skipAutoRebuild: true,
        scrubber: { mode: 'regex' },
      });
      const m = fakeMemory('reach me at alice@example.com');
      const report = store.add(m);

      assert.ok(report);
      assert.equal(report!.hardReject, false);

      const after = store.findById(m.id)!;
      assert.match(after.content as string, /\[REDACTED:email\]/);
      assert.doesNotMatch(after.content as string, /alice@example\.com/);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hard-rejects credential-class secrets (default behavior)', () => {
    const dir = tempDir();
    try {
      const store = HybridMemoryStore.open({
        jsonlPath: join(dir, 'memory.jsonl'),
        sqlitePath: join(dir, 'memory.sqlite'),
        skipAutoRebuild: true,
        scrubber: { mode: 'regex' },
      });
      const m = fakeMemory('the key is sk-abcdefghijklmnopqrstuvwxyz123');
      assert.throws(() => store.add(m), HardRejectError);
      // SQLite + JSONL must both be empty after the rejected write.
      assert.equal(store.findById(m.id), null);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mode=off lets credentials through (documented unsafe)', () => {
    const dir = tempDir();
    try {
      const store = HybridMemoryStore.open({
        jsonlPath: join(dir, 'memory.jsonl'),
        sqlitePath: join(dir, 'memory.sqlite'),
        skipAutoRebuild: true,
        scrubber: { mode: 'off' },
      });
      const m = fakeMemory('contact bob@example.com or use sk-keepthis1234567890');
      const report = store.add(m);

      // Off mode short-circuits scrub() — report is still {mode:'off', ...}
      assert.ok(report);
      assert.equal(report!.mode, 'off');
      assert.equal(report!.hardReject, false);

      const after = store.findById(m.id)!;
      // Original content preserved unchanged.
      assert.match(after.content as string, /bob@example\.com/);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
