/**
 * Phase 4 — namespace tests.
 *
 * Covers §4.4 acceptance:
 *   1. Memory carries explicit namespace (Phase 1, but exercised here)
 *   2. Path resolver maps every scope to the documented layout
 *   3. HybridMemoryStore.query filters by namespace
 *   4. queryAll spans namespaces
 *   5. Legacy directory names are interpreted as project-scoped
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';

import {
  HybridMemoryStore,
  namespaceToRelativePath,
  pathToNamespace,
  interpretLegacyDir,
  namespacesEqual,
  namespaceKey,
} from '../index.js';
import type { Memory, MemoryNamespace } from '../index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-memory-namespace-'));
}

function fakeMemory(opts: {
  namespace: MemoryNamespace;
  content: string;
  tags?: string[];
  confidence?: number;
}): Memory {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    namespace: opts.namespace,
    kind: 'semantic',
    subtype: 'fix-pattern',
    content: opts.content,
    tags: opts.tags ?? [],
    confidence: opts.confidence ?? 50,
    ttlDays: 30,
    expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString(),
    bitemporal: { validAt: now },
    decay: { lastAccessed: now, strength: 80, rehearseCount: 0 },
    provenance: { createdBy: 'auto-learner', createdAt: now },
  };
}

// ── path resolver ────────────────────────────────────────────────────────

describe('namespace path-resolver', () => {
  it('maps every scope to the documented layout', () => {
    assert.equal(namespaceToRelativePath({ scope: 'global' }), 'global');
    assert.equal(
      namespaceToRelativePath({ scope: 'user', userId: 'esan' }),
      'user/esan',
    );
    assert.equal(
      namespaceToRelativePath({ scope: 'project', projectId: 'anvil' }),
      'project/anvil',
    );
    assert.equal(
      namespaceToRelativePath({ scope: 'repo', projectId: 'anvil', repoId: 'cli' }),
      'repo/anvil/cli',
    );
  });

  it('throws on missing required ids', () => {
    assert.throws(() =>
      namespaceToRelativePath({ scope: 'user' } as MemoryNamespace),
    );
    assert.throws(() =>
      namespaceToRelativePath({ scope: 'project' } as MemoryNamespace),
    );
    assert.throws(() =>
      namespaceToRelativePath({
        scope: 'repo',
        projectId: 'p',
      } as MemoryNamespace),
    );
  });

  it('round-trips namespace ↔ path for v2 layout', () => {
    const cases: MemoryNamespace[] = [
      { scope: 'global' },
      { scope: 'user', userId: 'esan' },
      { scope: 'project', projectId: 'anvil' },
      { scope: 'repo', projectId: 'anvil', repoId: 'cli' },
    ];
    for (const ns of cases) {
      const rel = namespaceToRelativePath(ns);
      const back = pathToNamespace(rel);
      assert.ok(back, `expected ${rel} to parse`);
      assert.ok(
        namespacesEqual(ns, back!),
        `${JSON.stringify(ns)} ↔ ${rel} ↔ ${JSON.stringify(back)}`,
      );
    }
  });

  it('interprets legacy <project> directories as project-scoped', () => {
    const ns = interpretLegacyDir('feature-factory');
    assert.deepEqual(ns, { scope: 'project', projectId: 'feature-factory' });
  });

  it('treats `global` and `_global` legacy dirs as global scope', () => {
    assert.deepEqual(interpretLegacyDir('global'), { scope: 'global' });
    assert.deepEqual(interpretLegacyDir('_global'), { scope: 'global' });
  });

  it('namespaceKey is stable + collision-free', () => {
    const a: MemoryNamespace = { scope: 'project', projectId: 'p1' };
    const b: MemoryNamespace = { scope: 'project', projectId: 'p2' };
    assert.notEqual(namespaceKey(a), namespaceKey(b));
    assert.equal(namespaceKey(a), namespaceKey({ ...a }));
  });
});

// ── HybridMemoryStore.query / queryAll ────────────────────────────────────

describe('HybridMemoryStore — namespace API', () => {
  it('query() restricts results to the supplied namespace', () => {
    const dir = tempDir();
    try {
      const store = HybridMemoryStore.open({
        jsonlPath: join(dir, 'memory.jsonl'),
        sqlitePath: join(dir, 'memory.sqlite'),
        skipAutoRebuild: true,
      });
      const projA: MemoryNamespace = { scope: 'project', projectId: 'a' };
      const projB: MemoryNamespace = { scope: 'project', projectId: 'b' };
      store.add(fakeMemory({ namespace: projA, content: 'hello A', tags: ['t'] }));
      store.add(fakeMemory({ namespace: projB, content: 'hello B', tags: ['t'] }));

      const aHits = store.query(projA, { tags: ['t'] });
      assert.equal(aHits.length, 1);
      assert.equal(aHits[0].namespace.projectId, 'a');

      const bHits = store.query(projB, { tags: ['t'] });
      assert.equal(bHits.length, 1);
      assert.equal(bHits[0].namespace.projectId, 'b');

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('query() with no opts returns every memory in the namespace', () => {
    const dir = tempDir();
    try {
      const store = HybridMemoryStore.open({
        jsonlPath: join(dir, 'memory.jsonl'),
        sqlitePath: join(dir, 'memory.sqlite'),
        skipAutoRebuild: true,
      });
      const ns: MemoryNamespace = { scope: 'global' };
      store.add(fakeMemory({ namespace: ns, content: 'one' }));
      store.add(fakeMemory({ namespace: ns, content: 'two' }));
      store.add(
        fakeMemory({
          namespace: { scope: 'project', projectId: 'p' },
          content: 'three',
        }),
      );

      const hits = store.query(ns);
      assert.equal(hits.length, 2);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('queryAll() spans every namespace (admin-only)', () => {
    const dir = tempDir();
    try {
      const store = HybridMemoryStore.open({
        jsonlPath: join(dir, 'memory.jsonl'),
        sqlitePath: join(dir, 'memory.sqlite'),
        skipAutoRebuild: true,
      });
      store.add(fakeMemory({ namespace: { scope: 'global' }, content: 'g' }));
      store.add(
        fakeMemory({
          namespace: { scope: 'project', projectId: 'p' },
          content: 'p',
        }),
      );
      const all = store.queryAll();
      assert.equal(all.length, 2);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('query() honors text search inside the namespace', () => {
    const dir = tempDir();
    try {
      const store = HybridMemoryStore.open({
        jsonlPath: join(dir, 'memory.jsonl'),
        sqlitePath: join(dir, 'memory.sqlite'),
        skipAutoRebuild: true,
      });
      const projA: MemoryNamespace = { scope: 'project', projectId: 'a' };
      store.add(
        fakeMemory({
          namespace: projA,
          content: 'kafka rebalance fix',
        }),
      );
      store.add(
        fakeMemory({
          namespace: projA,
          content: 'unrelated note',
        }),
      );
      store.add(
        fakeMemory({
          namespace: { scope: 'project', projectId: 'b' },
          content: 'kafka rebalance fix in B',
        }),
      );

      const hits = store.query(projA, { text: 'kafka' });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].namespace.projectId, 'a');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
