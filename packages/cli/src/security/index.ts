/**
 * Security Guardrails — barrel exports.
 */

export { SecretScanner, type SecretFinding } from './secret-scanner.js';
export { DependencyChecker, type DependencyFinding, type DependencyCheckResult } from './dependency-checker.js';
export { DiffSizeGuard, type DiffSizeResult, type DiffSizeConfig } from './diff-size-guard.js';
export { SharpEdgeDetector, type SharpEdgeFinding } from './sharp-edge-detector.js';
