import { rmSync } from 'node:fs';
import type { CodeChunk, ScoredChunk } from '@esankhan3/anvil-knowledge-core';
import type { VectorStorePort, IvfPqIndexConfig } from './storage/ports.js';

/** A LanceDB store left 0-byte/truncated by a prior killed-mid-write (OOM /
 *  SIGKILL / ENOSPC). Surfaces as a lance IO / "Invalid range" / generic
 *  memory error on open or first read. Distinct from "table not found"
 *  (a normal first run), which must NOT trigger a destructive rebuild. */
function isCorruptVectorStore(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Invalid range|Generic memory error|LanceError\(IO\)|corrupt|unexpected end of file|failed to (read|open)/i.test(
    msg,
  );
}

/** IVF partitions probed per vector query (recall/latency dial; env-tunable so
 *  it can be adjusted on the VM without a redeploy). No effect until the IVF
 *  index exists (ensureVectorIndex). */
const VECTOR_NPROBES = Math.max(1, parseInt(process.env.CODE_SEARCH_VECTOR_NPROBES ?? '', 10) || 40);

export class VectorStore implements VectorStorePort {
  private db: any; // lancedb.Connection
  private table: any; // lancedb.Table
  private dbPath: string;
  private storageOptions?: Record<string, string>;
  private cacheBudget?: { indexCacheBytes: number; metadataCacheBytes: number };
  private indexConfig?: IvfPqIndexConfig;
  private initialized: boolean = false;

  /** `dbPath` is a local directory (default) or an object-store URI
   *  (`s3://bucket/prefix`). `storageOptions` carries the LanceDB/object_store
   *  S3 connection knobs (endpoint, region, path-style, …) for MinIO; omit for
   *  local. Access key/secret are read from the environment by object_store.
   *  `cacheBudget` (S3 deployments) bounds LanceDB's in-RAM index/metadata
   *  Session caches so a memory-limited pod stays under its limit; omit ⇒
   *  LanceDB defaults (≈6 GiB / 1 GiB). LanceDB has no on-disk fragment cache,
   *  so this RAM Session is the only adapter-level caching lever (ADR §5.5).
   *  `indexConfig` (ADR §5.5, `storage.vector.lancedb.index`) enables the IVF_PQ
   *  index so an S3 query reads only probed partitions; omit ⇒ flat/exact scan. */
  constructor(
    dbPath: string,
    storageOptions?: Record<string, string>,
    cacheBudget?: { indexCacheBytes: number; metadataCacheBytes: number },
    indexConfig?: IvfPqIndexConfig,
  ) {
    this.dbPath = dbPath;
    this.storageOptions = storageOptions;
    this.cacheBudget = cacheBudget;
    this.indexConfig = indexConfig;
  }

  /** True when dbPath is a local filesystem path (no `scheme://`). */
  private get isLocal(): boolean {
    return !/^[a-z0-9]+:\/\//i.test(this.dbPath);
  }

  /** Positional args for `lancedb.connect(uri, options?, session?)`. */
  private connectArgs(
    session?: any, // lancedb.Session — matches the `any` lancedb types used throughout
  ): [string, { storageOptions: Record<string, string> }?, any?] {
    const opts = this.storageOptions ? { storageOptions: this.storageOptions } : undefined;
    if (session) return [this.dbPath, opts, session];
    return opts ? [this.dbPath, opts] : [this.dbPath];
  }

