/**
 * Phase 9 — Personalized PageRank tests.
 *
 * Covers §9.4 acceptance items reachable in this phase:
 *   - PPR implemented in pure TS (this module)
 *   - Per-namespace subgraph extraction
 *   - Multi-hop transitivity: scores reach nodes 2+ hops from seeds
 *
 * Recognition-filter LLM call (§9.2.2) deferred to Phase 10 once
 * memory-core gains a LanguageModel registry — pprSearch already
 * accepts caller-provided seeds, so the integration is forward-compat.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';

import {
  HybridMemoryStore,
  extractNamespaceSubgraph,
  personalizedPageRank,
  pprSearch,
  MEMORY_LINK_RELATIONS,
} from '../index.js';
import type { Memory, MemoryNamespace, PprAdjacency } from '../index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-memory-ppr-'));
}

function open(dir: string): HybridMemoryStore {
  return HybridMemoryStore.open({
    jsonlPath: join(dir, 'memory.jsonl'),
    sqlitePath: join(dir, 'memory.sqlite'),
    skipAutoRebuild: true,
    scrubber: { mode: 'off' },
  });
}

function fakeMemory(opts: {
  content: string;
  ns?: MemoryNamespace;
  links?: Memory['links'];
}): Memory {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    namespace: opts.ns ?? { scope: 'project', projectId: 'demo' },
    kind: 'semantic',
    subtype: 'fix-pattern',
    content: opts.content,
    tags: [],
    confidence: 60,
    ttlDays: 30,
    expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString(),
    bitemporal: { validAt: now },
    decay: { lastAccessed: now, strength: 80, rehearseCount: 0 },
    provenance: { createdBy: 'auto-learner', createdAt: now },
    links: opts.links,
  };
}

// ── PPR algorithm ─────────────────────────────────────────────────────────

describe('personalizedPageRank', () => {
  it('returns the seed map (normalized) for an isolated graph', () => {
    const adjacency: PprAdjacency = new Map();
    const seeds = new Map<string, number>([['a', 1]]);
    const { scores, converged } = personalizedPageRank(adjacency, seeds);
    assert.equal(converged, true);
    assert.equal(scores.size, 1);
    assert.ok((scores.get('a') ?? 0) > 0);
  });

  it('propagates score along edges (multi-hop transitivity)', () => {
    // a -> b -> c (chain)
    const adjacency: PprAdjacency = new Map([
      ['a', [{ target: 'b', weight: 1 }]],
      ['b', [{ target: 'c', weight: 1 }]],
    ]);
    const { scores, converged } = personalizedPageRank(
      adjacency,
      new Map([['a', 1]]),
    );
    assert.ok(converged);
    const aScore = scores.get('a') ?? 0;
    const bScore = scores.get('b') ?? 0;
    const cScore = scores.get('c') ?? 0;
    // All three nodes should receive non-zero score because the chain
    // reaches every node and dangling mass diffuses back to seed `a`.
    assert.ok(aScore > 0);
    assert.ok(bScore > 0);
    assert.ok(cScore > 0);
    // Closer hop wins more score: a > b > c.
    assert.ok(aScore > bScore);
    assert.ok(bScore > cScore);
  });

  it('weights skew the diffusion', () => {
    // a fans out to b (weight 1) and c (weight 9). c should outscore b.
    const adjacency: PprAdjacency = new Map([
      [
        'a',
        [
          { target: 'b', weight: 1 },
          { target: 'c', weight: 9 },
        ],
      ],
    ]);
    const { scores } = personalizedPageRank(adjacency, new Map([['a', 1]]));
    const bScore = scores.get('b') ?? 0;
    const cScore = scores.get('c') ?? 0;
    assert.ok(cScore > bScore, `expected c > b, got c=${cScore}, b=${bScore}`);
  });

  it('respects maxIterations cap (does not loop forever)', () => {
    const adjacency: PprAdjacency = new Map([
      ['a', [{ target: 'b', weight: 1 }]],
      ['b', [{ target: 'a', weight: 1 }]],
    ]);
    const { iterations } = personalizedPageRank(adjacency, new Map([['a', 1]]), {
      maxIterations: 5,
      epsilon: 0, // force max-iterations
    });
    assert.ok(iterations <= 5);
  });
});

// ── subgraph extraction + pprSearch end-to-end ────────────────────────────

describe('pprSearch', () => {
  it('multi-hop ranking surfaces transitively-related memories', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      const c = fakeMemory({ content: 'leaf C', ns });
      const b = fakeMemory({
        content: 'middle B',
        ns,
        links: [{ targetId: c.id, relation: MEMORY_LINK_RELATIONS.REFERENCES, weight: 1 }],
      });
      const a = fakeMemory({
        content: 'root A',
        ns,
        links: [{ targetId: b.id, relation: MEMORY_LINK_RELATIONS.REFERENCES, weight: 1 }],
      });
      // Order matters: c must exist before b's link is materialized in the
      // graph, but the graph is rebuilt on every upsert so insertion order
      // doesn't change correctness.
      store.add(c);
      store.add(b);
      store.add(a);

      const result = pprSearch(store, ns, [a.id], { limit: 3 });
      assert.equal(result.memories.length, 3);
      // All three nodes should be returned (a is the seed).
      const ids = new Set(result.memories.map((m) => m.id));
      assert.ok(ids.has(a.id));
      assert.ok(ids.has(b.id));
      assert.ok(ids.has(c.id));
      // Score ordering: seed > 1-hop > 2-hop.
      assert.equal(result.memories[0].id, a.id);
      assert.equal(result.memories[1].id, b.id);
      assert.equal(result.memories[2].id, c.id);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extracts a per-namespace subgraph (no cross-namespace bleed)', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const nsA: MemoryNamespace = { scope: 'project', projectId: 'A' };
      const nsB: MemoryNamespace = { scope: 'project', projectId: 'B' };
      const aA = fakeMemory({ content: 'A.first', ns: nsA });
      const bA = fakeMemory({
        content: 'A.second',
        ns: nsA,
        links: [{ targetId: aA.id, relation: MEMORY_LINK_RELATIONS.REFERENCES, weight: 1 }],
      });
      const aB = fakeMemory({ content: 'B.first', ns: nsB });
      store.add(aA);
      store.add(bA);
      store.add(aB);

      const subgraph = extractNamespaceSubgraph(store, nsA);
      // Subgraph should only contain namespace A's memories.
      assert.ok(subgraph.nodes.has(aA.id));
      assert.ok(subgraph.nodes.has(bA.id));
      assert.equal(subgraph.nodes.has(aB.id), false);
      // Edge from bA → aA must be present.
      assert.deepEqual(subgraph.adjacency.get(bA.id), [
        { target: aA.id, weight: 1 },
      ]);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalidated memories are hidden from results by default", () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      const m = fakeMemory({ content: 'fact', ns });
      store.add(m);
      store.invalidate(m.id, new Date().toISOString(), 'test');

      const result = pprSearch(store, ns, [m.id]);
      assert.equal(result.memories.length, 0);

      const withInvalidated = pprSearch(store, ns, [m.id], {
        excludeInvalidated: false,
      });
      assert.equal(withInvalidated.memories.length, 1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
