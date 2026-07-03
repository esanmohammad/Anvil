/**
 * Storage ports (P0 of the storage-abstraction ADR).
 *
 * Three interfaces that knowledge-core's consumers depend on instead of
 * `node:fs` / `new VectorStore(...)` / `openSystemGraphStore(...)` directly.
 * The default adapters (LanceVectorStore, FsBlobStore, SqliteGraphStore)
 * wrap today's behavior exactly — `storage` unset ⇒ no change. Non-default
 * backends (s3 / mongo) are added in P1/P2; see
 * docs/CODE-SEARCH-STORAGE-ABSTRACTION-ADR.md §3 / §4 / §4b.
 */

import type { CodeChunk, ScoredChunk } from '../types.js';
import type { GraphStore } from '../graph-store.js';

/**
 * Vector + FTS port — promoted verbatim from `vector-store.ts:VectorStore`
 * (ADR §3). Every method is already called in production by the indexer and
 * retriever. Filters are SQL-ish strings; each adapter translates.
 */
/**
 * IVF_PQ vector-index params (ADR §5.5 / §6, `storage.vector.lancedb.index`).
 * Build-time: `numPartitions` / `numSubVectors` / `minRows`. Query-time:
 * `nprobes` / `refineFactor`. Omitted ⇒ flat/exact scan (today's behavior).
 */
export interface IvfPqIndexConfig {
  type: 'ivf_pq';
  numPartitions?: number;
  numSubVectors?: number;
  minRows?: number;
  nprobes?: number;
  refineFactor?: number;
}

export interface VectorStorePort {
  init(opts?: { healCorrupt?: boolean }): Promise<void>;
  ensureFtsIndex(): Promise<void>;
  /** (Re)build the vector index (IVF_FLAT default, IVF_PQ when
   *  `storage.vector.lancedb.index` is configured) — write path only. */
  ensureVectorIndex(opts?: { minRows?: number }): Promise<void>;
  /** Build scalar (bitmap/btree) indexes on filterable columns — write path only. */
  ensureScalarIndexes(): Promise<void>;
  /** Fold newly-appended rows into existing indexes (post-incremental-embed). */
  optimizeIndexes(): Promise<void>;
  /** Exact-symbol lookup by entityName (indexed equality) — the literal tier. */
  searchByEntityName(names: string[], limit?: number, filter?: string): Promise<ScoredChunk[]>;
  upsertChunks(chunks: Array<CodeChunk & { embedding: number[] }>): Promise<void>;
  addChunks(chunks: Array<CodeChunk & { embedding: number[] }>, opts?: { skipIndex?: boolean }): Promise<void>;
  vectorSearch(queryEmbedding: number[], opts?: { limit?: number; filter?: string }): Promise<ScoredChunk[]>;
  fullTextSearch(queryText: string, limit?: number, filter?: string): Promise<ScoredChunk[]>;
  getByIds(ids: string[]): Promise<CodeChunk[]>;
  getChunksByEntity(
    lookups: Array<{ repoName: string; filePath: string; entityName?: string }>,
  ): Promise<ScoredChunk[]>;
  getChunksByFile(
    repoName: string,
    filePath: string,
  ): Promise<Array<{ id: string; content: string; entityName: string; tokens: number }>>;
  deleteChunksByIds(ids: string[]): Promise<void>;
  deleteFileChunks(project: string, repoName: string, filePaths: string[]): Promise<void>;
  getChunkIds(project: string): Promise<string[]>;
  getStats(): Promise<{ rowCount: number } | null>;
  hasData(): Promise<boolean>;
}

/**
 * Named-key artifact store (ADR §4). Keys are project-relative POSIX paths
 * (`chunks.json`, `<repo>/graph.json`, `<repo>/index_meta.json`, …) — the
 * same names used on disk today, so `FsBlobStore` is a 1:1 mapping. The
 * streaming NDJSON pair never holds the whole file as one string (the V8
 * `String::kMaxLength` ceiling `chunks.json` can exceed); the binary pair
 * carries `system_graph.sqlite`.
 */
export interface BlobStorePort {
  exists(key: string): Promise<boolean>;
  getJson<T>(key: string): Promise<T | null>;
  putJson(key: string, value: unknown): Promise<void>;
  getText(key: string): Promise<string | null>;
  putText(key: string, text: string): Promise<void>;
  /** Binary artifact (`system_graph.sqlite`). `toFile` materializes it to a
   *  local path so a SQLite reader can open it read-only; else returns the
   *  buffer. Returns null when the key is absent. */
  getBytes(key: string, opts?: { toFile?: string }): Promise<Buffer | string | null>;
  /** Binary write. `Buffer` = bytes; `string` = a local file path to copy in. */
  putBytes(key: string, data: Buffer | string): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /** Streaming NDJSON write — never buffers the whole file. Accepts a sync or
   *  async iterable (an in-memory array or a streamed shard alike). */
  putNdjson(key: string, source: AsyncIterable<unknown> | Iterable<unknown>): Promise<void>;
  /** Streaming NDJSON read — one record at a time (legacy single-array files
   *  are detected and yielded element-by-element by the `fs` adapter). */
  iterateNdjson<T>(key: string): AsyncGenerator<T>;
}

/**
 * Merged-graph slice-query port (ADR §4b) — the existing `GraphStore`
 * interface promoted unchanged. `SqliteGraphStore` already implements it.
 */
export type GraphStorePort = GraphStore;

/**
 * The resolved storage handle every consumer receives from
 * `resolveStorage(project, config)`. `graph` is a thunk because a store may
 * not exist yet (pre-index) — it mirrors `openSystemGraphStore` returning
 * `null`. `basePath` is exposed as a transitional escape hatch for call sites
 * not yet ported off raw paths (removed as the strangler-fig migration
 * completes).
 */
export interface StorageBundle {
  basePath: string;
  vectors: VectorStorePort;
  blobs: BlobStorePort;
  graph: () => Promise<GraphStorePort | null>;
}