  /** Initialize connection, create or open table.
   *
   *  `healCorrupt` (write path only): force a real read on open so a table
   *  corrupted by a prior killed-mid-write surfaces here, and if it does, drop
   *  the table and start fresh — the caller rebuilds it from chunks.json. NEVER
   *  pass this on a read/search path: a reader must not delete the index. */
  async init(opts?: { healCorrupt?: boolean }): Promise<void> {
    let lancedb: typeof import('@lancedb/lancedb');
    try {
      lancedb = await import('@lancedb/lancedb');
    } catch {
      throw new Error(
        '@lancedb/lancedb is not installed. Install it with: npm install @lancedb/lancedb',
      );
    }
    // Bounded in-RAM Session (S3 deployments) — index + metadata caches sized
    // from storage.cache. Built only when a budget was resolved; otherwise
    // connect() with no session uses LanceDB defaults (today's behavior). The
    // `Session` export guards a binding too old to have it (native optional dep).
    const session =
      this.cacheBudget && lancedb.Session
        ? new lancedb.Session(
            BigInt(this.cacheBudget.indexCacheBytes),
            BigInt(this.cacheBudget.metadataCacheBytes),
          )
        : undefined;
    this.db = await lancedb.connect(...this.connectArgs(session));
    try {
      this.table = await this.db.openTable('chunks');
      // A 0-byte fragment from a killed-mid-write often opens fine but throws on
      // the first read, not at openTable — so force a read when healing.
      if (opts?.healCorrupt) await this.table.query().limit(1).toArray();
      // NOTE: the FTS index is built on the WRITE path only (embedChunks calls
      // ensureFtsIndex explicitly). A reader must NOT rebuild it — doing so here
      // rebuilt the full-text index over the whole table on every open, i.e. on
      // every query (getRetriever → init), which was the dominant serving cost.
    } catch (err) {
      if (opts?.healCorrupt && isCorruptVectorStore(err)) {
        // Store is unreadable but fully rebuildable from chunks.json: drop it
        // and reconnect to an empty dir so the embed loop recreates the table.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[knowledge-core] vector store at ${this.dbPath} is corrupt (${msg.slice(0, 160)}); dropping and rebuilding from chunks.json.`,
        );
        this.table = undefined;
        // Local stores only: drop the corrupt dir and recreate. An object-store
        // URI (s3://) can't be rm'd here — the sole-writer daemon rebuilds it on
        // its next full index.
        if (this.isLocal) {
          try { rmSync(this.dbPath, { recursive: true, force: true }); } catch { /* best effort */ }
        }
        this.db = await lancedb.connect(...this.connectArgs(session));
      }
      // else: table doesn't exist yet (first run) — created on first upsert.
    }
    this.initialized = true;
  }

  /** Create or rebuild the full-text search index on contextualizedContent */
  /** (Re)build the full-text index. Public so a streamed batch insert can
   *  defer it to a single call after the final batch instead of paying the
   *  rebuild on every addChunks. */
  async ensureFtsIndex(): Promise<void> {
    if (!this.table) return;
    try {
      const lancedb = await import('@lancedb/lancedb');
      await this.table.createIndex('contextualizedContent', {
        config: lancedb.Index.fts(),
        replace: true,
      });
    } catch {
      // Index creation can fail on empty tables or unsupported configs — non-fatal
    }
  }

  /** Build scalar indexes on every column that `.filter()` / `.where()` touches,
   *  so graph-expansion + filtered search do indexed lookups instead of full
   *  table scans — the dominant per-query cost at org scale (a 383k-row scan of
   *  text-heavy rows, repeated per graph-expansion batch). `bitmap` for
   *  low-cardinality equality columns (repoName, project), `btree` for
   *  high-cardinality ones (filePath, entityName, id).
   *
   *  Write path only; idempotent (build-if-absent — a full rebuild recreates the
   *  table and rebuilds these; incremental adds are folded by {@link optimizeIndexes}).
   *  Non-fatal: a missing index just means that query falls back to a scan, so a
   *  build failure (e.g. on an empty table) degrades performance, never correctness. */
  async ensureScalarIndexes(): Promise<void> {
    if (!this.table) return;
    const wanted: Array<{ col: string; kind: 'bitmap' | 'btree' }> = [
      { col: 'repoName', kind: 'bitmap' },
      { col: 'project', kind: 'bitmap' },
      { col: 'filePath', kind: 'btree' },
      { col: 'entityName', kind: 'btree' },
      { col: 'id', kind: 'btree' },
    ];
    try {
      const existing: Array<{ columns?: string[] }> = await this.table.listIndices();
      const indexed = new Set(existing.flatMap((i) => i.columns ?? []));
      const lancedb = await import('@lancedb/lancedb');
      for (const { col, kind } of wanted) {
        if (indexed.has(col)) continue; // already built; appends folded by optimizeIndexes()
        try {
          await this.table.createIndex(col, {
            config: kind === 'bitmap' ? lancedb.Index.bitmap() : lancedb.Index.btree(),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[knowledge-core] scalar index on ${col} skipped: ${msg.slice(0, 160)}`);
        }
      }
    } catch {
      // listIndices unavailable — non-fatal; queries fall back to scans.
    }
  }

  /** Fold newly-appended rows into the existing FTS/scalar/vector indexes (and
   *  compact fragments). Run on the write path AFTER an incremental embed so the
   *  unindexed tail doesn't grow across reindexes and drag scans back in. Work is
   *  proportional to the NEW data, not the whole table. Non-fatal. */
  async optimizeIndexes(): Promise<void> {
    if (!this.table) return;
    try {
      await this.table.optimize();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[knowledge-core] index optimize skipped: ${msg.slice(0, 160)}`);
    }
  }

  /** Build the vector-column index so vector search reads only the probed
   *  partitions instead of brute-force scanning every row — the fix for the
   *  multi-second flat-scan latency at org scale.
   *
   *  Two shapes, one write-path entry point:
   *  - Default (no `storage.vector.lancedb.index` config): **IVF_FLAT** — exact
   *    distances within each partition, no quantization recall loss; the full
   *    vectors fit local RAM. This is the local/VM production behavior.
   *  - `indexConfig` set (S3/MinIO deployments, ADR §5.5): **IVF_PQ** with the
   *    configured partitions/sub-vectors, so a query drags only probed,
   *    quantized partitions across the network.
   *
   *  WRITE PATH ONLY — a reader must never build an index (sole-writer
   *  invariant). Idempotent (build-if-absent — a full rebuild recreates it,
   *  incremental adds are folded by optimizeIndexes()). Below `minRows` a flat
   *  scan is already fast and IVF training is noise, so skip. Non-fatal: on
   *  failure (e.g. `numSubVectors` not dividing the embedding dimension) vector
   *  search falls back to the exact flat scan — degraded speed, never
   *  correctness — and the reason is logged. */
  async ensureVectorIndex(opts?: { minRows?: number }): Promise<void> {
    if (!this.table) return;
    const minRows = this.indexConfig?.minRows ?? opts?.minRows ?? 10_000;
    try {
      const count = await this.table.countRows();
      if (count < minRows) return;
      const existing: Array<{ columns?: string[] }> = await this.table.listIndices();
      // Already built (the FTS index is on contextualizedContent, not vector) →
      // leave it; appends are absorbed without a costly retrain.
      if (existing.some((i) => Array.isArray(i.columns) && i.columns.includes('vector'))) return;
      const lancedb = await import('@lancedb/lancedb');
      if (this.indexConfig) {
        const ivfOpts: { numPartitions?: number; numSubVectors?: number } = {};
        if (this.indexConfig.numPartitions) ivfOpts.numPartitions = this.indexConfig.numPartitions;
        if (this.indexConfig.numSubVectors) ivfOpts.numSubVectors = this.indexConfig.numSubVectors;
        await this.table.createIndex('vector', { config: lancedb.Index.ivfPq(ivfOpts) });
        console.error(
          `[knowledge-core] built IVF_PQ vector index on ${count} rows (${JSON.stringify(ivfOpts)}).`,
        );
      } else {
        await this.table.createIndex('vector', { config: lancedb.Index.ivfFlat() });
        console.error(`[knowledge-core] built IVF_FLAT vector index on ${count} rows.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[knowledge-core] vector index build skipped (flat scan still works): ${msg.slice(0, 200)}`);
    }
  }

  /** Insert or replace chunks with embeddings */
  async upsertChunks(chunks: Array<CodeChunk & { embedding: number[] }>): Promise<void> {
    // Map chunks to flat row objects for LanceDB
    const rows = chunks.map((c) => ({
      id: c.id,
      vector: c.embedding, // LanceDB uses 'vector' field for embeddings
      content: c.content,
      contextualizedContent: c.contextualizedContent,
      contextPrefix: c.contextPrefix,
      filePath: c.filePath,
      repoName: c.repoName,
      project: c.project,
      entityType: c.entityType,
      entityName: c.entityName ?? '',
      parentEntity: c.parentEntity ?? '',
      language: c.language,
      startLine: c.startLine,
      endLine: c.endLine,
      tokens: c.tokens,
    }));

    if (!this.table) {
      this.table = await this.db.createTable('chunks', rows, { mode: 'overwrite' });
    } else {
      // Delete existing chunks for the same project, then add new ones
      // This handles re-indexing
      const project = chunks[0]?.project;
      if (project) {
        try {
          await this.table.delete(`project = '${project.replace(/'/g, "''")}'`);
        } catch {
          /* ok if empty */
        }
      }
      await this.table.add(rows);
    }
    // Rebuild FTS index after data changes
    await this.ensureFtsIndex();
  }

  /** Semantic vector search */
  async vectorSearch(
    queryEmbedding: number[],
    opts?: {
      limit?: number;
      filter?: string;
    },
  ): Promise<ScoredChunk[]> {
    if (!this.table) return [];
    // nprobes = IVF partitions scanned per query (no-op on a flat/un-indexed
    // table). Higher = better recall, more work. `indexConfig` (IVF_PQ / S3
    // deployments) wins when set; otherwise the env-tunable VECTOR_NPROBES.
    // refineFactor (IVF_PQ only) re-ranks the top nprobes·refine candidates
    // with exact distance against the retained raw vectors (ADR §5.5).
    let query = this.table
      .search(queryEmbedding)
      .limit(opts?.limit ?? 20)
      .nprobes(this.indexConfig?.nprobes ?? VECTOR_NPROBES);
    if (this.indexConfig?.refineFactor) query = query.refineFactor(this.indexConfig.refineFactor);
    if (opts?.filter) query = query.where(opts.filter);
    const results = await query.toArray();
    return results.map((r: any) => ({
      chunk: rowToChunk(r),
      score: r._distance != null ? 1 / (1 + r._distance) : 0.5,
      source: 'vector' as const,
    }));
  }

  /** Approximate (IVF_PQ, index-backed) nearest-neighbor ids — applies the
   *  configured nprobes/refineFactor via vectorSearch. Used by the recall gate. */
  async vectorSearchIds(queryEmbedding: number[], k: number): Promise<string[]> {
    const results = await this.vectorSearch(queryEmbedding, { limit: k });
    return results.map((s) => s.chunk.id);
  }

  /** EXACT nearest-neighbor ids via `bypassVectorIndex()` — forces a flat scan
   *  on the same table, ignoring the IVF_PQ index. This is the ground-truth
   *  baseline the P1d recall gate compares the approximate search against. */
  async vectorSearchExactIds(queryEmbedding: number[], k: number): Promise<string[]> {
    if (!this.table) return [];
    const rows = await this.table.search(queryEmbedding).bypassVectorIndex().limit(k).toArray();
    return rows.map((r: any) => r.id as string);
  }

  /** Full-text BM25 search (LanceDB built-in FTS) */
  async fullTextSearch(queryText: string, limit: number = 20, filter?: string): Promise<ScoredChunk[]> {
    if (!this.table) return [];
    try {
      let q = this.table.search(queryText, 'fts', 'contextualizedContent').limit(limit);
      // Apply the same repo filter as vectorSearch — without it, BM25 results
      // leak across repos even when the caller scoped to specific repos.
      if (filter) q = q.where(filter);
      const results = await q.toArray();
      // FTS rows carry `_score` on this binding (0.27.x); `_relevance_score`
      // is the legacy field name — reading only that flattened every BM25
      // score to the 0.5 fallback.
      return results.map((r: any) => ({
        chunk: rowToChunk(r),
        score: r._score ?? r._relevance_score ?? 0.5,
        source: 'bm25' as const,
      }));
    } catch {
      // FTS index may not exist
      return [];
    }
  }

  /** Exact-symbol lookup: chunks whose entityName equals one of `names`.
   *  BTREE-indexed equality (see ensureScalarIndexes) — a definition becomes a
   *  retrieval candidate even when vector and BM25 both rank it outside their
   *  top-50 (the literal-recall gap vs trigram engines). */
  async searchByEntityName(names: string[], limit: number = 20, filter?: string): Promise<ScoredChunk[]> {
    if (!this.table || names.length === 0) return [];
    const esc = (s: string) => s.replace(/'/g, "''");
    const nameCond = `entityName IN (${names.map((n) => `'${esc(n)}'`).join(',')})`;
    const where = filter ? `(${nameCond}) AND (${filter})` : nameCond;
    try {
      const results = await this.table.query().where(where).limit(limit).toArray();
      return results.map((r: any) => ({
        chunk: rowToChunk(r),
        score: 1,
        source: 'exact' as const,
      }));
    } catch {
      return [];
    }
  }

  /** Get specific chunks by their IDs */
  async getByIds(ids: string[]): Promise<CodeChunk[]> {
    if (!this.table || ids.length === 0) return [];
    const filter = ids.map((id) => `id = '${id.replace(/'/g, "''")}'`).join(' OR ');
    try {
      // `.query().where()` — NOT the legacy `.filter()`, which is a no-op on this
      // binding (silently returns nothing). With the scalar index on `id` this is
      // an indexed lookup, not a scan.
      const results = await this.table.query().where(filter).toArray();
      return results.map((r: any) => rowToChunk(r));
    } catch {
      return [];
    }
  }

  /** Look up chunks by repo + file + entity name — for direct AST graph expansion.
   *  Returns ScoredChunks with a fixed graph-expansion score. */
  async getChunksByEntity(
    lookups: Array<{ repoName: string; filePath: string; entityName?: string }>,
  ): Promise<ScoredChunk[]> {
    if (!this.table || lookups.length === 0) return [];
    const esc = (s: string) => s.replace(/'/g, "''");
    const conditions = lookups.map((l) => {
      const base = `repoName = '${esc(l.repoName)}' AND filePath = '${esc(l.filePath)}'`;
      return l.entityName
        ? `(${base} AND entityName = '${esc(l.entityName)}')`
        : `(${base})`;
    });
    try {
      // Split into batches (avoid overly long filter strings) and run them
      // CONCURRENTLY — each is an independent indexed lookup (see
      // ensureScalarIndexes), so overlapping them collapses the graph-expansion
      // phase from sum-of-batches to slowest-batch latency.
      const batchSize = 20;
      const batches: string[] = [];
      for (let i = 0; i < conditions.length; i += batchSize) {
        batches.push(conditions.slice(i, i + batchSize).join(' OR '));
      }
      const perBatch = await Promise.all(
        // `.query().where()` — the legacy `.filter()` is a no-op on this binding
        // (this is why graph expansion silently returned nothing). The scalar
        // indexes on repoName/filePath/entityName make each an indexed lookup.
        batches.map((batch) => this.table.query().where(batch).limit(batchSize * 2).toArray()),
      );
      return perBatch.flat().map((r: any) => ({
        chunk: rowToChunk(r),
        score: 0.75,
        source: 'graph' as const,
      }));
    } catch {
      return [];
    }
  }

  /** Get all chunks for a specific file in a repo (for incremental comparison) */
  async getChunksByFile(
    repoName: string,
    filePath: string,
  ): Promise<Array<{ id: string; content: string; entityName: string; tokens: number }>> {
    if (!this.table) return [];
    const esc = (s: string) => s.replace(/'/g, "''");
    try {
      // `.query().where()` — see getByIds; `.filter()` is a no-op on this binding.
      const results = await this.table
        .query()
        .where(`repoName = '${esc(repoName)}' AND filePath = '${esc(filePath)}'`)
        .toArray();
      return results.map((r: any) => ({
        id: r.id,
        content: r.content,
        entityName: r.entityName || '',
        tokens: r.tokens || 0,
      }));
    } catch {
      return [];
    }
  }

  /** Delete specific chunks by their IDs (for surgical updates) */
  async deleteChunksByIds(ids: string[]): Promise<void> {
    if (!this.table || ids.length === 0) return;
    // Batch deletes to avoid overly long filter strings
    const batchSize = 50;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const filter = batch.map((id) => `id = '${id.replace(/'/g, "''")}'`).join(' OR ');
      try {
        await this.table.delete(filter);
      } catch { /* ok if chunk doesn't exist */ }
    }
  }

  /** Get all chunk IDs for a project (for incremental diff) */
  async getChunkIds(project: string): Promise<string[]> {
    if (!this.table) return [];
    try {
      const escapedProject = project.replace(/'/g, "''");
      const results = await this.table
        .query()
        .where(`project = '${escapedProject}'`)
        .select(['id'])
        .toArray();
      return results.map((r: any) => r.id as string);
    } catch {
      return [];
    }
  }

  /** Get index statistics */
  async getStats(): Promise<{ rowCount: number } | null> {
    if (!this.table) return null;
    try {
      const count = await this.table.countRows();
      return { rowCount: count };
    } catch {
      return null;
    }
  }

  /** Check if the store has data */
  async hasData(): Promise<boolean> {
    const stats = await this.getStats();
    return (stats?.rowCount ?? 0) > 0;
  }

  /** Delete chunks for specific files within a repo (for incremental re-indexing) */
  async deleteFileChunks(project: string, repoName: string, filePaths: string[]): Promise<void> {
    if (!this.table || filePaths.length === 0) return;
    const escapedProject = project.replace(/'/g, "''");
    const escapedRepo = repoName.replace(/'/g, "''");
    const fileFilter = filePaths.map((f) => `'${f.replace(/'/g, "''")}'`).join(', ');
    try {
      await this.table.delete(
        `project = '${escapedProject}' AND repoName = '${escapedRepo}' AND filePath IN (${fileFilter})`,
      );
    } catch {
      /* ok if empty */
    }
  }

  /** Add chunks without deleting existing project data (for incremental updates).
   *  Pass { skipIndex: true } to defer the FTS rebuild; the caller must then
   *  call ensureFtsIndex() once after the final batch. */
  async addChunks(chunks: Array<CodeChunk & { embedding: number[] }>, opts?: { skipIndex?: boolean }): Promise<void> {
    if (chunks.length === 0) return;
    const rows = chunks.map((c) => ({
      id: c.id,
      vector: c.embedding,
      content: c.content,
      contextualizedContent: c.contextualizedContent,
      contextPrefix: c.contextPrefix,
      filePath: c.filePath,
      repoName: c.repoName,
      project: c.project,
      entityType: c.entityType,
      entityName: c.entityName ?? '',
      parentEntity: c.parentEntity ?? '',
      language: c.language,
      startLine: c.startLine,
      endLine: c.endLine,
      tokens: c.tokens,
    }));

    if (!this.table) {
      this.table = await this.db.createTable('chunks', rows, { mode: 'overwrite' });
    } else {
      await this.table.add(rows);
    }
    // Rebuild FTS index after data changes — unless the caller is streaming
    // batches and will call ensureFtsIndex() once at the end.
    if (!opts?.skipIndex) {
      await this.ensureFtsIndex();
    }
  }
}

/** ADR §3 canonical name for the default LanceDB-backed `VectorStorePort`
 *  adapter. Alias for now; a later phase renames the class outright. */
export { VectorStore as LanceVectorStore };

function rowToChunk(row: any): CodeChunk {
  return {
    id: row.id,
    filePath: row.filePath,
    repoName: row.repoName,
    project: row.project,
    startLine: row.startLine,
    endLine: row.endLine,
    content: row.content,
    contextPrefix: row.contextPrefix,
    contextualizedContent: row.contextualizedContent,
    language: row.language,
    entityType: row.entityType,
    entityName: row.entityName || undefined,
    parentEntity: row.parentEntity || undefined,
    tokens: row.tokens,
    imports: [],
    exports: [],
  };
}
