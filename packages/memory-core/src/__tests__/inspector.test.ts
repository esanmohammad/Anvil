/**
 * Phase 13 — MemoryInspector tests.
 *
 * Covers §13.4 acceptance items at the API layer:
 *   - list / detail / proposals / ratify / reject all work
 *   - stats aggregates by kind, subtype, top tags, invalidated count
 *
 * Dashboard React tab + dashboard-server route registration deferred —
 * see ADR §8 Phase 13 deviation note.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';

import {
  HybridMemoryStore,
  MemoryInspector,
} from '../index.js';
import type { Memory, MemoryNamespace } from '../index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-memory-inspector-'));
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
  kind?: Memory['kind'];
  subtype?: Memory['subtype'];
  tags?: string[];
}): Memory {
  const now = new Date().toISOString();
  // Honor an explicit `subtype: undefined` (don't fall back to default).
  const subtype = 'subtype' in opts ? opts.subtype : 'fix-pattern';
  return {
    id: ulid(),
    namespace: opts.ns ?? { scope: 'project', projectId: 'demo' },
    kind: opts.kind ?? 'semantic',
    subtype,
    content: opts.content,
    tags: opts.tags ?? [],
    confidence: 50,
    ttlDays: 30,
    expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString(),
    bitemporal: { validAt: now },
    decay: { lastAccessed: now, strength: 80, rehearseCount: 0 },
    provenance: { createdBy: 'auto-learner', createdAt: now },
  };
}

describe('MemoryInspector — list + detail', () => {
  it('list returns all memories in namespace; detail round-trips a single id', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const inspector = new MemoryInspector(store);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };

      const a = fakeMemory({ content: 'first', ns });
      const b = fakeMemory({ content: 'second', ns });
      store.add(a);
      store.add(b);

      const all = inspector.list({ namespace: ns });
      assert.equal(all.length, 2);

      const detail = inspector.detail(a.id);
      assert.ok(detail);
      assert.equal(detail!.id, a.id);
      assert.equal(detail!.content, 'first');

      assert.equal(inspector.detail('does-not-exist'), null);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('list filters by kind + subtype', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const inspector = new MemoryInspector(store);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      store.add(
        fakeMemory({ content: 'fix1', ns, subtype: 'fix-pattern' }),
      );
      store.add(fakeMemory({ content: 'win1', ns, subtype: 'success' }));
      store.add(fakeMemory({ content: 'win2', ns, subtype: 'success' }));

      const fixes = inspector.list({ namespace: ns, subtype: 'fix-pattern' });
      assert.equal(fixes.length, 1);
      const wins = inspector.list({ namespace: ns, subtype: 'success' });
      assert.equal(wins.length, 2);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('list with search invokes BM25 over the namespace', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const inspector = new MemoryInspector(store);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      store.add(fakeMemory({ content: 'kafka rebalance fix', ns }));
      store.add(fakeMemory({ content: 'unrelated', ns }));

      const hits = inspector.list({ namespace: ns, search: 'kafka' });
      assert.equal(hits.length, 1);
      assert.match(hits[0].content as string, /kafka/);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MemoryInspector — proposal admin', () => {
  it('ratifyProposal moves pending → ratified and writes durable memory', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const inspector = new MemoryInspector(store);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      const candidate = fakeMemory({ content: 'pending fact', ns });
      const proposal = inspector.queue.enqueue(candidate, 'auto-learner');

      const out = inspector.ratifyProposal(proposal.id);
      assert.equal(out.ok, true);
      assert.equal(out.durableMemoryId, candidate.id);
      assert.ok(store.findById(candidate.id));
      assert.equal(inspector.queue.get(proposal.id)?.status, 'ratified');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejectProposal stamps the rejection reason', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const inspector = new MemoryInspector(store);
      const proposal = inspector.queue.enqueue(
        fakeMemory({ content: 'noise' }),
        'reason',
      );
      assert.equal(inspector.rejectProposal(proposal.id, 'too generic'), true);
      assert.equal(inspector.queue.get(proposal.id)?.rejectedReason, 'too generic');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listProposals defaults to pending', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const inspector = new MemoryInspector(store);
      inspector.queue.enqueue(fakeMemory({ content: 'p1' }), 'r1');
      inspector.queue.enqueue(fakeMemory({ content: 'p2' }), 'r2');
      assert.equal(inspector.listProposals().length, 2);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MemoryInspector — stats', () => {
  it('aggregates by kind, subtype, and top tags', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const inspector = new MemoryInspector(store);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      store.add(
        fakeMemory({
          content: 'a',
          ns,
          subtype: 'fix-pattern',
          tags: ['kafka', 'urgent'],
        }),
      );
      store.add(
        fakeMemory({
          content: 'b',
          ns,
          subtype: 'success',
          tags: ['kafka'],
        }),
      );
      store.add(
        fakeMemory({
          content: 'c',
          ns,
          kind: 'episodic',
          subtype: undefined,
          tags: [],
        }),
      );

      const stats = inspector.stats(ns);
      assert.equal(stats.total, 3);
      assert.equal(stats.byKind.semantic, 2);
      assert.equal(stats.byKind.episodic, 1);
      assert.equal(stats.bySubtype['fix-pattern'], 1);
      assert.equal(stats.bySubtype.success, 1);
      const kafka = stats.topTags.find((t) => t.tag === 'kafka');
      assert.ok(kafka);
      assert.equal(kafka!.count, 2);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports invalidated + withCodeBinding counts', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const inspector = new MemoryInspector(store);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      const a = fakeMemory({ content: 'a', ns });
      const b = fakeMemory({ content: 'b', ns });
      const c: Memory = {
        ...fakeMemory({ content: 'c', ns }),
        codeBinding: {
          filePath: 'src/x.ts',
          structuralHash: 'abc',
          lastSeenCommitSha: 'deadbeef',
          lastVerifiedAt: new Date().toISOString(),
        },
      };
      store.add(a);
      store.add(b);
      store.add(c);
      store.invalidate(b.id, new Date().toISOString(), 'test');

      const stats = inspector.stats(ns);
      assert.equal(stats.total, 3);
      assert.equal(stats.invalidated, 1);
      assert.equal(stats.withCodeBinding, 1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
