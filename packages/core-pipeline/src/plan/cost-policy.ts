/**
 * Default cost policy — built-in caps for plan-flow + pipeline spend.
 *
 * Until an end-user supplies a project-level policy file, every spawn
 * site reads from `DEFAULT_COST_POLICY`. The policy is intentionally
 * lean: budgets are per-stage USD ceilings; exceeding the cap fails
 * the stage with a structured `CostBreachError` so the dashboard's
 * cost-breach handler can surface it.
 */

export interface CostPolicy {
  /** Hard ceiling for the entire run. */
  maxPerRunUsd: number;
  /** Hard ceiling for a single Clarify/QA cycle. */
  maxPerClarifyUsd: number;
  /** Hard ceiling for a single plan-draft (initial planner spawn). */
  maxPerPlanDraftUsd: number;
  /**
   * Total ceiling for auto-refine retries on a single plan. Applies
   * across all targeted regens for a given plan version.
   */
  maxPerPlanRefineUsd: number;
  /** Hard ceiling for a build stage per repo. */
  maxPerBuildRepoUsd: number;
  /** Hard ceiling for the validate stage's test suite. */
  maxPerValidateUsd: number;
  /** Hard ceiling for the ship stage. */
  maxPerShipUsd: number;
}

export const DEFAULT_COST_POLICY: Readonly<CostPolicy> = Object.freeze({
  maxPerRunUsd: 5.0,
  maxPerClarifyUsd: 0.30,
  maxPerPlanDraftUsd: 0.50,
  maxPerPlanRefineUsd: 1.50,
  maxPerBuildRepoUsd: 1.50,
  maxPerValidateUsd: 0.50,
  maxPerShipUsd: 0.30,
});

/**
 * Caller-supplied overrides merged onto `DEFAULT_COST_POLICY`. Any
 * undefined field falls back to the default value — this is the
 * preferred way to read effective caps in pipeline code.
 */
export function resolveCostPolicy(overrides?: Partial<CostPolicy>): CostPolicy {
  if (!overrides) return { ...DEFAULT_COST_POLICY };
  return { ...DEFAULT_COST_POLICY, ...overrides };
}

/**
 * Error thrown when a spawn would exceed the policy's per-stage cap.
 * Dashboard-side cost-breach handler catches this and reports it via
 * a structured `plan-validation` event.
 */
export class CostBreachError extends Error {
  readonly name = 'CostBreachError';
  constructor(
    readonly stage: string,
    readonly attemptedUsd: number,
    readonly capUsd: number,
  ) {
    super(`cost breach at ${stage}: attempted $${attemptedUsd.toFixed(2)} exceeds cap $${capUsd.toFixed(2)}`);
  }
}
