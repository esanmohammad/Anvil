/**
 * On-disk reranker cache (P6).
 *
 * Cross-encoder reranking is the slowest phase of the retrieval pipeline
 * — a single Ollama call per (query, chunk) pair, sequential. The same
 * (query, chunk_id, reranker_model) tuple is asked on every search;
 * memoizing the score is a pure win.
 *
 * Implementation: a small append-only JSON file under `<dataDir>/rerank-
 * cache.json`. Keyed by SHA-256 of `query|chunk_id|model`. LRU eviction
 * on insert (default 50k entries). Survives daemon restarts; invalidated
 * implicitly by chunk-id changes (the chunk's content hash is part of its
 * id at index time).
 *
 * SQLite would be sturdier — but the package has zero runtime deps for
 * persistence today, and 50k entries × ~120 bytes = ~6 MB. Cheap enough.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RerankCacheOpts {
  filePath: string;
  /** Max entries before LRU eviction kicks in. Default 50_000. */
  maxEntries?: number;
}

interface CacheEntry {
  score: number;
  ts: number;
}

export class RerankCache {
  private readonly filePath: string;
  private readonly maxEntries: number;
  private map = new Map<string, CacheEntry>();
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(opts: RerankCacheOpts) {
    this.filePath = opts.filePath;
    this.maxEntries = opts.maxEntries ?? 50_000;
    this.load();
  }

  static keyFor(query: string, chunkId: string, model: string): string {
    return createHash('sha256').update(`${query}\u0000${chunkId}\u0000${model}`).digest('hex');
  }

  get(query: string, chunkId: string, model: string): number | null {
    const key = RerankCache.keyFor(query, chunkId, model);
    const e = this.map.get(key);
    if (!e) return null;
    // Move-to-end for LRU semantics — Map preserves insertion order, and
    // delete+set is O(1).
    this.map.delete(key);
    this.map.set(key, e);
    return e.score;
  }

  set(query: string, chunkId: string, model: string, score: number): void {
    const key = RerankCache.keyFor(query, chunkId, model);
    this.map.delete(key);
    this.map.set(key, { score, ts: Date.now() });
    if (this.map.size > this.maxEntries) {
      const evictCount = this.map.size - this.maxEntries;
      const keys = this.map.keys();
      for (let i = 0; i < evictCount; i++) {
        const k = keys.next().value;
        if (k !== undefined) this.map.delete(k);
      }
    }
    this.scheduleFlush();
  }

  /** Persist immediately. Use sparingly — prefer the scheduled flush. */
  flush(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const obj: Record<string, CacheEntry> = {};
    for (const [k, v] of this.map) obj[k] = v;
    writeFileSync(this.filePath, JSON.stringify(obj));
    this.dirty = false;
  }

  size(): number {
    return this.map.size;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Record<string, CacheEntry>;
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
    } catch {
      // Treat as a cold cache; we'll overwrite on next flush.
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    // Debounce writes — heavy search bursts only re-serialize once a second.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try { this.flush(); } catch { /* ignore */ }
    }, 1000);
    // Don't keep the process alive just for cache flushing.
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }
}
