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

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GraphDirection = 'callees' | 'callers' | 'both';
export interface GraphEdge { source: string; target: string; type?: string }
export interface GraphNodeRow { key: string; label: string; type: string; file: string; degree: number }

/** Query surface the six system-graph tools need. Implemented over SQLite and
 *  (fallback) over the legacy JSON export. */
export interface GraphStore {
  resolveNodes(name: string, repo?: string, fuzzy?: boolean): Array<{ key: string; label: string }>;
  callers(targetKeys: string[], limit: number): string[];
  dependencies(sourceKeys: string[], limit: number): string[];
  crossRepoEdges(repo: string | undefined, limit: number): { edges: GraphEdge[]; total: number };
  nodesInFiles(repo: string, files: string[], entity?: string): string[];
  dependents(nodeKeys: string[], limit: number): { edges: GraphEdge[]; total: number; repos: string[] };
  neighborsOf(key: string, direction: GraphDirection): string[];
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
interface SqliteDb { prepare(sql: string): SqliteStmt; exec(sql: string): void; close(): void }
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  key TEXT PRIMARY KEY, repo TEXT, file TEXT, label TEXT, type TEXT, degree INTEGER, attrs TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_repo  ON nodes(repo);
CREATE INDEX IF NOT EXISTS idx_nodes_type  ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(label);
CREATE INDEX IF NOT EXISTS idx_nodes_file  ON nodes(repo, file);
CREATE TABLE IF NOT EXISTS edges (
  source TEXT NOT NULL, target TEXT NOT NULL, type TEXT, confidence REAL,
  source_repo TEXT, target_repo TEXT
);
CREATE INDEX IF NOT EXISTS idx_edges_source    ON edges(source, type);
CREATE INDEX IF NOT EXISTS idx_edges_target    ON edges(target, type);
CREATE INDEX IF NOT EXISTS idx_edges_crossrepo ON edges(source_repo, target_repo);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

const repoOf = (key: string): string => key.split('::')[0] ?? '';
const fileOf = (key: string): string => key.split('::')[1] ?? '';
const labelFromKey = (key: string): string => key.split('::').slice(2).join('::') || key;

/** Stream the in-memory graph into a fresh sqlite db. Returns false if no
 *  driver is available (caller falls back to the JSON write). */
export async function writeSystemGraphSqlite(basePath: string, graph: GraphIterable): Promise<boolean> {
  const open = await loadDriver();
  if (!open) return false;
  const dbPath = systemGraphSqlitePath(basePath);
  // Full rebuild each index — drop any prior db (+ WAL sidecars) and recreate.
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { rmSync(f, { force: true }); } catch { /* ok */ }
  }
  const db = open(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  db.exec(SCHEMA);

  const insNode = db.prepare('INSERT OR REPLACE INTO nodes(key,repo,file,label,type,degree,attrs) VALUES(?,?,?,?,?,?,?)');
  const insEdge = db.prepare('INSERT INTO edges(source,target,type,confidence,source_repo,target_repo) VALUES(?,?,?,?,?,?)');

  const degree = new Map<string, number>();
  db.exec('BEGIN');
  try {
    graph.forEachEdge((source, target, attrs) => {
      const type = (attrs.type ?? attrs.relation ?? null) as string | null;
      const confidence = (typeof attrs.confidence === 'number' ? attrs.confidence : null) as number | null;
      insEdge.run(source, target, type, confidence, repoOf(source), repoOf(target));
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
        (repo as string) ?? repoOf(key),
        (file as string) ?? fileOf(key),
        (label as string) ?? labelFromKey(key),
        (type as string) ?? '',
        degree.get(key) ?? 0,
        Object.keys(rest).length ? JSON.stringify(rest) : null,
      );
    });
    db.prepare('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)').run('nodeCount', String(nodeCount));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.close();
    throw err;
  }
  db.close();
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
  /** Backfill node degrees, write meta, close. */
  finalize(): { nodeCount: number; edgeCount: number };
}

