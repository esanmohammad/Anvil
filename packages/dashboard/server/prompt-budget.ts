/**
 * Phase F4 — `prompt-budget` was promoted into `core-pipeline/utils`
 * so the cli prompt-builder, dashboard prompt-builder, and any future
 * tooling share one byte-budget enforcer over `token-util`. This file
 * is a back-compat re-export shim so any in-flight branch keeps
 * building.
 *
 * @deprecated Import from `@esankhan3/anvil-core-pipeline`:
 *   import { enforceBudget, estimateBudgetTokens,
 *     type PromptSection, type BudgetOptions, type BudgetDecision,
 *     type BudgetResult }
 *     from '@esankhan3/anvil-core-pipeline';
 */

export {
  enforceBudget,
  estimateBudgetTokens,
} from '@esankhan3/anvil-core-pipeline';
export type {
  PromptSection,
  BudgetOptions,
  BudgetDecision,
  BudgetResult,
} from '@esankhan3/anvil-core-pipeline';
