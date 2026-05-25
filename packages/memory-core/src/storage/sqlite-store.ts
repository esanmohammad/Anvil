/**
 * `SqliteHotIndex` — `better-sqlite3`-backed hot index over the v2
 * `Memory<T>` schema (ADR §7).
 *
 * Responsibilities:
 *   - Apply the embedded schema (idempotent) on open
 *   - upsert / findById / search by tag / search by FTS5 BM25 / bi-temporal
 *     queries / pruneExpired
 *   - Stable row → Memory<T> reconstruction (round-trips through `content_json`)
 *
 * Not responsible for: durability of canonical writes — that's the JSONL
 * append-log's job. SqliteHotIndex is rebuildable from the JSONL at any time.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import type {
  BiTemporal,
  CodeFactBinding,
  DecayState,
  Memory,
  MemoryKind,
  MemoryLink,
  MemoryNamespace,
  MemoryProvenance,
  SemanticSubtype,
} from '../types.js';

export interface SearchOpts {
  limit?: number;
  /**
   * If set, restrict to memories whose namespace matches all defined fields.
   * Undefined fields are wildcards.
   */
  namespace?: Partial<MemoryNamespace>;
}

export class SqliteHotIndex {
  readonly db: Database.Database;

  constructor(public readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.applySchema();
  }

  private applySchema(): void {
    this.db.exec(SCHEMA_SQL);
    this.applyAdditiveMigrations();
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (?, ?)`,
    );
    stmt.run(SCHEMA_VERSION, new Date().toISOString());
  }

  /**
   * Idempotent column adds for SQLite files that predate the current
   * SCHEMA_VERSION. CREATE TABLE IF NOT EXISTS won't add new columns to an
   * existing table, so we PRAGMA-detect missing columns and ALTER on demand.
   */
  private applyAdditiveMigrations(): void {
    const memoryCols = this.tableColumns('memory');
    if (!memoryCols.has('prov_invalidated_run_id')) {
      this.db.exec(`ALTER TABLE memory ADD COLUMN prov_invalidated_run_id TEXT`);
    }
    if (!memoryCols.has('prov_invalidated_reason')) {
      this.db.exec(`ALTER TABLE memory ADD COLUMN prov_invalidated_reason TEXT`);
    }
  }

  private tableColumns(table: string): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return new Set(rows.map((r) => r.name));
  }

  /** Idempotent insert / replace by id. Updates FTS + tag + edge tables in lock-step. */
  upsert(m: Memory): void {
    const tx = this.db.transaction((mem: Memory) => {
      this.upsertMemoryRow(mem);
      this.replaceTags(mem.id, mem.tags);
      this.replaceFts(mem.id, this.contentText(mem));
      this.replaceEdges(mem.id, mem.links ?? [], mem.bitemporal.validAt);
    });
    tx(m);
  }

  findById(id: string): Memory | null {
    const row = this.db
      .prepare(`SELECT * FROM memory WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToMemory(row) : null;
  }

  /** Memories tagged with ANY of `tags` (OR semantics, matching legacy queryByTags). */
  searchByTags(tags: string[], opts: SearchOpts = {}): Memory[] {
    if (tags.length === 0) return [];
    const placeholders = tags.map(() => '?').join(',');
    const limitClause = opts.limit ? `LIMIT ${Number(opts.limit) | 0}` : '';
    const nsClause = this.namespaceClause(opts.namespace);
    const sql = `
      SELECT DISTINCT m.* FROM memory m
      JOIN memory_tag t ON t.memory_id = m.id
      WHERE t.tag IN (${placeholders})${nsClause.where}
      ORDER BY m.confidence DESC, m.last_accessed DESC
      ${limitClause}
    `;
    const rows = this.db.prepare(sql).all(...tags, ...nsClause.bind) as Record<string, unknown>[];
    return rows.map((r) => this.rowToMemory(r));
  }

  /** FTS5 BM25-ranked text search. Returns highest-relevance first. */
  searchByText(query: string, opts: SearchOpts = {}): Memory[] {
    const safeQuery = toFtsQuery(query);
    if (safeQuery.length === 0) return [];
    const limitClause = opts.limit ? `LIMIT ${Number(opts.limit) | 0}` : '';
    const nsClause = this.namespaceClause(opts.namespace, 'm');
    const sql = `
      SELECT m.* FROM memory_fts f
      JOIN memory m ON m.id = f.id
      WHERE f.content_text MATCH ?${nsClause.where}
      ORDER BY bm25(memory_fts)
      ${limitClause}
    `;
    const rows = this.db
      .prepare(sql)
      .all(safeQuery, ...nsClause.bind) as Record<string, unknown>[];
    return rows.map((r) => this.rowToMemory(r));
  }

