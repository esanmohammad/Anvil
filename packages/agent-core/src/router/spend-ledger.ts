/**
 * SpendLedger — SQLite-backed per-call spend ledger.
 *
 * One row per terminal outcome (success or final failure). Failed calls
 * that incurred no cost still get a row so retry-driven amplification is
 * visible in audit. Schema locked in `AGENT-CORE-LLM-ROUTER-ADR.md` §4.
 *
 * Default location: `~/.anvil/router/spend.sqlite`. Honors `process.env.
 * ANVIL_HOME` to relocate the entire `~/.anvil/` tree (memory-core convention).
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const SPEND_LEDGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS spend (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  run_id TEXT,
  project TEXT,
  user TEXT,
  tag TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  fallback_index INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  error_class TEXT,
  trace_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_spend_run ON spend(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_spend_project ON spend(project, ts);
CREATE INDEX IF NOT EXISTS idx_spend_tag ON spend(tag, ts);
CREATE INDEX IF NOT EXISTS idx_spend_provider ON spend(provider, ts);
`;

export interface SpendRow {
  id: string;
  ts: string;
  runId?: string;
  project?: string;
  user?: string;
  tag: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
  durationMs: number;
  fallbackIndex: number;
  attemptCount: number;
  errorClass?: string;
  traceId?: string;
}

export interface SpendQueryOpts {
  runId?: string;
  project?: string;
  tag?: string;
  provider?: string;
  /** ISO timestamp lower-bound (inclusive). */
  since?: string;
  /** ISO timestamp upper-bound (exclusive). */
  until?: string;
}

export function defaultSpendLedgerPath(): string {
  const root = process.env.ANVIL_HOME ?? join(homedir(), '.anvil');
  return join(root, 'router', 'spend.sqlite');
}

export class SpendLedger {
  readonly db: Database.Database;

  constructor(public readonly filePath: string = defaultSpendLedgerPath()) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SPEND_LEDGER_SCHEMA_SQL);
    this.applyAdditiveMigrations();
  }

  /**
   * Idempotent column adds — for SQLite files created before a column
   * existed, we ALTER TABLE if missing. Mirrors memory-core's pattern.
   */
  private applyAdditiveMigrations(): void {
    const cols = (this.db.pragma('table_info(spend)') as { name: string }[]).map((c) => c.name);
    const ensure = (name: string, ddl: string) => {
      if (!cols.includes(name)) {
        this.db.exec(`ALTER TABLE spend ADD COLUMN ${ddl}`);
      }
    };
    ensure('error_class', 'error_class TEXT');
    ensure('trace_id', 'trace_id TEXT');
  }

  record(row: SpendRow): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO spend(
        id, ts, run_id, project, user, tag, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_usd, duration_ms, fallback_index, attempt_count, error_class, trace_id
      ) VALUES (
        @id, @ts, @runId, @project, @user, @tag, @provider, @model,
        @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
        @costUsd, @durationMs, @fallbackIndex, @attemptCount, @errorClass, @traceId
      )`,
    );
    stmt.run({
      id: row.id,
      ts: row.ts,
      runId: row.runId ?? null,
      project: row.project ?? null,
      user: row.user ?? null,
      tag: row.tag,
      provider: row.provider,
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens ?? 0,
      cacheWriteTokens: row.cacheWriteTokens ?? 0,
      costUsd: row.costUsd,
      durationMs: row.durationMs,
      fallbackIndex: row.fallbackIndex,
      attemptCount: row.attemptCount,
      errorClass: row.errorClass ?? null,
      traceId: row.traceId ?? null,
    });
  }

  /** Sum of cost_usd across rows matching the query. */
  totalUsd(opts: SpendQueryOpts = {}): number {
    const { sql, params } = this.buildWhere(opts);
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend ${sql}`)
      .get(...params) as { total: number };
    return row.total;
  }

  /** Aggregated cost grouped by tag (or runId / project). */
  groupBy(
    field: 'tag' | 'run_id' | 'project' | 'provider',
    opts: SpendQueryOpts = {},
  ): Array<{ key: string; totalUsd: number; count: number }> {
    const { sql, params } = this.buildWhere(opts);
    return this.db
      .prepare(
        `SELECT ${field} AS key, COALESCE(SUM(cost_usd), 0) AS totalUsd, COUNT(*) AS count
         FROM spend ${sql}
         GROUP BY ${field}
         ORDER BY totalUsd DESC`,
      )
      .all(...params) as Array<{ key: string; totalUsd: number; count: number }>;
  }

  /** Most-recent rows; default 50. */
  recent(limit = 50): SpendRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM spend ORDER BY ts DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(rowToSpend);
  }

  /** Total count — convenience for tests + sanity checks. */
  count(opts: SpendQueryOpts = {}): number {
    const { sql, params } = this.buildWhere(opts);
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM spend ${sql}`).get(...params) as { c: number };
    return row.c;
  }

  close(): void {
    this.db.close();
  }

  private buildWhere(opts: SpendQueryOpts): { sql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.runId !== undefined) {
      where.push('run_id = ?');
      params.push(opts.runId);
    }
    if (opts.project !== undefined) {
      where.push('project = ?');
      params.push(opts.project);
    }
    if (opts.tag !== undefined) {
      where.push('tag = ?');
      params.push(opts.tag);
    }
    if (opts.provider !== undefined) {
      where.push('provider = ?');
      params.push(opts.provider);
    }
    if (opts.since !== undefined) {
      where.push('ts >= ?');
      params.push(opts.since);
    }
    if (opts.until !== undefined) {
      where.push('ts < ?');
      params.push(opts.until);
    }
    return {
      sql: where.length ? `WHERE ${where.join(' AND ')}` : '',
      params,
    };
  }
}

function rowToSpend(row: Record<string, unknown>): SpendRow {
  return {
    id: row.id as string,
    ts: row.ts as string,
    runId: (row.run_id as string) ?? undefined,
    project: (row.project as string) ?? undefined,
    user: (row.user as string) ?? undefined,
    tag: row.tag as string,
    provider: row.provider as string,
    model: row.model as string,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    cacheReadTokens: (row.cache_read_tokens as number) ?? 0,
    cacheWriteTokens: (row.cache_write_tokens as number) ?? 0,
    costUsd: row.cost_usd as number,
    durationMs: row.duration_ms as number,
    fallbackIndex: row.fallback_index as number,
    attemptCount: row.attempt_count as number,
    errorClass: (row.error_class as string) ?? undefined,
    traceId: (row.trace_id as string) ?? undefined,
  };
}
