/**
 * Phase 2 — legacy primitives smoke test.
 *
 * Asserts the hoisted code from `cli/src/memory/` operates identically
 * after relocation. No semantic change should be visible — pure file
 * movement (per plan §2.1).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MemoryStore,
  createMemoryEntry,
  pruneExpired,
  pruneBySize,
  queryByTags,
  queryByContent,
  selectTopK,
  readJSONL,
  appendJSONL,
  writeJSONL,
  DEFAULT_TTL_DAYS,
  MAX_SIZE_BYTES,
  type MemoryEntry,
} from '../legacy/index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-memory-core-legacy-'));
}

describe('legacy MemoryStore round-trip', () => {
  it('add → list → query → remove preserves data', () => {
    const dir = tempDir();
    try {
      const store = new MemoryStore({
        path: dir,
        maxSizeBytes: MAX_SIZE_BYTES,
        defaultTTLDays: DEFAULT_TTL_DAYS,
      });

      const e1 = createMemoryEntry('fix-pattern', 'Error X → Fix Y', {
        confidence: 60,
        source: 'auto-learn',
        tags: ['fix', 'demo'],
      });
      const e2 = createMemoryEntry('success', 'Feature Z shipped', {
        confidence: 80,
        source: 'manual',
        tags: ['success', 'demo'],
      });
      store.add(e1);
      store.add(e2);

      const all = store.list();
      assert.equal(all.length, 2);

      const fixOnly = store.list('fix-pattern');
      assert.equal(fixOnly.length, 1);
      assert.equal(fixOnly[0].id, e1.id);

      const tagged = store.query({ tags: ['demo'], minConfidence: 70 });
      assert.equal(tagged.length, 1);
      assert.equal(tagged[0].id, e2.id);

      assert.ok(store.remove(e1.id));
      assert.equal(store.list().length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('legacy query helpers', () => {
  function fakeEntry(id: string, content: string, tags: string[], confidence = 50): MemoryEntry {
    return {
      id,
      kind: 'manual',
      content,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      confidence,
      source: 'test',
      tags,
    };
  }

  it('queryByTags filters by tag membership', () => {
    const dir = tempDir();
    try {
      const store = new MemoryStore({ path: dir, maxSizeBytes: MAX_SIZE_BYTES, defaultTTLDays: DEFAULT_TTL_DAYS });
      store.add(fakeEntry('a', 'foo', ['x']));
      store.add(fakeEntry('b', 'bar', ['y']));
      const out = queryByTags(store, ['x']);
      assert.equal(out.length, 1);
      assert.equal(out[0].id, 'a');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('queryByContent matches case-insensitively', () => {
    const dir = tempDir();
    try {
      const store = new MemoryStore({ path: dir, maxSizeBytes: MAX_SIZE_BYTES, defaultTTLDays: DEFAULT_TTL_DAYS });
      store.add(fakeEntry('a', 'TypeScript Generics', ['ts']));
      store.add(fakeEntry('b', 'something else', ['other']));
      const out = queryByContent(store, 'typescript');
      assert.equal(out.length, 1);
      assert.equal(out[0].id, 'a');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('selectTopK ranks by confidence then recency', () => {
    const a = fakeEntry('a', 'low conf', [], 10);
    const b = fakeEntry('b', 'high conf', [], 90);
    const c = fakeEntry('c', 'mid conf', [], 50);
    const ranked = selectTopK([a, b, c], 2);
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].id, 'b');
    assert.equal(ranked[1].id, 'c');
  });
});

describe('legacy pruning', () => {
  it('pruneExpired removes entries past expiresAt', () => {
    const dir = tempDir();
    try {
      const store = new MemoryStore({ path: dir, maxSizeBytes: MAX_SIZE_BYTES, defaultTTLDays: DEFAULT_TTL_DAYS });
      const expired: MemoryEntry = {
        id: 'old',
        kind: 'manual',
        content: 'expired',
        createdAt: new Date(Date.now() - 86_400_000 * 60).toISOString(),
        expiresAt: new Date(Date.now() - 86_400_000).toISOString(), // yesterday
        confidence: 50,
        source: 'test',
        tags: [],
      };
      const fresh: MemoryEntry = {
        id: 'new',
        kind: 'manual',
        content: 'fresh',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        confidence: 50,
        source: 'test',
        tags: [],
      };
      store.add(expired);
      store.add(fresh);
      pruneExpired(store);
      const remaining = store.list();
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].id, 'new');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pruneBySize(store, maxBytes) drops lowest-confidence first', () => {
    const dir = tempDir();
    try {
      const store = new MemoryStore({
        path: dir,
        maxSizeBytes: MAX_SIZE_BYTES, // store config is unused by pruneBySize — it takes maxBytes explicitly
        defaultTTLDays: DEFAULT_TTL_DAYS,
      });
      for (let i = 0; i < 10; i++) {
        store.add({
          id: `e${i}`,
          kind: 'manual',
          content: 'x'.repeat(100),
          createdAt: new Date(Date.now() + i * 1000).toISOString(),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          confidence: i * 10, // 0, 10, 20, … 90 — lowest-conf get pruned first
          source: 't',
          tags: [],
        });
      }
      const removed = pruneBySize(store, 500);
      assert.ok(removed > 0, 'expected pruning to remove some entries');
      const remaining = store.list();
      // The lowest-confidence entries (e0, e1, …) should be gone first.
      const remainingIds = new Set(remaining.map((e) => e.id));
      assert.equal(remainingIds.has('e0'), false);
      assert.equal(remainingIds.has('e9'), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('legacy JSONL primitives', () => {
  it('appendJSONL + readJSONL round-trip', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'sample.jsonl');
      appendJSONL(file, { a: 1 });
      appendJSONL(file, { a: 2 });
      assert.ok(existsSync(file));
      const rows = readJSONL<{ a: number }>(file);
      assert.deepEqual(
        rows.map((r) => r.a),
        [1, 2],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeJSONL overwrites the file contents', () => {
    const dir = tempDir();
    try {
      const file = join(dir, 'sample.jsonl');
      appendJSONL(file, { a: 1 });
      writeJSONL(file, [{ b: 2 }]);
      const rows = readJSONL<{ b: number }>(file);
      assert.deepEqual(rows, [{ b: 2 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
