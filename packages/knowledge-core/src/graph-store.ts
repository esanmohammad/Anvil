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

/**
 * Query surface the system-graph tools need. Implemented over SQLite and
 * (fallback) over the legacy JSON export.
 *
 * Name resolution (`resolveNodes`): exact by default — a node's full key, its
 * label, or a `::`-suffix of its key (`file::entity`), case-sensitive;
 * `fuzzy` = case-insensitive substring of symbol labels. `types` filters by
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
  resolveNodes(name: string, repo?: string, fuzzy?: boolean): Array<{ key: string; label: string }>;
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
  source_repo TEXT, target_repo TEXT, evidence TEXT
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
  const insEdge = db.prepare('INSERT INTO edges(source,target,type,confidence,source_repo,target_repo,evidence) VALUES(?,?,?,?,?,?,?)');

  const degree = new Map<string, number>();
  db.exec('BEGIN');
  try {
    graph.forEachEdge((source, target, attrs) => {
      const type = (attrs.type ?? attrs.relation ?? null) as string | null;
      const confidence = (typeof attrs.confidence === 'number' ? attrs.confidence : null) as number | null;
      const evidence = typeof attrs.evidence === 'string' ? attrs.evidence : null;
      insEdge.run(source, target, type, confidence, repoOf(source), repoOf(target), evidence);
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
  const insEdge = db.prepare('INSERT INTO edges(source,target,type,confidence,source_repo,target_repo,evidence) VALUES(?,?,?,?,?,?,?)');
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
          insEdge.run(src, tgt, type, conf, repoName, repoName, null);
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
          insEdge.run(src, tgt, e.edgeType, conf, e.sourceRepo, e.targetRepo, e.evidence ?? null);
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
const placeholders = (n: number): string => Array(n).fill('?').join(',');
/** Edges a traversal follows: not `contains`, confidence ≥ 0.7 (or unset), of `types` when given. */
const neighborFilter = (types?: string[]): string =>
  `(confidence IS NULL OR confidence >= 0.7) AND (type IS NULL OR type <> 'contains')${types?.length ? ` AND type IN (${placeholders(types.length)})` : ''}`;
/** Escape LIKE's wildcards for `ESCAPE '\'`. */
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

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
  private readonly hasRegexp: boolean;

  constructor(private db: SqliteDb) {
    const cols = db.prepare('PRAGMA table_info(edges)').all().map((c) => c.name as string);
    this.evidenceCol = cols.includes('evidence') ? 'evidence' : 'NULL AS evidence';
    this.hasRegexp = this.registerRegexp();
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

  resolveNodes(name: string, repo?: string, fuzzy = false): Array<{ key: string; label: string }> {
    const params: unknown[] = [];
    let where: string;
    if (fuzzy) {
      where = `label LIKE '%' || ? || '%' ESCAPE '\\' AND type NOT IN (${placeholders(NON_SYMBOL_TYPES.length)})`;
      params.push(likeEscape(name), ...NON_SYMBOL_TYPES);
    } else {
      // `=` / substr compare bytes: case-sensitive and wildcard-free.
      where = '(key = ? OR label = ? OR substr(key, -length(?)) = ?)';
      params.push(name, name, `::${name}`, `::${name}`);
    }
    if (repo) { where += ' AND repo = ?'; params.push(repo); }
    return this.db.prepare(`SELECT key, label FROM nodes WHERE ${where} LIMIT 5000`).all(...params)
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

  resolveNodes(name: string, repo?: string, fuzzy = false): Array<{ key: string; label: string }> {
    const inRepo = (k: string) => !repo || k.startsWith(repo + '::');
    const lc = name.toLowerCase();
    return this.nodes.filter((n) => inRepo(n.key) && (fuzzy
      ? !NON_SYMBOL_TYPES.includes(n.attributes?.type ?? '') && this.label(n).toLowerCase().includes(lc)
      : (n.key === name || this.label(n) === name || n.key.endsWith('::' + name)))
    ).map((n) => ({ key: n.key, label: this.label(n) }));
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
