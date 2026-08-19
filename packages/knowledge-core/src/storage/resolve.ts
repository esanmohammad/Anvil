/**
 * resolveStorage — the single factory that reads `config.storage` and builds
 * the three port adapters (ADR §2, decision 4). The only place backend
 * selection happens; every consumer takes the resolved bundle, never a raw
 * path or `new VectorStore(...)`.
 *
 * P0 implements the local defaults only (fs / lancedb / sqlite) — the exact
 * behavior of today. `s3` / `mongo` backends are added in P1/P2; selecting one
 * now throws a clear, actionable error rather than silently falling back.
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { KnowledgeConfig } from '../config.js';
import type { CodeChunk } from '../types.js';
import { getKnowledgeBasePath } from '../config.js';
import { VectorStore } from '../vector-store.js';
import { openSystemGraphStore } from '../graph-store.js';
import { FsBlobStore } from './fs-blob-store.js';
import { MongoBlobStore } from './mongo-blob-store.js';
import type { StorageBundle, BlobStorePort, GraphStorePort } from './ports.js';

function notYet(concern: string, backend: string): never {
  throw new Error(
    `[knowledge-core] storage.${concern}.backend='${backend}' is not implemented yet ` +
      `(P0 supports the local defaults: blob=fs, vector=lancedb, graph=sqlite). ` +
      `Unset storage.${concern} to use the default, or wait for the P1/P2 adapter.`,
  );
}

/**
 * Build the storage bundle for a project. With `config.storage` unset (or all
 * backends at their defaults) this is byte-for-byte today's wiring:
 *   - blobs  → FsBlobStore at getKnowledgeBasePath(project)
 *   - vectors→ LanceVectorStore at <basePath>/lancedb
 *   - graph  → openSystemGraphStore(<basePath>) (sqlite, JSON fallback)
 */
export function resolveStorage(project: string, config?: KnowledgeConfig): StorageBundle {
  const storage = config?.storage;

  const basePath = storage?.blob?.basePath ?? getKnowledgeBasePath(project);

  // 'fs' (default) and 'mongo' (P2) are implemented; 's3' blobs are not yet.
  const blobBackend = storage?.blob?.backend ?? 'fs';
  let blobs: BlobStorePort;
  if (blobBackend === 'fs') {
    blobs = new FsBlobStore(basePath);
  } else if (blobBackend === 'mongo') {
    if (!storage?.blob?.mongo?.uri || !storage.blob.mongo.db) {
      throw new Error(
        "[knowledge-core] storage.blob.backend='mongo' requires storage.blob.mongo { uri, db }.",
      );
    }
    blobs = new MongoBlobStore(project, storage.blob.mongo);
  } else {
    notYet('blob', blobBackend); // 's3'
  }

  // 'lancedb' (default) serves BOTH local dirs and s3:// (MinIO/S3, Topology B).
  // Only 'mongo' vectors are unimplemented.
  const vectorBackend = storage?.vector?.backend ?? 'lancedb';
  if (vectorBackend === 'mongo') notYet('vector', 'mongo');
  const lancedb = storage?.vector?.lancedb;
  const vectorUri = lancedb?.uri ?? join(basePath, 'lancedb');
  const vectorStorageOptions = lanceStorageOptions(lancedb?.s3);
  const vectorCache = lanceCacheBudget(storage?.cache);

  const graphBackend = storage?.graph?.backend ?? 'sqlite';
  if (graphBackend !== 'sqlite') notYet('graph', graphBackend);

  return {
    basePath,
    blobs,
    vectors: new VectorStore(vectorUri, vectorStorageOptions, vectorCache, lancedb?.index),
    graph: async () => {
      if (blobs instanceof FsBlobStore) return openSystemGraphStore(basePath);
      // Non-fs backend: the sqlite system graph is a blob artifact — pull it to
      // the local cache dir and open it there (read-only usage). Re-pulled
      // whenever the retriever rebuilds (invalidate-on-reindex), so readers see
      // the writer's latest graph.
      if (!(await blobs.exists('system_graph.sqlite'))) return null;
      const cacheDir = storage?.cache?.dir
        ? join(storage.cache.dir, project)
        : join(tmpdir(), 'code-search-graph-cache', project);
      mkdirSync(cacheDir, { recursive: true });
      await blobs.getBytes('system_graph.sqlite', { toFile: join(cacheDir, 'system_graph.sqlite') });
      return openSystemGraphStore(cacheDir);
    },
  };
}

/**
 * Map the config's S3/MinIO knobs to LanceDB/object_store `storageOptions`
 * (canonical keys, same set as the documented MinIO example). Access key/secret
 * are NOT placed here — object_store reads them from the environment
 * (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, injected via Vault). Returns
 * undefined for a local store (no s3 block).
 */
export function lanceStorageOptions(
  s3?: { endpoint?: string; region?: string; virtualHostedStyle?: boolean; allowHttp?: boolean },
): Record<string, string> | undefined {
  if (!s3) return undefined;
  const opts: Record<string, string> = {};
  if (s3.endpoint) opts.aws_endpoint = s3.endpoint;
  if (s3.region) opts.aws_region = s3.region;
  if (s3.virtualHostedStyle !== undefined) opts.aws_virtual_hosted_style_request = String(s3.virtualHostedStyle);
  if (s3.allowHttp !== undefined) opts.allow_http = String(s3.allowHttp);
  return Object.keys(opts).length > 0 ? opts : undefined;
}

