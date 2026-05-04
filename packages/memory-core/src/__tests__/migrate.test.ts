/**
 * Phase 14 — migration importer tests.
 *
 * Covers §14.3 acceptance items reachable in this phase:
 *   - Importer reads legacy `~/.anvil/memory/<project>/memories.jsonl`
 *   - Maps legacy MemoryKind → v2 SemanticSubtype with namespace
 *     {scope:'project', projectId}
 *   - Idempotent: re-running on the same input produces no duplicates
 *   - dryRun returns the plan without touching durable + skips backup
 *   - Backup file `.pre-migration.bak` created before write
 *   - Scrubber catches secrets in legacy data (Phase 7 integration)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  HybridMemoryStore,
  importLegacyMemories,
} from '../index.js';
import type { MemoryEntry } from '../legacy/types.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-memory-migrate-'));
}

function writeLegacyJsonl(file: string, entries: MemoryEntry[]): void {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(file, lines + '\n', 'utf8');
}

function legacyEntry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  const created = '2026-04-01T00:00:00.000Z';
  const expires = '2026-07-01T00:00:00.000Z';
  return {
    id: over.id ?? '01HZZZZZZZZZZZZZZZZZZZZZZZ',
    kind: over.kind ?? 'fix-pattern',
    content: over.content ?? 'kafka rebalance fix',
    createdAt: over.createdAt ?? created,
    expiresAt: over.expiresAt ?? expires,
    confidence: over.confidence ?? 70,
    source: over.source ?? 'auto-learner',
    tags: over.tags ?? ['kafka'],
  };
}

function openStore(dir: string): HybridMemoryStore {
  return HybridMemoryStore.open({
    jsonlPath: join(dir, 'v2.jsonl'),
    sqlitePath: join(dir, 'v2.sqlite'),
    skipAutoRebuild: true,
    scrubber: { mode: 'regex' },
  });
}

describe('importLegacyMemories', () => {
  it('reads legacy <project>/memories.jsonl and maps kinds → subtypes', () => {
    const root = tempDir();
    const v2 = tempDir();
    try {
      mkdirSync(join(root, 'demo'));
      writeLegacyJsonl(join(root, 'demo', 'memories.jsonl'), [
        legacyEntry({ id: 'm1', kind: 'fix-pattern', content: 'A' }),
        legacyEntry({ id: 'm2', kind: 'success', content: 'B' }),
      ]);

      const store = openStore(v2);
      const report = importLegacyMemories(root, store, {
        logger: () => {},
      });

      assert.equal(report.filesScanned, 1);
      assert.equal(report.entriesScanned, 2);
      assert.equal(report.imported, 2);
      assert.equal(report.byNamespace['project/demo'], 2);

      const m1 = store.findById('m1')!;
      assert.equal(m1.kind, 'semantic');
      assert.equal(m1.subtype, 'fix-pattern');
      assert.equal(m1.namespace.scope, 'project');
      assert.equal(m1.namespace.projectId, 'demo');
      assert.equal(m1.provenance.createdBy, 'migration');
      assert.equal(m1.provenance.sourceRunId, 'pre-migration');
      assert.equal(m1.bitemporal.validAt, '2026-04-01T00:00:00.000Z');
      assert.equal(m1.decay.strength, 100);

      const m2 = store.findById('m2')!;
      assert.equal(m2.subtype, 'success');
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(v2, { recursive: true, force: true });
    }
  });

  it('treats `global` directory as scope: "global"', () => {
    const root = tempDir();
    const v2 = tempDir();
    try {
      mkdirSync(join(root, 'global'));
      writeLegacyJsonl(join(root, 'global', 'memories.jsonl'), [
        legacyEntry({ id: 'g1', content: 'global fact' }),
      ]);
      const store = openStore(v2);
      const report = importLegacyMemories(root, store, { logger: () => {} });
      assert.equal(report.imported, 1);
      const g = store.findById('g1')!;
      assert.equal(g.namespace.scope, 'global');
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(v2, { recursive: true, force: true });
    }
  });

  it('writes a .pre-migration.bak before importing', () => {
    const root = tempDir();
    const v2 = tempDir();
    try {
      mkdirSync(join(root, 'p'));
      const file = join(root, 'p', 'memories.jsonl');
      writeLegacyJsonl(file, [legacyEntry({ id: 'b1' })]);
      const store = openStore(v2);
      importLegacyMemories(root, store, { logger: () => {} });
      assert.ok(existsSync(`${file}.pre-migration.bak`));
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(v2, { recursive: true, force: true });
    }
  });

  it('dryRun does not touch the durable store + does not backup', () => {
    const root = tempDir();
    const v2 = tempDir();
    try {
      mkdirSync(join(root, 'p'));
      const file = join(root, 'p', 'memories.jsonl');
      writeLegacyJsonl(file, [legacyEntry({ id: 'd1' })]);
      const store = openStore(v2);
      const report = importLegacyMemories(root, store, {
        dryRun: true,
        logger: () => {},
      });
      assert.equal(report.imported, 1);
      assert.equal(store.findById('d1'), null);
      assert.equal(existsSync(`${file}.pre-migration.bak`), false);
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(v2, { recursive: true, force: true });
    }
  });

  it('is idempotent — re-running produces no duplicates', () => {
    const root = tempDir();
    const v2 = tempDir();
    try {
      mkdirSync(join(root, 'p'));
      writeLegacyJsonl(join(root, 'p', 'memories.jsonl'), [
        legacyEntry({ id: 'i1', content: 'idem' }),
      ]);
      const store = openStore(v2);
      importLegacyMemories(root, store, { logger: () => {} });
      importLegacyMemories(root, store, { logger: () => {} });
      // Should be exactly one row in SQLite (upsert by id).
      assert.equal(store.sqlite.count(), 1);
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(v2, { recursive: true, force: true });
    }
  });

  it('scrubber hard-rejects credential-class secrets in legacy content', () => {
    const root = tempDir();
    const v2 = tempDir();
    try {
      mkdirSync(join(root, 'p'));
      writeLegacyJsonl(join(root, 'p', 'memories.jsonl'), [
        legacyEntry({ id: 'safe', content: 'plain fact' }),
        legacyEntry({
          id: 'leaked',
          content: 'cached token sk-abcdefghijklmnopqrstuvwxyz1234567',
        }),
      ]);
      const store = openStore(v2);
      const report = importLegacyMemories(root, store, { logger: () => {} });
      assert.equal(report.imported, 1);
      assert.equal(report.rejected, 1);
      assert.equal(store.findById('leaked'), null);
      assert.ok(store.findById('safe'));
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(v2, { recursive: true, force: true });
    }
  });

  it('returns empty report when legacy root does not exist', () => {
    const v2 = tempDir();
    try {
      const store = openStore(v2);
      const report = importLegacyMemories('/no/such/path', store, {
        logger: () => {},
      });
      assert.equal(report.filesScanned, 0);
      assert.equal(report.imported, 0);
      store.close();
    } finally {
      rmSync(v2, { recursive: true, force: true });
    }
  });
});
