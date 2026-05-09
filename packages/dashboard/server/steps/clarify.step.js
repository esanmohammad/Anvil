/**
 * Phase H1 — `clarify.step` was promoted into
 * `core-pipeline/src/steps/clarify.step.ts`. This file is a back-compat
 * re-export shim so any in-flight branch keeps building. The
 * `dashboard/server/steps/index.ts` barrel still picks it up, and
 * pipeline-runner.ts (when it adopts the canonical path in Phase I)
 * will import directly from @esankhan3/anvil-core-pipeline.
 *
 * @deprecated Import from `@esankhan3/anvil-core-pipeline`:
 *   import { createClarifyStep, parseClarifyQuestions, formatQAPairs,
 *     buildClarifySynthesisPrompt, CLARIFY_QA_ARTIFACT_ID,
 *     type ClarifyStepOptions, type ClarifyResult, type ClarifyQAPair,
 *     type ClarifyEvent }
 *     from '@esankhan3/anvil-core-pipeline';
 */
export { createClarifyStep, CLARIFY_QA_ARTIFACT_ID, parseClarifyQuestions, formatQAPairs, buildClarifySynthesisPrompt, } from '@esankhan3/anvil-core-pipeline';
//# sourceMappingURL=clarify.step.js.map