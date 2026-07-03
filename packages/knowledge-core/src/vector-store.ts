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
      // Ensure FTS index exists for existing tables
      await this.ensureFtsIndex();
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

  /** (Re)build the IVF_PQ index on the `vector` column — the write-path
   *  optimization that lets an S3-backed query read only the probed partitions
   *  instead of dragging every vector across the network (ADR §5.5).
   *
   *  No-op unless `storage.vector.lancedb.index` is configured (default ⇒
   *  flat/exact scan, byte-identical to today). Builds only when the table has
   *  ≥ `minRows` rows AND no `vector` index exists yet — so a fresh full build
   *  (table recreated via createTable/overwrite) trains centroids, while
   *  incremental `addChunks` appends into the existing index (recall decays
   *  slightly until the next full rebuild retrains). Below `minRows` the flat
   *  scan is both exact and faster, so we skip.
   *
   *  WRITE PATH ONLY — a reader must never build an index (sole-writer
   *  invariant, §5.5). Non-fatal on error: vector search falls back to the exact
   *  flat scan, so a misconfig (e.g. `numSubVectors` not dividing the embedding
   *  dimension) degrades performance but never breaks correctness — and is
   *  logged rather than silently swallowed. */
  async ensureVectorIndex(): Promise<void> {
    if (!this.table || !this.indexConfig) return;
    const minRows = this.indexConfig.minRows ?? 5000;
    try {
      const count = await this.table.countRows();
      if (count < minRows) return; // too small to benefit; flat scan is exact + faster
      const existing: Array<{ columns?: string[] }> = await this.table.listIndices();
      // Already built (the FTS index is on contextualizedContent, not vector) →
      // leave it; appends are absorbed without a costly retrain.
      if (existing.some((i) => Array.isArray(i.columns) && i.columns.includes('vector'))) return;
      const lancedb = await import('@lancedb/lancedb');
      const ivfOpts: { numPartitions?: number; numSubVectors?: number } = {};
      if (this.indexConfig.numPartitions) ivfOpts.numPartitions = this.indexConfig.numPartitions;
      if (this.indexConfig.numSubVectors) ivfOpts.numSubVectors = this.indexConfig.numSubVectors;
      await this.table.createIndex('vector', { config: lancedb.Index.ivfPq(ivfOpts) });
      console.error(
        `[knowledge-core] built IVF_PQ vector index on ${count} rows (${JSON.stringify(ivfOpts)}).`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[knowledge-core] IVF_PQ index build skipped (flat scan still works): ${msg.slice(0, 200)}`);
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
    let query = this.table.search(queryEmbedding).limit(opts?.limit ?? 20);
    // IVF_PQ recall/latency knobs (no-op on a flat scan): nprobes = partitions
    // probed per query; refineFactor re-ranks the top nprobes·refine candidates
    // with exact distance against the retained raw vectors (ADR §5.5).
    if (this.indexConfig?.nprobes) query = query.nprobes(this.indexConfig.nprobes);
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
      return results.map((r: any) => ({
        chunk: rowToChunk(r),
        score: r._relevance_score ?? 0.5,
        source: 'bm25' as const,
      }));
    } catch {
      // FTS index may not exist
      return [];
    }
  }

  /** Get specific chunks by their IDs */
  async getByIds(ids: string[]): Promise<CodeChunk[]> {
    if (!this.table || ids.length === 0) return [];
    const filter = ids.map((id) => `id = '${id}'`).join(' OR ');
    try {
      const results = await this.table.filter(filter).toArray();
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
      // Query in batches to avoid overly long filters
      const allResults: ScoredChunk[] = [];
      const batchSize = 20;
      for (let i = 0; i < conditions.length; i += batchSize) {
        const batch = conditions.slice(i, i + batchSize).join(' OR ');
        const results = await this.table.filter(batch).limit(batchSize * 2).toArray();
        for (const r of results) {
          allResults.push({
            chunk: rowToChunk(r),
            score: 0.75,
            source: 'graph' as const,
          });
        }
      }
      return allResults;
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
      const results = await this.table
        .filter(`repoName = '${esc(repoName)}' AND filePath = '${esc(filePath)}'`)
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
