/**
 * Phase F3 — `engineer-spec-slicer` was promoted into
 * `core-pipeline/utils` so cli + dashboard share one canonical
 * SPECS.md slicer. This file is a back-compat re-export shim so any
 * in-flight branch keeps building.
 *
 * @deprecated Import from `@esankhan3/anvil-core-pipeline`:
 *   import { parseSections, findSection, sliceSpecForRefs,
 *     type SpecSection, type SliceOptions, type SliceResult }
 *     from '@esankhan3/anvil-core-pipeline';
 */

export {
  parseSections,
  findSection,
  sliceSpecForRefs,
} from '@esankhan3/anvil-core-pipeline';
export type {
  SpecSection,
  SliceOptions,
  SliceResult,
} from '@esankhan3/anvil-core-pipeline';
