/**
 * Phase 8 — hybrid retrieval tests.
 *
 * Covers §8.6 acceptance items reachable in this phase:
 *   - BM25 search returns relevant results for keyword queries
 *   - Graph 1-hop expansion surfaces related memories
 *   - RRF fusion combines streams as expected
 *   - hybridSearch end-to-end produces ranked results
 *
 * Vector retrieval is a Phase-8 stub (returns []) — full benchmark
 * deferred to Phase 10 once sleeptime populates embeddings.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';

import {
  HybridMemoryStore,
  bm25Search,
  expandNeighbors,
  hybridSearch,
  reciprocalRankFusion,
  vectorSearch,
  MEMORY_LINK_RELATIONS,
} from '../index.js';
import type { Memory, MemoryNamespace } from '../index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-memory-retrieve-'));
}

function fakeMemory(opts: {
  content: string;
  ns?: MemoryNamespace;
  tags?: string[];
  links?: Memory['links'];
}): Memory {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    namespace: opts.ns ?? { scope: 'project', projectId: 'demo' },
    kind: 'semantic',
    subtype: 'fix-pattern',
    content: opts.content,
    tags: opts.tags ?? [],
    confidence: 60,
    ttlDays: 30,
    expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString(),
    bitemporal: { validAt: now },
    decay: { lastAccessed: now, strength: 80, rehearseCount: 0 },
    provenance: { createdBy: 'auto-learner', createdAt: now },
    links: opts.links,
  };
}

function open(dir: string): HybridMemoryStore {
  return HybridMemoryStore.open({
    jsonlPath: join(dir, 'memory.jsonl'),
    sqlitePath: join(dir, 'memory.sqlite'),
    skipAutoRebuild: true,
    scrubber: { mode: 'off' }, // tests use raw content
  });
}

// ── BM25 ──────────────────────────────────────────────────────────────────

describe('bm25Search', () => {
  it('ranks documents containing the query terms', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      store.add(fakeMemory({ content: 'kafka rebalance partition assignment' }));
      store.add(fakeMemory({ content: 'something completely unrelated' }));
      store.add(fakeMemory({ content: 'kafka topic auto-create' }));

      const hits = bm25Search(store, 'kafka', { namespace: ns });
      assert.ok(hits.length >= 2);
      for (const h of hits) {
        assert.match(h.content as string, /kafka/);
      }
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for empty queries', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      assert.deepEqual(bm25Search(store, '   '), []);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Graph linking ─────────────────────────────────────────────────────────

describe('graph linking', () => {
  it('persists Memory.links into memory_edge and exposes via neighborsOf', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const target = fakeMemory({ content: 'old fix' });
      store.add(target);
      const source = fakeMemory({
        content: 'new fix',
        links: [{ targetId: target.id, relation: MEMORY_LINK_RELATIONS.SUPERSEDES, weight: 1 }],
      });
      store.add(source);

      const round = store.findById(source.id)!;
      assert.equal(round.links?.length, 1);
      assert.equal(round.links![0].targetId, target.id);
      assert.equal(round.links![0].relation, MEMORY_LINK_RELATIONS.SUPERSEDES);

      const neighbors = expandNeighbors(store, [source]);
      assert.equal(neighbors.length, 1);
      assert.equal(neighbors[0].id, target.id);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects relation filter on neighborsOf', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const a = fakeMemory({ content: 'related a' });
      const b = fakeMemory({ content: 'related b' });
      store.add(a);
      store.add(b);
      const seed = fakeMemory({
        content: 'seed',
        links: [
          { targetId: a.id, relation: MEMORY_LINK_RELATIONS.REFERENCES, weight: 1 },
          { targetId: b.id, relation: MEMORY_LINK_RELATIONS.SUPERSEDES, weight: 1 },
        ],
      });
      store.add(seed);

      const refs = store.neighborsOf([seed.id], {
        relation: MEMORY_LINK_RELATIONS.REFERENCES,
      });
      assert.equal(refs.length, 1);
      assert.equal(refs[0].id, a.id);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Vector stub ───────────────────────────────────────────────────────────

describe('vectorSearch (Phase 8 stub)', () => {
  it('returns [] until Phase 10 sleeptime populates embeddings', async () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const result = await vectorSearch(store, 'anything');
      assert.deepEqual(result, []);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── RRF fusion ────────────────────────────────────────────────────────────

describe('reciprocalRankFusion', () => {
  it('boosts items ranked highly across multiple streams', () => {
    const m1 = fakeMemory({ content: 'one' });
    const m2 = fakeMemory({ content: 'two' });
    const m3 = fakeMemory({ content: 'three' });

    // m1 is rank-1 in both streams; m2 only appears in stream A; m3 only in B.
    const fused = reciprocalRankFusion([
      { results: [m1, m2] },
      { results: [m1, m3] },
    ]);
    assert.equal(fused[0].id, m1.id, 'm1 should win — it appears at rank 1 twice');
    assert.equal(fused.length, 3);
  });

  it('weight on a stream pushes its top hit up', () => {
    const m1 = fakeMemory({ content: 'one' });
    const m2 = fakeMemory({ content: 'two' });
    // Without weighting m2 would tie m1 (each shows up once at rank 1).
    // With weight 5 on the stream returning m2, m2 should win.
    const fused = reciprocalRankFusion([
      { results: [m1] },
      { results: [m2], weight: 5 },
    ]);
    assert.equal(fused[0].id, m2.id);
  });

  it('respects limit', () => {
    const memories = Array.from({ length: 10 }, (_, i) =>
      fakeMemory({ content: `m${i}` }),
    );
    const fused = reciprocalRankFusion([{ results: memories }], { limit: 3 });
    assert.equal(fused.length, 3);
  });
});

// ── hybridSearch end-to-end ───────────────────────────────────────────────

describe('hybridSearch', () => {
  it('returns BM25 hits and graph-expanded neighbors in fused order', async () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      const related = fakeMemory({ content: 'related-via-graph node' });
      store.add(related);
      const seed = fakeMemory({
        content: 'kafka rebalance graph seed',
        links: [{ targetId: related.id, relation: MEMORY_LINK_RELATIONS.REFERENCES, weight: 1 }],
      });
      store.add(seed);

      // Add noise so BM25 has to rank
      store.add(fakeMemory({ content: 'unrelated noise', ns }));

      const fused = await hybridSearch(store, 'kafka', { namespace: ns, limit: 5 });
      const ids = fused.map((m) => m.id);
      assert.ok(ids.includes(seed.id), 'BM25 should surface the seed');
      assert.ok(ids.includes(related.id), 'graph expansion should surface the linked memory');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disableGraph short-circuits graph expansion', async () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      const related = fakeMemory({ content: 'never returned' });
      store.add(related);
      const seed = fakeMemory({
        content: 'stripe webhook bug',
        links: [{ targetId: related.id, relation: MEMORY_LINK_RELATIONS.REFERENCES, weight: 1 }],
      });
      store.add(seed);

      const fused = await hybridSearch(store, 'stripe', {
        namespace: ns,
        disableGraph: true,
      });
      const ids = fused.map((m) => m.id);
      assert.ok(ids.includes(seed.id));
      assert.ok(!ids.includes(related.id), 'graph expansion was disabled');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
