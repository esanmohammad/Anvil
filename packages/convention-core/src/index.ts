/**
 * `@anvil/convention-core` — public surface.
 *
 * Convention extraction (file naming, imports, tests, error handling),
 * rule engine + defaults (typescript, go, kafka), promotion ledger
 * (lessons → conventions), markdown + JSON storage. Used by the cli's
 * `learn` command, the dashboard's pipeline runner, and the review
 * prepass.
 */

// Path injection
export type { ConventionPaths } from './paths.js';

// Extraction
export { extractConventions } from './extractor.js';
export type { RepoConventions } from './aggregator.js';
export { aggregateConventions } from './aggregator.js';
export { formatConventions } from './formatter.js';

// Detectors (per-repo signal)
export { detectFileNaming } from './detectors/file-naming.js';
export { detectImportPatterns } from './detectors/import-patterns.js';
export { detectTestPatterns } from './detectors/test-patterns.js';
export { detectErrorHandling } from './detectors/error-handling.js';

// Loaders — markdown for prompts, JSON rules for review prepass
export { loadConventions, loadRules, ConventionFileTooLargeError } from './load.js';

// Rule types + engine
export type {
  ConventionRule,
  RuleSet,
  RuleSeverity,
  RuleViolation,
} from './rules/types.js';
export { loadRules as loadRuleSet } from './rules/loader.js';
export { evaluateRules } from './rules/engine.js';
export { mergeRules } from './rules/merger.js';

// Promotion ledger
export {
  trackViolation,
  getViolationCount,
  getViolations,
  normalizeError,
  generateRule,
  checkAndPromote,
  persistRule,
} from './promotion/index.js';
export type { ViolationRecord, PromotionResult } from './promotion/index.js';
