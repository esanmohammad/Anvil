/**
 * Phase F5 — `context-budget` was promoted into `core-pipeline/utils`
 * so cli + dashboard share one priority-aware context budget over
 * `model-catalog` + `token-util` + `structural-truncator`. This file
 * is a back-compat re-export shim so any in-flight branch keeps
 * building.
 *
 * The result shape was renamed `ContextBudgetResult` in the new home
 * to avoid colliding with `prompt-budget`'s `BudgetResult` (different
 * shape). The legacy `BudgetResult` alias is preserved here so
 * dashboard internals keep compiling.
 *
 * @deprecated Import from `@esankhan3/anvil-core-pipeline`:
 *   import {
 *     getModelTokenLimit, estimateTokens, applyBudget, budgetPromptContext,
 *     type ContextComponent, type ContextBudgetResult,
 *     type PromptBudgetInput, type PromptBudgetOutput,
 *   } from '@esankhan3/anvil-core-pipeline';
 */

export {
  getModelTokenLimit,
  estimateTokens,
  applyBudget,
  budgetPromptContext,
} from '@esankhan3/anvil-core-pipeline';
export type {
  ContextComponent,
  ContextBudgetResult,
  PromptBudgetInput,
  PromptBudgetOutput,
} from '@esankhan3/anvil-core-pipeline';

import type { ContextBudgetResult as _ContextBudgetResult } from '@esankhan3/anvil-core-pipeline';
/** @deprecated Use `ContextBudgetResult` from `@esankhan3/anvil-core-pipeline`. */
export type BudgetResult = _ContextBudgetResult;
