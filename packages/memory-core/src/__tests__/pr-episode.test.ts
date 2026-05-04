/**
 * Phase 12 — PR-as-episode tests.
 *
 * Covers §12.5 acceptance items reachable in this phase:
 *   - PrEpisode memories serialize correctly (Memory<PrEpisode>)
 *   - recordPrEpisode persists with kind='episodic' + auto-ratified
 *   - retrievePrEpisodes filters to merged + ci-pass by default
 *   - successOnly=false returns failed/open PRs too
 *
 * cli `anvil memory list --kind=episodic --subtype=pr-episode` deferred.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  HybridMemoryStore,
  buildPrEpisodeMemory,
  recordPrEpisode,
  retrievePrEpisodes,
} from '../index.js';
import type { MemoryNamespace, PrEpisode } from '../index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-memory-pr-episode-'));
}

function open(dir: string): HybridMemoryStore {
  return HybridMemoryStore.open({
    jsonlPath: join(dir, 'memory.jsonl'),
    sqlitePath: join(dir, 'memory.sqlite'),
    skipAutoRebuild: true,
    scrubber: { mode: 'off' },
  });
}

function makeEpisode(overrides: Partial<PrEpisode> = {}): PrEpisode {
  return {
    prUrl: 'https://github.com/example/repo/pull/42',
    intent: 'Fix the kafka rebalance bug under partition reassignment',
    plan: 'Re-enable graceful rebalance; add idempotency to consumer commit',
    filesChanged: ['src/consumer.ts', 'tests/consumer.test.ts'],
    commitShas: ['abc1234'],
    testsAdded: ['tests/consumer.rebalance.test.ts'],
    ciStatus: 'pass',
    reviewOutcome: 'approved',
    mergeStatus: 'merged',
    durationMs: 4500_000,
    costUsd: 0.32,
    ...overrides,
  };
}

// ── builder ───────────────────────────────────────────────────────────────

describe('buildPrEpisodeMemory', () => {
  it('produces a fully-typed episodic Memory<PrEpisode>', () => {
    const ns: MemoryNamespace = { scope: 'repo', projectId: 'demo', repoId: 'svc' };
    const m = buildPrEpisodeMemory(makeEpisode(), { namespace: ns });

    assert.equal(m.kind, 'episodic');
    assert.equal(m.namespace.scope, 'repo');
    assert.equal(m.content.prUrl, 'https://github.com/example/repo/pull/42');
    assert.ok(m.tags.includes('pr-episode'));
    assert.ok(m.tags.includes('ci:pass'));
    assert.ok(m.tags.includes('merge:merged'));
    assert.ok(m.tags.includes('review:approved'));
    assert.equal(m.provenance.createdBy, 'pr-episode');
    assert.ok(m.provenance.ratifiedAt);
    assert.equal(m.ttlDays, 365);
  });

  it('sets ttl=-1 to never expire when caller asks for it', () => {
    const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
    const m = buildPrEpisodeMemory(makeEpisode(), { namespace: ns, ttlDays: -1 });
    assert.equal(m.ttlDays, -1);
    assert.equal(m.expiresAt, '9999-12-31T00:00:00.000Z');
  });
});

// ── recordPrEpisode + retrievePrEpisodes ──────────────────────────────────

describe('recordPrEpisode + retrievePrEpisodes', () => {
  it('persists and retrieves a successful PR episode by intent', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      const recorded = recordPrEpisode(store, makeEpisode(), { namespace: ns });

      const hits = retrievePrEpisodes(store, 'kafka rebalance', { namespace: ns });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].id, recorded.id);
      assert.equal(hits[0].content.prUrl, recorded.content.prUrl);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters out failed CI PRs by default (successOnly=true)', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      recordPrEpisode(
        store,
        makeEpisode({
          intent: 'broken kafka attempt',
          ciStatus: 'fail',
          mergeStatus: 'closed',
        }),
        { namespace: ns },
      );
      const ok = recordPrEpisode(
        store,
        makeEpisode({ intent: 'good kafka fix' }),
        { namespace: ns },
      );

      const successOnly = retrievePrEpisodes(store, 'kafka', { namespace: ns });
      assert.equal(successOnly.length, 1);
      assert.equal(successOnly[0].id, ok.id);

      const everything = retrievePrEpisodes(store, 'kafka', {
        namespace: ns,
        successOnly: false,
      });
      assert.equal(everything.length, 2);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('limit caps the final result count', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      for (let i = 0; i < 5; i++) {
        recordPrEpisode(
          store,
          makeEpisode({ intent: `kafka fix ${i}`, prUrl: `https://e/${i}` }),
          { namespace: ns },
        );
      }
      const hits = retrievePrEpisodes(store, 'kafka', { namespace: ns, limit: 2 });
      assert.equal(hits.length, 2);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
