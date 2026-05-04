/**
 * pipeline-calibration — pure helpers that consume aggregated learnings to
 * tune planner behaviour. Nothing here performs I/O or is wired into the live
 * pipeline. The planner persona and risk scorer will pick these up in a
 * follow-up integration step.
 */

import type { PlanApprovalStats, PathApprovalStats } from './pipeline-learnings-types.js';

/**
 * Cap on the multiplier returned by {@link calibrateRiskWeights}. Prevents a
 * single noisy path from dominating the risk score once enough rejections have
 * stacked up.
 */
const MAX_MULTIPLIER = 2.0;
/**
 * Minimum sample size before a path's rejection rate is trusted for
 * calibration. Below this we treat the path as unbiased (multiplier 1.0) to
 * avoid overreacting to a single bad decision.
 */
const MIN_SAMPLES_FOR_CALIBRATION = 3;

function pct(n: number): number {
  return Math.round(n * 100);
}

function topReasonFor(stats: PlanApprovalStats): string | null {
  return stats.topRejectionReasons[0]?.reason ?? null;
}

/**
 * Build a markdown few-shot block that can be concatenated onto the planner's
 * system prompt. Focus is on *contextual* signals the planner couldn't derive
 * from the repo snapshot alone — specifically, paths that historically get
 * rejected and the top reason users cite.
 *
 * Returns an empty string when `stats.totalPlans` is zero so callers can
 * safely splice it into prompts unconditionally.
 */
export function buildPlannerFewShots(stats: PlanApprovalStats, limit: number = 3): string {
  if (stats.totalPlans === 0) return '';

  const lines: string[] = [];
  lines.push(`## Historical plan outcomes for \`${stats.projectSlug}\``);
  lines.push('');
  lines.push(
    `Across ${stats.totalPlans} past plans: ${pct(stats.approvalRate)}% approved, ` +
      `${pct(stats.modificationRate)}% approved-with-edits, ${pct(stats.rejectionRate)}% rejected.`,
  );

  // Pick the riskiest paths by rejection rate, filtered for meaningful
  // sample size — otherwise a single rejection on a one-hit path would
  // always lead the recommendations.
  const risky = stats.byPath
    .filter((p) => p.total >= MIN_SAMPLES_FOR_CALIBRATION)
    .map((p) => ({ p, rej: p.total === 0 ? 0 : p.rejected / p.total }))
    .sort((a, b) => b.rej - a.rej || b.p.total - a.p.total)
    .slice(0, limit);

  if (risky.length > 0) {
    lines.push('');
    lines.push('### Paths to treat carefully');
    for (const { p, rej } of risky) {
      if (rej === 0) continue;
      lines.push(
        `- Plans touching **${p.path}** have been rejected ${pct(rej)}% of the time (n=${p.total}).`,
      );
    }
  }

  const topReason = topReasonFor(stats);
  if (topReason) {
    lines.push('');
    lines.push(`### Most common rejection reason`);
    lines.push(`> ${topReason}`);
    lines.push('');
    lines.push(
      'When scoping this plan, explicitly address the concern above if it could apply.',
    );
  }

  // Surface tiered approval so the planner knows which risk ceiling is safe.
  const high = stats.byRiskTier.high;
  if (high.total >= MIN_SAMPLES_FOR_CALIBRATION && high.approvalRate < 0.5) {
    lines.push('');
    lines.push(
      `High-risk plans in this project clear the gate only ${pct(high.approvalRate)}% of the time — ` +
        'prefer splitting into smaller steps where possible.',
    );
  }

  return lines.join('\n');
}

/**
 * Derive per-path weight multipliers suitable for feeding into
 * {@link ./plan-risk-scorer.ts}. A path whose rejection rate exceeds 50%
 * receives a multiplier > 1, scaling linearly up to {@link MAX_MULTIPLIER} at
 * 100% rejection. Paths without enough samples, or with healthy approval,
 * default to 1.0 (no-op).
 *
 * The linear scaling from 0.5 → 1.0 rejection rate into 1.0 → MAX_MULTIPLIER
 * is deliberately simple: calibration tuning is empirical and the consumer
 * (risk scorer) already clamps the final weight.
 */
export function calibrateRiskWeights(stats: PlanApprovalStats): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const p of stats.byPath) {
    if (p.total < MIN_SAMPLES_FOR_CALIBRATION) continue;
    const rejectionRate = p.total === 0 ? 0 : p.rejected / p.total;
    if (rejectionRate <= 0.5) continue;
    // Map [0.5, 1.0] → [1.0, MAX_MULTIPLIER].
    const t = (rejectionRate - 0.5) / 0.5;
    const mult = 1.0 + t * (MAX_MULTIPLIER - 1.0);
    weights[p.path] = Math.min(MAX_MULTIPLIER, mult);
  }
  return weights;
}

/**
 * Convenience: does this path history suggest it should be auto-held for
 * manual review even when the risk scorer would normally auto-approve? The
 * planner persona can use this to insert a gate-review suggestion.
 */
export function shouldSuggestManualGate(
  stats: PlanApprovalStats,
  path: string,
): boolean {
  const p: PathApprovalStats | undefined = stats.byPath.find((x) => x.path === path);
  if (!p || p.total < MIN_SAMPLES_FOR_CALIBRATION) return false;
  const rejectionRate = p.total === 0 ? 0 : p.rejected / p.total;
  return rejectionRate >= 0.4;
}
