/**
 * System-graph store. The merged cross-repo graph used to be persisted as one
 * `system_graph_v2.json` blob and read back with `JSON.parse(readFileSync())`.
 * At org scale (900k+ nodes / 2.4M+ edges) a single JSON string exceeds V8's
 * `String::kMaxLength` (~512MB) on BOTH write (`JSON.stringify`) and read, and
 * every graph-tool call would otherwise load the whole graph into memory.
 *
 * This module persists the graph into an embedded SQLite db
 * (`<basePath>/system_graph.sqlite`) and serves the graph tools as indexed
 * queries that touch only their slice. A JSON-backed store is kept as a
 * fallback for indexes built before this change / when no sqlite driver is
 * available. See docs/SYSTEM-GRAPH-SQLITE-PLAN.md.
 */

import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GraphDirection = 'callees' | 'callers' | 'both';
export interface GraphEdge { source: string; target: string; type?: string; evidence?: string }
export interface GraphNodeRow { key: string; label: string; type: string; file: string; degree: number }
/** A neighbouring node and the relation (edge type) that links it. */
export interface TypedNeighbor { key: string; type: string }

/** Cross-repo edge types that describe a shared resource (topic, table, key
 *  prefix, bucket, type, constant, env var, dependency) rather than a
 *  client → provider call: the detector stores one edge per pair in an
 *  arbitrary order, so each side depends on the other. */
export const SYMMETRIC_EDGE_TYPES: ReadonlySet<string> = new Set([
  'event-schema', 'database', 'redis', 's3', 'shared-type', 'shared-constant', 'env-var', 'npm-dep',
]);

/** Node types that are not symbols: files, and the synthetic endpoints of
 *  cross-repo edges (labelled `file::thing`). Fuzzy and regex name matching
 *  skip them unless the caller asks for the type explicitly. */
const NON_SYMBOL_TYPES = ['module', 'external'];

/** Fuzzy terms shorter than this (in characters) match exactly: the trigram
 *  index can't serve them, and a 1–2 character substring matches a large
 *  share of all symbols. */
export const FUZZY_MIN_CHARS = 3;

/**
 * Query surface the system-graph tools need. Implemented over SQLite and
 * (fallback) over the legacy JSON export.
 *
 * Name resolution (`resolveNodes`): exact by default — a node's full key, its
 * label, or a `::`-suffix of its key (`file::entity`), case-sensitive;
 * `fuzzy` = case-insensitive substring of symbol labels (a term under
 * {@link FUZZY_MIN_CHARS} characters matches exactly instead). At most `limit`
 * matches (default 5000), in insertion order. `types` filters by
 * edge type (`calls`, `imports`, `uses`, `type-ref`, `inherits`, cross-repo
 * types); omitted = every edge type except `contains`. `crossRepoEdges` also
 * returns same-repo `workspace-dep` edges. `dependents` follows edges into the
 * set, plus {@link SYMMETRIC_EDGE_TYPES} edges out of it (returned flipped, so
 * `source` is always the dependent); with `maxRows` it stops after that many
 * edges, and `truncated` says the count stopped there. `neighborEdges` is
 * `neighborsOf` for many keys at once — `[key, neighbour]` pairs, at most
 * `limit`. `searchNodes` `name` is a case-insensitive regex over symbol
 * labels; an invalid one throws.
 */
export interface GraphStore {
  resolveNodes(name: string, repo?: string, fuzzy?: boolean, limit?: number): Array<{ key: string; label: string }>;
  callers(targetKeys: string[], limit: number, types?: string[]): TypedNeighbor[];
  dependencies(sourceKeys: string[], limit: number, types?: string[]): TypedNeighbor[];
  crossRepoEdges(repo: string | undefined, limit: number): { edges: GraphEdge[]; total: number };
  nodesInFiles(repo: string, files: string[], entity?: string): string[];
  dependents(nodeKeys: string[], limit: number, maxRows?: number): { edges: GraphEdge[]; total: number; repos: string[]; truncated: boolean };
  neighborsOf(key: string, direction: GraphDirection, types?: string[]): string[];
  neighborEdges(keys: string[], direction: GraphDirection, types: string[] | undefined, limit: number): Array<[string, string]>;
  labelsOf(keys: string[]): Map<string, string>;
  nodeTypes(keys: string[]): Map<string, string>;
  searchNodes(
    f: { name?: string; type?: string; file?: string; repo?: string; minDegree?: number },
    limit: number,
  ): { rows: GraphNodeRow[]; total: number };
  close(): void;
}

export interface GraphIterable {
  forEachNode(cb: (key: string, attrs: Record<string, unknown>) => void): void;
  forEachEdge(cb: (source: string, target: string, attrs: Record<string, unknown>) => void): void;
}

export function systemGraphSqlitePath(basePath: string): string {
  return join(basePath, 'system_graph.sqlite');
}

// ---------------------------------------------------------------------------
// SQLite driver wrapper — prefer better-sqlite3 (works on the deploy Node),
// fall back to node:sqlite (built-in, Node 22.5+/local), else null → caller
// uses the JSON store. Both drivers share prepare/run/all/get/exec/close.
// ---------------------------------------------------------------------------

interface SqliteStmt { run(...a: unknown[]): unknown; all(...a: unknown[]): any[]; get(...a: unknown[]): any }
interface SqliteDb {
  prepare(sql: string): SqliteStmt;
  exec(sql: string): void;
  close(): void;
  /** User-defined SQL function — better-sqlite3, and node:sqlite from 22.13 / 23.5. */
  function?(name: string, options: { deterministic?: boolean }, fn: (...a: any[]) => unknown): unknown;
}
type Opener = (path: string) => SqliteDb;

let driverPromise: Promise<Opener | null> | undefined;
function loadDriver(): Promise<Opener | null> {
  if (!driverPromise) {
    driverPromise = (async () => {
      try {
        const m: any = await import('better-sqlite3');
        const open = (p: string) => new m.default(p) as SqliteDb;
        open(':memory:').close(); // probe: the native binding loads lazily on first open, not at import
        return open;
      } catch { /* not installed or native ABI mismatch → try the next driver */ }
      try {
        const m: any = await import('node:sqlite');
        const open = (p: string) => new m.DatabaseSync(p) as SqliteDb;
        open(':memory:').close(); // probe: throws on Node without the flag / too-old Node
        return open;
      } catch { /* not available → caller falls back to JSON */ }
      return null;
    })();
  }
  return driverPromise;
}

