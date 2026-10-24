import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CodeChunk, ScoredChunk } from '@esankhan3/anvil-knowledge-core';
import type {
  VectorStorePort,
  IvfPqIndexConfig,
  VectorIndexBuildResult,
  VectorIndexState,
  VectorIndexType,
} from './storage/ports.js';

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

/** IVF partitions probed per vector query. The writer calibrates it per index
 *  (vector_index.json: the fewest probes reaching the target recall on
 *  query-like probes) and readers apply it via setCalibratedNprobes.
 *  CODE_SEARCH_VECTOR_NPROBES overrides it — e.g. to trade recall for latency
 *  on a VM without a redeploy; DEFAULT_NPROBES applies when there is neither.
 *  No effect until the IVF index exists (ensureVectorIndex). */
const ENV_NPROBES = parseInt(process.env.CODE_SEARCH_VECTOR_NPROBES ?? '', 10) > 0
  ? parseInt(process.env.CODE_SEARCH_VECTOR_NPROBES ?? '', 10)
  : undefined;
const DEFAULT_NPROBES = 40;

/** Insert a space at camelCase / PascalCase / acronym boundaries
 *  (`parseHTTPResponse` → `parse HTTP Response`) so identifier parts become
 *  BM25 terms. snake_case needs nothing: `_` already breaks tokens. */
