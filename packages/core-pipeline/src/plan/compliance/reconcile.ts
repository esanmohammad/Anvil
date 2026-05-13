/**
 * Phase G — post-ship reconciliation skeleton.
 *
 * After PRs merge (or close), this module compares the plan's claims
 * to the actual delivered outcome and emits `plan-reconciliation.json`
 * for plan-learnings ingestion. Real production reconciliation needs
 * a GitHub-merge webhook to fire it; this module supplies the pure
 * data shape + diff so the dashboard can wire either polling or a
 * webhook receiver.
 */

import type { Plan } from '../../utils/plan-types.js';

export interface PlanReconciliation {
  planSlug: string;
  planVersion: number;
  planHash: string;
  reconciliatedAt: string;
  estimate: {
    /** From plan.estimate.usd. */
    plannedUsd: number;
    /** Caller-supplied: sum of run.totalCost for runs against this plan. */
    actualUsd: number;
    /** plannedMinutes vs actual elapsed wall-clock. */
    plannedMinutes: number;
    actualMinutes: number;
    plannedPrs: number;
    actualPrs: number;
  };
  /** Plan acceptance claims that resolved to a passing test post-merge. */
  acceptanceDelivered: string[];
  /** Plan acceptance claims still unverifiable after merge. */
  acceptanceMissing: string[];
  /** Risks the plan flagged + whether they triggered post-merge. */
  risks: Array<{
    id: string; title: string; severity: 'low' | 'med' | 'high';
    triggered: boolean;
  }>;
}

export interface ReconcileInput {
  plan: Plan;
  /** Sum of `run.totalCost` across runs against this plan. */
  actualUsd: number;
  actualMinutes: number;
  actualPrs: number;
  /** acceptanceRef → test passed post-merge? */
  acceptanceVerified: Record<string, boolean>;
  /** Risk ids that were triggered (detected) post-merge. */
  triggeredRiskIds: Set<string>;
  /** Override the timestamp (test seam). */
  now?: () => Date;
}

export function reconcilePlan(input: ReconcileInput): PlanReconciliation {
  const now = input.now ? input.now() : new Date();
  const delivered: string[] = [];
  const missing: string[] = [];
  for (const item of input.plan.scope.inScope) {
    for (const a of item.acceptance) {
      const key = item.id;
      if (input.acceptanceVerified[key]) delivered.push(a);
      else missing.push(a);
    }
  }
  return {
    planSlug: input.plan.slug,
    planVersion: input.plan.version,
    planHash: input.plan.contentHash,
    reconciliatedAt: now.toISOString(),
    estimate: {
      plannedUsd: input.plan.estimate.usd,
      actualUsd: input.actualUsd,
      plannedMinutes: input.plan.estimate.minutes,
      actualMinutes: input.actualMinutes,
      plannedPrs: input.plan.estimate.prs,
      actualPrs: input.actualPrs,
    },
    acceptanceDelivered: delivered,
    acceptanceMissing: missing,
    risks: input.plan.risks.map((r) => ({
      id: r.id,
      title: r.title,
      severity: r.severity,
      triggered: input.triggeredRiskIds.has(r.id),
    })),
  };
}
