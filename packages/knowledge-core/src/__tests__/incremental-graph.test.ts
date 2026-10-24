/**
 * buildKB updates system_graph.sqlite in place when a few repos change, and
 * the result equals a full rebuild. Drives the real buildKB (kb-fixture.ts).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildKBFromPath } from '@esankhan3/anvil-knowledge-core';
import { fn, withKbFixture } from './kb-fixture.js';

const require = createRequire(import.meta.url);

function snapshot(dbPath: string): { nodes: string[]; edges: string[] } {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    const nodes = db.prepare('SELECT key, repo, type, label, degree FROM nodes').all().map((r: unknown) => JSON.stringify(r)).sort();
    const edges = db.prepare('SELECT source, target, type, source_repo, target_repo FROM edges').all().map((r: unknown) => JSON.stringify(r)).sort();
    return { nodes, edges };
  } finally {
    db.close();
  }
}

describe('incremental system graph', () => {
  it('a one-repo change updates the graph in place, equal to a full rebuild', async (t) => {
    try { require('better-sqlite3'); } catch { t.skip('better-sqlite3 unavailable'); return; }
    await withKbFixture(t, async (f) => {
      const topic = "export const TOPIC = 'order.created';\n";
      f.repo('pub', { 'p.ts': topic + fn('publishOrder') + fn('helperPub') });
      f.repo('sub', { 's.ts': topic + fn('consumeOrder') });
      f.repo('gone', { 'g.ts': fn('goneFn') });
      await f.index();

      f.write('pub', 'p.ts', topic + fn('publishOrder', ' + 1') + fn('helperPub') + fn('addedPub'));
      f.commit('pub');
      rmSync(join(f.ws, 'gone'), { recursive: true, force: true });
      const logs: string[] = [];
      await buildKBFromPath(f.project, f.ws, { config: f.config, onProgress: (m: string) => logs.push(m) });
      assert.ok(logs.some((m) => m.startsWith('Updated project graph in place')), `no in-place update: ${logs.join(' | ')}`);

      const dbPath = join(process.env.CODE_SEARCH_DATA_DIR!, f.project, 'system_graph.sqlite');
      const updated = snapshot(dbPath);
      assert.ok(updated.nodes.some((n) => n.includes('addedPub')), 'new entity present');
      assert.ok(!updated.nodes.some((n) => n.includes('"gone"')), 'removed repo gone');

      await buildKBFromPath(f.project, f.ws, { config: f.config, force: true });
      assert.deepEqual(updated, snapshot(dbPath), 'differs from a full rebuild');
    });
  });
});
