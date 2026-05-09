/**
 * Phase F8 — `plan-to-artifacts` was promoted into
 * `core-pipeline/utils` so cli + dashboard share one canonical Plan →
 * Markdown renderer (REQUIREMENTS.md, SPECS.md, TASKS.md). This file
 * is a back-compat re-export shim so any in-flight branch keeps
 * building.
 *
 * @deprecated Import from `@esankhan3/anvil-core-pipeline`:
 *   import {
 *     renderRequirements, renderRepoRequirements, renderRepoSpecs,
 *     renderRepoTasks, planCoversRepo, planCoversStagesForRepo,
 *     planCoversCrossRepo, summarisePlanSkip,
 *   } from '@esankhan3/anvil-core-pipeline';
 */

export {
  renderRequirements,
  renderRepoRequirements,
  renderRepoSpecs,
  renderRepoTasks,
  planCoversRepo,
  planCoversStagesForRepo,
  planCoversCrossRepo,
  summarisePlanSkip,
} from '@esankhan3/anvil-core-pipeline';
export type { PlanRepoImpact } from '@esankhan3/anvil-core-pipeline';
