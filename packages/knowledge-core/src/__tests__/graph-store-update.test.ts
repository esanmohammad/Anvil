/**
 * Incremental system-graph updates and atomic full rebuilds.
 *
 * Pins: an update — a changed, a removed and an added repo plus a new
 * cross-repo edge set — leaves the same graph as a full rebuild from the same
 * inputs (nodes, degrees, edges, meta, the label index, exact / fuzzy
 * resolution, neighbours); WAL readers keep the old graph until the update
 * commits; the updater returns null for a file it can't update in place
 * (missing, unversioned / other version, no label index, no key_tail) and
 * rolls back on misuse; a full rebuild is renamed into place — the path holds
 * the old complete graph until then, readers of the old file keep reading it
 * and their close leaves the new file's -wal / -shm alone, and the old file's
 * WAL frames never reach the new file.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  createSystemGraphSqliteWriter,
  openSystemGraphSqliteUpdater,
  openSystemGraphStore,
  ProjectGraphBuilder,
  writeSystemGraphSqlite,
} from '@esankhan3/anvil-knowledge-core';
import type { CrossRepoEdge, GraphifyOutput, GraphStore, SystemGraphSqliteWriter } from '@esankhan3/anvil-knowledge-core';

type RepoGraph = Parameters<SystemGraphSqliteWriter['addRepoGraph']>[1];
type CrossEdges = Parameters<SystemGraphSqliteWriter['addCrossRepoEdges']>[0];

const root = join(tmpdir(), `kc-gsu-${randomBytes(6).toString('hex')}`);

const mod = (file: string) => ({ id: file, label: file.split('/').pop()!, type: 'module', file });
const ent = (file: string, name: string, type = 'function') => ({ id: `${file}::${name}`, label: name, type, file });
const has = (file: string, name: string) => ({ source: file, target: `${file}::${name}`, type: 'contains', confidence: 1 });
const rel = (source: string, target: string, type?: string, confidence?: number) =>
  ({ source, target, ...(type ? { type } : {}), ...(confidence === undefined ? {} : { confidence }) });

const A: RepoGraph = {
  nodes: [mod('a.ts'), ent('a.ts', 'getUser'), ent('a.ts', 'saveUser'), ent('a.ts', 'CONFIG_KEY', 'const')],
  links: [
    has('a.ts', 'getUser'), has('a.ts', 'saveUser'),
    rel('a.ts::getUser', 'a.ts::saveUser', 'calls', 0.9),
    rel('a.ts::saveUser', 'a.ts::saveUser', 'calls'), // self-loop, default confidence
    rel('a.ts', 'a.ts::getUser'),                     // no type → 'depends'
    rel('a.ts::getUser', 'a.ts::missing', 'calls'),   // endpoint not in the graph → skipped
  ],
};
const B1: RepoGraph = {
  nodes: [mod('b.ts'), ent('b.ts', 'handleOrder'), { ...ent('b.ts', 'getOrder'), community: 3 }],
  links: [has('b.ts', 'handleOrder'), rel('b.ts::handleOrder', 'b.ts::getOrder', 'calls', 0.9)],
};
const B2: RepoGraph = {
  nodes: [mod('b.ts'), ent('b.ts', 'handleOrder'), { ...ent('b.ts', 'handleOrder'), label: 'dup' }, ent('b.ts', 'fetchOrder')],
  links: [has('b.ts', 'handleOrder'), rel('b.ts::handleOrder', 'b.ts::fetchOrder', 'calls', 0.9), rel('b.ts::fetchOrder', 'b.ts::handleOrder', 'type-ref', 0.85)],
};
const C: RepoGraph = { nodes: [mod('c.ts'), ent('c.ts', 'parseConfig')], links: [has('c.ts', 'parseConfig')] };
const D: RepoGraph = {
  nodes: [{ id: 'pkg::@m/a', label: '@m/a', type: 'package', file: 'packages/a' }, { id: 'pkg::@m/b', label: '@m/b', type: 'package', file: 'packages/b' }],
  links: [],
};
const E: RepoGraph = {
  nodes: [mod('e.ts'), ent('e.ts', 'getEvent'), ent('e.ts', 'emitEvent')],
  links: [has('e.ts', 'getEvent'), rel('e.ts::emitEvent', 'e.ts::getEvent', 'calls', 0.9)],
};
const ORDERS_ROUTE = { sourceRepo: 'a', sourceNode: 'a.ts::/api/orders', targetRepo: 'b', targetNode: 'b.ts::/api/orders', edgeType: 'http', evidence: 'GET /api/orders', confidence: 0.8 };
const WORKSPACE = { sourceRepo: 'd', sourceNode: 'pkg::@m/a', targetRepo: 'd', targetNode: 'pkg::@m/b', edgeType: 'workspace-dep', evidence: '@m/a depends on @m/b', confidence: 1 };
const X1: CrossEdges = [
  ORDERS_ROUTE,
  { sourceRepo: 'c', sourceNode: 'c.ts::CONFIG_KEY', targetRepo: 'a', targetNode: 'a.ts::CONFIG_KEY', edgeType: 'env-var', evidence: 'CONFIG_KEY', confidence: 0.85 },
  WORKSPACE,
  { sourceRepo: 'b', sourceNode: 'b.ts::getOrder', targetRepo: 'a', targetNode: 'a.ts::getUser', edgeType: 'http', evidence: 'GET /users' },
];
const X2: CrossEdges = [
  ORDERS_ROUTE,
  WORKSPACE,
  { sourceRepo: 'b', sourceNode: 'b.ts::fetchOrder', targetRepo: 'a', targetNode: 'a.ts::getUser', edgeType: 'http', evidence: 'GET /users', confidence: 0.7 },
  { sourceRepo: 'e', sourceNode: 'e.ts::order-created', targetRepo: 'b', targetNode: 'b.ts::order-created', edgeType: 'event-schema', evidence: 'order-created', confidence: 0.85 },
  { sourceRepo: 'a', sourceNode: 'a.ts::/api/orders', targetRepo: 'e', targetNode: 'e.ts::/api/orders', edgeType: 'http', evidence: 'GET /api/orders', confidence: 0.8 },
];
const V1: Array<[string, RepoGraph]> = [['a', A], ['b', B1], ['c', C], ['d', D]];
const V2: Array<[string, RepoGraph]> = [['e', E], ['d', D], ['b', B2], ['a', A]];

const dbFile = (dir: string) => join(dir, 'system_graph.sqlite');

async function fullBuild(dir: string, repos: Array<[string, RepoGraph]>, cross: CrossEdges): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const w = await createSystemGraphSqliteWriter(dir);
  assert.ok(w, 'no sqlite driver');
  for (const [name, g] of repos) w.addRepoGraph(name, g);
  w.addCrossRepoEdges(cross);
  w.finalize();
}

/** v1 → v2 in place: b changed, c removed, e added, cross-repo edges replaced. */
async function updateToV2(dir: string): Promise<void> {
  const u = await openSystemGraphSqliteUpdater(dir);
  assert.ok(u, 'updater refused a current file');
  u.removeRepos(['b', 'c', 'e']);
  u.addRepoGraph('b', B2);
  u.addRepoGraph('e', E);
  u.replaceCrossRepoEdges(X2);
  u.finalize();
}

