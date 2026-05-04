/**
 * Phase 5 tests — `MemoryStore` is now a thin façade over
 * `@anvil/memory-core`'s `HybridMemoryStore`. Tests verify:
 *   - The 5 public ops keep their legacy return shapes.
 *   - Char-limit enforcement, dedup, and substring matching for
 *     replace/remove are preserved.
 *   - The first read/write per project triggers a one-time scan of the
 *     legacy markdown files; entries land in memory-core; the markdown
 *     dir moves under `_archive_<ts>/`.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../memory-store.js';

let tmpHome: string;

before(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'anvil-mem-'));
});

after(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  // Each test runs against a fresh ANVIL_HOME so the singleton picks up
  // the new SQLite file. Wipe everything but recreate the dir.
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(tmpHome, { recursive: true });
});

// ── Public op return shapes ─────────────────────────────────────────────

describe('MemoryStore — return shapes', () => {
  it('add returns success + entries + usage + entryCount', () => {
    const store = new MemoryStore(tmpHome);
    const r = store.add('demo', 'memory', 'first entry');
    assert.equal(r.success, true);
    assert.equal(r.target, 'memory');
    assert.equal(r.entryCount, 1);
    assert.deepEqual(r.entries, ['first entry']);
    assert.match(r.usage, /\d+%/);
    assert.match(r.usage, /chars/);
    assert.equal(r.message, 'Entry added.');
  });

  it('add rejects empty content', () => {
    const store = new MemoryStore(tmpHome);
    const r = store.add('demo', 'memory', '   ');
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /empty/);
  });

  it('add returns the existing list when content duplicates', () => {
    const store = new MemoryStore(tmpHome);
    store.add('demo', 'memory', 'one');
    const r = store.add('demo', 'memory', 'one');
    assert.equal(r.success, true);
    assert.equal(r.entryCount, 1);
    assert.match(r.message ?? '', /already exists/);
  });

  it('add rejects when the entry would exceed the char limit', () => {
    const store = new MemoryStore(tmpHome);
    // USER_CHAR_LIMIT is 2000.
    const r1 = store.add('demo', 'user', 'x'.repeat(1500));
    assert.equal(r1.success, true);
    const r2 = store.add('demo', 'user', 'y'.repeat(1500));
    assert.equal(r2.success, false);
    assert.match(r2.error ?? '', /exceed the limit/);
    assert.equal(r2.entryCount, 1);
  });
});

// ── replace / remove ───────────────────────────────────────────────────

describe('MemoryStore — replace', () => {
  it('replaces the matching entry by substring', () => {
    const store = new MemoryStore(tmpHome);
    store.add('demo', 'memory', 'API uses snake_case keys');
    store.add('demo', 'memory', 'CI runs on every push');
    const r = store.replace('demo', 'memory', 'snake_case', 'API uses camelCase keys');
    assert.equal(r.success, true);
    assert.deepEqual(r.entries.sort(), ['API uses camelCase keys', 'CI runs on every push'].sort());
  });

  it('errors when no entry matches', () => {
    const store = new MemoryStore(tmpHome);
    store.add('demo', 'memory', 'foo');
    const r = store.replace('demo', 'memory', 'absent', 'replacement');
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /No entry matched/);
  });

  it('errors when multiple distinct entries match the substring', () => {
    const store = new MemoryStore(tmpHome);
    store.add('demo', 'memory', 'foo bar one');
    store.add('demo', 'memory', 'foo bar two');
    const r = store.replace('demo', 'memory', 'foo bar', 'replacement');
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /Multiple entries matched/);
  });
});

describe('MemoryStore — remove', () => {
  it('removes the matching entry by substring', () => {
    const store = new MemoryStore(tmpHome);
    store.add('demo', 'memory', 'one');
    store.add('demo', 'memory', 'two');
    const r = store.remove('demo', 'memory', 'one');
    assert.equal(r.success, true);
    assert.deepEqual(r.entries, ['two']);
  });

  it('errors when no entry matches', () => {
    const store = new MemoryStore(tmpHome);
    store.add('demo', 'memory', 'foo');
    const r = store.remove('demo', 'memory', 'absent');
    assert.equal(r.success, false);
  });
});

// ── getEntriesWithMeta + formatForPrompt ───────────────────────────────

describe('MemoryStore — read paths', () => {
  it('getEntriesWithMeta returns entries newest-first with addedAt', async () => {
    const store = new MemoryStore(tmpHome);
    store.add('demo', 'memory', 'older');
    // Tiny sleep so timestamps differ.
    await new Promise((r) => setTimeout(r, 5));
    store.add('demo', 'memory', 'newer');
    const entries = store.getEntriesWithMeta('demo', 'memory');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].content, 'newer');
    assert.equal(entries[1].content, 'older');
    assert.match(entries[0].addedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('formatForPrompt returns "" when empty, otherwise the legacy header layout', () => {
    const store = new MemoryStore(tmpHome);
    assert.equal(store.formatForPrompt('demo', 'memory'), '');
    store.add('demo', 'memory', 'fact one');
    const out = store.formatForPrompt('demo', 'memory');
    assert.match(out, /SYSTEM MEMORY \[\d+%/);
    assert.match(out, /═{40,}/);
    assert.match(out, /fact one/);
  });

  it('formatForPrompt uses the USER PROFILE header for user target', () => {
    const store = new MemoryStore(tmpHome);
    store.add('demo', 'user', 'prefers concise prose');
    const out = store.formatForPrompt('demo', 'user');
    assert.match(out, /USER PROFILE/);
    assert.match(out, /prefers concise prose/);
  });

  it('per-project namespacing — entries in project A are invisible to project B', () => {
    const store = new MemoryStore(tmpHome);
    store.add('proj-a', 'memory', 'fact A');
    store.add('proj-b', 'memory', 'fact B');
    assert.deepEqual(
      store.getEntriesWithMeta('proj-a', 'memory').map((e) => e.content),
      ['fact A'],
    );
    assert.deepEqual(
      store.getEntriesWithMeta('proj-b', 'memory').map((e) => e.content),
      ['fact B'],
    );
  });
});

// ── Markdown migration ─────────────────────────────────────────────────

describe('MemoryStore — markdown migration', () => {
  it('migrates legacy MEMORY.md + USER.md and archives the project dir', () => {
    // Seed the legacy layout.
    const projectLegacyDir = join(tmpHome, 'memories', 'demo');
    mkdirSync(projectLegacyDir, { recursive: true });
    writeFileSync(
      join(projectLegacyDir, 'MEMORY.md'),
      '<!-- added:2025-01-01T00:00:00.000Z -->\nlegacy fact A\n§\n<!-- added:2025-02-01T00:00:00.000Z -->\nlegacy fact B',
      'utf-8',
    );
    writeFileSync(
      join(projectLegacyDir, 'USER.md'),
      '<!-- added:2025-01-01T00:00:00.000Z -->\nuser prefers Go',
      'utf-8',
    );

    const store = new MemoryStore(tmpHome);
    const memories = store.getEntriesWithMeta('demo', 'memory');
    const profile = store.getEntriesWithMeta('demo', 'user');

    assert.deepEqual(memories.map((e) => e.content).sort(), ['legacy fact A', 'legacy fact B']);
    assert.equal(profile.length, 1);
    assert.equal(profile[0].content, 'user prefers Go');
    // Timestamps preserved verbatim from the markdown headers.
    assert.ok(memories.some((e) => e.addedAt === '2025-02-01T00:00:00.000Z'));

    // Project directory archived under _archive_<ts>/demo
    assert.equal(existsSync(projectLegacyDir), false);
    const memoriesRoot = join(tmpHome, 'memories');
    const archives = readdirSync(memoriesRoot).filter((name) => name.startsWith('_archive_'));
    assert.equal(archives.length, 1);
    const archived = join(memoriesRoot, archives[0], 'demo');
    assert.equal(existsSync(archived), true);
  });

  it('migration is idempotent — second open does not re-import', () => {
    const projectLegacyDir = join(tmpHome, 'memories', 'demo');
    mkdirSync(projectLegacyDir, { recursive: true });
    writeFileSync(join(projectLegacyDir, 'MEMORY.md'), 'fact one', 'utf-8');

    const store1 = new MemoryStore(tmpHome);
    const before = store1.getEntriesWithMeta('demo', 'memory').length;
    assert.equal(before, 1);

    // Re-open against the same SQLite — the legacy dir is now gone, so
    // no second migration triggers.
    const store2 = new MemoryStore(tmpHome);
    const after = store2.getEntriesWithMeta('demo', 'memory').length;
    assert.equal(after, 1);
  });

  it('skips migration entirely when no legacy directory exists', () => {
    const store = new MemoryStore(tmpHome);
    assert.deepEqual(store.getEntriesWithMeta('untouched', 'memory'), []);
  });
});

// ── listProjects ───────────────────────────────────────────────────────

describe('MemoryStore — listProjects', () => {
  it('lists every project that has memory or user entries', () => {
    const store = new MemoryStore(tmpHome);
    store.add('alpha', 'memory', 'a');
    store.add('beta', 'user', 'b');
    const out = store.listProjects();
    assert.deepEqual(out.sort(), ['alpha', 'beta']);
  });
});
