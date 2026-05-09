/**
 * Phase F2 — `model-tier-resolver` was promoted into
 * `@esankhan3/anvil-agent-core` because tier-based routing is
 * provider-shaped (same layer as `model-catalog`). The dashboard's
 * discovery layer (`provider-registry.ts`, FS+exec heavy) stays here
 * and produces values that satisfy the resolver's structural input
 * types (`ResolverDiscoveryResult` / `ResolverModel`).
 *
 * This file is a back-compat re-export shim so any in-flight branch
 * keeps building.
 *
 * @deprecated Import from `@esankhan3/anvil-agent-core`:
 *   import {
 *     resolveModelByTier, setDiscoveryResult, invalidateResolverCache,
 *     type ModelTier, type ResolverDiscoveryResult, type ResolverModel
 *   } from '@esankhan3/anvil-agent-core';
 */

export {
  resolveModelByTier,
  setDiscoveryResult,
  invalidateResolverCache,
} from '@esankhan3/anvil-agent-core';
export type {
  ResolverTier,
  ResolverCapability,
  ResolverModelWeight,
  ResolverModel,
  ResolverDiscoveryResult,
} from '@esankhan3/anvil-agent-core';
// `ModelTier` is dashboard's legacy alias for the resolver's tier
// vocabulary. Kept as a back-compat re-export so any in-flight
// branch keeps building. Prefer `ResolverTier` going forward.
import type { ResolverTier as _ResolverTier } from '@esankhan3/anvil-agent-core';
/** @deprecated Use `ResolverTier` from `@esankhan3/anvil-agent-core`. */
export type ModelTier = _ResolverTier;