/** Every row of the file (rowids aside, which only order insertion). */
function rows(dir: string) {
  const db = new Database(dbFile(dir), { readonly: true });
  try {
    return {
      nodes: db.prepare('SELECT key, key_tail, repo, file, label, type, degree, attrs FROM nodes ORDER BY key').all(),
      edges: db.prepare('SELECT source, target, type, confidence, source_repo, target_repo, evidence, cross_repo FROM edges')
        .all().map((r) => JSON.stringify(r)).sort(),
      meta: db.prepare('SELECT k, v FROM meta ORDER BY k').all(),
    };
  } finally { db.close(); }
}

/** The label index holds exactly the node labels: for each term, the rows it
 *  matches are the rows whose label contains the term. */
function assertLabelIndexExact(dir: string): void {
  const db = new Database(dbFile(dir), { readonly: true });
  try {
    const labels = (db.prepare('SELECT label FROM nodes').all() as Array<{ label: string }>).map((r) => r.label);
    const terms = new Set(labels.filter((l) => l.length >= 3).flatMap((l) => [l, l.slice(0, 3), l.slice(-3)]));
    for (const t of terms) {
      const fts = (db.prepare('SELECT rowid r FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY rowid').all(`"${t.replace(/"/g, '""')}"`) as Array<{ r: number }>).map((x) => x.r);
      const scan = (db.prepare("SELECT rowid r FROM nodes WHERE instr(lower(label), lower(?)) > 0 ORDER BY rowid").all(t) as Array<{ r: number }>).map((x) => x.r);
      assert.deepEqual(fts, scan, `label index vs labels for "${t}"`);
    }
  } finally { db.close(); }
  const rw = new Database(dbFile(dir));
  try { rw.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('integrity-check')"); } finally { rw.close(); }
}

const sortedKeys = (xs: Array<{ key: string }>) => xs.map((x) => x.key).sort();

/** What the graph tools read from a store, order-insensitive. */
function answers(store: GraphStore) {
  const all = store.searchNodes({}, 1000).rows;
  const keys = all.map((r) => r.key).sort();
  const names = [...new Set(all.map((r) => r.label))].sort();
  return {
    nodes: all.map((r) => JSON.stringify(r)).sort(),
    exact: names.map((n) => [n, sortedKeys(store.resolveNodes(n)), sortedKeys(store.resolveNodes(n, 'b'))]),
    fuzzy: ['order', 'USER', 'get', 'api', '@m/', 'event', 'config', 'pars'].map((t) => [t, sortedKeys(store.resolveNodes(t, undefined, true)), sortedKeys(store.resolveNodes(t, 'a', true))]),
    neighbours: store.neighborEdges(keys, 'both', undefined, 10_000).map((p) => p.join(' ')).sort(),
    dependents: keys.map((k) => [k, store.dependents([k], 100).edges.map((e) => JSON.stringify(e)).sort()]),
    cross: store.crossRepoEdges(undefined, 100).edges.map((e) => JSON.stringify(e)).sort(),
  };
}

before(() => mkdirSync(root, { recursive: true }));
after(() => rmSync(root, { recursive: true, force: true }));

describe('openSystemGraphSqliteUpdater', () => {
  it('an update leaves the same graph as a full rebuild from the same inputs', async () => {
    const upd = join(root, 'same-upd');
    const full = join(root, 'same-full');
    await fullBuild(upd, V1, X1);
    await updateToV2(upd);
    await fullBuild(full, V2, X2);
    assert.deepEqual(rows(upd), rows(full));
    assertLabelIndexExact(upd);
    const [s1, s2] = [await openSystemGraphStore(upd), await openSystemGraphStore(full)];
    assert.ok(s1 && s2);
    try {
      assert.deepEqual(answers(s1), answers(s2));
      assert.deepEqual(sortedKeys(s1.resolveNodes('fetchOrder')), ['b::b.ts::fetchOrder']);
      assert.deepEqual(s1.resolveNodes('parseConfig'), []);
    } finally { s1.close(); s2.close(); }
  });

  it('a second update with nothing changed but the cross-repo edges still matches', async () => {
    const upd = join(root, 'again-upd');
    await fullBuild(upd, V1, X1);
    await updateToV2(upd);
    const u = await openSystemGraphSqliteUpdater(upd);
    assert.ok(u);
    u.removeRepos([]);
    u.replaceCrossRepoEdges(X1.filter((e) => e.sourceRepo !== 'c'));
    u.finalize();
    const full = join(root, 'again-full');
    await fullBuild(full, V2, X1.filter((e) => e.sourceRepo !== 'c'));
    assert.deepEqual(rows(upd), rows(full));
    assertLabelIndexExact(upd);
  });

  it('a reader keeps the old graph until the update commits', async () => {
    const dir = join(root, 'snapshot');
    await fullBuild(dir, V1, X1);
    const reader = await openSystemGraphStore(dir);
    assert.ok(reader);
    try {
      const u = await openSystemGraphSqliteUpdater(dir);
      assert.ok(u);
      u.removeRepos(['b', 'c', 'e']);
      u.addRepoGraph('b', B2);
      u.addRepoGraph('e', E);
      u.replaceCrossRepoEdges(X2);
      assert.deepEqual(sortedKeys(reader.resolveNodes('parseConfig')), ['c::c.ts::parseConfig']);
      assert.deepEqual(reader.resolveNodes('fetchOrder'), []);
      assert.deepEqual(sortedKeys(reader.resolveNodes('order', undefined, true)), ['b::b.ts::getOrder', 'b::b.ts::handleOrder']);
      u.finalize();
      assert.deepEqual(sortedKeys(reader.resolveNodes('fetchOrder')), ['b::b.ts::fetchOrder']); // WAL: the next read sees the commit
    } finally { reader.close(); }
    const reopened = await openSystemGraphStore(dir);
    assert.ok(reopened);
    try {
      assert.deepEqual(reopened.resolveNodes('parseConfig'), []);
      assert.deepEqual(sortedKeys(reopened.resolveNodes('fetchOrder')), ['b::b.ts::fetchOrder']);
    } finally { reopened.close(); }
  });

  it('returns null for a file it cannot update in place, leaving the file alone', async () => {
    const current = join(root, 'null-current');
    await fullBuild(current, V1, X1);
    const currentVersion = (rows(current).meta as Array<{ k: string; v: string }>).find((m) => m.k === 'schemaVersion')?.v;
    assert.ok(currentVersion, 'the writer records a schema version');
    assert.equal(await openSystemGraphSqliteUpdater(join(root, 'nowhere')), null);
    const edit = async (name: string, sql: string) => {
      const dir = join(root, `null-${name}`);
      await fullBuild(dir, V1, X1);
      const db = new Database(dbFile(dir));
      db.exec(sql);
      db.close();
      const before = rows(dir);
      assert.equal(await openSystemGraphSqliteUpdater(dir), null, name);
      assert.deepEqual(rows(dir), before, name);
    };
    await edit('unversioned', "DELETE FROM meta WHERE k = 'schemaVersion'");
    await edit('other-version', "UPDATE meta SET v = '0' WHERE k = 'schemaVersion'");
    await edit('no-label-index', 'DROP TABLE nodes_fts');
    // A file from before key_tail existed (claiming the current version).
    const old = join(root, 'null-no-key-tail');
    mkdirSync(old, { recursive: true });
    const db = new Database(dbFile(old));
    db.exec(`
      CREATE TABLE nodes (key TEXT PRIMARY KEY, repo TEXT, file TEXT, label TEXT, type TEXT, degree INTEGER, attrs TEXT);
      CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, type TEXT, confidence REAL, source_repo TEXT, target_repo TEXT, evidence TEXT, cross_repo INTEGER);
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE VIRTUAL TABLE nodes_fts USING fts5(name, content='', columnsize=0, tokenize='trigram');
    `);
    db.prepare("INSERT INTO meta VALUES ('schemaVersion', ?)").run(currentVersion);
    db.close();
    assert.equal(await openSystemGraphSqliteUpdater(old), null);
  });

  it('rolls back on misuse and on abort, leaving the file as it was', async () => {
    const dir = join(root, 'misuse');
    await fullBuild(dir, V1, X1);
    const before = rows(dir);
    const still = await openSystemGraphSqliteUpdater(dir);
    assert.ok(still);
    assert.throws(() => still.addRepoGraph('b', B2), /removeRepos/); // b is still in the graph
    assert.throws(() => still.finalize(), /closed/);
    const late = await openSystemGraphSqliteUpdater(dir);
    assert.ok(late);
    late.removeRepos(['b']);
    late.replaceCrossRepoEdges(X1);
    assert.throws(() => late.addRepoGraph('b', B2), /order/);
    const aborted = await openSystemGraphSqliteUpdater(dir);
    assert.ok(aborted);
    aborted.removeRepos(['a', 'b', 'c', 'd']);
    aborted.abort();
    assert.deepEqual(rows(dir), before);
  });
});

describe('full rebuild', () => {
  it('keeps the old complete graph at the path until it is done, then renames the new one in', async () => {
    const dir = join(root, 'atomic');
    await fullBuild(dir, V1, X1);
    const w = await createSystemGraphSqliteWriter(dir);
    assert.ok(w);
    for (const [name, g] of V2) w.addRepoGraph(name, g);
    const mid = await openSystemGraphStore(dir);
    assert.ok(mid);
    try {
      assert.deepEqual(sortedKeys(mid.resolveNodes('parseConfig')), ['c::c.ts::parseConfig']);
      assert.deepEqual(mid.resolveNodes('fetchOrder'), []);
    } finally { mid.close(); }
    w.addCrossRepoEdges(X2);
    w.finalize();
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp')), []);
    const after = await openSystemGraphStore(dir);
    assert.ok(after);
    try {
      assert.deepEqual(after.resolveNodes('parseConfig'), []);
      assert.deepEqual(sortedKeys(after.resolveNodes('fetchOrder')), ['b::b.ts::fetchOrder']);
    } finally { after.close(); }
  });

  it("a reader of the old file keeps reading it, and its close leaves the new file's -wal / -shm alone", async () => {
    const dir = join(root, 'old-reader');
    await fullBuild(dir, V1, X1);
    const oldReader = await openSystemGraphStore(dir);
    assert.ok(oldReader);
    assert.deepEqual(sortedKeys(oldReader.resolveNodes('parseConfig')), ['c::c.ts::parseConfig']);
    await fullBuild(dir, V2, X2);
    const newReader = await openSystemGraphStore(dir);
    assert.ok(newReader);
    try {
      assert.deepEqual(sortedKeys(oldReader.resolveNodes('parseConfig')), ['c::c.ts::parseConfig']);
      assert.deepEqual(oldReader.resolveNodes('fetchOrder'), []);
      assert.deepEqual(sortedKeys(newReader.resolveNodes('fetchOrder')), ['b::b.ts::fetchOrder']);
      assert.ok(existsSync(`${dbFile(dir)}-shm`) && existsSync(`${dbFile(dir)}-wal`));
      oldReader.close();
      assert.ok(existsSync(`${dbFile(dir)}-shm`) && existsSync(`${dbFile(dir)}-wal`), 'the old reader deleted the new file\'s -wal / -shm');
      assert.deepEqual(sortedKeys(newReader.resolveNodes('fetchOrder')), ['b::b.ts::fetchOrder']);
    } finally { newReader.close(); }
  });

  it("the old file's WAL frames never reach the new file", async () => {
    const dir = join(root, 'stale-wal');
    await fullBuild(dir, V1, X1);
    const writer = new Database(dbFile(dir)); // leaves committed frames in the WAL while it stays open
    writer.pragma('wal_autocheckpoint = 0');
    writer.prepare("INSERT INTO nodes(key, key_tail, repo, file, label, type, degree) VALUES ('z::z.ts::staleNode', 'staleNode', 'z', 'z.ts', 'staleNode', 'function', 0)").run();
    try {
      await fullBuild(dir, V2, X2);
      const full = join(root, 'stale-wal-full');
      await fullBuild(full, V2, X2);
      assert.deepEqual(rows(dir), rows(full));
      const db = new Database(dbFile(dir), { readonly: true });
      try { assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); } finally { db.close(); }
    } finally { writer.close(); }
  });

  it('marks the cross-repo edges on the in-memory path too, so its file can be updated', async () => {
    const dir = join(root, 'graphology');
    mkdirSync(dir, { recursive: true });
    const b = new ProjectGraphBuilder();
    await b.init();
    for (const [name, g] of V1) b.addRepoGraph(name, g as GraphifyOutput);
    b.addCrossRepoEdges(X1 as CrossRepoEdge[]);
    assert.ok(await writeSystemGraphSqlite(dir, b));
    const db = new Database(dbFile(dir), { readonly: true });
    try {
      assert.equal((db.prepare('SELECT count(*) c FROM edges WHERE cross_repo IS NOT NULL').get() as { c: number }).c, X1.length);
    } finally { db.close(); }
    const u = await openSystemGraphSqliteUpdater(dir);
    assert.ok(u);
    u.abort();
  });
});
