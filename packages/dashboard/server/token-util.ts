/**
 * Phase D3 — `token-util` was promoted into `core-pipeline/utils` so
 * cli + dashboard share one canonical heuristic. This file is a
 * back-compat re-export shim so any in-flight branch keeps building.
 *
 * @deprecated Import from `@esankhan3/anvil-core-pipeline`:
 *   import { heuristicTokenCount, heuristicTokenCountFromBytes, countTokens }
 *     from '@esankhan3/anvil-core-pipeline';
 */

export {
  heuristicTokenCount,
  heuristicTokenCountFromBytes,
  countTokens,
} from '@esankhan3/anvil-core-pipeline';
