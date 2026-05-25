/**
 * `embedMemory` / `embedMemoriesBatch` — write per-memory embeddings to the
 * LanceDB vector store.
 *
 * Callers (sleeptime backfill, on-write embedding) invoke these with an
 * `Embedder` reachable via `getEmbedder()`. The store's vector layer is
 * optional — if LanceDB isn't installed, both helpers no-op so the
 * rest of the pipeline keeps working. Likewise if no embedder has been
 * injected via `setEmbedder`.
 *
 * The result reports how many memories were embedded vs skipped (vector
 * store unavailable, embedder missing, empty content).
 */

import { namespaceToRelativePath } from './namespace/path-resolver.js';
import { getEmbedder } from './storage/vector-store.js';
import type { HybridMemoryStore } from './storage/hybrid-store.js';
import type { Memory } from './types.js';

export interface EmbedResult {
  embedded: number;
  skipped: number;
  reason?: string;
}

function memoryAsText(m: Memory): string {
  const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  const tagTail = (m.tags ?? []).length > 0 ? ` ${m.tags.join(' ')}` : '';
  return `${text}${tagTail}`.trim();
}

export async function embedMemory(
  store: HybridMemoryStore,
  memory: Memory,
): Promise<EmbedResult> {
  const embedder = getEmbedder();
  const vectorStore = store.vectorStore;
  if (!embedder) return { embedded: 0, skipped: 1, reason: 'no-embedder' };
  if (!vectorStore) return { embedded: 0, skipped: 1, reason: 'no-vector-store' };
  const text = memoryAsText(memory);
  if (!text) return { embedded: 0, skipped: 1, reason: 'empty-content' };

  await vectorStore.init();
  if (!vectorStore.isAvailable()) {
    return { embedded: 0, skipped: 1, reason: 'lancedb-unavailable' };
  }

  let vec: number[];
  try {
    vec = await embedder(text);
  } catch (err) {
    return {
      embedded: 0,
      skipped: 1,
      reason: `embed-failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  await vectorStore.upsert({
    id: memory.id,
    vector: vec,
    namespacePath: namespaceToRelativePath(memory.namespace),
    kind: memory.kind,
    subtype: memory.subtype ?? '',
  });
  return { embedded: 1, skipped: 0 };
}

/**
 * Embed up to `opts.limit` memories that don't yet have a row in the
 * vector store. Iterates the SQLite index in id-order (ULIDs ⇒
 * chronological) so the oldest unembedded entries land first.
 *
 * Best-effort: any single embed failure increments `skipped` and the
 * loop continues. Returns aggregate counts.
 */
export async function embedMemoriesBatch(
  store: HybridMemoryStore,
  opts: { limit?: number } = {},
): Promise<EmbedResult> {
  const embedder = getEmbedder();
  const vectorStore = store.vectorStore;
  if (!embedder) return { embedded: 0, skipped: 0, reason: 'no-embedder' };
  if (!vectorStore) return { embedded: 0, skipped: 0, reason: 'no-vector-store' };
  await vectorStore.init();
  if (!vectorStore.isAvailable()) {
    return { embedded: 0, skipped: 0, reason: 'lancedb-unavailable' };
  }

  // Identify memories not yet embedded: ask the vector store for the set
  // of known ids, diff against the SQLite memory ids. For a first cut
  // we read the latest 500 memories and skip any already in vector store.
  // (Phase 3 sleeptime backfill bounds this further by tick.)
  const candidates = store.sqlite.recentForBackfill(opts.limit ?? 100);

  let embedded = 0;
  let skipped = 0;
  for (const m of candidates) {
    try {
      const r = await embedMemory(store, m);
      embedded += r.embedded;
      skipped += r.skipped;
    } catch {
      skipped += 1;
    }
  }
  return { embedded, skipped };
}
