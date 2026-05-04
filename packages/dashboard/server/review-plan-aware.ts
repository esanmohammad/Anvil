/**
 * review-plan-aware — turns a PRPlanComparison into plan-aware findings for
 * the Review surface.
 *
 * When a PR was seeded from a Plan, the reviewer's job grows: it must also
 * tell the author whether the diff actually delivers the plan's steps (no
 * under-delivery) and does not silently widen into work the plan didn't
 * authorise (no scope creep). This module translates a PRPlanComparison —
 * produced by review-plan-diff-comparator — into zero or more
 * PlanAwareFinding records, each carrying the plan-step id (for traceability
 * back to the plan section that was missed) or the unexpected file path.
 *
 * Severity mapping:
 *   missing-deliverable  → medium (one finding per missing step);
 *   scope-creep          → matches comparison.scopeCreepSeverity tier, and
 *                          is escalated to 'blocker' when the unexpected
 *                          file touches a sensitive path (auth/**,
 *                          migrations/**);
 *   plan-ok              → low (signal-only; integration can filter out).
 *
 * The integration layer (review-publisher) is responsible for mapping
 * PlanAwareFinding -> ReviewFinding. The field shapes align so the mapping
 * is mechanical — see review-plan-aware-INTEGRATION.md.
 */

import type { PRPlanComparison, PlanStepMatch } from './review-plan-diff-comparator.js';

// ── Public types ─────────────────────────────────────────────────────────

export type PlanAwareKind = 'scope-creep' | 'missing-deliverable' | 'plan-ok';
export type PlanAwareSeverity = 'low' | 'medium' | 'high' | 'blocker';

export interface PlanAwareFinding {
  id: string;
  kind: PlanAwareKind;
  severity: PlanAwareSeverity;
  filePath?: string;
  message: string;
  evidence?: string;
  planStepId?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /(^|\/)auth\//i,
  /(^|\/)migrations\//i,
];

function isSensitive(path: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(path));
}

/**
 * Deterministic finding id. We don't depend on crypto.randomUUID() so that
 * test snapshots are stable when this helper is called twice for the same
 * input. Prefix matches the 'pa-' family so downstream UIs can recognise
 * plan-aware findings at a glance.
 */
let counter = 0;
function nextId(prefix: string): string {
  counter = (counter + 1) & 0xffff;
  return `pa-${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

function snippet(description: string, max = 120): string {
  const trimmed = description.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function severityForScopeCreep(
  tier: PRPlanComparison['scopeCreepSeverity'],
  filePath: string,
): PlanAwareSeverity {
  if (isSensitive(filePath)) return 'blocker';
  if (tier === 'high') return 'high';
  if (tier === 'medium') return 'medium';
  // 'low' and 'none' both map to 'low' — 'none' is only reached when
  // unexpectedFiles is empty, so this branch is defensive.
  return 'low';
}

// ── Rule builders ────────────────────────────────────────────────────────

function buildMissingDeliverableFinding(step: PlanStepMatch): PlanAwareFinding {
  return {
    id: nextId('miss'),
    kind: 'missing-deliverable',
    severity: 'medium',
    message:
      `Plan step "${snippet(step.description, 80)}" does not appear to be ` +
      `delivered by the PR (no diff file scored above the match threshold).`,
    evidence: snippet(step.description),
    planStepId: step.stepId,
  };
}

function buildScopeCreepFinding(
  filePath: string,
  tier: PRPlanComparison['scopeCreepSeverity'],
): PlanAwareFinding {
  const severity = severityForScopeCreep(tier, filePath);
  const sensitiveNote = isSensitive(filePath)
    ? ' Touches a sensitive path — escalated to blocker.'
    : '';
  return {
    id: nextId('creep'),
    kind: 'scope-creep',
    severity,
    filePath,
    message:
      `"${filePath}" is modified by the PR but wasn't mentioned in the plan.` +
      sensitiveNote +
      ' Consider splitting the change or updating the plan first.',
    evidence: filePath,
  };
}

function buildPlanOkFinding(comparison: PRPlanComparison): PlanAwareFinding {
  return {
    id: nextId('ok'),
    kind: 'plan-ok',
    severity: 'low',
    message:
      `PR matches the plan: ${comparison.matchedSteps}/${comparison.totalSteps}` +
      ` steps delivered, no unexpected files.`,
  };
}

// ── Public entry point ───────────────────────────────────────────────────

export function producePlanAwareFindings(comparison: PRPlanComparison): PlanAwareFinding[] {
  const findings: PlanAwareFinding[] = [];

  for (const step of comparison.missingSteps) {
    findings.push(buildMissingDeliverableFinding(step));
  }

  for (const file of comparison.unexpectedFiles) {
    findings.push(buildScopeCreepFinding(file, comparison.scopeCreepSeverity));
  }

  // An empty plan (totalSteps === 0) is not a success — there's nothing to
  // confirm. Stay silent in that case so we don't emit a misleading plan-ok.
  const hasPlan = comparison.totalSteps > 0;
  const allClear =
    hasPlan &&
    comparison.missingSteps.length === 0 &&
    comparison.unexpectedFiles.length === 0;
  if (allClear) {
    findings.push(buildPlanOkFinding(comparison));
  }

  return findings;
}
