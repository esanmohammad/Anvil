/**
 * Phase D3 — `structural-truncator` was promoted into
 * `core-pipeline/utils` so cli + dashboard share one canonical
 * code-aware truncator. This file is a back-compat re-export shim
 * so any in-flight branch keeps building.
 *
 * @deprecated Import from `@esankhan3/anvil-core-pipeline`:
 *   import { structurallyTruncate, looksLikeCode } from '@esankhan3/anvil-core-pipeline';
 */

export { structurallyTruncate, looksLikeCode } from '@esankhan3/anvil-core-pipeline';
export type { StructuralTruncateOptions } from '@esankhan3/anvil-core-pipeline';
