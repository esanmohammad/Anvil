/**
 * Phase 10 — sleeptime / proposal-queue tests.
 *
 * Covers §10.6 acceptance items reachable in this phase:
 *   - Proposal queue enqueue + listPending
 *   - ratify ADD writes to durable store + stamps prov_ratified_at
 *   - ratify MERGE-INTO bumps target confidence + strength
 *   - ratify REJECT marks proposal with reason
 *   - ratify SUPERSEDE adds new memory + invalidates target + links
 *   - consolidate end-to-end with default + custom decideFn
 *
 * Hot-path auto-learner rewrite, cli `anvil memory consolidate`,
 * file-lock concurrency, and LLM-driven contradiction detection
 * are deferred to later phases — see ADR §8 Phase 10 deviation note.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';

import {
  HybridMemoryStore,
  ProposalQueue,
  consolidate,
  contentDigest,
  defaultDecide,
  findNearestDuplicate,
  ratifyProposal,
  MEMORY_LINK_RELATIONS,
} from '../index.js';
import type { Memory, MemoryNamespace } from '../index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-memory-sleeptime-'));
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
  tags?: string[];
  confidence?: number;
}): Memory {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    namespace: opts.ns ?? { scope: 'project', projectId: 'demo' },
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

// ── ProposalQueue ─────────────────────────────────────────────────────────

describe('ProposalQueue', () => {
  it('enqueue + listPending round-trips a proposal', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      const m = fakeMemory({ content: 'pending fact' });
      const proposal = queue.enqueue(m, 'auto-learner saw repeated pattern');

      const pending = queue.listPending();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].id, proposal.id);
      assert.equal(pending[0].status, 'pending');
      assert.equal(pending[0].candidate.id, m.id);
      assert.equal(queue.pendingCount(), 1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listPending filters by namespace', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      queue.enqueue(
        fakeMemory({ content: 'A1', ns: { scope: 'project', projectId: 'A' } }),
        'A1',
      );
      queue.enqueue(
        fakeMemory({ content: 'B1', ns: { scope: 'project', projectId: 'B' } }),
        'B1',
      );
      const onlyA = queue.listPending({
        namespace: { scope: 'project', projectId: 'A' },
      });
      assert.equal(onlyA.length, 1);
      assert.equal((onlyA[0].candidate.content as string), 'A1');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('updateStatus only transitions pending proposals', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      const proposal = queue.enqueue(
        fakeMemory({ content: 'q' }),
        'reason',
      );
      assert.equal(queue.updateStatus(proposal.id, 'rejected', { rejectedReason: 'noise' }), true);
      // Second transition is a no-op (already rejected).
      assert.equal(queue.updateStatus(proposal.id, 'ratified'), false);
      const after = queue.get(proposal.id);
      assert.equal(after?.status, 'rejected');
      assert.equal(after?.rejectedReason, 'noise');
      assert.ok(after?.decidedAt);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── dedupe ────────────────────────────────────────────────────────────────

describe('dedupe', () => {
  it('contentDigest is stable for identical content+tags', () => {
    const a = fakeMemory({ content: 'same', tags: ['x', 'y'] });
    const b = fakeMemory({ content: 'same', tags: ['y', 'x'] });
    assert.equal(contentDigest(a), contentDigest(b));
  });

  it('findNearestDuplicate returns the matching durable memory', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      const existing = fakeMemory({ content: 'kafka rebalance fix', ns });
      store.add(existing);

      const candidate = fakeMemory({ content: 'kafka rebalance fix', ns });
      const dup = findNearestDuplicate(store, candidate);
      assert.ok(dup);
      assert.equal(dup!.exact, true);
      assert.equal(dup!.memory.id, existing.id);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── ratifyProposal ────────────────────────────────────────────────────────

describe('ratifyProposal', () => {
  it("'add' writes to durable + stamps prov_ratified_at", () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      const proposal = queue.enqueue(
        fakeMemory({ content: 'fact' }),
        'auto-learner',
      );

      const outcome = ratifyProposal({
        store,
        queue,
        proposal,
        decision: { kind: 'add' },
      });
      assert.equal(outcome.kind, 'add');
      assert.equal(outcome.durableMemoryId, proposal.candidate.id);

      const ratified = store.findById(proposal.candidate.id);
      assert.ok(ratified);
      assert.ok(ratified!.provenance.ratifiedAt);

      const after = queue.get(proposal.id);
      assert.equal(after?.status, 'ratified');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("'merge-into' bumps target confidence + rehearseCount", () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      const target = fakeMemory({ content: 'kafka fix', confidence: 60 });
      store.add(target);
      const proposal = queue.enqueue(
        fakeMemory({ content: 'kafka fix' }),
        'duplicate signal',
      );

      const outcome = ratifyProposal({
        store,
        queue,
        proposal,
        decision: { kind: 'merge-into', targetId: target.id },
      });
      assert.equal(outcome.kind, 'merge-into');
      assert.equal(outcome.durableMemoryId, target.id);

      const merged = store.findById(target.id)!;
      assert.equal(merged.confidence, 65);
      assert.equal(merged.decay.rehearseCount, 1);
      assert.equal(queue.get(proposal.id)?.status, 'merged-into');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("'reject' marks proposal with reason and does not touch durable", () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      const proposal = queue.enqueue(
        fakeMemory({ content: 'noise' }),
        'low confidence',
      );

      const outcome = ratifyProposal({
        store,
        queue,
        proposal,
        decision: { kind: 'reject', reason: 'too generic' },
      });
      assert.equal(outcome.kind, 'reject');
      assert.equal(store.findById(proposal.candidate.id), null);
      assert.equal(queue.get(proposal.id)?.rejectedReason, 'too generic');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("'supersede' invalidates target + links new memory via SUPERSEDES", () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      const old = fakeMemory({ content: 'old fix' });
      store.add(old);
      const proposal = queue.enqueue(
        fakeMemory({ content: 'better fix' }),
        'contradicts old fix',
      );

      const outcome = ratifyProposal({
        store,
        queue,
        proposal,
        decision: { kind: 'supersede', targetId: old.id },
        runId: 'sleeptime-1',
      });
      assert.equal(outcome.kind, 'supersede');

      const newMemory = store.findById(proposal.candidate.id)!;
      assert.ok(
        newMemory.links?.some(
          (l) =>
            l.targetId === old.id && l.relation === MEMORY_LINK_RELATIONS.SUPERSEDES,
        ),
      );
      const oldAfter = store.findById(old.id)!;
      assert.ok(oldAfter.bitemporal.invalidAt);
      assert.match(
        oldAfter.provenance.invalidatedBy?.reason ?? '',
        /superseded-by:/,
      );
      assert.equal(queue.get(proposal.id)?.status, 'ratified');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── consolidate ───────────────────────────────────────────────────────────

describe('consolidate', () => {
  it('routes pending proposals through defaultDecide (ADD vs MERGE-INTO)', async () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };

      const existing = fakeMemory({ content: 'kafka rebalance fix', ns });
      store.add(existing);

      queue.enqueue(fakeMemory({ content: 'kafka rebalance fix', ns }), 'dup');
      queue.enqueue(fakeMemory({ content: 'fresh new fact', ns }), 'novel');

      const result = await consolidate(store, queue, ns);
      assert.equal(result.scanned, 2);
      assert.equal(result.ratified, 1);
      assert.equal(result.merged, 1);
      assert.equal(queue.pendingCount(), 0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors a custom decideFn (e.g., reject everything)', async () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      queue.enqueue(fakeMemory({ content: 'a', ns }), 'a');
      queue.enqueue(fakeMemory({ content: 'b', ns }), 'b');

      const result = await consolidate(store, queue, ns, {
        decideFn: () => ({ kind: 'reject', reason: 'shed everything' }),
      });
      assert.equal(result.scanned, 2);
      assert.equal(result.rejected, 2);
      assert.equal(queue.pendingCount(), 0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaultDecide returns ADD for novel proposals', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      const proposal = queue.enqueue(
        fakeMemory({ content: 'totally new fact' }),
        'reason',
      );
      const decision = defaultDecide(store, proposal);
      assert.equal(decision.kind, 'add');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
