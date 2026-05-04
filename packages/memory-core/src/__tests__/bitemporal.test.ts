/**
 * Phase 5 — bi-temporal tests.
 *
 * Covers §5.5 acceptance:
 *   1. Memories are never hard-deleted by normal flows
 *   2. validAt query returns historically-correct results
 *   3. invalidate() sets invalid_at + provenance.invalidatedBy
 *   4. Hard-delete only after retention period
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';

import { HybridMemoryStore, MEMORY_LINK_RELATIONS } from '../index.js';
import type { Memory, MemoryNamespace } from '../index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-memory-bitemporal-'));
}

function open(dir: string): HybridMemoryStore {
  return HybridMemoryStore.open({
    jsonlPath: join(dir, 'memory.jsonl'),
    sqlitePath: join(dir, 'memory.sqlite'),
    skipAutoRebuild: true,
  });
}

function fakeMemory(opts: {
  namespace?: MemoryNamespace;
  content: string;
  validAt?: string;
  ttlDays?: number;
  expiresAt?: string;
  tags?: string[];
}): Memory {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    namespace: opts.namespace ?? { scope: 'project', projectId: 'demo' },
    kind: 'semantic',
    subtype: 'fix-pattern',
    content: opts.content,
    tags: opts.tags ?? [],
    confidence: 60,
    ttlDays: opts.ttlDays ?? 30,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000 * 30).toISOString(),
    bitemporal: { validAt: opts.validAt ?? now },
    decay: { lastAccessed: now, strength: 80, rehearseCount: 0 },
    provenance: { createdBy: 'auto-learner', createdAt: now },
  };
}

describe('HybridMemoryStore — invalidate', () => {
  it('sets invalid_at + provenance, never deletes the row', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const m = fakeMemory({ content: 'kafka rebalance fix' });
      store.add(m);

      const ok = store.invalidate(m.id, '2026-04-29T12:00:00.000Z', 'fix obsolete', 'run-1');
      assert.equal(ok, true);

      const after = store.findById(m.id);
      assert.ok(after);
      assert.equal(after!.bitemporal.invalidAt, '2026-04-29T12:00:00.000Z');
      assert.deepEqual(after!.provenance.invalidatedBy, {
        runId: 'run-1',
        reason: 'fix obsolete',
      });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when invalidating an unknown id', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const ok = store.invalidate('does-not-exist', new Date().toISOString(), 'noop');
      assert.equal(ok, false);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('default query() hides invalidated rows', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      const m1 = fakeMemory({ content: 'good fact' });
      const m2 = fakeMemory({ content: 'stale fact' });
      store.add(m1);
      store.add(m2);

      store.invalidate(m2.id, new Date().toISOString(), 'superseded by m1');

      const visible = store.query(ns);
      assert.equal(visible.length, 1);
      assert.equal(visible[0].id, m1.id);

      const withInvalidated = store.query(ns, { includeInvalidated: true });
      assert.equal(withInvalidated.length, 2);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validAt slice returns historically-correct results', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };

      const old = fakeMemory({
        content: 'old kafka fix',
        validAt: '2026-01-01T00:00:00.000Z',
      });
      store.add(old);

      // Invalidate later so the historical query at T0 still sees it.
      store.invalidate(old.id, '2026-03-01T00:00:00.000Z', 'replaced by Phase 4 fix');

      const atFeb = store.query(ns, { validAt: '2026-02-15T00:00:00.000Z' });
      assert.equal(atFeb.length, 1, 'historical query should return the row before invalidation');

      const atApril = store.query(ns, { validAt: '2026-04-15T00:00:00.000Z' });
      assert.equal(atApril.length, 0, 'after invalid_at the row drops out');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('HybridMemoryStore — TTL soft-prune + retention', () => {
  it('pruneExpired soft-deletes (sets invalid_at) instead of removing rows', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const m = fakeMemory({
        content: 'expired fact',
        expiresAt: '2020-01-01T00:00:00.000Z',
      });
      store.add(m);

      const pruned = store.pruneExpired('2026-04-29T00:00:00.000Z');
      assert.equal(pruned, 1);

      const row = store.findById(m.id);
      assert.ok(row, 'row must still exist after soft-prune');
      assert.ok(row!.bitemporal.invalidAt);
      assert.equal(row!.provenance.invalidatedBy?.reason, 'ttl-expired');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hardDeleteInvalidatedOlderThan removes rows past the retention cutoff', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const m = fakeMemory({ content: 'will be retained then deleted' });
      store.add(m);
      store.invalidate(m.id, '2026-01-01T00:00:00.000Z', 'old');

      const beforeCutoff = store.hardDeleteInvalidatedOlderThan(
        '2025-12-31T00:00:00.000Z',
      );
      assert.equal(beforeCutoff, 0, 'retention window not yet reached');
      assert.ok(store.findById(m.id));

      const afterCutoff = store.hardDeleteInvalidatedOlderThan(
        '2026-04-29T00:00:00.000Z',
      );
      assert.equal(afterCutoff, 1);
      assert.equal(store.findById(m.id), null, 'row physically removed');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Memory link relations', () => {
  it('exposes SUPERSEDES as a well-known relation', () => {
    assert.equal(MEMORY_LINK_RELATIONS.SUPERSEDES, 'supersedes');
    assert.equal(MEMORY_LINK_RELATIONS.REFERENCES, 'references');
    assert.equal(MEMORY_LINK_RELATIONS.DERIVED_FROM, 'derived-from');
  });
});
