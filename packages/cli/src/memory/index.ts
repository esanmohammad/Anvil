/**
 * cli memory barrel — re-exports from `@anvil/memory-core` (Phase 2 hoist)
 * with cli-specific orchestration that stays here:
 *   - resolveMemoryPath (project-aware via `getFFDirs()`)
 *   - createMemoryStore factory (wires resolveMemoryPath into the store)
 *   - injectMemories (project-aware orchestration over query helpers)
 *   - trackMemoryUsage (uses `getFFDirs().memory`)
 *
 * Existing consumers can keep importing from `'../memory'` unchanged —
 * symbol names match the pre-Phase-2 surface 1:1.
 */

export type {
  MemoryKind,
  MemoryEntry,
  MemoryQueryOpts,
  MemoryStoreConfig,
  CreateMemoryOpts,
} from '@anvil/memory-core/legacy/index.js';
export {
  DEFAULT_TTL_DAYS,
  MAX_SIZE_BYTES,
  readJSONL,
  appendJSONL,
  writeJSONL,
  MemoryStore,
  createMemoryEntry,
  pruneExpired,
  pruneBySize,
  queryByTags,
  queryByContent,
  selectTopK,
} from '@anvil/memory-core/legacy/index.js';

// cli-specific
export { resolveMemoryPath, resolveNamespacePath } from './paths.js';
export { injectMemories } from './injector.js';
export { trackMemoryUsage } from './usage-tracker.js';

import {
  MemoryStore,
  pruneExpired,
  pruneBySize,
  DEFAULT_TTL_DAYS,
  MAX_SIZE_BYTES,
} from '@anvil/memory-core/legacy/index.js';
import type {
  MemoryStoreConfig,
  MemoryEntry,
  MemoryKind,
  MemoryQueryOpts,
} from '@anvil/memory-core/legacy/index.js';
import type { MemoryNamespace } from '@anvil/memory-core';
import { resolveMemoryPath, resolveNamespacePath } from './paths.js';

/**
 * A MemoryStore wrapper that auto-prunes on list/query.
 */
class ManagedMemoryStore extends MemoryStore {
  list(kind?: MemoryKind): MemoryEntry[] {
    pruneExpired(this);
    pruneBySize(this);
    return super.list(kind);
  }

  query(opts: MemoryQueryOpts): MemoryEntry[] {
    pruneExpired(this);
    pruneBySize(this);
    return super.query(opts);
  }
}

/**
 * Factory: create a managed MemoryStore with auto-pruning.
 *
 * Accepts either a legacy positional project name (`createMemoryStore('foo')`)
 * or a v2 `MemoryNamespace` tuple (`createMemoryStore({scope: 'global'})`).
 * The path-aware resolver picks the correct on-disk directory under
 * `~/.anvil/memory/` for each form.
 */
export function createMemoryStore(target?: string | MemoryNamespace): MemoryStore {
  const memPath = isNamespace(target)
    ? resolveNamespacePath(target)
    : resolveMemoryPath(target);
  const config: MemoryStoreConfig = {
    path: memPath,
    maxSizeBytes: MAX_SIZE_BYTES,
    defaultTTLDays: DEFAULT_TTL_DAYS,
  };
  return new ManagedMemoryStore(config);
}

function isNamespace(v: unknown): v is MemoryNamespace {
  return (
    typeof v === 'object' &&
    v !== null &&
    'scope' in v &&
    typeof (v as { scope?: unknown }).scope === 'string'
  );
}
