/**
 * Wave 4 — memory-injection telemetry tests.
 *
 * Covers:
 *   - record() inserts; idempotent on (run, stage, memory) dupes
 *   - markUsed() flips the `used` flag
 *   - injectedFor / forRun return the right shape
 *   - hitStatsByKind groups by kind+subtype, computes hitRatio
 *   - topHitMemories ranks by used count desc
 *   - applyRetrievalHit bumps confidence/strength/rehearseCount with caps
 *   - vacuumOlderThan deletes the right rows
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';

import { HybridMemoryStore } from '../index.js';
import type { Memory, MemoryNamespace } from '../index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-memory-inj-'));
}

function open(dir: string): HybridMemoryStore {
  return HybridMemoryStore.open({
    jsonlPath: join(dir, 'memory.jsonl'),
    sqlitePath: join(dir, 'memory.sqlite'),
    skipAutoRebuild: true,
    scrubber: { mode: 'off' },
    vectorDbPath: null,
  });
}

function fakeMemory(opts: {
  ns?: MemoryNamespace;
  content?: string;
  subtype?: Memory['subtype'];
  kind?: Memory['kind'];
}): Memory {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    namespace: opts.ns ?? { scope: 'project', projectId: 'demo' },
    kind: opts.kind ?? 'semantic',
    subtype: opts.subtype ?? 'fix-pattern',
    content: opts.content ?? 'content',
    tags: [],
    confidence: 50,
    ttlDays: 30,
    expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString(),
    bitemporal: { validAt: now },
    decay: { lastAccessed: now, strength: 80, rehearseCount: 0 },
    provenance: { createdBy: 'auto-learner', createdAt: now },
  };
}

describe('InjectionLog.record', () => {
  it('inserts a row per memory id and is idempotent on dupes', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      store.injections.record('run-1', 'implement', ['a', 'b', 'c']);
      store.injections.record('run-1', 'implement', ['a']); // dupe — no-op
      const records = store.injections.forRun('run-1');
      assert.equal(records.length, 3);
      assert.deepEqual(records.map((r) => r.memoryId).sort(), ['a', 'b', 'c']);
      for (const r of records) {
        assert.equal(r.used, false);
        assert.equal(r.stage, 'implement');
      }
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no-ops on empty memoryIds array', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      store.injections.record('run-1', 'implement', []);
      assert.equal(store.injections.forRun('run-1').length, 0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('InjectionLog.markUsed', () => {
  it('flips used=1 for matching (run, memory) and returns rowCount', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      store.injections.record('run-1', 'implement', ['a', 'b']);
      store.injections.record('run-1', 'validate', ['a']);
      const n = store.injections.markUsed('run-1', 'a');
      assert.equal(n, 2, 'both stages of run-1 mention "a" → both flipped');
      const records = store.injections.forRun('run-1');
      const a = records.filter((r) => r.memoryId === 'a');
      const b = records.find((r) => r.memoryId === 'b');
      assert.ok(a.every((r) => r.used));
      assert.equal(b?.used, false);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 0 when no rows match', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      assert.equal(store.injections.markUsed('run-1', 'unknown'), 0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('InjectionLog.injectedFor', () => {
  it('returns memory ids for a specific (run, stage)', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      store.injections.record('run-1', 'implement', ['a', 'b']);
      store.injections.record('run-1', 'validate', ['c']);
      assert.deepEqual(store.injections.injectedFor('run-1', 'implement').sort(), ['a', 'b']);
      assert.deepEqual(store.injections.injectedFor('run-1', 'validate'), ['c']);
      assert.deepEqual(store.injections.injectedFor('run-2', 'implement'), []);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('InjectionLog.hitStatsByKind', () => {
  it('groups by kind+subtype and computes hitRatio', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const fix1 = fakeMemory({ subtype: 'fix-pattern' });
      const fix2 = fakeMemory({ subtype: 'fix-pattern' });
      const succ = fakeMemory({ subtype: 'success' });
      store.add(fix1);
      store.add(fix2);
      store.add(succ);

      store.injections.record('r', 'implement', [fix1.id, fix2.id, succ.id]);
      store.injections.markUsed('r', fix1.id);
      store.injections.markUsed('r', succ.id);

      const stats = store.injections.hitStatsByKind();
      const fixStat = stats.find((s) => s.subtype === 'fix-pattern');
      const succStat = stats.find((s) => s.subtype === 'success');
      assert.equal(fixStat?.injected, 2);
      assert.equal(fixStat?.used, 1);
      assert.equal(fixStat?.hitRatio, 0.5);
      assert.equal(succStat?.injected, 1);
      assert.equal(succStat?.used, 1);
      assert.equal(succStat?.hitRatio, 1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('InjectionLog.topHitMemories', () => {
  it('ranks memories by used count descending', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      store.injections.record('r1', 'implement', ['a', 'b', 'c']);
      store.injections.record('r2', 'implement', ['a', 'b']);
      store.injections.record('r3', 'implement', ['a']);
      store.injections.markUsed('r1', 'a');
      store.injections.markUsed('r2', 'a');
      store.injections.markUsed('r1', 'b');
      const top = store.injections.topHitMemories({ limit: 3 });
      assert.equal(top[0].memoryId, 'a');
      assert.equal(top[0].used, 2);
      assert.equal(top[1].memoryId, 'b');
      assert.equal(top[1].used, 1);
      assert.equal(top[2].memoryId, 'c');
      assert.equal(top[2].used, 0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('HybridMemoryStore.applyRetrievalHit', () => {
  it('bumps confidence (+2) / strength (+5) / rehearseCount (+1), capped at 100', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const m = fakeMemory({});
      store.add(m);

      const r1 = store.applyRetrievalHit(m.id);
      assert.ok(r1);
      assert.equal(r1!.confidence, 52);
      assert.equal(r1!.decay.strength, 85);
      assert.equal(r1!.decay.rehearseCount, 1);

      // Repeat enough times that BOTH 50→100 (needs 25 +2 ticks) and
      // 80→100 (needs 4 +5 ticks) saturate. 30 iterations covers both.
      // After r1 above we're already at (52, 85, 1); 30 more = 31 total.
      for (let i = 0; i < 30; i++) store.applyRetrievalHit(m.id);
      const final = store.findById(m.id);
      assert.equal(final?.confidence, 100, 'confidence saturates at 100');
      assert.equal(final?.decay.strength, 100, 'strength saturates at 100');
      assert.equal(final?.decay.rehearseCount, 31, 'rehearseCount keeps climbing');

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when memory id is unknown', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      assert.equal(store.applyRetrievalHit('nonexistent'), null);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('InjectionLog.vacuumOlderThan', () => {
  it('deletes records older than the cutoff', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const oldIso = '2020-01-01T00:00:00.000Z';
      const newIso = '2030-01-01T00:00:00.000Z';
      store.injections.record('old-run', 'implement', ['a'], oldIso);
      store.injections.record('new-run', 'implement', ['b'], newIso);
      const deleted = store.injections.vacuumOlderThan('2025-01-01T00:00:00.000Z');
      assert.equal(deleted, 1);
      assert.equal(store.injections.forRun('old-run').length, 0);
      assert.equal(store.injections.forRun('new-run').length, 1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
