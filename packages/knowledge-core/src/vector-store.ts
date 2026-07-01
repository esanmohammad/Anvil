import { rmSync } from 'node:fs';
import type { CodeChunk, ScoredChunk } from '@esankhan3/anvil-knowledge-core';

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

export class VectorStore {
  private db: any; // lancedb.Connection
  private table: any; // lancedb.Table
  private dbPath: string;
  private initialized: boolean = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
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
    this.db = await lancedb.connect(this.dbPath);
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
        try { rmSync(this.dbPath, { recursive: true, force: true }); } catch { /* best effort */ }
        this.db = await lancedb.connect(this.dbPath);
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

  /** Build an IVF_FLAT index on the `vector` column so vector search reads only
   *  the probed partitions instead of brute-force scanning every row — the fix
   *  for the multi-second flat-scan latency at org scale. IVF_FLAT (not PQ) keeps
   *  exact distances within each partition, so there's no quantization recall
   *  loss, and the full vectors fit comfortably in the VM's RAM. Query-time
   *  `nprobes` (VECTOR_NPROBES) trades recall vs partitions scanned.
   *
   *  Write path only; idempotent (build-if-absent — a full rebuild recreates it,
   *  incremental adds are folded by optimizeIndexes()). Below `minRows` a flat
   *  scan is already fast and IVF training is noise, so skip. Non-fatal: on
   *  failure vector search falls back to the exact flat scan. */
  async ensureVectorIndex(opts?: { minRows?: number }): Promise<void> {
    if (!this.table) return;
    const minRows = opts?.minRows ?? 10_000;
    try {
      const count = await this.table.countRows();
      if (count < minRows) return;
      const existing: Array<{ columns?: string[] }> = await this.table.listIndices();
      if (existing.some((i) => Array.isArray(i.columns) && i.columns.includes('vector'))) return;
      const lancedb = await import('@lancedb/lancedb');
      await this.table.createIndex('vector', { config: lancedb.Index.ivfFlat() });
      console.error(`[knowledge-core] built IVF_FLAT vector index on ${count} rows.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[knowledge-core] vector index build skipped (flat scan still works): ${msg.slice(0, 160)}`);
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
    // table). Higher = better recall, more work; tunable without a redeploy.
    let query = this.table.search(queryEmbedding).limit(opts?.limit ?? 20).nprobes(VECTOR_NPROBES);
    if (opts?.filter) query = query.where(opts.filter);
    const results = await query.toArray();
    return results.map((r: any) => ({
      chunk: rowToChunk(r),
      score: r._distance != null ? 1 / (1 + r._distance) : 0.5,
      source: 'vector' as const,
    }));
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
