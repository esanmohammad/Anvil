/**
 * `MemoryInspector` — read-only + admin-write primitive for the
 * dashboard memory tab (Phase 13 — plan §13.1).
 *
 * Wraps `HybridMemoryStore` + `ProposalQueue` with the shape the
 * dashboard server's REST handlers (and any cli `anvil memory inspect`
 * subcommand) will consume. Keeps the actual Express/Fastify route
 * registration out of memory-core so the package remains framework-
 * agnostic — the dashboard ships a thin adapter that maps HTTP verbs
 * to these methods.
 */

import type { HybridMemoryStore } from '../storage/hybrid-store.js';
import { ProposalQueue } from '../sleeptime/proposal-queue.js';
import type {
  Memory,
  MemoryKind,
  MemoryNamespace,
  Proposal,
  ProposalStatus,
  SemanticSubtype,
} from '../types.js';
import {
  verifyCodeBindings,
  type VerifyCodeBindingsOptions,
  type VerifyCodeBindingsResult,
} from '../drift/index.js';

export interface InspectorListFilter {
  namespace?: MemoryNamespace;
  kind?: MemoryKind;
  subtype?: SemanticSubtype;
  /** BM25 search term against content. */
  search?: string;
  limit?: number;
  /** Include rows whose `invalid_at` is set. */
  includeInvalidated?: boolean;
}

export interface InspectorStats {
  total: number;
  byKind: Record<MemoryKind, number>;
  bySubtype: Record<string, number>;
  topTags: Array<{ tag: string; count: number }>;
  invalidated: number;
  withCodeBinding: number;
}

export class MemoryInspector {
  readonly queue: ProposalQueue;

  constructor(readonly store: HybridMemoryStore) {
    this.queue = new ProposalQueue(store.sqlite);
  }

  list(filter: InspectorListFilter = {}): Memory[] {
    const limit = filter.limit ?? 50;
    let rows: Memory[];
    if (filter.search && filter.search.trim().length > 0) {
      rows = filter.namespace
        ? this.store.query(filter.namespace, {
            text: filter.search,
            limit,
            includeInvalidated: filter.includeInvalidated,
          })
        : this.store.queryAll({
            text: filter.search,
            limit,
            includeInvalidated: filter.includeInvalidated,
          });
    } else if (filter.namespace) {
      rows = this.store.query(filter.namespace, {
        limit,
        includeInvalidated: filter.includeInvalidated,
      });
    } else {
      rows = this.store.queryAll({
        limit,
        includeInvalidated: filter.includeInvalidated,
      });
    }
    return rows.filter((m) => {
      if (filter.kind && m.kind !== filter.kind) return false;
      if (filter.subtype && m.subtype !== filter.subtype) return false;
      return true;
    });
  }

  detail(id: string): Memory | null {
    return this.store.findById(id);
  }

  /** Pending or otherwise-statused proposals, optionally namespace-scoped. */
  listProposals(
    status: ProposalStatus = 'pending',
    namespace?: MemoryNamespace,
    limit?: number,
  ): Proposal[] {
    return this.queue.list(status, { namespace, limit });
  }

  /**
   * Manual ratify (admin-only — caller is responsible for auth). Writes
   * the candidate to durable memory and marks the proposal `'ratified'`.
   */
  ratifyProposal(id: string): { ok: boolean; durableMemoryId?: string } {
    const proposal = this.queue.get(id);
    if (!proposal || proposal.status !== 'pending') {
      return { ok: false };
    }
    this.store.add(proposal.candidate);
    const ok = this.queue.updateStatus(id, 'ratified', {
      ratifiedTo: proposal.candidate.id,
    });
    return { ok, durableMemoryId: ok ? proposal.candidate.id : undefined };
  }

  /** Manual reject (admin-only). Marks the proposal `'rejected'` with a reason. */
  rejectProposal(id: string, reason: string): boolean {
    return this.queue.updateStatus(id, 'rejected', { rejectedReason: reason });
  }

  /**
   * One-shot drift sweep (Phase 6) over a namespace. Caller passes the
   * workspace root; the inspector forwards to `verifyCodeBindings`.
   */
  driftSweep(opts: VerifyCodeBindingsOptions, namespace: MemoryNamespace): VerifyCodeBindingsResult {
    return verifyCodeBindings(this.store, namespace, opts);
  }

  /** Aggregate stats: counts by kind/subtype, top tags, invalidated count. */
  stats(namespace?: MemoryNamespace): InspectorStats {
    const memories = namespace
      ? this.store.query(namespace, { includeInvalidated: true })
      : this.store.queryAll({ includeInvalidated: true });

    const byKind: Record<MemoryKind, number> = {
      working: 0,
      episodic: 0,
      semantic: 0,
      procedural: 0,
      profile: 0,
    };
    const bySubtype: Record<string, number> = {};
    const tagCounts = new Map<string, number>();
    let invalidated = 0;
    let withCodeBinding = 0;

    for (const m of memories) {
      byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
      if (m.subtype) {
        bySubtype[m.subtype] = (bySubtype[m.subtype] ?? 0) + 1;
      }
      for (const t of m.tags) {
        tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
      if (m.bitemporal.invalidAt) invalidated += 1;
      if (m.codeBinding) withCodeBinding += 1;
    }

    const topTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => ({ tag, count }));

    return {
      total: memories.length,
      byKind,
      bySubtype,
      topTags,
      invalidated,
      withCodeBinding,
    };
  }
}
