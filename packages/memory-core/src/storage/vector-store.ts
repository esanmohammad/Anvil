/**
 * Memory-vector store — LanceDB-backed semantic recall layer.
 *
 * Each row is `{ id, vector, namespacePath, kind, subtype }` where `id`
 * matches the SQLite memory id (ULID). On query we return only the ids
 * + distances; the consumer (`retrieve/vector.ts`) hydrates full
 * `Memory<T>` records from the SQLite hot index by id. Co-located on
 * disk with the memory store; default path
 * `<dataDir>/memory_vectors.lance`.
 *
 * Embeddings are NOT computed inside this module. Callers supply an
 * embedder via `setEmbedder` (or pass `vector: number[]` directly) so
 * memory-core stays free of LLM/embedding SDK dependencies. Mirrors the
 * `ReflectionInvoker` pattern from `reflect/reflector.ts`.
 *
 * If `@lancedb/lancedb` is not installed, the store is a no-op: writes
 * are dropped, reads return []. This matches the deferred-cost intent —
 * users without LanceDB still see hybrid retrieval working via BM25 +
 * graph paths.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryNamespace } from '../types.js';
import { namespaceToRelativePath } from '../namespace/path-resolver.js';

/** Row shape stored in LanceDB. */
interface MemoryVectorRow {
  id: string;
  vector: number[];
  namespacePath: string;
  kind: string;
  subtype: string;
}

/** Search result. Distance is cosine-like; lower = more similar. */
export interface VectorHit {
  id: string;
  distance: number;
}

export class MemoryVectorStore {
  // Avoid any explicit lancedb type imports so the dep stays optional.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private table: any = null;
  private initialized = false;
  private available = false; // true once we've confirmed lancedb is installed

  constructor(private readonly dbPath: string) {}

  /** Lazy init — first call probes for lancedb. Idempotent. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!existsSync(dirname(this.dbPath))) {
      try { mkdirSync(dirname(this.dbPath), { recursive: true }); }
      catch { /* path already exists or unwritable — fall through */ }
    }
    try {
      const lancedb = await import('@lancedb/lancedb');
      this.db = await lancedb.connect(this.dbPath);
      try {
        this.table = await this.db.openTable('memory_vectors');
      } catch {
        // Table not yet created; first upsert will create it.
      }
      this.available = true;
    } catch {
      // lancedb not installed → no-op mode. Logged once at first call site.
      this.available = false;
    }
  }

  /** True iff LanceDB is installed and `init()` succeeded. */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Upsert one memory's embedding. Delete-then-insert by id to keep this
   * row unique. Cheap operation; designed for incremental backfill.
   */
  async upsert(row: MemoryVectorRow): Promise<void> {
    await this.init();
    if (!this.available) return;
    if (!this.table) {
      this.table = await this.db.createTable('memory_vectors', [row], { mode: 'overwrite' });
      return;
    }
    try {
      await this.table.delete(`id = '${row.id.replace(/'/g, "''")}'`);
    } catch {
      // ok if empty
    }
    await this.table.add([row]);
  }

  /** Bulk upsert. Drops any pre-existing rows by id before insert. */
  async upsertMany(rows: MemoryVectorRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.init();
    if (!this.available) return;
    if (!this.table) {
      this.table = await this.db.createTable('memory_vectors', rows, { mode: 'overwrite' });
      return;
    }
    const ids = rows.map((r) => `'${r.id.replace(/'/g, "''")}'`).join(',');
    try { await this.table.delete(`id IN (${ids})`); } catch { /* ok */ }
    await this.table.add(rows);
  }

  /**
   * Cosine-equivalent nearest-neighbor search. Returns ids + distances.
   * `namespace` filter narrows to `kind` + `namespacePath` prefix match.
   */
  async search(opts: {
    vector: number[];
    namespace?: MemoryNamespace;
    limit?: number;
  }): Promise<VectorHit[]> {
    await this.init();
    if (!this.available || !this.table) return [];
    const limit = opts.limit ?? 20;
    try {
      let q = this.table.search(opts.vector).limit(limit);
      if (opts.namespace) {
        const prefix = namespaceToRelativePath(opts.namespace);
        q = q.where(`namespacePath = '${prefix.replace(/'/g, "''")}'`);
      }
      const rows = await q.toArray();
      return rows.map((r: { id: string; _distance?: number; distance?: number }) => ({
        id: r.id,
        distance: r._distance ?? r.distance ?? 0,
      }));
    } catch {
      // Table empty / shape mismatch / etc → no hits.
      return [];
    }
  }

  /** Delete vector rows by id. Used when a memory is hard-deleted. */
  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.init();
    if (!this.available || !this.table) return;
    const quoted = ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(',');
    try { await this.table.delete(`id IN (${quoted})`); } catch { /* ok */ }
  }
}

// ── Embedder injection ────────────────────────────────────────────────────

/** Embed a string into a fixed-dim vector. Caller-injected. */
export type Embedder = (text: string) => Promise<number[]>;

let embedder: Embedder | null = null;

/**
 * Inject the embedder used by `vectorSearch` (for query embeddings) and
 * `embedMemory` (for backfill). Once set, hybrid retrieval automatically
 * routes vector queries through this function. Without an embedder
 * configured, `vectorSearch` returns [] (legacy no-op behavior).
 */
export function setEmbedder(e: Embedder | null): void {
  embedder = e;
}

export function getEmbedder(): Embedder | null {
  return embedder;
}
