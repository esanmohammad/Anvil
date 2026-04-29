/**
 * `HybridMemoryStore` — orchestrates the JSONL canonical archive + the
 * SQLite hot index per ADR §M1.
 *
 * Write path: every `add` writes to JSONL first (durable, auditable), then
 * upserts into SQLite (hot index). If the SQLite write fails, the JSONL
 * append still succeeded — `rebuildIndexFromJsonl` reconciles.
 *
 * Read path: all queries hit SQLite for indexed performance.
 *
 * Auto-rebuild: when opening with an existing JSONL file but a fresh SQLite
 * (count == 0 vs jsonl > 0), the constructor automatically rebuilds the
 * hot index. A single stderr warning informs the user.
 */

import { JsonlAppendLog } from './jsonl-store.js';
import { SqliteHotIndex, type SearchOpts } from './sqlite-store.js';
import type { Memory } from '../types.js';

export interface OpenHybridOptions {
  jsonlPath: string;
  sqlitePath: string;
  /** Skip the auto-rebuild on open (useful for tests). */
  skipAutoRebuild?: boolean;
}

export interface RebuildResult {
  count: number;
  durationMs: number;
}

export class HybridMemoryStore {
  readonly jsonl: JsonlAppendLog;
  readonly sqlite: SqliteHotIndex;

  constructor(jsonl: JsonlAppendLog, sqlite: SqliteHotIndex) {
    this.jsonl = jsonl;
    this.sqlite = sqlite;
  }

  /**
   * Factory: opens the pair and (unless `skipAutoRebuild`) rebuilds the
   * hot index when the JSONL has data but SQLite is empty.
   */
  static open(opts: OpenHybridOptions): HybridMemoryStore {
    const jsonl = new JsonlAppendLog(opts.jsonlPath);
    const sqlite = new SqliteHotIndex(opts.sqlitePath);
    const store = new HybridMemoryStore(jsonl, sqlite);
    if (!opts.skipAutoRebuild && jsonl.exists() && sqlite.count() === 0) {
      const records = jsonl.readAll();
      if (records.length > 0) {
        process.stderr.write(
          `[anvil-memory] rebuilding SQLite hot index from ${opts.jsonlPath} (${records.length} entries)…\n`,
        );
        store.rebuildIndexFromJsonl();
      }
    }
    return store;
  }

  /** Append to JSONL canonical, then upsert into SQLite hot index. */
  add(m: Memory): void {
    this.jsonl.append(m);
    this.sqlite.upsert(m);
  }

  findById(id: string): Memory | null {
    return this.sqlite.findById(id);
  }

  searchByTags(tags: string[], opts?: SearchOpts): Memory[] {
    return this.sqlite.searchByTags(tags, opts);
  }

  searchByText(query: string, opts?: SearchOpts): Memory[] {
    return this.sqlite.searchByText(query, opts);
  }

  validAtTime(at: string, opts?: SearchOpts): Memory[] {
    return this.sqlite.validAtTime(at, opts);
  }

  pruneExpired(now?: string): number {
    return this.sqlite.pruneExpired(now);
  }

  /**
   * Drop every memory row + tag + FTS row, then re-upsert each line of the
   * JSONL canonical. JSONL is unchanged. Returns `{count, durationMs}`.
   */
  rebuildIndexFromJsonl(): RebuildResult {
    const start = Date.now();
    const records = this.jsonl.readAll();
    const tx = this.sqlite.db.transaction(() => {
      this.sqlite.db.exec(`DELETE FROM memory; DELETE FROM memory_tag; DELETE FROM memory_fts;`);
      for (const m of records) {
        this.sqlite.upsert(m);
      }
    });
    tx();
    return { count: records.length, durationMs: Date.now() - start };
  }

  close(): void {
    this.sqlite.close();
  }
}
