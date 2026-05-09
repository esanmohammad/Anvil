/**
 * Phase F12 — `feature-manifest-extractors` was promoted into
 * `core-pipeline/utils` so cli + dashboard share one canonical set of
 * deterministic regex parsers for the markdown headings personas
 * produce. This file is a back-compat re-export shim so any
 * in-flight branch keeps building.
 *
 * @deprecated Import from `@esankhan3/anvil-core-pipeline`:
 *   import {
 *     extractAcceptanceCriteria, extractAffectedRepos, extractApiEndpoints,
 *     extractTablesTouched, extractFilesPlanned, extractTestBehaviors,
 *     extractChangeBrief, extractOpenQuestions,
 *     type ExtractorResult, type ManifestExtractor,
 *   } from '@esankhan3/anvil-core-pipeline';
 */

export {
  extractAcceptanceCriteria,
  extractAffectedRepos,
  extractApiEndpoints,
  extractTablesTouched,
  extractFilesPlanned,
  extractTestBehaviors,
  extractChangeBrief,
  extractOpenQuestions,
} from '@esankhan3/anvil-core-pipeline';
export type {
  ExtractorResult,
  ManifestExtractor,
} from '@esankhan3/anvil-core-pipeline';