  /**
   * Bi-temporal slice (M8): all memories that were valid at `at`, i.e.
   * `valid_at <= at AND (invalid_at IS NULL OR invalid_at > at)`.
   */
  validAtTime(at: string, opts: SearchOpts = {}): Memory[] {
    const limitClause = opts.limit ? `LIMIT ${Number(opts.limit) | 0}` : '';
    const nsClause = this.namespaceClause(opts.namespace);
    const sql = `
      SELECT * FROM memory
      WHERE valid_at <= ? AND (invalid_at IS NULL OR invalid_at > ?)
      ${nsClause.where.replace(/^ AND/, ' AND')}
      ORDER BY valid_at DESC
      ${limitClause}
    `;
    const rows = this.db
      .prepare(sql)
      .all(at, at, ...nsClause.bind) as Record<string, unknown>[];
    return rows.map((r) => this.rowToMemory(r));
  }

  /**
   * Soft-prune: TTL-expired rows get `invalid_at = now()` rather than being
   * deleted (Phase 5 — plan §5.2.3). Rows already invalidated are skipped.
   * Returns the number of rows newly invalidated. Use
   * `hardDeleteInvalidatedOlderThan` to physically remove old invalidated
   * rows after a retention window.
   */
  pruneExpired(now: string = new Date().toISOString()): number {
    const tx = this.db.transaction(() => {
      const expired = this.db
        .prepare(
          `SELECT id FROM memory
           WHERE ttl_days >= 0
             AND expires_at < ?
             AND invalid_at IS NULL`,
        )
        .all(now) as Array<{ id: string }>;
      for (const { id } of expired) {
        this.db
          .prepare(
            `UPDATE memory
             SET invalid_at = ?,
                 prov_invalidated_reason = COALESCE(prov_invalidated_reason, 'ttl-expired')
             WHERE id = ?`,
          )
          .run(now, id);
      }
      return expired.length;
    });
    return tx();
  }

