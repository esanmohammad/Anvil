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
import {
  HardRejectError,
  scrub,
  type ScrubOptions,
  type ScrubResult,
} from '../scrubber/index.js';
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
  /**
   * If true, includes rows whose `invalid_at` is set (Phase 5).
   * Defaults to `false` — invalidated rows are hidden from normal queries.
   * Use for audit / admin paths only.
   */
  includeInvalidated?: boolean;
}

export interface OpenHybridOptions {
  jsonlPath: string;
  sqlitePath: string;
  /** Skip the auto-rebuild on open (useful for tests). */
  skipAutoRebuild?: boolean;
  /**
   * Phase 7 scrubber overrides — applied to every `add()` payload before
   * it reaches JSONL or SQLite. Defaults to env-derived behavior
   * (`ANVIL_MEMORY_SCRUB=1` regex; `=0` off; `=llm` regex+classifier).
   */
  scrubber?: ScrubOptions;
}

export interface RebuildResult {
  count: number;
  durationMs: number;
}

export class HybridMemoryStore {
  readonly jsonl: JsonlAppendLog;
  readonly sqlite: SqliteHotIndex;
  readonly scrubberOpts: ScrubOptions | undefined;

  constructor(
    jsonl: JsonlAppendLog,
    sqlite: SqliteHotIndex,
    scrubberOpts?: ScrubOptions,
  ) {
    this.jsonl = jsonl;
    this.sqlite = sqlite;
    this.scrubberOpts = scrubberOpts;
  }

  /**
   * Factory: opens the pair and (unless `skipAutoRebuild`) rebuilds the
   * hot index when the JSONL has data but SQLite is empty.
   */
  static open(opts: OpenHybridOptions): HybridMemoryStore {
    const jsonl = new JsonlAppendLog(opts.jsonlPath);
    const sqlite = new SqliteHotIndex(opts.sqlitePath);
    const store = new HybridMemoryStore(jsonl, sqlite, opts.scrubber);
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

  /**
   * Append to JSONL canonical, then upsert into SQLite hot index.
   *
   * Phase 7 scrubber: every payload is scrubbed before write. PII
   * patterns are redacted in place; credential-class patterns hard-
   * reject the write via `HardRejectError` (callers must catch).
   * Returns the scrub report so auto-learners can log redactions.
   */
  add(m: Memory): ScrubResult | null {
    const result = this.scrubMemory(m);
    if (result?.hardReject) {
      throw new HardRejectError(
        `memory ${m.id} rejected: matched credential rules ${result.redactions
          .filter((r) => r.category === 'credential')
          .map((r) => r.rule)
          .join(', ')}`,
        result.redactions,
      );
    }
    const cleaned = result ? this.applyScrubResult(m, result) : m;
    this.jsonl.append(cleaned);
    this.sqlite.upsert(cleaned);
    return result;
  }

  private scrubMemory(m: Memory): ScrubResult | null {
    const text = typeof m.content === 'string' ? m.content : safeStringify(m.content);
    if (!text) return null;
    return scrub(text, this.scrubberOpts);
  }

  private applyScrubResult(m: Memory, result: ScrubResult): Memory {
    if (result.redactions.length === 0) return m;
    if (typeof m.content === 'string') {
      return { ...m, content: result.cleaned } as Memory;
    }
    // Structured payload: parse the cleaned string back if it round-trips
    // as JSON; otherwise leave the payload untouched (the scrubber would
    // need a per-shape strategy to safely rewrite nested structures, which
    // is deferred to Phase 10's structured-content auto-learners).
    try {
      const parsed = JSON.parse(result.cleaned);
      return { ...m, content: parsed } as Memory;
    } catch {
      return m;
    }
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
   * Bi-temporal soft-delete (Phase 5). Marks the row invalid in SQLite
   * and appends a tombstone record into the JSONL canonical so the
   * audit trail survives auto-rebuilds. Returns true if the row existed.
   */
  invalidate(id: string, invalidAt: string, reason: string, runId?: string): boolean {
    const before = this.sqlite.findById(id);
    if (!before) return false;
    const ok = this.sqlite.invalidate(id, invalidAt, reason, runId);
    if (!ok) return false;
    const after = this.sqlite.findById(id);
    if (after) this.jsonl.append(after);
    return true;
  }

  /**
   * Retention enforcement: physically drop rows whose `invalid_at` is
   * older than `cutoff`. Use after the soft-delete window (default 365d
   * per ADR §M8). Note: does not rewrite the JSONL — those entries
   * remain in the audit trail.
   */
  hardDeleteInvalidatedOlderThan(cutoff: string): number {
    return this.sqlite.hardDeleteInvalidatedOlderThan(cutoff);
  }

  /** Phase 8: 1-hop neighbor expansion for graph retrieval. */
  neighborsOf(seedIds: string[], opts?: { relation?: string; limit?: number }): Memory[] {
    return this.sqlite.neighborsOf(seedIds, opts);
  }

  /**
   * Phase 4 namespace-scoped read with Phase 5 bi-temporal defaults. Picks
   * one of the underlying SqliteHotIndex queries based on which `opts`
   * field is set, applying the namespace filter to every candidate path.
   * Precedence: `text` → `tags` → `validAt` → "all in namespace".
   *
   * Bi-temporal default: rows whose `invalid_at` is set are filtered out
   * unless `opts.includeInvalidated === true` or an explicit `validAt`
   * (which already encodes the historical slice) is supplied.
   */
  query(ns: MemoryNamespace, opts: NamespaceQueryOpts = {}): Memory[] {
    const search: SearchOpts = { limit: opts.limit, namespace: ns };
    return this.applyBitemporalFilter(this.runQuery(opts, search, ns), opts);
  }

  /**
   * Cross-namespace admin query — same shape as `query` but skips the
   * namespace filter. Use for migrations, dashboards, and `--scope=*`
   * cli flags.
   */
  queryAll(opts: NamespaceQueryOpts = {}): Memory[] {
    const search: SearchOpts = { limit: opts.limit };
    return this.applyBitemporalFilter(this.runQuery(opts, search, undefined), opts);
  }

  private runQuery(
    opts: NamespaceQueryOpts,
    search: SearchOpts,
    ns: MemoryNamespace | undefined,
  ): Memory[] {
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

  private applyBitemporalFilter(rows: Memory[], opts: NamespaceQueryOpts): Memory[] {
    if (opts.includeInvalidated || opts.validAt) return rows;
    return rows.filter((m) => !m.bitemporal.invalidAt);
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

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}
