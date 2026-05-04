/**
 * `ProposalQueue` — durable proposal queue for the sleeptime ratification
 * pass (Phase 10 — ADR §M9, plan §10.2).
 *
 * Hot-path auto-learners enqueue candidate memories with `status='pending'`.
 * The consolidator (run on PR/CI completion or every-N-runs) walks the
 * pending queue, dedupes / ratifies / rejects, and writes survivors to
 * the durable `HybridMemoryStore`.
 *
 * The `proposal` table already exists in the SQLite schema (Phase 3).
 * This module provides the typed read/write surface around it.
 */

import { ulid } from 'ulid';
import type { SqliteHotIndex } from '../storage/sqlite-store.js';
import type {
  Memory,
  MemoryNamespace,
  Proposal,
  ProposalStatus,
} from '../types.js';

export interface EnqueueOptions {
  /** Override the proposal id (otherwise generated). */
  id?: string;
  /** ISO-8601; defaults to now. */
  proposedAt?: string;
}

export interface ListProposalOptions {
  /** Restrict to a namespace; matches every defined field. */
  namespace?: Partial<MemoryNamespace>;
  /** Limit; defaults unlimited. */
  limit?: number;
}

export class ProposalQueue {
  constructor(private readonly sqlite: SqliteHotIndex) {}

  enqueue(
    candidate: Memory,
    reason: string,
    opts: EnqueueOptions = {},
  ): Proposal {
    const proposal: Proposal = {
      id: opts.id ?? ulid(),
      candidate,
      reason,
      status: 'pending',
      proposedAt: opts.proposedAt ?? new Date().toISOString(),
    };
    this.sqlite.db
      .prepare(
        `INSERT INTO proposal(id, candidate_json, reason, status, proposed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.id,
        JSON.stringify(proposal.candidate),
        proposal.reason,
        proposal.status,
        proposal.proposedAt,
      );
    return proposal;
  }

  get(id: string): Proposal | null {
    const row = this.sqlite.db
      .prepare(`SELECT * FROM proposal WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToProposal(row) : null;
  }

  listPending(opts: ListProposalOptions = {}): Proposal[] {
    return this.list('pending', opts);
  }

  list(status: ProposalStatus, opts: ListProposalOptions = {}): Proposal[] {
    const limitClause = opts.limit ? `LIMIT ${Number(opts.limit) | 0}` : '';
    const rows = this.sqlite.db
      .prepare(
        `SELECT * FROM proposal WHERE status = ? ORDER BY proposed_at ASC ${limitClause}`,
      )
      .all(status) as Array<Record<string, unknown>>;
    const all = rows.map((r) => this.rowToProposal(r));
    if (!opts.namespace) return all;
    return all.filter((p) => matchesNamespace(p.candidate.namespace, opts.namespace!));
  }

  /**
   * Apply a status transition to a proposal. Pending → {ratified, rejected,
   * merged-into}. Stamps `decided_at` automatically.
   */
  updateStatus(
    id: string,
    status: Exclude<ProposalStatus, 'pending'>,
    extras: { ratifiedTo?: string; rejectedReason?: string; decidedAt?: string } = {},
  ): boolean {
    const decidedAt = extras.decidedAt ?? new Date().toISOString();
    const result = this.sqlite.db
      .prepare(
        `UPDATE proposal
         SET status = ?, ratified_to = ?, rejected_reason = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(
        status,
        extras.ratifiedTo ?? null,
        extras.rejectedReason ?? null,
        decidedAt,
        id,
      );
    return result.changes > 0;
  }

  pendingCount(): number {
    const row = this.sqlite.db
      .prepare(`SELECT COUNT(*) AS n FROM proposal WHERE status = 'pending'`)
      .get() as { n: number };
    return row.n;
  }

  private rowToProposal(row: Record<string, unknown>): Proposal {
    return {
      id: row.id as string,
      candidate: JSON.parse(row.candidate_json as string) as Memory,
      reason: row.reason as string,
      status: row.status as ProposalStatus,
      ratifiedTo: (row.ratified_to as string | null) ?? undefined,
      rejectedReason: (row.rejected_reason as string | null) ?? undefined,
      proposedAt: row.proposed_at as string,
      decidedAt: (row.decided_at as string | null) ?? undefined,
    };
  }
}

function matchesNamespace(
  ns: MemoryNamespace,
  filter: Partial<MemoryNamespace>,
): boolean {
  if (filter.scope && filter.scope !== ns.scope) return false;
  if (filter.projectId && filter.projectId !== ns.projectId) return false;
  if (filter.repoId && filter.repoId !== ns.repoId) return false;
  if (filter.userId && filter.userId !== ns.userId) return false;
  return true;
}
