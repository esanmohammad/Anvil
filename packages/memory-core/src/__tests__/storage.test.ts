/**
 * Phase 3 — hybrid storage tests.
 *
 * Covers §3.8 acceptance:
 *   1. SQLite hot index exists alongside JSONL
 *   2. Read paths return correct results (round-trips through Memory<T>)
 *   3. Tag + text query work with namespace filtering
 *   4. Rebuild correctly: drop sqlite, reopen → auto-rebuild from jsonl
 *
 * Plus: bi-temporal `validAtTime`, `pruneExpired`, FTS5 BM25 ordering.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  unlinkSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';

import {
  HybridMemoryStore,
  JsonlAppendLog,
  SqliteHotIndex,
} from '../storage/index.js';
import type { Memory } from '../types.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-memory-storage-'));
}

function fakeMemory(opts: Partial<Memory> & { content: string }): Memory {
  const now = new Date().toISOString();
  return {
    id: opts.id ?? ulid(),
    namespace: opts.namespace ?? { scope: 'project', projectId: 'demo' },
    kind: opts.kind ?? 'semantic',
    subtype: opts.subtype ?? 'fix-pattern',
    content: opts.content,
    tags: opts.tags ?? [],
    confidence: opts.confidence ?? 50,
    ttlDays: opts.ttlDays ?? 30,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000 * 30).toISOString(),
    bitemporal: opts.bitemporal ?? { validAt: now },
    decay: opts.decay ?? { lastAccessed: now, strength: 80, rehearseCount: 0 },
    provenance: opts.provenance ?? {
      createdBy: 'auto-learner',
      createdAt: now,
    },
    codeBinding: opts.codeBinding,
    embedding: opts.embedding,
    links: opts.links,
  };
}

// ── §3.8(1): SQLite + JSONL co-exist ─────────────────────────────────────

describe('HybridMemoryStore — files', () => {
  it('creates both jsonl + sqlite files alongside each other', () => {
    const dir = tempDir();
    try {
      const store = HybridMemoryStore.open({
        jsonlPath: join(dir, 'memory.jsonl'),
        sqlitePath: join(dir, 'memory.sqlite'),
      });
      const m = fakeMemory({ content: 'first record' });
      store.add(m);
      store.close();

      assert.ok(existsSync(join(dir, 'memory.jsonl')));
      assert.ok(existsSync(join(dir, 'memory.sqlite')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── §3.8(2): round-trip through Memory<T> ────────────────────────────────

describe('SqliteHotIndex — round-trip', () => {
  it('upsert + findById preserves every field', () => {
    const dir = tempDir();
    try {
      const sqlite = new SqliteHotIndex(join(dir, 'memory.sqlite'));
      const m = fakeMemory({
        content: 'TypeScript generic constraint',
        tags: ['ts', 'generics'],
        confidence: 75,
        codeBinding: {
          filePath: 'src/foo.ts',
          structuralHash: 'abc123',
          lastSeenCommitSha: 'deadbeef',
          lastVerifiedAt: '2026-04-29T00:00:00.000Z',
        },
        bitemporal: {
          validAt: '2026-01-01T00:00:00.000Z',
          invalidAt: '2026-04-01T00:00:00.000Z',
        },
        provenance: {
          createdBy: 'reflection',
          createdAt: '2026-01-01T00:00:00.000Z',
          sourceRunId: 'run-123',
          sourceCommit: 'cafebabe',
        },
      });
      sqlite.upsert(m);
      const found = sqlite.findById(m.id);
      assert.ok(found);
      assert.equal(found!.content, m.content);
      assert.deepEqual(found!.tags, m.tags);
      assert.equal(found!.confidence, 75);
      assert.deepEqual(found!.codeBinding, m.codeBinding);
      assert.equal(found!.bitemporal.invalidAt, '2026-04-01T00:00:00.000Z');
      assert.equal(found!.provenance.sourceRunId, 'run-123');
      sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upsert is idempotent — re-upsert replaces fields', () => {
    const dir = tempDir();
    try {
      const sqlite = new SqliteHotIndex(join(dir, 'm.sqlite'));
      const m = fakeMemory({ content: 'original', confidence: 50 });
      sqlite.upsert(m);
      sqlite.upsert({ ...m, content: 'updated', confidence: 90 });
      assert.equal(sqlite.count(), 1);
      const found = sqlite.findById(m.id);
      assert.equal(found?.content, 'updated');
      assert.equal(found?.confidence, 90);
      sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── §3.8(3): tag + text + namespace queries ──────────────────────────────

describe('SqliteHotIndex — search', () => {
  it('searchByTags returns memories tagged with any input tag', () => {
    const dir = tempDir();
    try {
      const sqlite = new SqliteHotIndex(join(dir, 'm.sqlite'));
      sqlite.upsert(fakeMemory({ content: 'a', tags: ['x', 'y'] }));
      sqlite.upsert(fakeMemory({ content: 'b', tags: ['y'] }));
      sqlite.upsert(fakeMemory({ content: 'c', tags: ['z'] }));
      const xy = sqlite.searchByTags(['x']);
      assert.equal(xy.length, 1);
      assert.equal(xy[0].content, 'a');
      const xz = sqlite.searchByTags(['x', 'z']);
      assert.equal(xz.length, 2);
      sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('searchByText returns BM25-ranked FTS5 matches', () => {
    const dir = tempDir();
    try {
      const sqlite = new SqliteHotIndex(join(dir, 'm.sqlite'));
      sqlite.upsert(fakeMemory({ content: 'TypeScript generic constraint', tags: [] }));
      sqlite.upsert(fakeMemory({ content: 'Python decorator pattern', tags: [] }));
      sqlite.upsert(fakeMemory({ content: 'TypeScript decorator metadata', tags: [] }));
      const ts = sqlite.searchByText('typescript');
      assert.equal(ts.length, 2);
      assert.ok(ts.every((m) => /typescript/i.test(m.content as string)));
      const dec = sqlite.searchByText('decorator');
      assert.equal(dec.length, 2);
      sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('namespace filter narrows search', () => {
    const dir = tempDir();
    try {
      const sqlite = new SqliteHotIndex(join(dir, 'm.sqlite'));
      sqlite.upsert(
        fakeMemory({
          content: 'project-A entry',
          tags: ['shared'],
          namespace: { scope: 'project', projectId: 'A' },
        } as Partial<Memory> & { content: string }),
      );
      sqlite.upsert(
        fakeMemory({
          content: 'project-B entry',
          tags: ['shared'],
          namespace: { scope: 'project', projectId: 'B' },
        } as Partial<Memory> & { content: string }),
      );
      const onlyA = sqlite.searchByTags(['shared'], {
        namespace: { scope: 'project', projectId: 'A' },
      });
      assert.equal(onlyA.length, 1);
      assert.equal(onlyA[0].content, 'project-A entry');
      sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Bi-temporal validAtTime ──────────────────────────────────────────────

describe('SqliteHotIndex — bi-temporal', () => {
  it('validAtTime returns memories valid at the given instant', () => {
    const dir = tempDir();
    try {
      const sqlite = new SqliteHotIndex(join(dir, 'm.sqlite'));
      sqlite.upsert(
        fakeMemory({
          content: 'always valid',
          bitemporal: { validAt: '2026-01-01T00:00:00.000Z' },
        }),
      );
      sqlite.upsert(
        fakeMemory({
          content: 'invalidated 2026-04-01',
          bitemporal: {
            validAt: '2026-01-01T00:00:00.000Z',
            invalidAt: '2026-04-01T00:00:00.000Z',
          },
        }),
      );
      sqlite.upsert(
        fakeMemory({
          content: 'not yet valid',
          bitemporal: { validAt: '2027-01-01T00:00:00.000Z' },
        }),
      );

      const atFeb = sqlite.validAtTime('2026-02-15T00:00:00.000Z');
      assert.equal(atFeb.length, 2);
      const atMay = sqlite.validAtTime('2026-05-01T00:00:00.000Z');
      assert.equal(atMay.length, 1);
      assert.equal(atMay[0].content, 'always valid');
      sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── pruneExpired ─────────────────────────────────────────────────────────

describe('SqliteHotIndex — pruneExpired', () => {
  it('drops only entries past expiresAt with non-negative ttl_days', () => {
    const dir = tempDir();
    try {
      const sqlite = new SqliteHotIndex(join(dir, 'm.sqlite'));
      sqlite.upsert(
        fakeMemory({
          content: 'expired',
          ttlDays: 1,
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
      );
      sqlite.upsert(
        fakeMemory({
          content: 'never expires',
          ttlDays: -1,
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
      );
      sqlite.upsert(
        fakeMemory({
          content: 'still fresh',
          ttlDays: 30,
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      );
      const removed = sqlite.pruneExpired('2026-04-29T00:00:00.000Z');
      assert.equal(removed, 1);
      assert.equal(sqlite.count(), 2);
      sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── §3.8(4): rebuild from JSONL ──────────────────────────────────────────

describe('HybridMemoryStore — rebuild', () => {
  it('rebuildIndexFromJsonl restores results identically after dropping sqlite', () => {
    const dir = tempDir();
    const jsonlPath = join(dir, 'memory.jsonl');
    const sqlitePath = join(dir, 'memory.sqlite');
    try {
      const store = HybridMemoryStore.open({ jsonlPath, sqlitePath });
      const m1 = fakeMemory({ content: 'alpha', tags: ['a'] });
      const m2 = fakeMemory({ content: 'beta', tags: ['b'] });
      store.add(m1);
      store.add(m2);
      store.close();

      // Delete sqlite — simulates corruption / first run
      unlinkSync(sqlitePath);

      const reopened = HybridMemoryStore.open({ jsonlPath, sqlitePath });
      // Auto-rebuild should have populated sqlite from jsonl.
      assert.equal(reopened.sqlite.count(), 2);
      assert.equal(reopened.findById(m1.id)?.content, 'alpha');
      assert.equal(reopened.findById(m2.id)?.content, 'beta');
      assert.equal(reopened.searchByTags(['a']).length, 1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('explicit rebuildIndexFromJsonl reports count + durationMs', () => {
    const dir = tempDir();
    const jsonlPath = join(dir, 'memory.jsonl');
    const sqlitePath = join(dir, 'memory.sqlite');
    try {
      const store = HybridMemoryStore.open({ jsonlPath, sqlitePath });
      for (let i = 0; i < 5; i++) {
        store.add(fakeMemory({ content: `entry ${i}`, tags: [`t${i}`] }));
      }
      const result = store.rebuildIndexFromJsonl();
      assert.equal(result.count, 5);
      assert.ok(result.durationMs >= 0);
      assert.equal(store.sqlite.count(), 5);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skipAutoRebuild leaves sqlite untouched when JSONL has data', () => {
    const dir = tempDir();
    const jsonlPath = join(dir, 'memory.jsonl');
    const sqlitePath = join(dir, 'memory.sqlite');
    try {
      // Seed JSONL via a temporary store, then close.
      const seed = HybridMemoryStore.open({ jsonlPath, sqlitePath });
      seed.add(fakeMemory({ content: 'seed' }));
      seed.close();
      unlinkSync(sqlitePath);

      const store = HybridMemoryStore.open({
        jsonlPath,
        sqlitePath,
        skipAutoRebuild: true,
      });
      assert.equal(store.sqlite.count(), 0);
      assert.equal(new JsonlAppendLog(jsonlPath).readAll().length, 1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── JsonlAppendLog ───────────────────────────────────────────────────────

describe('JsonlAppendLog', () => {
  it('append + readAll round-trips Memory records', () => {
    const dir = tempDir();
    try {
      const log = new JsonlAppendLog(join(dir, 'memory.jsonl'));
      const a = fakeMemory({ content: 'one' });
      const b = fakeMemory({ content: 'two' });
      log.append(a);
      log.append(b);
      const all = log.readAll();
      assert.equal(all.length, 2);
      assert.equal(all[0].content, 'one');
      assert.equal(all[1].content, 'two');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readAll skips malformed lines gracefully', () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'memory.jsonl');
      const log = new JsonlAppendLog(path);
      log.append(fakeMemory({ content: 'good' }));
      // Inject a malformed line by appending raw text.
      appendFileSync(path, '{ this is not valid json\n', 'utf-8');
      log.append(fakeMemory({ content: 'good2' }));

      // Suppress stderr WARN noise
      const origWrite = process.stderr.write.bind(process.stderr);
      const captured: string[] = [];
      (process.stderr as { write: typeof origWrite }).write = (chunk: string | Uint8Array) => {
        captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return true;
      };
      let all: Memory[];
      try {
        all = log.readAll();
      } finally {
        (process.stderr as { write: typeof origWrite }).write = origWrite;
      }
      assert.equal(all.length, 2);
      assert.ok(captured.some((c) => c.includes('malformed line')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
