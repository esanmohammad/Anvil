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
import type { Memory, MemoryNamespace } from '../types.js';

/**
 * Phase 4 (plan §4.2.2) namespace-scoped query options. A `query(ns, opts)`
 * call must restrict to memories whose namespace matches `ns` exactly on
 * every defined field — undefined fields are wildcards, just like the
 * underlying `SearchOpts.namespace` filter, but with `ns` provided
 * up-front so callers can't forget.
 */
export interface NamespaceQueryOpts {
  /** Filter by tags (OR semantics, like SqliteHotIndex.searchByTags). */
  tags?: string[];
  /** FTS5 BM25-ranked text search. */
  text?: string;
  /** Bi-temporal slice: memories valid at this ISO timestamp. */
  validAt?: string;
  /** Max rows to return. */
  limit?: number;
}

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
   * Phase 4 namespace-scoped read. Picks one of the underlying
   * SqliteHotIndex queries based on which `opts` field is set, applying
   * the namespace filter to every candidate path. Precedence: `text` →
   * `tags` → `validAt` → "all in namespace".
   */
  query(ns: MemoryNamespace, opts: NamespaceQueryOpts = {}): Memory[] {
    const search: SearchOpts = { limit: opts.limit, namespace: ns };
    if (opts.text && opts.text.trim().length > 0) {
      return this.sqlite.searchByText(opts.text, search);
    }
    if (opts.tags && opts.tags.length > 0) {
      return this.sqlite.searchByTags(opts.tags, search);
    }
    if (opts.validAt) {
      return this.sqlite.validAtTime(opts.validAt, search);
    }
    return this.allInNamespace(ns, opts.limit);
  }

  /**
   * Cross-namespace admin query — same shape as `query` but skips the
   * namespace filter. Use for migrations, dashboards, and `--scope=*`
   * cli flags.
   */
  queryAll(opts: NamespaceQueryOpts = {}): Memory[] {
    const search: SearchOpts = { limit: opts.limit };
    if (opts.text && opts.text.trim().length > 0) {
      return this.sqlite.searchByText(opts.text, search);
    }
    if (opts.tags && opts.tags.length > 0) {
      return this.sqlite.searchByTags(opts.tags, search);
    }
    if (opts.validAt) {
      return this.sqlite.validAtTime(opts.validAt, search);
    }
    return this.allInNamespace(undefined, opts.limit);
  }

  private allInNamespace(ns: MemoryNamespace | undefined, limit?: number): Memory[] {
    const conds: string[] = [];
    const bind: unknown[] = [];
    if (ns) {
      conds.push('namespace_scope = ?');
      bind.push(ns.scope);
      if (ns.projectId) {
        conds.push('namespace_project = ?');
        bind.push(ns.projectId);
      }
      if (ns.repoId) {
        conds.push('namespace_repo = ?');
        bind.push(ns.repoId);
      }
      if (ns.userId) {
        conds.push('namespace_user = ?');
        bind.push(ns.userId);
      }
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const limitClause = limit ? `LIMIT ${Number(limit) | 0}` : '';
    const sql = `SELECT id FROM memory ${where} ORDER BY confidence DESC, last_accessed DESC ${limitClause}`;
    const rows = this.sqlite.db.prepare(sql).all(...bind) as Array<{ id: string }>;
    const out: Memory[] = [];
    for (const { id } of rows) {
      const m = this.sqlite.findById(id);
      if (m) out.push(m);
    }
    return out;
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