// nodes.key_tail = keyTail(key), indexed so exact `::name` resolution is a
// btree lookup (files written before it existed have no such column).
// edges.cross_repo = 1 on the edges addCrossRepoEdges wrote (same-repo
// `workspace-dep` ones included), NULL on repo-graph edges: the updater
// replaces exactly that set. idx_nodes_repo, idx_edges_crossrepo (source_repo)
// and idx_edges_target_repo serve its per-repo deletes.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  key TEXT PRIMARY KEY, key_tail TEXT, repo TEXT, file TEXT, label TEXT, type TEXT, degree INTEGER, attrs TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_repo  ON nodes(repo);
CREATE INDEX IF NOT EXISTS idx_nodes_type  ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(label);
CREATE INDEX IF NOT EXISTS idx_nodes_key_tail ON nodes(key_tail);
CREATE INDEX IF NOT EXISTS idx_nodes_file  ON nodes(repo, file);
CREATE TABLE IF NOT EXISTS edges (
  source TEXT NOT NULL, target TEXT NOT NULL, type TEXT, confidence REAL,
  source_repo TEXT, target_repo TEXT, evidence TEXT, cross_repo INTEGER
);
CREATE INDEX IF NOT EXISTS idx_edges_source    ON edges(source, type);
CREATE INDEX IF NOT EXISTS idx_edges_target    ON edges(target, type);
CREATE INDEX IF NOT EXISTS idx_edges_crossrepo ON edges(source_repo, target_repo);
CREATE INDEX IF NOT EXISTS idx_edges_target_repo ON edges(target_repo);
CREATE INDEX IF NOT EXISTS idx_edges_cross     ON edges(cross_repo) WHERE cross_repo IS NOT NULL;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;
/** meta `schemaVersion`: the file has everything above (`nodes_fts` only when
 *  the driver could build it). Absent: written before versioning — readers
 *  feature-detect, the updater refuses the file. */
const SCHEMA_VERSION = '1';

const repoOf = (key: string): string => key.split('::')[0] ?? '';
const fileOf = (key: string): string => key.split('::')[1] ?? '';
const labelFromKey = (key: string): string => key.split('::').slice(2).join('::') || key;
/** Text after the last `::`. A key ending in `::name` has the same tail as `::name`. */
const keyTail = (key: string): string => {
  const i = key.lastIndexOf('::');
  return i < 0 ? key : key.slice(i + 2);
};
const INSERT_NODE = 'INSERT OR REPLACE INTO nodes(key,key_tail,repo,file,label,type,degree,attrs) VALUES(?,?,?,?,?,?,?,?)';
const INSERT_EDGE = 'INSERT INTO edges(source,target,type,confidence,source_repo,target_repo,evidence,cross_repo) VALUES(?,?,?,?,?,?,?,?)';

function writeMeta(db: SqliteDb, nodeCount: number): void {
  const set = db.prepare('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)');
  set.run('nodeCount', String(nodeCount));
  set.run('schemaVersion', SCHEMA_VERSION);
}

/** A full rebuild writes here, next to the live file, and then
 *  {@link publishGraphFile} renames it over the live file. One name, so a
 *  rebuild that died is cleared by the next one (there is one writer). */
const tempGraphPath = (dbPath: string): string => `${dbPath}.tmp`;

/** A new, empty graph file at `path` (any old one and its -wal / -shm removed). */
function createGraphFile(open: Opener, path: string): SqliteDb {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    try { rmSync(f, { force: true }); } catch { /* ok */ }
  }
  const db = open(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  db.exec(SCHEMA);
  return db;
}

/**
 * Swap a finished, closed graph file in for the live one by rename, so a
 * reader opening `system_graph.sqlite` gets the old complete graph or the new
 * one, never a partial one. Connections to the old file keep reading it (its
 * inode lives until they close); SQLite sees that file has moved, so their
 * close neither checkpoints into nor deletes the -wal / -shm at the path.
 * Those belong to the old file: the old WAL is truncated before the rename and
 * both are unlinked right after it, so new connections start fresh ones. A
 * connection opened between the rename and the unlink finds no WAL frames but
 * shares the old -shm, so it must be reopened before the file is next updated
 * (readers reopen per index generation).
 */
