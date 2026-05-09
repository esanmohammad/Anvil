/**
 * Phase F1 — `model-catalog` was promoted into `@esankhan3/anvil-agent-core`
 * because token-limit knowledge is provider-shaped and lives one layer
 * down with the adapters. This file is a back-compat re-export shim so
 * any in-flight branch keeps building.
 *
 * @deprecated Import from `@esankhan3/anvil-agent-core`:
 *   import { getModelSpec, getContextWindow, getMaxOutput, DEFAULT_SPEC, type ModelSpec }
 *     from '@esankhan3/anvil-agent-core';
 */

export {
  DEFAULT_SPEC,
  getModelSpec,
  getContextWindow,
  getMaxOutput,
} from '@esankhan3/anvil-agent-core';
export type { ModelSpec } from '@esankhan3/anvil-agent-core';
