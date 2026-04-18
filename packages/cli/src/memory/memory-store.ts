// Memory store — Section A.5

import { join } from 'node:path';
import type { MemoryEntry, MemoryKind, MemoryQueryOpts, MemoryStoreConfig } from './types.js';
import { readJSONL, appendJSONL, writeJSONL } from './jsonl.js';

const MEMORIES_FILE = 'memories.jsonl';

export class MemoryStore {
  readonly config: MemoryStoreConfig;
  private get filePath(): string {
    return join(this.config.path, MEMORIES_FILE);
  }

  constructor(config: MemoryStoreConfig) {
    this.config = config;
  }

  /** Add a memory entry */
  add(entry: MemoryEntry): void {
    appendJSONL(this.filePath, entry);
  }

  /** List all entries, optionally filtered by kind */
  list(kind?: MemoryKind): MemoryEntry[] {
    const entries = readJSONL<MemoryEntry>(this.filePath);
    if (kind) {
      return entries.filter((e) => e.kind === kind);
    }
    return entries;
  }

  /** Query entries with filters */
  query(opts: MemoryQueryOpts): MemoryEntry[] {
    let entries = this.list(opts.kind);

    if (opts.tags && opts.tags.length > 0) {
      entries = entries.filter((e) =>
        opts.tags!.some((tag) => e.tags.includes(tag)),
      );
    }

    if (opts.minConfidence !== undefined) {
      entries = entries.filter((e) => e.confidence >= opts.minConfidence!);
    }

    if (opts.search) {
      const lower = opts.search.toLowerCase();
      entries = entries.filter((e) =>
        e.content.toLowerCase().includes(lower),
      );
    }

    if (opts.limit !== undefined) {
      entries = entries.slice(0, opts.limit);
    }

    return entries;
  }

  /** Remove an entry by ID */
  remove(id: string): boolean {
    const entries = this.list();
    const filtered = entries.filter((e) => e.id !== id);
    if (filtered.length === entries.length) return false;
    writeJSONL(this.filePath, filtered);
    return true;
  }

  /** Clear all entries */
  clear(): void {
    writeJSONL(this.filePath, []);
  }

  /** Overwrite all entries (used by pruning) */
  replaceAll(entries: MemoryEntry[]): void {
    writeJSONL(this.filePath, entries);
  }
}