export async function createSystemGraphSqliteWriter(basePath: string): Promise<SystemGraphSqliteWriter | null> {
  const open = await loadDriver();
  if (!open) return null;
  const dbPath = systemGraphSqlitePath(basePath);
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { rmSync(f, { force: true }); } catch { /* ok */ }
  }
  const db = open(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  db.exec(SCHEMA);
  const insNode = db.prepare('INSERT OR REPLACE INTO nodes(key,repo,file,label,type,degree,attrs) VALUES(?,?,?,?,?,?,?)');
  const insEdge = db.prepare('INSERT INTO edges(source,target,type,confidence,source_repo,target_repo) VALUES(?,?,?,?,?,?)');
  const updDegree = db.prepare('UPDATE nodes SET degree=? WHERE key=?');

  const nodeKeys = new Set<string>();
  const degree = new Map<string, number>();
  let edgeCount = 0;
  const bump = (type: string | null, src: string, tgt: string) => {
    if (type !== 'contains') {
      degree.set(src, (degree.get(src) ?? 0) + 1);
      degree.set(tgt, (degree.get(tgt) ?? 0) + 1);
    }
  };

  return {
    addRepoGraph(repoName, graph) {
      db.exec('BEGIN');
      try {
        for (const node of graph.nodes ?? []) {
          const key = `${repoName}::${node.id}`;
          if (nodeKeys.has(key)) continue; // dedup — mirrors the hasNode guard
          nodeKeys.add(key);
          const attrs = node.community !== undefined ? JSON.stringify({ community: node.community }) : null;
          insNode.run(key, repoName, node.file ?? fileOf(key), node.label ?? labelFromKey(key), node.type ?? '', 0, attrs);
        }
        for (const edge of graph.links ?? []) {
          const src = `${repoName}::${edge.source}`;
          const tgt = `${repoName}::${edge.target}`;
          if (!nodeKeys.has(src) || !nodeKeys.has(tgt)) continue; // both endpoints must exist
          const type = edge.type ?? 'depends';
          const conf = typeof edge.confidence === 'number' ? edge.confidence : 0.8;
          insEdge.run(src, tgt, type, conf, repoName, repoName);
          edgeCount++;
          bump(type, src, tgt);
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },

    addCrossRepoEdges(edges) {
      db.exec('BEGIN');
      try {
        for (const e of edges ?? []) {
          const src = `${e.sourceRepo}::${e.sourceNode}`;
          const tgt = `${e.targetRepo}::${e.targetNode}`;
          if (!nodeKeys.has(src)) { nodeKeys.add(src); insNode.run(src, e.sourceRepo, fileOf(src), e.sourceNode, 'external', 0, null); }
          if (!nodeKeys.has(tgt)) { nodeKeys.add(tgt); insNode.run(tgt, e.targetRepo, fileOf(tgt), e.targetNode, 'external', 0, null); }
          const conf = typeof e.confidence === 'number' ? e.confidence : null;
          insEdge.run(src, tgt, e.edgeType, conf, e.sourceRepo, e.targetRepo);
          edgeCount++;
          bump(e.edgeType, src, tgt);
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },

    finalize() {
      db.exec('BEGIN');
      try {
        for (const [key, deg] of degree) updDegree.run(deg, key);
        db.prepare('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)').run('nodeCount', String(nodeKeys.size));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); db.close(); throw e; }
      db.close();
      return { nodeCount: nodeKeys.size, edgeCount };
    },
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

class SqliteGraphStore implements GraphStore {
  constructor(private db: SqliteDb) {}

  resolveNodes(name: string, repo?: string, fuzzy = false): Array<{ key: string; label: string }> {
    const repoClause = repo ? " AND key LIKE ? || '::%'" : '';
    const params: unknown[] = [];
    let where: string;
    if (fuzzy) {
      where = "(label LIKE '%' || ? || '%' OR key LIKE '%' || ? || '%')";
      params.push(name, name);
    } else {
      where = "(label = ? OR key LIKE '%::' || ?)";
      params.push(name, name);
    }
    if (repo) params.push(repo);
    return this.db.prepare(`SELECT key, label FROM nodes WHERE ${where}${repoClause} LIMIT 5000`).all(...params)
      .map((r) => ({ key: r.key as string, label: (r.label as string) || labelFromKey(r.key) }));
  }

  private distinctEdgeEndpoint(keys: string[], side: 'callers' | 'deps', limit: number): string[] {
    const col = side === 'callers' ? 'source' : 'target';
    const match = side === 'callers' ? 'target' : 'source';
    const seen = new Set<string>();
    for (const batch of chunked(keys)) {
      const ph = batch.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT DISTINCT ${col} AS v FROM edges WHERE ${match} IN (${ph}) AND (type IS NULL OR type <> 'contains') LIMIT ?`,
      ).all(...batch, limit);
      for (const r of rows) { seen.add(r.v as string); if (seen.size >= limit) return [...seen]; }
    }
    return [...seen];
  }
  callers(targetKeys: string[], limit: number): string[] { return this.distinctEdgeEndpoint(targetKeys, 'callers', limit); }
  dependencies(sourceKeys: string[], limit: number): string[] { return this.distinctEdgeEndpoint(sourceKeys, 'deps', limit); }

  crossRepoEdges(repo: string | undefined, limit: number): { edges: GraphEdge[]; total: number } {
    const base = 'FROM edges WHERE source_repo <> target_repo' + (repo ? ' AND (source_repo = ? OR target_repo = ?)' : '');
    const p: unknown[] = repo ? [repo, repo] : [];
    const total = this.db.prepare(`SELECT COUNT(*) c ${base}`).get(...p).c as number;
    const edges = this.db.prepare(`SELECT source, target, type ${base} LIMIT ?`).all(...p, limit)
      .map((r) => ({ source: r.source as string, target: r.target as string, type: r.type as string | undefined }));
    return { edges, total };
  }

  nodesInFiles(repo: string, files: string[], entity?: string): string[] {
    const out: string[] = [];
    for (const file of files) {
      const prefix = `${repo}::${file}`;
      const ent = entity ? ' AND key LIKE ?' : '';
      const params: unknown[] = [repo, prefix, `${prefix}::%`];
      if (entity) params.push(`%::${entity}`);
      const rows = this.db.prepare(
        `SELECT key FROM nodes WHERE repo = ? AND (key = ? OR key LIKE ?)${ent} LIMIT 2000`,
      ).all(...params);
      for (const r of rows) out.push(r.key as string);
    }
    return out;
  }

  dependents(nodeKeys: string[], limit: number): { edges: GraphEdge[]; total: number; repos: string[] } {
    const set = new Set(nodeKeys);
    const edges: GraphEdge[] = [];
    const repos = new Set<string>();
    let total = 0;
    for (const batch of chunked(nodeKeys)) {
      const ph = batch.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT source, target, type, source_repo FROM edges WHERE target IN (${ph}) AND (type IS NULL OR type <> 'contains')`,
      ).all(...batch);
      for (const r of rows) {
        if (set.has(r.source as string)) continue; // dependents are from OUTSIDE the set
        total++;
        repos.add((r.source_repo as string) || repoOf(r.source as string));
        if (edges.length < limit) edges.push({ source: r.source as string, target: r.target as string, type: r.type as string | undefined });
      }
    }
    return { edges, total, repos: [...repos] };
  }

  neighborsOf(key: string, direction: GraphDirection): string[] {
    const out = new Set<string>();
    const conf = "(confidence IS NULL OR confidence >= 0.7) AND (type IS NULL OR type <> 'contains')";
    if (direction === 'callees' || direction === 'both') {
      for (const r of this.db.prepare(`SELECT target FROM edges WHERE source = ? AND ${conf}`).all(key)) out.add(r.target as string);
    }
    if (direction === 'callers' || direction === 'both') {
      for (const r of this.db.prepare(`SELECT source FROM edges WHERE target = ? AND ${conf}`).all(key)) out.add(r.source as string);
    }
    return [...out];
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
    const cond: string[] = ['degree >= ?'];
    const p: unknown[] = [f.minDegree ?? 0];
    if (f.repo) { cond.push("key LIKE ? || '::%'"); p.push(f.repo); }
    if (f.type) { cond.push('type = ?'); p.push(f.type); }
    if (f.file) { cond.push("file LIKE '%' || ? || '%'"); p.push(f.file); }
    if (f.name) { cond.push("(label LIKE '%' || ? || '%' OR key LIKE '%' || ? || '%')"); p.push(f.name, f.name); }
    const where = cond.join(' AND ');
    const total = this.db.prepare(`SELECT COUNT(*) c FROM nodes WHERE ${where}`).get(...p).c as number;
    const rows = this.db.prepare(`SELECT key,label,type,file,degree FROM nodes WHERE ${where} ORDER BY degree DESC LIMIT ?`).all(...p, limit)
      .map((r) => ({ key: r.key as string, label: (r.label as string) || labelFromKey(r.key), type: (r.type as string) || '?', file: (r.file as string) || fileOf(r.key), degree: (r.degree as number) ?? 0 }));
    return { rows, total };
  }

  close(): void { this.db.close(); }
}

// ---------------------------------------------------------------------------
// JSON-backed reader (fallback for pre-sqlite indexes / no driver). Loads the
// legacy export into arrays — fine for the small graphs that fit in JSON.
// ---------------------------------------------------------------------------

interface JNode { key: string; attributes?: { label?: string; type?: string; repo?: string; file?: string } }
interface JEdge { source: string; target: string; attributes?: { type?: string; relation?: string; confidence?: number } }

class JsonGraphStore implements GraphStore {
  private adjCallees?: Map<string, Set<string>>;
  private adjCallers?: Map<string, Set<string>>;
  private degreeCache?: Map<string, number>;
  constructor(private nodes: JNode[], private edges: JEdge[]) {}

  private et(e: JEdge): string | undefined { return e.attributes?.type ?? e.attributes?.relation; }
  private label(n: JNode): string { return n.attributes?.label ?? labelFromKey(n.key); }

  resolveNodes(name: string, repo?: string, fuzzy = false): Array<{ key: string; label: string }> {
    const inRepo = (k: string) => !repo || k.startsWith(repo + '::');
    return this.nodes.filter((n) => inRepo(n.key) && (fuzzy
      ? ((n.attributes?.label ?? '').includes(name) || n.key.includes(name))
      : (n.attributes?.label === name || n.key.endsWith('::' + name)))
    ).map((n) => ({ key: n.key, label: this.label(n) }));
  }
  callers(targetKeys: string[], limit: number): string[] {
    const set = new Set(targetKeys);
    return [...new Set(this.edges.filter((e) => set.has(e.target) && this.et(e) !== 'contains').map((e) => e.source))].slice(0, limit);
  }
  dependencies(sourceKeys: string[], limit: number): string[] {
    const set = new Set(sourceKeys);
    return [...new Set(this.edges.filter((e) => set.has(e.source) && this.et(e) !== 'contains').map((e) => e.target))].slice(0, limit);
  }
  crossRepoEdges(repo: string | undefined, limit: number): { edges: GraphEdge[]; total: number } {
    const cross = this.edges.filter((e) => {
      const s = repoOf(e.source), t = repoOf(e.target);
      if (!s || !t || s === t) return false;
      return !repo || s === repo || t === repo;
    });
    return { edges: cross.slice(0, limit).map((e) => ({ source: e.source, target: e.target, type: this.et(e) })), total: cross.length };
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
  dependents(nodeKeys: string[], limit: number): { edges: GraphEdge[]; total: number; repos: string[] } {
    const set = new Set(nodeKeys);
    const all = this.edges.filter((e) => set.has(e.target) && !set.has(e.source) && this.et(e) !== 'contains');
    const repos = [...new Set(all.map((e) => repoOf(e.source)))];
    return { edges: all.slice(0, limit).map((e) => ({ source: e.source, target: e.target, type: this.et(e) })), total: all.length, repos };
  }
  private adj(direction: GraphDirection): Map<string, Set<string>> {
    if (direction === 'callees' && this.adjCallees) return this.adjCallees;
    if (direction === 'callers' && this.adjCallers) return this.adjCallers;
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => { if (!m.has(a)) m.set(a, new Set()); m.get(a)!.add(b); };
    for (const e of this.edges) {
      if (!e.source || !e.target || this.et(e) === 'contains') continue;
      if ((e.attributes?.confidence ?? 0.8) < 0.7) continue;
      if (direction === 'callees' || direction === 'both') add(e.source, e.target);
      if (direction === 'callers' || direction === 'both') add(e.target, e.source);
    }
    if (direction === 'callees') this.adjCallees = m;
    else if (direction === 'callers') this.adjCallers = m;
    return m;
  }
  neighborsOf(key: string, direction: GraphDirection): string[] { return [...(this.adj(direction).get(key) ?? [])]; }
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
    const deg = this.degree();
    let nameTest: (s: string) => boolean = () => true;
    if (f.name) { try { const re = new RegExp(f.name, 'i'); nameTest = (s) => re.test(s); } catch { const lc = f.name.toLowerCase(); nameTest = (s) => s.toLowerCase().includes(lc); } }
    const matches = this.nodes.filter((n) => {
      if (f.repo && !n.key.startsWith(f.repo + '::')) return false;
      if (f.type && n.attributes?.type !== f.type) return false;
      const file = n.attributes?.file ?? fileOf(n.key);
      if (f.file && !file.includes(f.file)) return false;
      if (f.name && !(nameTest(n.attributes?.label ?? '') || nameTest(n.key))) return false;
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