function publishGraphFile(open: Opener, tmp: string, dbPath: string): void {
  if (existsSync(dbPath)) {
    try {
      const live = open(dbPath);
      try {
        live.exec('PRAGMA busy_timeout = 5000');
        live.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally { live.close(); }
    } catch { /* unreadable: replaced below all the same */ }
  }
  renameSync(tmp, dbPath);
  for (const f of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    try { rmSync(f, { force: true }); } catch { /* ok */ }
  }
}

/** Trigram FTS5 index over node labels (rowid = nodes.rowid; contentless, so
 *  it stores only the index) for fuzzy name matching. Skipped when the
 *  driver's SQLite has no FTS5 or trigram tokenizer (SQLite < 3.34): readers
 *  then scan. */
function indexLabels(db: SqliteDb): void {
  try {
    db.exec("CREATE VIRTUAL TABLE nodes_fts USING fts5(name, content='', columnsize=0, tokenize='trigram')");
  } catch { return; }
  db.exec('INSERT INTO nodes_fts(rowid, name) SELECT rowid, label FROM nodes');
}

/** Stream the in-memory graph into a fresh sqlite db, swapped in for the live
 *  one once complete. Returns false if no driver is available (caller falls
 *  back to the JSON write). */
export async function writeSystemGraphSqlite(basePath: string, graph: GraphIterable): Promise<boolean> {
  const open = await loadDriver();
  if (!open) return false;
  const dbPath = systemGraphSqlitePath(basePath);
  const tmp = tempGraphPath(dbPath);
  const db = createGraphFile(open, tmp);

  const insNode = db.prepare(INSERT_NODE);
  const insEdge = db.prepare(INSERT_EDGE);

  const degree = new Map<string, number>();
  db.exec('BEGIN');
  try {
    graph.forEachEdge((source, target, attrs) => {
      const type = (attrs.type ?? attrs.relation ?? null) as string | null;
      const confidence = (typeof attrs.confidence === 'number' ? attrs.confidence : null) as number | null;
      const evidence = typeof attrs.evidence === 'string' ? attrs.evidence : null;
      insEdge.run(source, target, type, confidence, repoOf(source), repoOf(target), evidence, attrs.crossRepo === true ? 1 : null);
      if (type !== 'contains') {
        degree.set(source, (degree.get(source) ?? 0) + 1);
        degree.set(target, (degree.get(target) ?? 0) + 1);
      }
    });
    let nodeCount = 0;
    graph.forEachNode((key, attrs) => {
      nodeCount++;
      const { label, type, repo, file, ...rest } = attrs as Record<string, unknown>;
      insNode.run(
        key,
        keyTail(key),
        (repo as string) ?? repoOf(key),
        (file as string) ?? fileOf(key),
        (label as string) ?? labelFromKey(key),
        (type as string) ?? '',
        degree.get(key) ?? 0,
        Object.keys(rest).length ? JSON.stringify(rest) : null,
      );
    });
    writeMeta(db, nodeCount);
    indexLabels(db);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }
  db.close();
  publishGraphFile(open, tmp, dbPath);
  return true;
}

// ---------------------------------------------------------------------------
// Streaming writer — write the system graph to SQLite per-repo as repos finish,
// WITHOUT ever assembling the full in-memory graphology graph (~5GB at org
// scale, the last unbounded structure in buildKB). Holds only a node-key Set +
// a degree Map (~hundreds of MB). Produces a byte-equivalent system_graph.sqlite
// to ProjectGraphBuilder → writeSystemGraphSqlite (verified by parity test).
// Returns null if no sqlite driver (caller keeps the in-memory fallback).
// ---------------------------------------------------------------------------

interface RepoGraphInput {
  nodes: Array<{ id: string; label?: string; type?: string; file?: string; community?: unknown }>;
  links: Array<{ source: string; target: string; type?: string; confidence?: number }>;
}
interface CrossEdgeInput {
  sourceRepo: string; sourceNode: string; targetRepo: string; targetNode: string;
  edgeType: string; evidence?: string; confidence?: number;
}
export interface SystemGraphSqliteWriter {
  /** Namespace + insert one repo's nodes/edges (mirrors ProjectGraphBuilder.addRepoGraph). */
  addRepoGraph(repoName: string, graph: RepoGraphInput): void;
  /** Insert cross-repo edges + synthetic endpoints (mirrors addCrossRepoEdges). */
  addCrossRepoEdges(edges: CrossEdgeInput[]): void;
  /** Backfill node degrees, write meta, build the label index, close, and
   *  rename the file over the live one. */
  finalize(): { nodeCount: number; edgeCount: number };
}

/** Where {@link insertRepoGraph} / {@link insertCrossRepoEdges} write — the
 *  full writer and the updater — so both build the same graph from the same input. */
interface GraphSink {
  /** Insert the node unless its key is already in the graph. */
  addNode(key: string, repo: string, file: string, label: string, type: string, attrs: string | null): void;
  hasNode(key: string): boolean;
  addEdge(source: string, target: string, type: string, confidence: number | null,
    sourceRepo: string, targetRepo: string, evidence: string | null, crossRepo: 1 | null): void;
}

/** One repo's nodes and edges, keyed `<repo>::<id>` (mirrors
 *  ProjectGraphBuilder.addRepoGraph): a duplicate key keeps its first node; an
 *  edge needs both endpoints. */
function insertRepoGraph(sink: GraphSink, repoName: string, graph: RepoGraphInput): void {
  for (const node of graph.nodes ?? []) {
    const key = `${repoName}::${node.id}`;
    const attrs = node.community !== undefined ? JSON.stringify({ community: node.community }) : null;
    sink.addNode(key, repoName, node.file ?? fileOf(key), node.label ?? labelFromKey(key), node.type ?? '', attrs);
  }
  for (const edge of graph.links ?? []) {
    const src = `${repoName}::${edge.source}`;
    const tgt = `${repoName}::${edge.target}`;
    if (!sink.hasNode(src) || !sink.hasNode(tgt)) continue;
    const conf = typeof edge.confidence === 'number' ? edge.confidence : 0.8;
    sink.addEdge(src, tgt, edge.type ?? 'depends', conf, repoName, repoName, null, null);
  }
}

/** Cross-repo edges, plus an `external` node for each endpoint not in the
 *  graph (mirrors ProjectGraphBuilder.addCrossRepoEdges). */
function insertCrossRepoEdges(sink: GraphSink, edges: CrossEdgeInput[]): void {
  for (const e of edges ?? []) {
    const src = `${e.sourceRepo}::${e.sourceNode}`;
    const tgt = `${e.targetRepo}::${e.targetNode}`;
    sink.addNode(src, e.sourceRepo, fileOf(src), e.sourceNode, 'external', null);
    sink.addNode(tgt, e.targetRepo, fileOf(tgt), e.targetNode, 'external', null);
    const conf = typeof e.confidence === 'number' ? e.confidence : null;
    sink.addEdge(src, tgt, e.edgeType, conf, e.sourceRepo, e.targetRepo, e.evidence ?? null, 1);
  }
}

/** A full rebuild: writes a new file next to the live one and renames it over
 *  the live one at finalize, so readers never see a partial graph. */
export async function createSystemGraphSqliteWriter(basePath: string): Promise<SystemGraphSqliteWriter | null> {
  const open = await loadDriver();
  if (!open) return null;
  const dbPath = systemGraphSqlitePath(basePath);
  const tmp = tempGraphPath(dbPath);
  const db = createGraphFile(open, tmp);
  const insNode = db.prepare(INSERT_NODE);
  const insEdge = db.prepare(INSERT_EDGE);
  const updDegree = db.prepare('UPDATE nodes SET degree=? WHERE key=?');

  const nodeKeys = new Set<string>();
  const degree = new Map<string, number>();
  let edgeCount = 0;
  const sink: GraphSink = {
    addNode(key, repo, file, label, type, attrs) {
      if (nodeKeys.has(key)) return; // dedup — mirrors the hasNode guard
      nodeKeys.add(key);
      insNode.run(key, keyTail(key), repo, file, label, type, 0, attrs);
    },
    hasNode: (key) => nodeKeys.has(key),
    addEdge(src, tgt, type, conf, srcRepo, tgtRepo, evidence, crossRepo) {
      insEdge.run(src, tgt, type, conf, srcRepo, tgtRepo, evidence, crossRepo);
      edgeCount++;
      if (type !== 'contains') {
        degree.set(src, (degree.get(src) ?? 0) + 1);
        degree.set(tgt, (degree.get(tgt) ?? 0) + 1);
      }
    },
  };
  const inTransaction = (fn: () => void) => {
    db.exec('BEGIN');
    try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  return {
    addRepoGraph(repoName, graph) { inTransaction(() => insertRepoGraph(sink, repoName, graph)); },
    addCrossRepoEdges(edges) { inTransaction(() => insertCrossRepoEdges(sink, edges)); },

    finalize() {
      db.exec('BEGIN');
      try {
        for (const [key, deg] of degree) updDegree.run(deg, key);
        writeMeta(db, nodeKeys.size);
        indexLabels(db);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); db.close(); throw e; }
      db.close();
      publishGraphFile(open, tmp, dbPath);
      return { nodeCount: nodeKeys.size, edgeCount };
    },
  };
}

// ---------------------------------------------------------------------------
// In-place updater — replaces the changed repos' slices of the live file in
// one write transaction, instead of rewriting every repo's graph.
// ---------------------------------------------------------------------------

/**
 * Updates `system_graph.sqlite` in place, in ONE write transaction: WAL
 * readers keep the old graph until `finalize` commits. Call sequence:
 *
 *   removeRepos(changed ∪ removed)    — an added repo counts as changed
 *   addRepoGraph(name, graph)          — for each changed (or added) repo
 *   replaceCrossRepoEdges(allEdges)    — the complete cross-repo edge set
 *   finalize()
 *
 * The result has the same nodes, edges and degrees as a full rebuild
 * ({@link createSystemGraphSqliteWriter}) from the same per-repo graphs and
 * cross-repo edges; only rowids — insertion order — differ. A call out of that
 * order, `addRepoGraph` for a repo still in the file, or any error rolls the
 * update back and closes it (later calls throw); `abort` does so on purpose.
 */
export interface SystemGraphSqliteUpdater {
  /** Delete these repos' nodes (and their `nodes_fts` rows) and every edge touching them. */
  removeRepos(names: string[]): void;
  /** Insert one repo's nodes and edges, as {@link SystemGraphSqliteWriter.addRepoGraph}. */
  addRepoGraph(repoName: string, graph: RepoGraphInput): void;
  /** Drop every cross-repo edge and `external` endpoint node, then insert `edges`
   *  as {@link SystemGraphSqliteWriter.addCrossRepoEdges}. */
  replaceCrossRepoEdges(edges: CrossEdgeInput[]): void;
  /** Recount degrees of the nodes whose edges changed, write meta, commit,
   *  checkpoint the WAL into the file (waiting up to 5 s for readers) and close. */
  finalize(): { nodeCount: number; edgeCount: number };
  abort(): void;
}

/** Null when there is no driver or the file can't be updated in place —
 *  missing, not at the current schema version, or without `nodes_fts` /
 *  `nodes.key_tail`: rebuild it with {@link createSystemGraphSqliteWriter}. */
export async function openSystemGraphSqliteUpdater(basePath: string): Promise<SystemGraphSqliteUpdater | null> {
  const open = await loadDriver();
  if (!open) return null;
  const dbPath = systemGraphSqlitePath(basePath);
  if (!existsSync(dbPath)) return null;
  let db: SqliteDb;
  try { db = open(dbPath); } catch { return null; }
  try {
    const version = db.prepare("SELECT v FROM meta WHERE k = 'schemaVersion'").get()?.v;
    const hasKeyTail = db.prepare('PRAGMA table_info(nodes)').all().some((c) => c.name === 'key_tail');
    if (version !== SCHEMA_VERSION || !hasKeyTail) throw new Error('not updatable');
    db.prepare('SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?'); // throws: no table, or no FTS5 / trigram
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    db.exec('BEGIN IMMEDIATE');
  } catch {
    db.close();
    return null;
  }

  const insNode = db.prepare('INSERT OR IGNORE INTO nodes(key,key_tail,repo,file,label,type,degree,attrs) VALUES(?,?,?,?,?,?,?,?)');
  const insFts = db.prepare('INSERT INTO nodes_fts(rowid, name) VALUES(?, ?)');
  const getNode = db.prepare('SELECT 1 FROM nodes WHERE key = ?');
  const repoHasNodes = db.prepare('SELECT 1 FROM nodes WHERE repo = ? LIMIT 1');
  const insEdge = db.prepare(INSERT_EDGE);
  /** Nodes whose edge set changed — their degrees are recounted at finalize. */
  const touched = new Set<string>();
  const added = new Set<string>();
  const touch = (rows: any[]) => { for (const r of rows) { touched.add(r.source as string); touched.add(r.target as string); } };
  const sink: GraphSink = {
    addNode(key, repo, file, label, type, attrs) {
      const r = insNode.run(key, keyTail(key), repo, file, label, type, 0, attrs) as { changes: number | bigint; lastInsertRowid: number | bigint };
      if (Number(r.changes) > 0) insFts.run(r.lastInsertRowid, label);
    },
    hasNode: (key) => getNode.get(key) !== undefined,
    addEdge(src, tgt, type, conf, srcRepo, tgtRepo, evidence, crossRepo) {
      insEdge.run(src, tgt, type, conf, srcRepo, tgtRepo, evidence, crossRepo);
      if (type !== 'contains') { touched.add(src); touched.add(tgt); }
    },
  };

  let step = 0;
  let closed = false;
  const abort = () => {
    if (closed) return;
    closed = true;
    try { db.exec('ROLLBACK'); } catch { /* no transaction left to roll back */ }
    db.close();
  };
  /** Run `fn` as the `next` step of the sequence; any error rolls everything back. */
  const run = <T>(next: number, fn: () => T): T => {
    if (closed) throw new Error('system graph updater is closed');
    try {
      if (next < step) throw new Error('system graph updater: call removeRepos → addRepoGraph → replaceCrossRepoEdges → finalize, in that order');
      step = next;
      return fn();
    } catch (e) {
      abort();
      throw e;
    }
  };

  return {
    removeRepos(names) {
      run(0, () => {
        for (const batch of chunked([...new Set(names)])) {
          const ph = placeholders(batch.length);
          // A cross-repo edge into a removed repo also ends at a node that stays.
          touch(db.prepare(`SELECT source, target FROM edges WHERE cross_repo IS NOT NULL AND (source_repo IN (${ph}) OR target_repo IN (${ph}))`).all(...batch, ...batch));
          // Contentless FTS5 deletes a row given the values it indexed.
          db.prepare(`INSERT INTO nodes_fts(nodes_fts, rowid, name) SELECT 'delete', rowid, label FROM nodes WHERE repo IN (${ph})`).run(...batch);
          db.prepare(`DELETE FROM nodes WHERE repo IN (${ph})`).run(...batch);
          db.prepare(`DELETE FROM edges WHERE source_repo IN (${ph}) OR target_repo IN (${ph})`).run(...batch, ...batch);
        }
      });
    },

    addRepoGraph(repoName, graph) {
      run(1, () => {
        if (!added.has(repoName) && repoHasNodes.get(repoName) !== undefined) {
          throw new Error(`system graph updater: "${repoName}" is still in the graph — removeRepos it first`);
        }
        added.add(repoName);
        insertRepoGraph(sink, repoName, graph);
      });
    },

    replaceCrossRepoEdges(edges) {
      run(2, () => {
        touch(db.prepare('SELECT source, target FROM edges WHERE cross_repo IS NOT NULL').all());
        db.exec("INSERT INTO nodes_fts(nodes_fts, rowid, name) SELECT 'delete', rowid, label FROM nodes WHERE type = 'external'");
        db.exec("DELETE FROM nodes WHERE type = 'external'");
        db.exec('DELETE FROM edges WHERE cross_repo IS NOT NULL');
        insertCrossRepoEdges(sink, edges);
      });
    },

    finalize() {
      return run(3, () => {
        const nonContains = "(type IS NULL OR type <> 'contains')";
        const recount = db.prepare(`UPDATE nodes SET degree = (SELECT count(*) FROM edges WHERE source = ? AND ${nonContains})`
          + ` + (SELECT count(*) FROM edges WHERE target = ? AND ${nonContains}) WHERE key = ?`);
        for (const key of touched) recount.run(key, key, key);
        const nodeCount = Number(db.prepare('SELECT count(*) c FROM nodes').get().c);
        const edgeCount = Number(db.prepare('SELECT count(*) c FROM edges').get().c);
        writeMeta(db, nodeCount);
        db.exec('COMMIT');
        closed = true;
        // Into the file itself: an upload of system_graph.sqlite alone carries the update.
        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
        return { nodeCount, edgeCount };
      });
    },

    abort,
  };
}

// ---------------------------------------------------------------------------
// SQLite-backed reader
// ---------------------------------------------------------------------------

const CHUNK = 400; // bound IN(...) list size (mirrors vector-store batching)
function chunked<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
const placeholders = (n: number): string => Array(n).fill('?').join(',');
/** Edges a traversal follows: not `contains`, confidence ≥ 0.7 (or unset), of `types` when given. */
const neighborFilter = (types?: string[]): string =>
  `(confidence IS NULL OR confidence >= 0.7) AND (type IS NULL OR type <> 'contains')${types?.length ? ` AND type IN (${placeholders(types.length)})` : ''}`;
/** Escape LIKE's wildcards for `ESCAPE '\'`. */
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** `s` as one FTS5 phrase: over the trigram index, the labels containing it (case-insensitive). */
const ftsPhrase = (s: string): string => `"${s.replace(/"/g, '""')}"`;
/** A searchNodes name the trigram index can serve: long enough, and free of
 *  regex syntax, so a case-insensitive substring; printable ASCII only, where
 *  the index's case folding and the regex's agree. */
const isLiteralName = (s: string): boolean =>
  s.length >= FUZZY_MIN_CHARS && /^[\x20-\x7e]+$/.test(s) && !/[\\^$.|?*+()[\]{}]/.test(s);

/** Compile a caller-supplied name filter (case-insensitive). */
function nameRegex(pattern: string): RegExp {
  try { return new RegExp(pattern, 'i'); } catch (e) {
    throw new Error(`Invalid regex for name: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function rowToEdge(r: any): GraphEdge {
  const e: GraphEdge = { source: r.source as string, target: r.target as string, type: (r.type as string | null) ?? undefined };
  if (r.evidence != null) e.evidence = r.evidence as string;
  return e;
}

class SqliteGraphStore implements GraphStore {
  /** Files written before cross-repo evidence was stored have no `evidence` column. */
  private readonly evidenceCol: string;
  /** Files written before it existed have no `nodes.key_tail`: exact resolution scans them. */
  private readonly hasKeyTail: boolean;
  private readonly hasRegexp: boolean;
  /** Files written before it existed have no `nodes_fts`, and a driver without
   *  FTS5 / trigram can't read it: fuzzy matching scans those (bounded by its limit). */
  private readonly hasFts: boolean;

  constructor(private db: SqliteDb) {
    const cols = db.prepare('PRAGMA table_info(edges)').all().map((c) => c.name as string);
    this.evidenceCol = cols.includes('evidence') ? 'evidence' : 'NULL AS evidence';
    this.hasKeyTail = db.prepare('PRAGMA table_info(nodes)').all().some((c) => c.name === 'key_tail');
    this.hasRegexp = this.registerRegexp();
    this.hasFts = this.canReadFts();
  }

  private canReadFts(): boolean {
    try {
      this.db.prepare('SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?');
      return true;
    } catch {
      return false;
    }
  }

  private registerRegexp(): boolean {
    if (typeof this.db.function !== 'function') return false;
    let last: { src: string; re: RegExp } | undefined;
    try {
      this.db.function('regexp', { deterministic: true }, (src: string, value: unknown) => {
        if (last?.src !== src) last = { src, re: new RegExp(src, 'i') };
        return typeof value === 'string' && last.re.test(value) ? 1 : 0;
      });
      return true;
    } catch {
      return false;
    }
  }

  resolveNodes(name: string, repo?: string, fuzzy = false, limit = 5000): Array<{ key: string; label: string }> {
    const params: unknown[] = [];
    let where: string;
    let repoCol = 'repo';
    let from = 'nodes';
    let order = 'rowid';
    if (fuzzy && [...name].length >= FUZZY_MIN_CHARS) {
      where = `label LIKE '%' || ? || '%' ESCAPE '\\' AND type NOT IN (${placeholders(NON_SYMBOL_TYPES.length)})`;
      params.push(likeEscape(name), ...NON_SYMBOL_TYPES);
      if (this.hasFts) {
        // The index yields the candidates in rowid order, so LIMIT stops the
        // read; the LIKE above keeps the scan's exact semantics.
        from = 'nodes_fts JOIN nodes ON nodes.rowid = nodes_fts.rowid';
        where = `nodes_fts MATCH ? AND ${where}`;
        params.unshift(ftsPhrase(name));
        if (repo) {
          // Read only from the repo's first node to its last symbol. The writer
          // inserts a repo's nodes together and cross-repo endpoints after every
          // repo, so this range holds little but the repo.
          where += ' AND nodes_fts.rowid BETWEEN (SELECT min(rowid) FROM nodes WHERE repo = ?)'
            + ` AND (SELECT rowid FROM nodes WHERE repo = ? AND type NOT IN (${placeholders(NON_SYMBOL_TYPES.length)}) ORDER BY rowid DESC LIMIT 1)`;
          params.push(repo, repo, ...NON_SYMBOL_TYPES);
        }
        order = 'nodes_fts.rowid';
        repoCol = '+repo'; // `+`: filter only — keeps the planner on the index
      }
    } else if (this.hasKeyTail) {
      // `=` / substr compare bytes: case-sensitive and wildcard-free. Every OR
      // arm has an index (key, label, key_tail); key_tail narrows the suffix
      // test to the keys that can end in `::name`.
      where = '(key = ? OR label = ? OR (key_tail = ? AND substr(key, -length(?)) = ?))';
      params.push(name, name, keyTail(`::${name}`), `::${name}`, `::${name}`);
      repoCol = '+repo'; // `+`: filter only — keeps the planner on the OR's indexes, not a scan of the repo
    } else {
      where = '(key = ? OR label = ? OR substr(key, -length(?)) = ?)';
      params.push(name, name, `::${name}`, `::${name}`);
    }
    if (repo) { where += ` AND ${repoCol} = ?`; params.push(repo); }
    // rowid = insertion order, the order a scan returns (callers may take the first match).
    return this.db.prepare(`SELECT key, label FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT ?`).all(...params, limit)
      .map((r) => ({ key: r.key as string, label: (r.label as string) || labelFromKey(r.key) }));
  }

  private typedEndpoints(keys: string[], side: 'callers' | 'deps', limit: number, types?: string[]): TypedNeighbor[] {
    const col = side === 'callers' ? 'source' : 'target';
    const match = side === 'callers' ? 'target' : 'source';
    const typeClause = types?.length ? ` AND type IN (${placeholders(types.length)})` : '';
    const seen = new Map<string, TypedNeighbor>();
    for (const batch of chunked(keys)) {
      const rows = this.db.prepare(
        `SELECT DISTINCT ${col} AS v, type FROM edges WHERE ${match} IN (${placeholders(batch.length)}) AND (type IS NULL OR type <> 'contains')${typeClause} LIMIT ?`,
      ).all(...batch, ...(types ?? []), limit);
      for (const r of rows) {
        const type = (r.type as string | null) ?? '';
        seen.set(`${type}\0${r.v}`, { key: r.v as string, type });
        if (seen.size >= limit) return [...seen.values()];
      }
    }
    return [...seen.values()];
  }
  callers(targetKeys: string[], limit: number, types?: string[]): TypedNeighbor[] { return this.typedEndpoints(targetKeys, 'callers', limit, types); }
  dependencies(sourceKeys: string[], limit: number, types?: string[]): TypedNeighbor[] { return this.typedEndpoints(sourceKeys, 'deps', limit, types); }

  crossRepoEdges(repo: string | undefined, limit: number): { edges: GraphEdge[]; total: number } {
    const base = "FROM edges WHERE (source_repo <> target_repo OR type = 'workspace-dep')" + (repo ? ' AND (source_repo = ? OR target_repo = ?)' : '');
    const p: unknown[] = repo ? [repo, repo] : [];
    const total = this.db.prepare(`SELECT COUNT(*) c ${base}`).get(...p).c as number;
    const edges = this.db.prepare(`SELECT source, target, type, ${this.evidenceCol} ${base} LIMIT ?`).all(...p, limit).map(rowToEdge);
    return { edges, total };
  }

  nodesInFiles(repo: string, files: string[], entity?: string): string[] {
    const out: string[] = [];
    const ent = entity ? ' AND substr(key, -length(?)) = ?' : '';
    // Keys under a file sort between `<prefix>::` and `<prefix>:;` (';' follows ':').
    const stmt = this.db.prepare(`SELECT key FROM nodes WHERE repo = ? AND (key = ? OR (key >= ? AND key < ?))${ent} LIMIT 2000`);
    for (const file of files) {
      const prefix = `${repo}::${file}`;
      const params: unknown[] = [repo, prefix, `${prefix}::`, `${prefix}:;`];
      if (entity) params.push(`::${entity}`, `::${entity}`);
      for (const r of stmt.all(...params)) out.push(r.key as string);
    }
    return out;
  }

  dependents(nodeKeys: string[], limit: number, maxRows?: number): { edges: GraphEdge[]; total: number; repos: string[]; truncated: boolean } {
    const set = new Set(nodeKeys);
    const sym = [...SYMMETRIC_EDGE_TYPES];
    const edges: GraphEdge[] = [];
    const repos = new Set<string>();
    let total = 0;
    let read = 0;
    const take = (r: any) => {
      if (set.has(r.source as string)) return; // dependents are from OUTSIDE the set
      total++;
      repos.add((r.source_repo as string) || repoOf(r.source as string));
      if (edges.length < limit) edges.push(rowToEdge(r));
    };
    const full = () => maxRows !== undefined && read >= maxRows;
    const scan = (sql: string, params: unknown[]) => {
      const rows = this.db.prepare(`${sql} LIMIT ?`).all(...params, maxRows === undefined ? -1 : maxRows - read); // -1 = no limit
      read += rows.length;
      for (const r of rows) take(r);
    };
    for (const batch of chunked(nodeKeys)) {
      if (full()) break;
      const ph = placeholders(batch.length);
      scan(`SELECT source, target, type, ${this.evidenceCol}, source_repo FROM edges WHERE target IN (${ph}) AND (type IS NULL OR type <> 'contains')`, batch);
      if (!full()) {
        scan(`SELECT target AS source, source AS target, type, ${this.evidenceCol}, target_repo AS source_repo FROM edges WHERE source IN (${ph}) AND type IN (${placeholders(sym.length)})`, [...batch, ...sym]);
      }
    }
    return { edges, total, repos: [...repos], truncated: full() };
  }

  neighborsOf(key: string, direction: GraphDirection, types?: string[]): string[] {
    const out = new Set<string>();
    const conf = neighborFilter(types);
    const tp = types ?? [];
    if (direction === 'callees' || direction === 'both') {
      for (const r of this.db.prepare(`SELECT target FROM edges WHERE source = ? AND ${conf}`).all(key, ...tp)) out.add(r.target as string);
    }
    if (direction === 'callers' || direction === 'both') {
      for (const r of this.db.prepare(`SELECT source FROM edges WHERE target = ? AND ${conf}`).all(key, ...tp)) out.add(r.source as string);
    }
    return [...out];
  }

  neighborEdges(keys: string[], direction: GraphDirection, types: string[] | undefined, limit: number): Array<[string, string]> {
    const filter = neighborFilter(types);
    const tp = types ?? [];
    const out: Array<[string, string]> = [];
    for (const batch of chunked(keys)) {
      if (out.length >= limit) break;
      const ph = placeholders(batch.length);
      const parts: string[] = [];
      const params: unknown[] = [];
      if (direction === 'callees' || direction === 'both') {
        parts.push(`SELECT source AS k, target AS n FROM edges WHERE source IN (${ph}) AND ${filter}`);
        params.push(...batch, ...tp);
      }
      if (direction === 'callers' || direction === 'both') {
        parts.push(`SELECT target AS k, source AS n FROM edges WHERE target IN (${ph}) AND ${filter}`);
        params.push(...batch, ...tp);
      }
      for (const r of this.db.prepare(`${parts.join(' UNION ALL ')} LIMIT ?`).all(...params, limit - out.length)) {
        out.push([r.k as string, r.n as string]);
      }
    }
    return out;
  }

  labelsOf(keys: string[]): Map<string, string> {
    const m = new Map<string, string>();
    for (const batch of chunked(keys)) {
      const ph = batch.map(() => '?').join(',');
      for (const r of this.db.prepare(`SELECT key, label FROM nodes WHERE key IN (${ph})`).all(...batch)) {
        m.set(r.key as string, (r.label as string) || labelFromKey(r.key as string));
      }
    }
    for (const k of keys) if (!m.has(k)) m.set(k, labelFromKey(k));
    return m;
  }

  nodeTypes(keys: string[]): Map<string, string> {
    const m = new Map<string, string>();
    for (const batch of chunked(keys)) {
      const ph = batch.map(() => '?').join(',');
      for (const r of this.db.prepare(`SELECT key, type FROM nodes WHERE key IN (${ph})`).all(...batch)) {
        m.set(r.key as string, (r.type as string) || '');
      }
    }
    return m;
  }

  searchNodes(
    f: { name?: string; type?: string; file?: string; repo?: string; minDegree?: number },
    limit: number,
  ): { rows: GraphNodeRow[]; total: number } {
    const re = f.name ? nameRegex(f.name) : undefined;
    const cond: string[] = ['degree >= ?'];
    const p: unknown[] = [f.minDegree ?? 0];
    if (f.repo) { cond.push('repo = ?'); p.push(f.repo); }
    if (f.type) { cond.push('type = ?'); p.push(f.type); }
    else if (re) { cond.push(`type NOT IN (${placeholders(NON_SYMBOL_TYPES.length)})`); p.push(...NON_SYMBOL_TYPES); }
    if (f.file) { cond.push("file LIKE '%' || ? || '%' ESCAPE '\\'"); p.push(likeEscape(f.file)); }
    if (re && this.hasFts && isLiteralName(f.name!)) {
      // A plain substring: the index narrows the rows the regex checks.
      cond.push('rowid IN (SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?)');
      p.push(ftsPhrase(f.name!));
    }
    if (re && this.hasRegexp) { cond.push('regexp(?, label)'); p.push(f.name); }
    const where = cond.join(' AND ');
    const toRow = (r: any): GraphNodeRow => ({ key: r.key as string, label: (r.label as string) || labelFromKey(r.key), type: (r.type as string) || '?', file: (r.file as string) || fileOf(r.key), degree: (r.degree as number) ?? 0 });
    const select = `SELECT key,label,type,file,degree FROM nodes WHERE ${where} ORDER BY degree DESC`;
    if (re && !this.hasRegexp) {
      // Driver without user functions: match the label in JS.
      const all = this.db.prepare(select).all(...p).filter((r) => re.test((r.label as string) ?? ''));
      return { rows: all.slice(0, limit).map(toRow), total: all.length };
    }
    const total = this.db.prepare(`SELECT COUNT(*) c FROM nodes WHERE ${where}`).get(...p).c as number;
    const rows = this.db.prepare(`${select} LIMIT ?`).all(...p, limit).map(toRow);
    return { rows, total };
  }

  close(): void { this.db.close(); }
}

// ---------------------------------------------------------------------------
// JSON-backed reader (fallback for pre-sqlite indexes / no driver). Loads the
// legacy export into arrays — fine for the small graphs that fit in JSON.
// ---------------------------------------------------------------------------

interface JNode { key: string; attributes?: { label?: string; type?: string; repo?: string; file?: string } }
interface JEdge { source: string; target: string; attributes?: { type?: string; relation?: string; confidence?: number; evidence?: string } }

class JsonGraphStore implements GraphStore {
  private adjCache = new Map<string, Map<string, Set<string>>>();
  private degreeCache?: Map<string, number>;
  constructor(private nodes: JNode[], private edges: JEdge[]) {}

  private et(e: JEdge): string | undefined { return e.attributes?.type ?? e.attributes?.relation; }
  private label(n: JNode): string { return n.attributes?.label ?? labelFromKey(n.key); }
  private edge(e: JEdge): GraphEdge {
    const out: GraphEdge = { source: e.source, target: e.target, type: this.et(e) };
    if (e.attributes?.evidence != null) out.evidence = e.attributes.evidence;
    return out;
  }

  resolveNodes(name: string, repo?: string, fuzzy = false, limit = 5000): Array<{ key: string; label: string }> {
    const inRepo = (k: string) => !repo || k.startsWith(repo + '::');
    const lc = name.toLowerCase();
    return this.nodes.filter((n) => inRepo(n.key) && (fuzzy && [...name].length >= FUZZY_MIN_CHARS
      ? !NON_SYMBOL_TYPES.includes(n.attributes?.type ?? '') && this.label(n).toLowerCase().includes(lc)
      : (n.key === name || this.label(n) === name || n.key.endsWith('::' + name)))
    ).slice(0, limit).map((n) => ({ key: n.key, label: this.label(n) }));
  }
  private typedEndpoints(keys: string[], side: 'callers' | 'deps', limit: number, types?: string[]): TypedNeighbor[] {
    const set = new Set(keys);
    const want = types?.length ? new Set(types) : null;
    const seen = new Map<string, TypedNeighbor>();
    for (const e of this.edges) {
      const type = this.et(e) ?? '';
      if (type === 'contains' || (want && !want.has(type))) continue;
      if (!set.has(side === 'callers' ? e.target : e.source)) continue;
      const key = side === 'callers' ? e.source : e.target;
      seen.set(`${type}\0${key}`, { key, type });
      if (seen.size >= limit) break;
    }
    return [...seen.values()];
  }
  callers(targetKeys: string[], limit: number, types?: string[]): TypedNeighbor[] { return this.typedEndpoints(targetKeys, 'callers', limit, types); }
  dependencies(sourceKeys: string[], limit: number, types?: string[]): TypedNeighbor[] { return this.typedEndpoints(sourceKeys, 'deps', limit, types); }
  crossRepoEdges(repo: string | undefined, limit: number): { edges: GraphEdge[]; total: number } {
    const cross = this.edges.filter((e) => {
      const s = repoOf(e.source), t = repoOf(e.target);
      if (!s || !t || (s === t && this.et(e) !== 'workspace-dep')) return false;
      return !repo || s === repo || t === repo;
    });
    return { edges: cross.slice(0, limit).map((e) => this.edge(e)), total: cross.length };
  }
  nodesInFiles(repo: string, files: string[], entity?: string): string[] {
    const out: string[] = [];
    for (const f of files) {
      const prefix = `${repo}::${f}`;
      for (const n of this.nodes) {
        if ((n.key === prefix || n.key.startsWith(prefix + '::')) && (!entity || n.key.endsWith('::' + entity))) out.push(n.key);
      }
    }
    return out;
  }
  dependents(nodeKeys: string[], limit: number, maxRows = Number.POSITIVE_INFINITY): { edges: GraphEdge[]; total: number; repos: string[]; truncated: boolean } {
    const set = new Set(nodeKeys);
    const all: GraphEdge[] = [];
    for (const e of this.edges) {
      if (all.length >= maxRows) break;
      const type = this.et(e);
      if (type === 'contains') continue;
      if (set.has(e.target) && !set.has(e.source)) all.push(this.edge(e));
      else if (type && SYMMETRIC_EDGE_TYPES.has(type) && set.has(e.source) && !set.has(e.target)) {
        all.push({ ...this.edge(e), source: e.target, target: e.source });
      }
    }
    const repos = [...new Set(all.map((e) => repoOf(e.source)))];
    return { edges: all.slice(0, limit), total: all.length, repos, truncated: all.length >= maxRows };
  }
  private adj(direction: GraphDirection, types?: string[]): Map<string, Set<string>> {
    const cacheKey = `${direction}|${types?.join(',') ?? '*'}`;
    const cached = this.adjCache.get(cacheKey);
    if (cached) return cached;
    const want = types?.length ? new Set(types) : null;
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => { if (!m.has(a)) m.set(a, new Set()); m.get(a)!.add(b); };
    for (const e of this.edges) {
      const type = this.et(e);
      if (!e.source || !e.target || type === 'contains') continue;
      if (want && !want.has(type ?? '')) continue;
      if ((e.attributes?.confidence ?? 0.8) < 0.7) continue;
      if (direction === 'callees' || direction === 'both') add(e.source, e.target);
      if (direction === 'callers' || direction === 'both') add(e.target, e.source);
    }
    this.adjCache.set(cacheKey, m);
    return m;
  }
  neighborsOf(key: string, direction: GraphDirection, types?: string[]): string[] { return [...(this.adj(direction, types).get(key) ?? [])]; }
  neighborEdges(keys: string[], direction: GraphDirection, types: string[] | undefined, limit: number): Array<[string, string]> {
    const adj = this.adj(direction, types);
    const out: Array<[string, string]> = [];
    for (const k of keys) {
      for (const n of adj.get(k) ?? []) {
        if (out.length >= limit) return out;
        out.push([k, n]);
      }
    }
    return out;
  }
  labelsOf(keys: string[]): Map<string, string> {
    const want = new Set(keys);
    const m = new Map<string, string>();
    for (const n of this.nodes) if (want.has(n.key)) m.set(n.key, this.label(n));
    for (const k of keys) if (!m.has(k)) m.set(k, labelFromKey(k));
    return m;
  }
  nodeTypes(keys: string[]): Map<string, string> {
    const want = new Set(keys);
    const m = new Map<string, string>();
    for (const n of this.nodes) if (want.has(n.key)) m.set(n.key, n.attributes?.type ?? '');
    return m;
  }
  private degree(): Map<string, number> {
    if (this.degreeCache) return this.degreeCache;
    const d = new Map<string, number>();
    for (const e of this.edges) {
      if (this.et(e) === 'contains') continue;
      d.set(e.source, (d.get(e.source) ?? 0) + 1);
      d.set(e.target, (d.get(e.target) ?? 0) + 1);
    }
    return (this.degreeCache = d);
  }
  searchNodes(f: { name?: string; type?: string; file?: string; repo?: string; minDegree?: number }, limit: number): { rows: GraphNodeRow[]; total: number } {
    const re = f.name ? nameRegex(f.name) : undefined;
    const deg = this.degree();
    const fileLc = f.file?.toLowerCase();
    const matches = this.nodes.filter((n) => {
      if (f.repo && !n.key.startsWith(f.repo + '::')) return false;
      const type = n.attributes?.type ?? '';
      if (f.type ? type !== f.type : re && NON_SYMBOL_TYPES.includes(type)) return false;
      const file = n.attributes?.file ?? fileOf(n.key);
      if (fileLc && !file.toLowerCase().includes(fileLc)) return false;
      if (re && !re.test(this.label(n))) return false;
      return (deg.get(n.key) ?? 0) >= (f.minDegree ?? 0);
    }).map((n) => ({ key: n.key, label: this.label(n), type: n.attributes?.type ?? '?', file: n.attributes?.file ?? fileOf(n.key), degree: deg.get(n.key) ?? 0 }))
      .sort((a, b) => b.degree - a.degree);
    return { rows: matches.slice(0, limit), total: matches.length };
  }
  close(): void { /* nothing to close */ }
}

// ---------------------------------------------------------------------------
// Factory: sqlite if present + driver loads, else legacy JSON, else null.
// ---------------------------------------------------------------------------

export async function openSystemGraphStore(basePath: string): Promise<GraphStore | null> {
  const sqlitePath = systemGraphSqlitePath(basePath);
  if (existsSync(sqlitePath)) {
    const open = await loadDriver();
    if (open) {
      try { return new SqliteGraphStore(open(sqlitePath)); } catch { /* fall through to JSON */ }
    }
  }
  const jsonPath = join(basePath, 'system_graph_v2.json');
  if (existsSync(jsonPath)) {
    try {
      const g = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      return new JsonGraphStore(g.nodes ?? [], g.edges ?? []);
    } catch { /* too large to parse / corrupt */ }
  }
  return null;
}
