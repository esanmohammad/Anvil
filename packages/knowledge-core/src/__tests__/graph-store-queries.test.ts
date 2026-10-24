/**
 * GraphStore query semantics — run against BOTH backends (the SQLite store
 * buildKB writes, and the JSON store for indexes without a SQLite driver), so
 * the graph tools behave the same on either.
 *
 * Pins: cross-repo evidence is stored and returned; symmetric cross-repo edge
 * types count as dependents from both sides; same-repo workspace-dep edges are
 * listed with the cross-repo edges; exact name resolution is case-sensitive,
 * wildcard-free and accepts a full `repo::file::entity` id; fuzzy and regex
 * name matching look at symbol names, not file paths; relation-typed
 * callers / dependencies / neighbours.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  createSystemGraphSqliteWriter,
  openSystemGraphStore,
  ProjectGraphBuilder,
  SYMMETRIC_EDGE_TYPES,
} from '@esankhan3/anvil-knowledge-core';
import type { CrossRepoEdge, GraphStore, GraphifyOutput } from '@esankhan3/anvil-knowledge-core';

const root = join(tmpdir(), `kc-gsq-${randomBytes(6).toString('hex')}`);

const ORDERS: GraphifyOutput = {
  nodes: [
    { id: 'src/server.ts', label: 'server.ts', type: 'module', file: 'src/server.ts' },
    { id: 'src/server.ts::getOrderById', label: 'getOrderById', type: 'function', file: 'src/server.ts' },
    { id: 'src/server.ts::get_order', label: 'get_order', type: 'function', file: 'src/server.ts' },
    { id: 'src/server.ts::getXorder', label: 'getXorder', type: 'function', file: 'src/server.ts' },
    { id: 'src/server.ts::Handler', label: 'Handler', type: 'class', file: 'src/server.ts' },
    { id: 'src/server.ts::handler', label: 'handler', type: 'function', file: 'src/server.ts' },
    { id: 'src/models.ts', label: 'models.ts', type: 'module', file: 'src/models.ts' },
    { id: 'src/models.ts::LineItem', label: 'LineItem', type: 'interface', file: 'src/models.ts' },
    { id: 'src/models.ts::Base', label: 'Base', type: 'class', file: 'src/models.ts' },
    { id: 'src/models.ts::Order', label: 'Order', type: 'class', file: 'src/models.ts' },
    { id: 'src/models.ts::total', label: 'total', type: 'method', file: 'src/models.ts' },
    { id: 'src/pipeline/chainA.ts', label: 'chainA.ts', type: 'module', file: 'src/pipeline/chainA.ts' },
    { id: 'src/pipeline/chainA.ts::startPipeline', label: 'startPipeline', type: 'function', file: 'src/pipeline/chainA.ts' },
    { id: 'src/pipeline/stepThree.ts', label: 'stepThree.ts', type: 'module', file: 'src/pipeline/stepThree.ts' },
    { id: 'src/pipeline/stepThree.ts::stepThree', label: 'stepThree', type: 'function', file: 'src/pipeline/stepThree.ts' },
  ],
  links: [
    { source: 'src/server.ts', target: 'src/server.ts::getOrderById', type: 'contains', confidence: 1 },
    { source: 'src/models.ts::Order', target: 'src/models.ts::total', type: 'contains', confidence: 1 },
    { source: 'src/pipeline/chainA.ts::startPipeline', target: 'src/pipeline/stepThree.ts::stepThree', type: 'calls', confidence: 0.9 },
    { source: 'src/pipeline/chainA.ts', target: 'src/pipeline/stepThree.ts', type: 'imports', confidence: 1 },
    { source: 'src/pipeline/chainA.ts', target: 'src/pipeline/stepThree.ts::stepThree', type: 'uses', confidence: 0.95 },
    { source: 'src/server.ts::getOrderById', target: 'src/models.ts::LineItem', type: 'type-ref', confidence: 0.85 },
    { source: 'src/models.ts::Order', target: 'src/models.ts::Base', type: 'inherits', confidence: 0.95 },
  ],
};

const WEB: GraphifyOutput = {
  nodes: [{ id: 'src/api/orders.ts::fetchOrder', label: 'fetchOrder', type: 'function', file: 'src/api/orders.ts' }],
  links: [],
};

const ANALYTICS: GraphifyOutput = {
  nodes: [{ id: 'consumer.py::consume', label: 'consume', type: 'function', file: 'consumer.py' }],
  links: [],
};

const MONO: GraphifyOutput = {
  nodes: [
    { id: 'pkg::@m/a', label: '@m/a', type: 'package', file: 'packages/a' },
    { id: 'pkg::@m/b', label: '@m/b', type: 'package', file: 'packages/b' },
  ],
  links: [],
};

const CROSS: CrossRepoEdge[] = [
  {
    sourceRepo: 'web', sourceNode: 'src/api/orders.ts::/api/orders/:param',
    targetRepo: 'orders', targetNode: 'src/server.ts::/api/orders/:param',
    edgeType: 'http', evidence: 'API endpoint: /api/orders/:param', confidence: 0.8,
  },
  {
    sourceRepo: 'analytics', sourceNode: 'consumer.py::order-created',
    targetRepo: 'orders', targetNode: 'src/server.ts::order-created',
    edgeType: 'event-schema', evidence: 'Shared event/topic: order-created', confidence: 0.85,
  },
  {
    sourceRepo: 'mono', sourceNode: 'pkg::@m/a', targetRepo: 'mono', targetNode: 'pkg::@m/b',
    edgeType: 'workspace-dep', evidence: '@m/a depends on @m/b (packages/a/package.json)', confidence: 1,
  },
];

const REPOS: Array<[string, GraphifyOutput]> = [['orders', ORDERS], ['web', WEB], ['analytics', ANALYTICS], ['mono', MONO]];

async function buildSqlite(dir: string): Promise<GraphStore> {
  mkdirSync(dir, { recursive: true });
  const w = await createSystemGraphSqliteWriter(dir);
  assert.ok(w, 'no sqlite driver');
  for (const [name, g] of REPOS) w.addRepoGraph(name, g);
  w.addCrossRepoEdges(CROSS);
  w.finalize();
  const store = await openSystemGraphStore(dir);
  assert.ok(store);
  return store;
}

async function buildJson(dir: string): Promise<GraphStore> {
  mkdirSync(dir, { recursive: true });
  const b = new ProjectGraphBuilder();
  await b.init();
  for (const [name, g] of REPOS) b.addRepoGraph(name, g);
  b.addCrossRepoEdges(CROSS);
  writeFileSync(join(dir, 'system_graph_v2.json'), JSON.stringify(b.exportJson()));
  const store = await openSystemGraphStore(dir);
  assert.ok(store);
  return store;
}

const keys = (rows: Array<{ key: string }>): string[] => rows.map((r) => r.key).sort();

before(() => mkdirSync(root, { recursive: true }));
after(() => rmSync(root, { recursive: true, force: true }));

for (const [kind, build] of [['sqlite', buildSqlite], ['json', buildJson]] as const) {
  describe(`GraphStore (${kind})`, () => {
    let store: GraphStore;
    before(async () => { store = await build(join(root, kind)); });
    after(() => store.close());

    it('returns cross-repo edge evidence', () => {
      const { edges } = store.crossRepoEdges('web', 10);
      assert.equal(edges.length, 1);
      assert.equal(edges[0].evidence, 'API endpoint: /api/orders/:param');
      const dep = store.dependents(store.nodesInFiles('orders', ['src/server.ts']), 10);
      assert.ok(dep.edges.some((e) => e.evidence === 'Shared event/topic: order-created'));
    });

    it('treats symmetric edge types as dependents from both sides; directional ones one way', () => {
      assert.ok(SYMMETRIC_EDGE_TYPES.has('event-schema'));
      assert.ok(!SYMMETRIC_EDGE_TYPES.has('http'));
      // analytics is the stored source of the shared-topic edge: orders still depends on it.
      const fromAnalytics = store.dependents(store.nodesInFiles('analytics', ['consumer.py']), 10);
      assert.deepEqual(fromAnalytics.repos, ['orders']);
      assert.equal(fromAnalytics.edges[0].source, 'orders::src/server.ts::order-created');
      // http is client → route: the route's repo is not a dependent of the client.
      assert.deepEqual(store.dependents(store.nodesInFiles('web', ['src/api/orders.ts']), 10).repos, []);
      assert.deepEqual(store.dependents(store.nodesInFiles('orders', ['src/server.ts']), 10).repos.sort(), ['analytics', 'web']);
    });

    it('lists same-repo workspace-dep edges with the cross-repo edges', () => {
      const { edges, total } = store.crossRepoEdges('mono', 10);
      assert.equal(total, 1);
      assert.equal(edges[0].type, 'workspace-dep');
      assert.equal(store.crossRepoEdges(undefined, 10).total, 3);
    });

    it('resolves a full repo::file::entity id', () => {
      assert.deepEqual(keys(store.resolveNodes('orders::src/pipeline/chainA.ts::startPipeline')), ['orders::src/pipeline/chainA.ts::startPipeline']);
      assert.deepEqual(keys(store.resolveNodes('src/pipeline/chainA.ts::startPipeline')), ['orders::src/pipeline/chainA.ts::startPipeline']);
    });

    it('exact resolution is case-sensitive and treats % and _ literally', () => {
      assert.deepEqual(store.resolveNodes('%'), []);
      assert.deepEqual(keys(store.resolveNodes('get_order')), ['orders::src/server.ts::get_order']);
      assert.deepEqual(keys(store.resolveNodes('handler')), ['orders::src/server.ts::handler']);
      assert.deepEqual(store.resolveNodes('fetchOrder', 'we_'), []);
      assert.deepEqual(store.nodesInFiles('orders', ['src/server.ts'], 'get_order'), ['orders::src/server.ts::get_order']);
      assert.deepEqual(store.nodesInFiles('orders', ['src/server_ts']), []);
      assert.deepEqual(store.nodesInFiles('orders', ['SRC/server.ts']), []);
    });

    it('fuzzy resolution matches symbol names, not file paths', () => {
      assert.deepEqual(keys(store.resolveNodes('Pipeline', undefined, true)), ['orders::src/pipeline/chainA.ts::startPipeline']);
      assert.deepEqual(keys(store.resolveNodes('three', undefined, true)), ['orders::src/pipeline/stepThree.ts::stepThree']);
      assert.deepEqual(store.resolveNodes('%', undefined, true), []);
    });

    it('callers / dependencies / neighbours filter by relation and report it', () => {
      const stepThree = ['orders::src/pipeline/stepThree.ts::stepThree'];
      assert.deepEqual(store.callers(stepThree, 10, ['calls']), [{ key: 'orders::src/pipeline/chainA.ts::startPipeline', type: 'calls' }]);
      assert.deepEqual(
        store.callers(stepThree, 10).map((c) => `${c.type} ${c.key}`).sort(),
        ['calls orders::src/pipeline/chainA.ts::startPipeline', 'uses orders::src/pipeline/chainA.ts'],
      );
      assert.deepEqual(store.callers(['orders::src/models.ts::LineItem'], 10, ['calls']), []);
      assert.deepEqual(store.dependencies(['orders::src/server.ts::getOrderById'], 10, ['type-ref']), [{ key: 'orders::src/models.ts::LineItem', type: 'type-ref' }]);
      assert.deepEqual(store.neighborsOf('orders::src/pipeline/chainA.ts', 'callees', ['calls']), []);
      assert.deepEqual(store.neighborsOf('orders::src/pipeline/chainA.ts', 'callees').sort(), [
        'orders::src/pipeline/stepThree.ts', 'orders::src/pipeline/stepThree.ts::stepThree',
      ]);
    });

    it('searchNodes: case-insensitive regex on symbol names, every node type', () => {
      assert.deepEqual(keys(store.searchNodes({ name: '^step.*$' }, 10).rows), ['orders::src/pipeline/stepThree.ts::stepThree']);
      assert.deepEqual(keys(store.searchNodes({ name: 'PIPELINE' }, 10).rows), ['orders::src/pipeline/chainA.ts::startPipeline']);
      assert.deepEqual(keys(store.searchNodes({ name: 'stepThree', type: 'module' }, 10).rows), ['orders::src/pipeline/stepThree.ts']);
      assert.deepEqual(keys(store.searchNodes({ type: 'method' }, 10).rows), ['orders::src/models.ts::total']);
      assert.deepEqual(keys(store.searchNodes({ name: 'get_order' }, 10).rows), ['orders::src/server.ts::get_order']);
      assert.equal(store.searchNodes({ repo: 'we_' }, 10).total, 0);
      assert.throws(() => store.searchNodes({ name: '(' }, 10), /Invalid regex/);
    });
  });
}

describe('SqliteGraphStore — files written before evidence was stored', () => {
  it('still reads edges (evidence absent)', async () => {
    const dir = join(root, 'old');
    mkdirSync(dir, { recursive: true });
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(join(dir, 'system_graph.sqlite'));
    db.exec(`
      CREATE TABLE nodes (key TEXT PRIMARY KEY, repo TEXT, file TEXT, label TEXT, type TEXT, degree INTEGER, attrs TEXT);
      CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, type TEXT, confidence REAL, source_repo TEXT, target_repo TEXT);
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
      INSERT INTO nodes VALUES ('a::x.ts::r', 'a', 'x.ts', 'x.ts::r', 'external', 1, NULL), ('b::y.ts::r', 'b', 'y.ts', 'y.ts::r', 'external', 1, NULL);
      INSERT INTO edges VALUES ('a::x.ts::r', 'b::y.ts::r', 'database', 0.85, 'a', 'b');
    `);
    db.close();
    const store = await openSystemGraphStore(dir);
    assert.ok(store);
    const { edges, total } = store.crossRepoEdges(undefined, 10);
    assert.equal(total, 1);
    assert.equal(edges[0].evidence, undefined);
    assert.deepEqual(store.dependents(['a::x.ts::r'], 10).repos, ['b']);
    store.close();
  });
});
