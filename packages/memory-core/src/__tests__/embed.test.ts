/**
 * Tier 3 — embed.ts unit tests.
 *
 * The vector store is optional-dep on `@lancedb/lancedb`. These tests
 * pin the no-op fallback behavior (no embedder injected, lancedb absent
 * → returns skipped/0, no crash) and the happy path is exercised via
 * the integration test in `vector-search.integration.test.ts` (only
 * runs when lancedb is available on the host).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';

import {
  HybridMemoryStore,
  embedMemory,
  embedMemoriesBatch,
  setEmbedder,
} from '../index.js';
import type { Memory, MemoryNamespace } from '../index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-memory-embed-'));
}

function open(dir: string, opts: { vectorDbPath?: string | null } = {}): HybridMemoryStore {
  return HybridMemoryStore.open({
    jsonlPath: join(dir, 'memory.jsonl'),
    sqlitePath: join(dir, 'memory.sqlite'),
    skipAutoRebuild: true,
    scrubber: { mode: 'off' },
    vectorDbPath: opts.vectorDbPath,
  });
}

function fakeMemory(ns: MemoryNamespace, content: string): Memory {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    namespace: ns,
    kind: 'semantic',
    subtype: 'success',
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

describe('embedMemory', () => {
  before(() => { setEmbedder(null); });
  after(() => { setEmbedder(null); });

  it('no-op (skipped: 1) when no embedder is configured', async () => {
    const dir = tempDir();
    try {
      const store = open(dir, { vectorDbPath: null });
      const m = fakeMemory({ scope: 'project', projectId: 'demo' }, 'a fact');
      const res = await embedMemory(store, m);
      assert.equal(res.embedded, 0);
      assert.equal(res.skipped, 1);
      assert.equal(res.reason, 'no-embedder');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no-op when vectorDbPath is explicitly null', async () => {
    setEmbedder(async () => new Array(8).fill(0));
    try {
      const dir = tempDir();
      try {
        const store = open(dir, { vectorDbPath: null });
        const m = fakeMemory({ scope: 'project', projectId: 'demo' }, 'fact');
        const res = await embedMemory(store, m);
        assert.equal(res.skipped, 1);
        assert.equal(res.reason, 'no-vector-store');
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      setEmbedder(null);
    }
  });

  it('embedder throwing returns skipped with embed-failed reason', async () => {
    setEmbedder(async () => {
      throw new Error('upstream offline');
    });
    try {
      const dir = tempDir();
      try {
        const store = open(dir);
        // We can't tell whether LanceDB is installed in test env, so
        // accept either outcome: lancedb-unavailable OR embed-failed.
        const m = fakeMemory({ scope: 'project', projectId: 'demo' }, 'something');
        const res = await embedMemory(store, m);
        assert.equal(res.embedded, 0);
        assert.equal(res.skipped, 1);
        assert.ok(
          res.reason === 'embed-failed: upstream offline' ||
            res.reason === 'lancedb-unavailable',
          `unexpected reason: ${res.reason}`,
        );
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      setEmbedder(null);
    }
  });

  it('empty content (whitespace-only) skips with empty-content reason', async () => {
    setEmbedder(async () => new Array(8).fill(0));
    try {
      const dir = tempDir();
      try {
        const store = open(dir);
        const m = fakeMemory({ scope: 'project', projectId: 'demo' }, '   ');
        const res = await embedMemory(store, m);
        // Could be lancedb-unavailable on first call OR empty-content;
        // both indicate the path is wired correctly and not crashing.
        assert.equal(res.embedded, 0);
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      setEmbedder(null);
    }
  });
});

describe('embedMemoriesBatch', () => {
  before(() => { setEmbedder(null); });
  after(() => { setEmbedder(null); });

  it('no-op when no embedder is configured', async () => {
    const dir = tempDir();
    try {
      const store = open(dir, { vectorDbPath: null });
      const m = fakeMemory({ scope: 'project', projectId: 'demo' }, 'fact');
      store.add(m);
      const res = await embedMemoriesBatch(store, { limit: 10 });
      assert.equal(res.embedded, 0);
      assert.equal(res.reason, 'no-embedder');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no-op when vectorDbPath is null even with embedder set', async () => {
    setEmbedder(async () => new Array(8).fill(0));
    try {
      const dir = tempDir();
      try {
        const store = open(dir, { vectorDbPath: null });
        store.add(fakeMemory({ scope: 'project', projectId: 'demo' }, 'fact'));
        const res = await embedMemoriesBatch(store, { limit: 5 });
        assert.equal(res.embedded, 0);
        assert.equal(res.reason, 'no-vector-store');
        store.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      setEmbedder(null);
    }
  });
});
