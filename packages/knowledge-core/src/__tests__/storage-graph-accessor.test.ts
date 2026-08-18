/**
 * getGraphStore — shared, cached system-graph store per project.
 *
 * Pins the contract the mcp graph tools rely on: (1) a null resolution (KB
 * not built yet) is NOT pinned — the store appears on the next call once the
 * writer publishes; (2) repeat calls share ONE open store (no re-open — and
 * on a remote blob backend, no re-download — per tool call); (3)
 * invalidateRetriever closes + drops it so the next call reopens fresh data.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  getGraphStore,
  invalidateRetriever,
  writeSystemGraphSqlite,
  getKnowledgeBasePath,
} from '@esankhan3/anvil-knowledge-core';
import type { GraphIterable } from '@esankhan3/anvil-knowledge-core';

const dataDir = join(tmpdir(), `kc-graph-acc-${randomBytes(6).toString('hex')}`);
const prev = process.env.CODE_SEARCH_DATA_DIR;

before(() => { process.env.CODE_SEARCH_DATA_DIR = dataDir; });
after(async () => {
  await invalidateRetriever(); // release SQLite handles before rm
  if (prev === undefined) delete process.env.CODE_SEARCH_DATA_DIR;
  else process.env.CODE_SEARCH_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

function tinyGraph(): GraphIterable {
  const nodes: Array<[string, Record<string, unknown>]> = [
    ['repoA::src/a.ts::fnA', { label: 'fnA', type: 'function', file: 'src/a.ts' }],
    ['repoA::src/b.ts::fnB', { label: 'fnB', type: 'function', file: 'src/b.ts' }],
  ];
  const edges: Array<[string, string, Record<string, unknown>]> = [
    ['repoA::src/a.ts::fnA', 'repoA::src/b.ts::fnB', { type: 'calls' }],
  ];
  return {
    forEachNode: (cb) => nodes.forEach(([k, a]) => cb(k, a)),
    forEachEdge: (cb) => edges.forEach(([s, t, a]) => cb(s, t, a)),
  };
}

describe('getGraphStore — shared cached graph store', () => {
  it('null before the writer publishes, found after (null not pinned), then cached', async () => {
    const project = `proj-${randomBytes(4).toString('hex')}`;

    assert.equal(await getGraphStore(project), null, 'no graph yet');

    mkdirSync(getKnowledgeBasePath(project), { recursive: true });
    const wrote = await writeSystemGraphSqlite(getKnowledgeBasePath(project), tinyGraph());
    assert.equal(wrote, true);

    const store = await getGraphStore(project);
    assert.ok(store, 'graph visible on the call after publish');
    assert.equal(store.resolveNodes('fnA')[0]?.label, 'fnA');

    // Cached: the same instance serves repeat calls (no re-open per tool call).
    assert.equal(await getGraphStore(project), store);
  });

  it('invalidateRetriever closes the shared store and the next call reopens', async () => {
    const project = `proj-${randomBytes(4).toString('hex')}`;
    mkdirSync(getKnowledgeBasePath(project), { recursive: true });
    await writeSystemGraphSqlite(getKnowledgeBasePath(project), tinyGraph());

    const first = await getGraphStore(project);
    assert.ok(first);
    await invalidateRetriever(project);

    // Old handle is closed…
    assert.throws(() => first.resolveNodes('fnA'));
    // …and the next call serves a fresh, working store.
    const second = await getGraphStore(project);
    assert.ok(second);
    assert.notEqual(second, first);
    assert.equal(second.resolveNodes('fnB')[0]?.label, 'fnB');
  });
});