/**
 * Translate `storage.cache` into a LanceDB in-RAM Session budget (index +
 * metadata cache byte sizes) for `VectorStore`.
 *
 * Reality check (ADR §5.5): the LanceDB Node binding does all object-store I/O
 * inside Rust — the adapter never sees per-fragment reads, so there is no
 * on-disk read-through *fragment* cache to implement here. The binding's only
 * caching lever is an in-memory `Session` (index + metadata caches). So
 * `mode: 'read-through'` (the ADR's disk-mirror idea) is not realizable at this
 * layer and is treated as `'ram'`; a true disk mirror would need an S3 sync of
 * the Lance dataset (deferred, P2-weight).
 *
 * Returns `undefined` ⇒ no custom Session ⇒ LanceDB defaults (≈6 GiB index /
 * 1 GiB metadata), i.e. byte-for-byte today's behavior. A budget is built only
 * on an explicit bounded request (`cache` present, `mode !== 'none'`, positive
 * `maxBytes`). `maxBytes` is the TOTAL RAM budget, split across the two caches
 * so a memory-limited pod stays under its limit.
 */
export function lanceCacheBudget(
  cache?: { maxBytes?: number; mode?: 'read-through' | 'ram' | 'none' },
): { indexCacheBytes: number; metadataCacheBytes: number } | undefined {
  if (!cache || cache.mode === 'none') return undefined;
  const max = cache.maxBytes;
  if (!max || !Number.isFinite(max) || max <= 0) return undefined;
  // Metadata (file/schema) cache is the small one — cap at 25% of the budget
  // or 1 GiB, whichever is less; the index cache (IVF partitions, the bulk) gets
  // the rest. Both together stay ≤ maxBytes.
  const metadataCacheBytes = Math.min(Math.floor(max * 0.25), 1024 ** 3);
  const indexCacheBytes = max - metadataCacheBytes;
  return { indexCacheBytes, metadataCacheBytes };
}

/**
 * Shared, cached system-graph store for a project (ADR §4b / P2c).
 *
 * The per-call pattern (open → query → close) is fine on the fs backend where
 * opening is a local SQLite handle, but on a remote blob backend the bundle's
 * graph thunk DOWNLOADS system_graph.sqlite before opening — per tool call
 * that would re-pull the whole file every time. This memoizes the opened
 * store per (project, blob identity); callers must NOT close() it. Freshness
 * matches the retriever: reindex invalidates via indexer.invalidateRetriever
 * (which calls {@link invalidateGraphStores}); remote read replicas refresh
 * on redeploy, same as the retriever's invalidate-on-reindex contract.
 *
 * A null resolution (KB not built yet) is not pinned — the next call re-checks
 * so readers pick up the graph as soon as the writer publishes it.
 */
const graphStoreCache = new Map<string, Promise<GraphStorePort | null>>();

function graphCacheKey(project: string, config?: KnowledgeConfig): string {
  const b = config?.storage?.blob;
  const id = b?.backend === 'mongo'
    ? `mongo:${b.mongo?.uri}/${b.mongo?.db}`
    : `fs:${b?.basePath ?? getKnowledgeBasePath(project)}`;
  return `${project}::${id}`;
}

export function getGraphStore(project: string, config?: KnowledgeConfig): Promise<GraphStorePort | null> {
  const key = graphCacheKey(project, config);
  let p = graphStoreCache.get(key);
  if (!p) {
    p = resolveStorage(project, config).graph();
    graphStoreCache.set(key, p);
    p.then(
      (store) => { if (!store) graphStoreCache.delete(key); },
      () => graphStoreCache.delete(key),
    );
  }
  return p;
}

/** Close + drop cached graph stores so the next call reopens against fresh
 *  data. No arg = all projects. Called from indexer.invalidateRetriever. */
export async function invalidateGraphStores(project?: string): Promise<void> {
  const entries = [...graphStoreCache.entries()].filter(([k]) => !project || k.startsWith(`${project}::`));
  for (const [k, p] of entries) {
    graphStoreCache.delete(k);
    try { (await p)?.close(); } catch { /* already closed / open failed */ }
  }
}

/**
 * Convenience accessor for consumers that only need the blob port (ADR §2,
 * decision 5 — "code-search-mcp consumes a knowledge-core blob accessor").
 * Resolves against the same base as the rest of the stack (getKnowledgeBasePath
 * unless overridden), so it reads the CODE_SEARCH_DATA_DIR-aware location.
 */
export function getBlobStore(project: string, config?: KnowledgeConfig): BlobStorePort {
  return resolveStorage(project, config).blobs;
}

/**
 * Stream a project's chunks.json through the blob port and return up to `limit`
 * matches, stopping early. Backend-agnostic replacement for the path-based
 * `findChunksInFile` — lets `get_code_snippet` fetch one entity without a raw
 * filesystem read (and without loading millions of chunks).
 */
export async function findChunksInProject(
  project: string,
  match: (c: CodeChunk) => boolean,
  limit: number,
  config?: KnowledgeConfig,
): Promise<CodeChunk[]> {
  const blobs = resolveStorage(project, config).blobs;
  const out: CodeChunk[] = [];
  for await (const c of blobs.iterateNdjson<CodeChunk>('chunks.json')) {
    if (match(c)) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}
