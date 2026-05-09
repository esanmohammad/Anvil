/**
 * `@esankhan3/anvil-core-pipeline/utils` — shared utility helpers used
 * by both cli and dashboard pipeline drivers. Pure functions, no
 * filesystem / network side effects.
 */

export {
  heuristicTokenCount,
  heuristicTokenCountFromBytes,
  countTokens,
} from './token-util.js';
export { structurallyTruncate, looksLikeCode } from './structural-truncator.js';
export type { StructuralTruncateOptions } from './structural-truncator.js';
export {
  parseSections,
  findSection,
  sliceSpecForRefs,
} from './engineer-spec-slicer.js';
export type {
  SpecSection,
  SliceOptions,
  SliceResult,
} from './engineer-spec-slicer.js';
export {
  enforceBudget,
  estimateBudgetTokens,
} from './prompt-budget.js';
export type {
  PromptSection,
  BudgetOptions,
  BudgetDecision,
  BudgetResult,
} from './prompt-budget.js';