export function splitIdentifiers(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

/** Words with no case boundary inside: lowercase, ALL_CAPS, Capitalized. */
const PLAIN_WORD = /\b(?:[a-z0-9_]+|[A-Z0-9_]+|[A-Z][a-z0-9_]+)\b/g;

/** The parts of a text's compound identifiers only (`return
 *  verifyExpectedBacklogCount(q)` → `verify Expected Backlog Count`). The
 *  contentSplit column holds this rather than the whole split text, so a
 *  plain word counts once — in contextualizedContent — not once per column. */
export function identifierParts(text: string): string {
  return splitIdentifiers(text.replace(PLAIN_WORD, ' ').replace(/[^A-Za-z0-9_]+/g, ' '));
}

/** SHA-256 (hex) of the text a chunk is embedded from — the key embedding
 *  reuse looks vectors up by. */
export function contentHash(contextualizedContent: string): string {
  return createHash('sha256').update(contextualizedContent).digest('hex');
}

/** Columns derived from others, with the SQL that fills them in for rows
 *  written before the column existed (ensureColumns). Each SQL must match the
 *  JS that addChunks uses for new rows (`(?-u:\b)` = JS's ASCII `\b`). */
const DERIVED_COLUMNS = [
  { name: 'contentHash', valueSql: "encode(sha256(contextualizedContent), 'hex')" },
  {
    name: 'contentSplit',
    valueSql:
      "regexp_replace(regexp_replace(regexp_replace(regexp_replace(contextualizedContent, " +
      "'(?-u:\\b)(?:[a-z0-9_]+|[A-Z0-9_]+|[A-Z][a-z0-9_]+)(?-u:\\b)', ' ', 'g'), '[^A-Za-z0-9_]+', ' ', 'g'), " +
      "'([a-z0-9])([A-Z])', '${1} ${2}', 'g'), '([A-Z]+)([A-Z][a-z])', '${1} ${2}', 'g')",
  },
];

/** Full-text indexes. Each name stands for its config in ensureFtsIndex:
 *  change a config → change its name, and the next write cycle builds the new
 *  index and drops the old one. */
const FTS_INDEXES = [
  // Positions enable PhraseQuery (multi-token literal matching).
  { column: 'contextualizedContent', name: 'contextualizedContent_idx', options: { withPosition: true } },
  // Compound-identifier parts for term search; phrases stay on the original column.
  { column: 'contentSplit', name: 'contentSplit_idx', options: { withPosition: false } },
  // Lowercased trigrams of entity names, verbatim (no stemming, punctuation
  // kept): the substring tier's candidates (searchByEntitySubstring).
  {
    column: 'entityName',
    name: 'entityName_ngram_idx',
    options: {
      withPosition: false, baseTokenizer: 'ngram' as const, ngramMinLength: 3, ngramMaxLength: 3,
      stem: false, asciiFolding: false,
    },
  },
];

export class VectorStore implements VectorStorePort {
  private db: any; // lancedb.Connection
  private table: any; // lancedb.Table
  private dbPath: string;
  private storageOptions?: Record<string, string>;
  private cacheBudget?: { indexCacheBytes: number; metadataCacheBytes: number };
  private indexConfig?: IvfPqIndexConfig;
  private initialized: boolean = false;
  private columnsEnsured = false;
  private calibratedNprobes?: number;
  /** Names of the table's indexes (FTS_INDEXES added since are absent on
   *  tables no upgraded writer has touched yet); resolved on first search. */
  private indexNames?: Promise<Set<string>>;

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
   *  the table and start fresh — the caller rebuilds it from the chunk files. NEVER
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
        // Store is unreadable but fully rebuildable from the chunk files: drop it
        // and reconnect to an empty dir so the embed loop recreates the table.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[knowledge-core] vector store at ${this.dbPath} is corrupt (${msg.slice(0, 160)}); dropping and rebuilding from the chunk files.`,
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

  /** Build each full-text index (FTS_INDEXES) that is missing or was built
   *  with an older config, after adding any derived column the table lacks.
   *  An existing current index is left alone: rows appended since are still
   *  searched (unindexed rows are scanned) and optimizeIndexes() folds them
   *  in, so a cycle's cost tracks what changed, not the corpus size. Write
   *  path only. */
  async ensureFtsIndex(): Promise<void> {
    if (!this.table) return;
    await this.ensureColumns();
    const lancedb = await import('@lancedb/lancedb');
    for (const spec of FTS_INDEXES) {
      try {
        const indexes: Array<{ name: string; indexType: string; columns: string[] }> = await this.table.listIndices();
        const fts = indexes.filter((i) => i.indexType === 'FTS' && i.columns.includes(spec.column));
        if (fts.some((i) => i.name === spec.name)) continue;
        // removeStopWords: the default drops 'to'/'if'/'in' etc., which
        // silently breaks phrases containing them — and stop words are
        // meaningful tokens in code and error strings.
        await this.table.createIndex(spec.column, {
          config: lancedb.Index.fts({ ...spec.options, removeStopWords: false }),
          name: spec.name,
          replace: true,
        });
        this.indexNames = undefined;
        // Indexes built under another name carry an older config. Drop them
        // only after the current one exists, so search never lacks an index.
        for (const old of fts) await this.table.dropIndex(old.name);
      } catch {
        // Index creation can fail on empty tables or unsupported configs — non-fatal
      }
    }
  }

  /** Add the DERIVED_COLUMNS an older writer's table lacks, computed in SQL
   *  from existing columns — a column add writes only the new column's files,
   *  never rewrites rows. Must run before this writer's first add (rows carry
   *  every column), so addChunks / upsertChunks / ensureFtsIndex call it.
   *  Write path only. */
  private async ensureColumns(): Promise<void> {
    if (!this.table || this.columnsEnsured) return;
    const schema = await this.table.schema();
    const have = new Set(schema.fields.map((f: { name: string }) => f.name));
    const missing = DERIVED_COLUMNS.filter((c) => !have.has(c.name));
    if (missing.length > 0) await this.table.addColumns(missing);
    this.columnsEnsured = true;
  }

  /** Build scalar indexes on every column that `.filter()` / `.where()` touches,
   *  so graph-expansion + filtered search do indexed lookups instead of full
   *  table scans — the dominant per-query cost at org scale (a 383k-row scan of
   *  text-heavy rows, repeated per graph-expansion batch). `bitmap` for
   *  low-cardinality equality columns (repoName, project), `btree` for
   *  high-cardinality ones (filePath, entityName, id, and contentHash for the
   *  writer's embedding-reuse lookups).
   *
   *  Write path only; idempotent (build-if-absent — a new table, e.g. after a
   *  corrupt-store heal, gets them on its first run; incremental adds are folded
   *  by {@link optimizeIndexes}).
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
      { col: 'contentHash', kind: 'btree' },
    ];
    try {
      await this.ensureColumns();
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

  /** Whether any index has rows appended since it was last folded in. */
  async hasUnindexedRows(): Promise<boolean> {
    if (!this.table) return false;
    try {
      const indexes: Array<{ name: string }> = await this.table.listIndices();
      for (const { name } of indexes) {
        if (((await this.table.indexStats(name))?.numUnindexedRows ?? 0) > 0) return true;
      }
      return false;
    } catch {
      return true; // unknown → fold, as an optimize would
    }
  }

  /** Fold newly-appended rows into the existing FTS/scalar/vector indexes (and
   *  compact fragments). Run on the write path AFTER an incremental embed so the
   *  unindexed tail doesn't grow across reindexes and drag scans back in. Work is
   *  proportional to the NEW data, not the whole table. Non-fatal. */
  async optimizeIndexes(): Promise<void> {
    if (!this.table) return;
    try {
      // Also prune old dataset versions: Lance is MVCC and optimize() alone
      // keeps every version, so a 6h reindex cycle grows the bucket forever
      // (measured: +50-100% of dataset size per cycle; each optimize also
      // rewrites every index — several GB at 1M rows). Retention must exceed
      // the readers' refresh window (retriever TTL, default 30 s / invalidate
      // broadcast) so an in-flight reader never loses the version it has open;
      // an hour is far past it.
      const hours = Number(process.env.CODE_SEARCH_LANCE_RETENTION_HOURS) || 1;
      await this.table.optimize({ cleanupOlderThan: new Date(Date.now() - hours * 3_600_000) });
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
   *  invariant). Builds when absent; otherwise leaves the index alone unless
   *  `retrain` is set, in which case it retrains in place (same name,
   *  `replace: true` — one atomic commit, so readers pinned to the previous
   *  version keep the old index). Appends between retrains are folded into the
   *  existing centroids by optimizeIndexes(); when to retrain is decided by
   *  vector-index-maintenance.ts. Below `minRows` a flat scan is already fast
   *  and IVF training is noise, so a first build is skipped. Non-fatal: on
   *  failure (e.g. `numSubVectors` not dividing the embedding dimension) vector
   *  search keeps the previous index or the exact flat scan — degraded speed,
   *  never correctness — and the reason is logged and returned. */
  async ensureVectorIndex(opts?: { minRows?: number; retrain?: boolean }): Promise<VectorIndexBuildResult> {
    if (!this.table) return { status: 'no-table' };
    const minRows = this.indexConfig?.minRows ?? opts?.minRows ?? 10_000;
    try {
      const count = await this.table.countRows();
      const existing = await this.vectorIndexConfig();
      if (existing && !opts?.retrain) return { status: 'present' };
      if (!existing && count < minRows) return { status: 'below-min' };
      const lancedb = await import('@lancedb/lancedb');
      const indexType = this.desiredVectorIndexType();
      // Explicit partition count (LanceDB's own default is √rows) so the value
      // is known for health reporting.
      const numPartitions = this.indexConfig?.numPartitions ?? Math.max(1, Math.round(Math.sqrt(count)));
      let config;
      if (indexType === 'IVF_PQ') {
        const ivfOpts: { numPartitions: number; numSubVectors?: number } = { numPartitions };
        if (this.indexConfig?.numSubVectors) ivfOpts.numSubVectors = this.indexConfig.numSubVectors;
        config = lancedb.Index.ivfPq(ivfOpts);
      } else {
        config = lancedb.Index.ivfFlat({ numPartitions });
      }
      const started = Date.now();
      await this.table.createIndex('vector', {
        config,
        ...(existing ? { name: existing.name, replace: true } : {}),
      });
      const durationMs = Date.now() - started;
      const status = existing ? 'retrained' : 'built';
      console.error(
        `[knowledge-core] ${status} ${indexType} vector index on ${count} rows (${numPartitions} partitions, ${durationMs}ms).`,
      );
      return { status, indexType, numPartitions, rows: count, durationMs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[knowledge-core] vector index build skipped (flat scan still works): ${msg.slice(0, 200)}`);
      return { status: 'failed', error: msg.slice(0, 500) };
    }
  }

  /** The index type a build would produce under the current config. */
  desiredVectorIndexType(): VectorIndexType {
    return this.indexConfig ? 'IVF_PQ' : 'IVF_FLAT';
  }

  /** The vector-column index entry from listIndices(), if any (the FTS index is
   *  on contextualizedContent, scalar ones on their own columns). */
  private async vectorIndexConfig(): Promise<{ name: string } | null> {
    const existing: Array<{ name: string; columns?: string[] }> = await this.table.listIndices();
    return existing.find((i) => Array.isArray(i.columns) && i.columns.includes('vector')) ?? null;
  }

  /** Live vector-index state: row count plus the index's indexed/unindexed
   *  split (rows appended since the last optimize() are unindexed and served by
   *  brute-force scan). Null when there is no table. */
  async vectorIndexState(): Promise<VectorIndexState | null> {
    if (!this.table) return null;
    const rowCount: number = await this.table.countRows();
    const existing = await this.vectorIndexConfig();
    if (!existing) return { rowCount, index: null };
    const stats = await this.table.indexStats(existing.name);
    return {
      rowCount,
      index: {
        name: existing.name,
        indexType: stats?.indexType ?? 'unknown',
        numIndexedRows: stats?.numIndexedRows ?? 0,
        numUnindexedRows: stats?.numUnindexedRows ?? 0,
      },
    };
  }

  /** Insert or replace chunks with embeddings */
  async upsertChunks(chunks: Array<CodeChunk & { embedding: number[] }>): Promise<void> {
    // Map chunks to flat row objects for LanceDB
    const rows = chunks.map((c) => ({
      id: c.id,
      vector: c.embedding, // LanceDB uses 'vector' field for embeddings
      content: c.content,
      contextualizedContent: c.contextualizedContent,
      contentSplit: identifierParts(c.contextualizedContent),
      contentHash: contentHash(c.contextualizedContent),
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
      await this.ensureColumns();
      // Replace rows with the given ids, keep everything else.
      await this.deleteChunksByIds(rows.map((r) => r.id));
      await this.table.add(rows);
    }
    await this.ensureFtsIndex();
  }

  /** Semantic vector search */
  async vectorSearch(
    queryEmbedding: number[],
    opts?: {
      limit?: number;
      filter?: string;
      /** Probe count for this query only (calibration). */
      nprobes?: number;
    },
  ): Promise<ScoredChunk[]> {
    if (!this.table) return [];
    // nprobes = IVF partitions scanned per query (no-op on a flat/un-indexed
    // table). Higher = better recall, more work. Precedence: this call's
    // value, `indexConfig` (IVF_PQ / S3 deployments), the env override, the
    // writer-calibrated value, the default.
    // refineFactor (IVF_PQ only) re-ranks the top nprobes·refine candidates
    // with exact distance against the retained raw vectors (ADR §5.5).
    let query = this.table
      .search(queryEmbedding)
      .select([...CHUNK_COLUMNS, '_distance'])
      .limit(opts?.limit ?? 20)
      .nprobes(opts?.nprobes ?? this.indexConfig?.nprobes ?? ENV_NPROBES ?? this.calibratedNprobes ?? DEFAULT_NPROBES);
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
  async vectorSearchIds(queryEmbedding: number[], k: number, nprobes?: number): Promise<string[]> {
    const results = await this.vectorSearch(queryEmbedding, { limit: k, nprobes });
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
      // Apply the same repo filter as vectorSearch — without it, BM25 results
      // leak across repos even when the caller scoped to specific repos.
      const run = (q: any) => (filter ? q.where(filter) : q).toArray();
      // FTS rows carry `_score` on this binding (0.27.x); `_relevance_score`
      // is the legacy field name — reading only that flattened every BM25
      // score to the 0.5 fallback.
      const score = (r: any): number => r._score ?? r._relevance_score ?? 0.5;
      // Words containing '_' are already split into terms on the original
      // column; sending them to the split column too would count them again
      // for camelCase spellings of the same words (TRIGGER_TO_WEB_TYPE vs
      // triggerToWebType) and outrank the definition.
      const splitQuery = splitIdentifiers(queryText.replace(/[A-Za-z0-9]*_[A-Za-z0-9_]*/g, ' '));
      const useSplit = /[A-Za-z0-9]/.test(splitQuery) && (await this.hasIndex('contentSplit_idx'));
      const original = run(this.table.search(queryText, 'fts', 'contextualizedContent').select(FTS_COLUMNS).limit(limit));
      let results: Array<{ row: any; score: number }>;
      if (useSplit) {
        // Original tokens on the original column, identifier parts on the
        // split column; a row's score is the sum. An exact identifier keeps
        // its rare full token, and "expected backlog count" also reaches
        // `verifyExpectedBacklogCount`. Two searches, not one BooleanQuery:
        // that cost ~1.5× their sum at 1M rows. A single identifier matches
        // by parts only where all of them occur — `getUserById` reaches
        // `getUserByIdOrThrow`, not every row with a `get…` and an `…Id`.
        const { MatchQuery, Operator } = await import('@lancedb/lancedb');
        const single = !/\s/.test(queryText.trim());
        const [a, b] = await Promise.all([
          original,
          run(this.table.query()
            .fullTextSearch(new MatchQuery(splitQuery, 'contentSplit', single ? { operator: Operator.And } : undefined))
            .select(FTS_COLUMNS)
            .limit(limit)),
        ]);
        const byId = new Map<string, { row: any; score: number }>();
        for (const r of [...a, ...b]) {
          const hit = byId.get(r.id);
          if (hit) hit.score += score(r);
          else byId.set(r.id, { row: r, score: score(r) });
        }
        results = [...byId.values()].sort((x, y) => y.score - x.score).slice(0, limit);
      } else {
        results = (await original).map((r: any) => ({ row: r, score: score(r) }));
      }
      return results.map(({ row, score: s }) => ({
        chunk: rowToChunk(row),
        score: s,
        source: 'bm25' as const,
      }));
    } catch {
      // FTS index may not exist
      return [];
    }
  }

  /** Use the writer-calibrated probe count (vector_index.json) for queries. */
  setCalibratedNprobes(nprobes: number | undefined): void {
    this.calibratedNprobes = nprobes && nprobes > 0 ? nprobes : undefined;
  }

  private async hasIndex(name: string): Promise<boolean> {
    this.indexNames ??= (async () => {
      const indexes: Array<{ name: string }> = await this.table.listIndices();
      return new Set(indexes.map((i) => i.name));
    })().catch(() => new Set<string>());
    return (await this.indexNames).has(name);
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
      const results = await this.table.query().where(where).select(CHUNK_COLUMNS).limit(limit).toArray();
      return results.map((r: any) => ({
        chunk: rowToChunk(r),
        score: 1,
        source: 'exact' as const,
      }));
    } catch {
      return [];
    }
  }

  /** Substring symbol lookup: chunks whose entityName CONTAINS the query,
   *  case-insensitively — the Zoekt-style partial-identifier tier
   *  (`SearchResponse` finds `CompanySearchResponse`). Candidates come from
   *  the entity-name trigram index (rows holding every trigram of the query,
   *  shorter names first), kept if they contain the query; a table without
   *  that index yet, or a query under 3 chars, scans with ILIKE instead —
   *  ~140ms at 1.15M rows, the slowest search tier before the index. Results
   *  ranked exact > prefix > infix, then shorter names (tighter match) first. */
  async searchByEntitySubstring(query: string, limit: number = 20, filter?: string): Promise<ScoredChunk[]> {
    if (!this.table || query.length === 0) return [];
    const q = query.toLowerCase();
    try {
      // Over-fetch so the JS ranking below sees enough candidates to prefer
      // exact/prefix matches over incidental infix hits.
      let rows: any[];
      if (query.length >= 3 && (await this.hasIndex('entityName_ngram_idx'))) {
        const { MatchQuery, Operator } = await import('@lancedb/lancedb');
        let fq = this.table.query()
          .fullTextSearch(new MatchQuery(query, 'entityName', { operator: Operator.And }))
          .select(FTS_COLUMNS)
          .limit(limit * 4);
        if (filter) fq = fq.where(filter);
        rows = (await fq.toArray()).filter((r: any) => (r.entityName ?? '').toLowerCase().includes(q));
      } else {
        const esc = query.replace(/'/g, "''").replace(/([%_\\])/g, '\\$1');
        const cond = `entityName ILIKE '%${esc}%'`;
        rows = await this.table.query()
          .where(filter ? `(${cond}) AND (${filter})` : cond)
          .select(CHUNK_COLUMNS)
          .limit(limit * 4)
          .toArray();
      }
      const rank = (name: string): number => {
        const n = name.replace(/\$\d+$/, '').toLowerCase();
        if (n === q) return 0;
        if (n.startsWith(q) || n.endsWith(q)) return 1;
        return 2;
      };
      return rows
        .map((r: any) => ({ row: r, r: rank(r.entityName ?? ''), len: (r.entityName ?? '').length }))
        .sort((a: any, b: any) => a.r - b.r || a.len - b.len)
        .slice(0, limit)
        .map(({ row, r }: any) => ({
          chunk: rowToChunk(row),
          score: 1 - r * 0.2,
          source: 'exact' as const,
        }));
    } catch {
      return [];
    }
  }

  /** Exact-phrase search over the code text (tantivy PhraseQuery) — multi-token
   *  literals (error strings, exact statements) match as an adjacent phrase
   *  instead of a bag of tokens. Requires the FTS index built withPosition;
   *  until the next reindex provides that, this returns [] (non-fatal). */
  async phraseSearch(queryText: string, limit: number = 20, filter?: string): Promise<ScoredChunk[]> {
    if (!this.table) return [];
    try {
      const lancedb = await import('@lancedb/lancedb');
      const pq = new (lancedb as any).PhraseQuery(queryText, 'contextualizedContent');
      let q = this.table.query().fullTextSearch(pq).select(FTS_COLUMNS).limit(limit);
      if (filter) q = q.where(filter);
      const results = await q.toArray();
      return results.map((r: any) => ({
        chunk: rowToChunk(r),
        score: r._score ?? r._relevance_score ?? 0.5,
        source: 'phrase' as const,
      }));
    } catch {
      // PhraseQuery unavailable (old binding) or index lacks positions — no-op.
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
      const results = await this.table.query().where(filter).select(CHUNK_COLUMNS).toArray();
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
      if (!l.entityName) return `(${base})`;
      // `Class.member` (graph node ids) → that class's member chunk.
      const dot = l.entityName.lastIndexOf('.');
      const member = dot > 0
        ? ` OR (entityName = '${esc(l.entityName.slice(dot + 1))}' AND parentEntity = '${esc(l.entityName.slice(0, dot))}')`
        : '';
      return `(${base} AND (entityName = '${esc(l.entityName)}'${member}))`;
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
        batches.map((batch) => this.table.query().where(batch).select(CHUNK_COLUMNS).limit(batchSize * 2).toArray()),
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
    // Batched IN-lists: each delete is one table commit, so the batch bounds
    // both the filter length and the commit count (a full id sweep can be
    // hundreds of thousands of ids).
    const batchSize = 1000;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const filter = `id IN (${batch.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')})`;
      try {
        await this.table.delete(filter);
      } catch { /* ok if chunk doesn't exist */ }
    }
  }

  /** Get all chunk IDs for a project (for incremental diff) */
  /** Ids of the project's rows — of `repoNames` only, when given. */
  async getChunkIds(project: string, repoNames?: string[]): Promise<string[]> {
    if (!this.table) return [];
    const esc = (s: string) => s.replace(/'/g, "''");
    const base = `project = '${esc(project)}'`;
    // repoName is bitmap-indexed; batches keep each IN-list short.
    const filters = repoNames
      ? Array.from({ length: Math.ceil(repoNames.length / 200) }, (_, i) =>
          `${base} AND repoName IN (${repoNames.slice(i * 200, i * 200 + 200).map((n) => `'${esc(n)}'`).join(', ')})`)
      : [base];
    try {
      const ids: string[] = [];
      for (const where of filters) {
        for (const r of await this.table.query().where(where).select(['id']).toArray()) ids.push(r.id as string);
      }
      return ids;
    } catch {
      return [];
    }
  }

  /** Delete every row of `repoNames` (repos dropped from the index). */
  async deleteRepoRows(project: string, repoNames: string[]): Promise<void> {
    if (!this.table || repoNames.length === 0) return;
    const esc = (s: string) => s.replace(/'/g, "''");
    for (let i = 0; i < repoNames.length; i += 200) {
      const names = repoNames.slice(i, i + 200).map((n) => `'${esc(n)}'`).join(', ');
      await this.table.delete(`project = '${esc(project)}' AND repoName IN (${names})`);
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
    try {
      await this.table.delete(fileRowsFilter(project, repoName, filePaths));
    } catch {
      /* ok if empty */
    }
  }

  /** (id, contentHash) of every row of the given files. Write path only. */
  async getFileRowHashes(project: string, repoName: string, filePaths: string[]): Promise<Array<{ id: string; contentHash: string }>> {
    if (!this.table || filePaths.length === 0) return [];
    await this.ensureColumns();
    const rows = await this.table.query()
      .where(fileRowsFilter(project, repoName, filePaths))
      .select(['id', 'contentHash'])
      .toArray();
    return rows.map((r: any) => ({ id: r.id, contentHash: r.contentHash }));
  }

  /** A vector for each of `hashes` that some row's contentHash equals — the
   *  embedding of that exact text, for reuse instead of a provider call.
   *  BTREE-indexed (ensureScalarIndexes). Write path only. */
  async getVectorsByContentHash(hashes: string[]): Promise<Map<string, number[]>> {
    const found = new Map<string, number[]>();
    if (!this.table || hashes.length === 0) return found;
    await this.ensureColumns();
    const batchSize = 1000;
    for (let i = 0; i < hashes.length; i += batchSize) {
      const batch = hashes.slice(i, i + batchSize).filter((h) => /^[0-9a-f]{64}$/.test(h));
      if (batch.length === 0) continue;
      const rows = await this.table.query()
        .where(`contentHash IN (${batch.map((h) => `'${h}'`).join(', ')})`)
        .select(['contentHash', 'vector'])
        .toArray();
      for (const r of rows) if (!found.has(r.contentHash)) found.set(r.contentHash, Array.from(r.vector as ArrayLike<number>));
    }
    return found;
  }

  /** Delete exactly these rows — each matched on id AND contentHash, so a new
   *  row that took over an id (chunk ids are position-keyed) survives. */
  async deleteRows(rows: Array<{ id: string; contentHash: string }>): Promise<void> {
    if (!this.table || rows.length === 0) return;
    const esc = (s: string) => s.replace(/'/g, "''");
    // Each pair is two conditions; Lance rejects a filter with more than 500.
    const batchSize = 200;
    for (let i = 0; i < rows.length; i += batchSize) {
      const filter = rows.slice(i, i + batchSize)
        .map((r) => `(id = '${esc(r.id)}' AND contentHash = '${esc(r.contentHash)}')`)
        .join(' OR ');
      await this.table.delete(filter);
    }
  }

  /** Add chunks without deleting existing project data (for incremental updates).
   *  Pass { skipIndex: true } to skip the ensureFtsIndex() check; the caller
   *  must then call it once after the final batch. */
  async addChunks(chunks: Array<CodeChunk & { embedding: number[] }>, opts?: { skipIndex?: boolean }): Promise<void> {
    if (chunks.length === 0) return;
    const rows = chunks.map((c) => ({
      id: c.id,
      vector: c.embedding,
      content: c.content,
      contextualizedContent: c.contextualizedContent,
      contentSplit: identifierParts(c.contextualizedContent),
      contentHash: contentHash(c.contextualizedContent),
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
      await this.ensureColumns();
      await this.table.add(rows);
    }
    if (!opts?.skipIndex) {
      await this.ensureFtsIndex();
    }
  }
}

/** ADR §3 canonical name for the default LanceDB-backed `VectorStorePort`
 *  adapter. Alias for now; a later phase renames the class outright. */
export { VectorStore as LanceVectorStore };

/** Predicate for every row of the given files of one repo. */
function fileRowsFilter(project: string, repoName: string, filePaths: string[]): string {
  const esc = (s: string) => s.replace(/'/g, "''");
  const files = filePaths.map((f) => `'${esc(f)}'`).join(', ');
  return `project = '${esc(project)}' AND repoName = '${esc(repoName)}' AND filePath IN (${files})`;
}

/** The columns rowToChunk reads: what a search fetches — not the vector or
 *  the derived columns (5–11% of a query's CPU at 1M rows). */
const CHUNK_COLUMNS = [
  'id', 'filePath', 'repoName', 'project', 'startLine', 'endLine', 'content', 'contextPrefix',
  'contextualizedContent', 'language', 'entityType', 'entityName', 'parentEntity', 'tokens',
];
/** Full-text searches name their score column too (omitting it is deprecated). */
const FTS_COLUMNS = [...CHUNK_COLUMNS, '_score'];

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
