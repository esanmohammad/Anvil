/**
 * @anvil/memory-core/drift — code-fact drift detection (Phase 6).
 */

export {
  checkCodeBindingDrift,
  type DriftCheckOptions,
  type DriftCheckResult,
  type DriftStatus,
} from './drift-detector.js';
export {
  verifyCodeBindings,
  type DriftPolicy,
  type VerifyCodeBindingsOptions,
  type VerifyCodeBindingsResult,
} from './verify.js';
export { detectLanguageFromPath } from './language.js';