  /**
   * Bi-temporal soft-delete (Phase 5 — plan §5.2.2). Sets `invalid_at` and
   * stamps `prov_invalidated_*`. Idempotent: re-invalidating a row updates
   * the reason but never moves `invalid_at` backwards. Returns true if a
   * row was touched.
   */
  invalidate(
    id: string,
    invalidAt: string,
    reason: string,
    runId?: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE memory
         SET invalid_at = COALESCE(invalid_at, ?),
             prov_invalidated_reason = ?,
             prov_invalidated_run_id = ?
         WHERE id = ?`,
      )
      .run(invalidAt, reason, runId ?? null, id);
    return result.changes > 0;
  }

  /**
   * Hard-delete invalidated rows whose `invalid_at` is older than the
   * given cutoff. Used by retention policy after the soft-delete window.
   * Returns the number of rows deleted.
   */
  hardDeleteInvalidatedOlderThan(cutoff: string): number {
    const tx = this.db.transaction(() => {
      const stale = this.db
        .prepare(`SELECT id FROM memory WHERE invalid_at IS NOT NULL AND invalid_at < ?`)
        .all(cutoff) as Array<{ id: string }>;
      for (const { id } of stale) {
        this.db.prepare(`DELETE FROM memory WHERE id = ?`).run(id);
        this.db.prepare(`DELETE FROM memory_tag WHERE memory_id = ?`).run(id);
        this.db.prepare(`DELETE FROM memory_fts WHERE id = ?`).run(id);
      }
      return stale.length;
    });
    return tx();
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM memory`).get() as { n: number };
    return row.n;
  }

  /**
   * Return the most recent N memories in id-descending order. Used by
   * vector backfill (`embedMemoriesBatch`) to embed the newest first
   * so the freshest signal lands in retrieval. ULID id sort doubles as
   * chronological since ULIDs encode timestamp.
   */
  recentForBackfill(limit: number): Memory[] {
    const rows = this.db
      .prepare(`SELECT * FROM memory WHERE invalid_at IS NULL ORDER BY id DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToMemory(r));
  }

  /**
   * Wave 2 — find memories code-bound to a specific file path. Used by
   * the implement stage's prompt-context-cache to surface memories
   * about the file the agent is about to edit, regardless of BM25
   * rank. Filters by namespace if provided. Falls back to substring
   * match when the file path contains common prefixes — many bindings
   * are stored as relative paths but callers pass absolute.
   */
  findByCodeBindingFile(
    filePath: string,
    opts: { namespace?: { scope: string; projectId?: string; repoId?: string; userId?: string }; limit?: number } = {},
  ): Memory[] {
    const limit = opts.limit ?? 8;
    const ns = opts.namespace;
    const params: Array<string | number> = [];
    let sql = `SELECT * FROM memory WHERE invalid_at IS NULL AND (code_file = ? OR code_file LIKE ?)`;
    params.push(filePath);
    params.push(`%/${filePath}`); // absolute-vs-relative tolerance
    if (ns) {
      sql += ` AND namespace_scope = ?`;
      params.push(ns.scope);
      if (ns.projectId !== undefined) {
        sql += ` AND namespace_project = ?`;
        params.push(ns.projectId);
      }
      if (ns.repoId !== undefined) {
        sql += ` AND namespace_repo = ?`;
        params.push(ns.repoId);
      }
    }
    sql += ` ORDER BY strength DESC, id DESC LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToMemory(r));
  }

  close(): void {
    this.db.close();
  }

  // ── Internal: row encode / decode ──────────────────────────────────────

  private upsertMemoryRow(m: Memory): void {
    const stmt = this.db.prepare(`
      INSERT INTO memory (
        id,
        namespace_scope, namespace_project, namespace_repo, namespace_user,
        kind, subtype, content_json, tags_json,
        confidence, ttl_days, expires_at,
        valid_at, invalid_at,
        last_accessed, strength, rehearse_count,
        code_file, code_structural_hash, code_last_seen_sha, code_last_verified_at,
        prov_run_id, prov_message_id, prov_file, prov_commit,
        prov_created_by, prov_created_at, prov_proposed_at, prov_ratified_at,
        prov_invalidated_run_id, prov_invalidated_reason,
        embedding_id
      ) VALUES (
        @id,
        @namespace_scope, @namespace_project, @namespace_repo, @namespace_user,
        @kind, @subtype, @content_json, @tags_json,
        @confidence, @ttl_days, @expires_at,
        @valid_at, @invalid_at,
        @last_accessed, @strength, @rehearse_count,
        @code_file, @code_structural_hash, @code_last_seen_sha, @code_last_verified_at,
        @prov_run_id, @prov_message_id, @prov_file, @prov_commit,
        @prov_created_by, @prov_created_at, @prov_proposed_at, @prov_ratified_at,
        @prov_invalidated_run_id, @prov_invalidated_reason,
        @embedding_id
      )
      ON CONFLICT(id) DO UPDATE SET
        namespace_scope = excluded.namespace_scope,
        namespace_project = excluded.namespace_project,
        namespace_repo = excluded.namespace_repo,
        namespace_user = excluded.namespace_user,
        kind = excluded.kind,
        subtype = excluded.subtype,
        content_json = excluded.content_json,
        tags_json = excluded.tags_json,
        confidence = excluded.confidence,
        ttl_days = excluded.ttl_days,
        expires_at = excluded.expires_at,
        valid_at = excluded.valid_at,
        invalid_at = excluded.invalid_at,
        last_accessed = excluded.last_accessed,
        strength = excluded.strength,
        rehearse_count = excluded.rehearse_count,
        code_file = excluded.code_file,
        code_structural_hash = excluded.code_structural_hash,
        code_last_seen_sha = excluded.code_last_seen_sha,
        code_last_verified_at = excluded.code_last_verified_at,
        prov_run_id = excluded.prov_run_id,
        prov_message_id = excluded.prov_message_id,
        prov_file = excluded.prov_file,
        prov_commit = excluded.prov_commit,
        prov_created_by = excluded.prov_created_by,
        prov_created_at = excluded.prov_created_at,
        prov_proposed_at = excluded.prov_proposed_at,
        prov_ratified_at = excluded.prov_ratified_at,
        prov_invalidated_run_id = excluded.prov_invalidated_run_id,
        prov_invalidated_reason = excluded.prov_invalidated_reason,
        embedding_id = excluded.embedding_id
    `);
    stmt.run(this.memoryToRow(m));
  }

  private replaceTags(memoryId: string, tags: string[]): void {
    this.db.prepare(`DELETE FROM memory_tag WHERE memory_id = ?`).run(memoryId);
    if (tags.length === 0) return;
    const ins = this.db.prepare(`INSERT INTO memory_tag(memory_id, tag) VALUES (?, ?)`);
    for (const t of tags) ins.run(memoryId, t);
  }

  private replaceEdges(sourceId: string, links: MemoryLink[], validAt: string): void {
    this.db.prepare(`DELETE FROM memory_edge WHERE source_id = ?`).run(sourceId);
    if (links.length === 0) return;
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO memory_edge(source_id, target_id, relation, weight, valid_at, invalid_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    );
    for (const link of links) {
      ins.run(sourceId, link.targetId, link.relation, link.weight, validAt);
    }
  }

  private replaceFts(memoryId: string, text: string): void {
    this.db.prepare(`DELETE FROM memory_fts WHERE id = ?`).run(memoryId);
    this.db.prepare(`INSERT INTO memory_fts(id, content_text) VALUES (?, ?)`).run(memoryId, text);
  }

  private contentText(m: Memory): string {
    if (typeof m.content === 'string') return m.content;
    try {
      return JSON.stringify(m.content);
    } catch {
      return '';
    }
  }

  private memoryToRow(m: Memory): Record<string, unknown> {
    return {
      id: m.id,
      namespace_scope: m.namespace.scope,
      namespace_project: m.namespace.projectId ?? null,
      namespace_repo: m.namespace.repoId ?? null,
      namespace_user: m.namespace.userId ?? null,
      kind: m.kind,
      subtype: m.subtype ?? null,
      content_json: JSON.stringify(m.content),
      tags_json: JSON.stringify(m.tags),
      confidence: m.confidence,
      ttl_days: m.ttlDays,
      expires_at: m.expiresAt,
      valid_at: m.bitemporal.validAt,
      invalid_at: m.bitemporal.invalidAt ?? null,
      last_accessed: m.decay.lastAccessed,
      strength: m.decay.strength,
      rehearse_count: m.decay.rehearseCount,
      code_file: m.codeBinding?.filePath ?? null,
      code_structural_hash: m.codeBinding?.structuralHash ?? null,
      code_last_seen_sha: m.codeBinding?.lastSeenCommitSha ?? null,
      code_last_verified_at: m.codeBinding?.lastVerifiedAt ?? null,
      prov_run_id: m.provenance.sourceRunId ?? null,
      prov_message_id: m.provenance.sourceMessageId ?? null,
      prov_file: m.provenance.sourceFile ?? null,
      prov_commit: m.provenance.sourceCommit ?? null,
      prov_created_by: m.provenance.createdBy,
      prov_created_at: m.provenance.createdAt,
      prov_proposed_at: m.provenance.proposedAt ?? null,
      prov_ratified_at: m.provenance.ratifiedAt ?? null,
      prov_invalidated_run_id: m.provenance.invalidatedBy?.runId ?? null,
      prov_invalidated_reason: m.provenance.invalidatedBy?.reason ?? null,
      embedding_id: m.embedding ? `inline:${m.id}` : null,
    };
  }

  private rowToMemory(row: Record<string, unknown>): Memory {
    const namespace: MemoryNamespace = {
      scope: row.namespace_scope as MemoryNamespace['scope'],
      projectId: (row.namespace_project as string | null) ?? undefined,
      repoId: (row.namespace_repo as string | null) ?? undefined,
      userId: (row.namespace_user as string | null) ?? undefined,
    };
    const bitemporal: BiTemporal = {
      validAt: row.valid_at as string,
      invalidAt: (row.invalid_at as string | null) ?? undefined,
    };
    const decay: DecayState = {
      lastAccessed: row.last_accessed as string,
      strength: row.strength as number,
      rehearseCount: row.rehearse_count as number,
    };
    const provenance: MemoryProvenance = {
      sourceRunId: (row.prov_run_id as string | null) ?? undefined,
      sourceMessageId: (row.prov_message_id as string | null) ?? undefined,
      sourceFile: (row.prov_file as string | null) ?? undefined,
      sourceCommit: (row.prov_commit as string | null) ?? undefined,
      createdBy: row.prov_created_by as MemoryProvenance['createdBy'],
      createdAt: row.prov_created_at as string,
      proposedAt: (row.prov_proposed_at as string | null) ?? undefined,
      ratifiedAt: (row.prov_ratified_at as string | null) ?? undefined,
    };
    const invalidatedReason = (row.prov_invalidated_reason as string | null) ?? null;
    if (invalidatedReason) {
      provenance.invalidatedBy = {
        runId: (row.prov_invalidated_run_id as string | null) ?? undefined,
        reason: invalidatedReason,
      };
    }
    let codeBinding: CodeFactBinding | undefined;
    if (row.code_file && row.code_structural_hash && row.code_last_seen_sha) {
      codeBinding = {
        filePath: row.code_file as string,
        structuralHash: row.code_structural_hash as string,
        lastSeenCommitSha: row.code_last_seen_sha as string,
        lastVerifiedAt: (row.code_last_verified_at as string) ?? '',
      };
    }
    const links = this.linksOf(row.id as string);
    return {
      id: row.id as string,
      namespace,
      kind: row.kind as MemoryKind,
      subtype: (row.subtype as SemanticSubtype | null) ?? undefined,
      content: JSON.parse(row.content_json as string),
      tags: JSON.parse(row.tags_json as string) as string[],
      confidence: row.confidence as number,
      ttlDays: row.ttl_days as number,
      expiresAt: row.expires_at as string,
      bitemporal,
      decay,
      codeBinding,
      provenance,
      links: links.length > 0 ? links : undefined,
    };
  }

  /** Read every outgoing edge for a memory id. */
  linksOf(memoryId: string): MemoryLink[] {
    const rows = this.db
      .prepare(
        `SELECT target_id, relation, weight FROM memory_edge
         WHERE source_id = ? AND invalid_at IS NULL`,
      )
      .all(memoryId) as Array<{ target_id: string; relation: string; weight: number }>;
    return rows.map((r) => ({
      targetId: r.target_id,
      relation: r.relation,
      weight: r.weight,
    }));
  }

  /**
   * 1-hop graph traversal (Phase 8 — plan §8.2.1.graph). Returns the
   * memories that `seedIds` link out to, optionally filtered by relation.
   */
  neighborsOf(
    seedIds: string[],
    opts: { relation?: string; limit?: number } = {},
  ): Memory[] {
    if (seedIds.length === 0) return [];
    const placeholders = seedIds.map(() => '?').join(',');
    const relationClause = opts.relation ? ' AND relation = ?' : '';
    const limitClause = opts.limit ? `LIMIT ${Number(opts.limit) | 0}` : '';
    const sql = `
      SELECT DISTINCT target_id FROM memory_edge
      WHERE source_id IN (${placeholders})${relationClause}
        AND invalid_at IS NULL
      ${limitClause}
    `;
    const params: unknown[] = [...seedIds];
    if (opts.relation) params.push(opts.relation);
    const rows = this.db.prepare(sql).all(...params) as Array<{ target_id: string }>;
    const out: Memory[] = [];
    for (const { target_id } of rows) {
      const m = this.findById(target_id);
      if (m) out.push(m);
    }
    return out;
  }

  private namespaceClause(
    ns: Partial<MemoryNamespace> | undefined,
    alias = '',
  ): { where: string; bind: unknown[] } {
    if (!ns) return { where: '', bind: [] };
    const prefix = alias ? `${alias}.` : '';
    const conds: string[] = [];
    const bind: unknown[] = [];
    if (ns.scope) {
      conds.push(`${prefix}namespace_scope = ?`);
      bind.push(ns.scope);
    }
    if (ns.projectId) {
      conds.push(`${prefix}namespace_project = ?`);
      bind.push(ns.projectId);
    }
    if (ns.repoId) {
      conds.push(`${prefix}namespace_repo = ?`);
      bind.push(ns.repoId);
    }
    if (ns.userId) {
      conds.push(`${prefix}namespace_user = ?`);
      bind.push(ns.userId);
    }
    return conds.length === 0
      ? { where: '', bind: [] }
      : { where: ' AND ' + conds.join(' AND '), bind };
  }
}

/**
 * Sanitize a free-text query for FTS5 MATCH. FTS5 treats `column:term`,
 * bareword operators (`AND` / `OR` / `NOT`), `*`, `^`, parens, and double
 * quotes as syntactic — passing raw memory bodies through MATCH explodes
 * with `SqliteError: no such column: X` the moment the text contains
 * `Word:` followed by anything. We split into alphanumeric tokens and
 * quote each as a literal phrase so FTS5 treats them as plain terms.
 */
function toFtsQuery(raw: string): string {
  const tokens = raw.match(/[\p{L}\p{N}]+/gu);
  if (!tokens) return '';
  const quoted = tokens
    .filter((t) => t.length >= 2 && t.length <= 64)
    .slice(0, 32)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return quoted.join(' OR ');
}
