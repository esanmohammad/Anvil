// Memory module barrel — Section A.8

export type { MemoryKind, MemoryEntry, MemoryQueryOpts, MemoryStoreConfig } from './types.js';
export { DEFAULT_TTL_DAYS, MAX_SIZE_BYTES } from './types.js';
export { readJSONL, appendJSONL, writeJSONL } from './jsonl.js';
export { resolveMemoryPath } from './paths.js';
export { createMemoryEntry } from './entry-factory.js';
export type { CreateMemoryOpts } from './entry-factory.js';
export { MemoryStore } from './memory-store.js';
export { pruneExpired } from './expiration.js';
export { pruneBySize } from './size-prune.js';

// Section B exports
export { queryByTags } from './query-by-tags.js';
export { queryByContent } from './query-by-content.js';
export { selectTopK } from './top-k.js';
export { injectMemories } from './injector.js';
export { trackMemoryUsage } from './usage-tracker.js';

import { join } from 'node:path';
import { MemoryStore } from './memory-store.js';
import { resolveMemoryPath } from './paths.js';
import { pruneExpired } from './expiration.js';
import { pruneBySize } from './size-prune.js';
import { DEFAULT_TTL_DAYS, MAX_SIZE_BYTES } from './types.js';
import type { MemoryStoreConfig, MemoryEntry, MemoryKind, MemoryQueryOpts } from './types.js';

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
 */
export function createMemoryStore(project?: string): MemoryStore {
  const memPath = resolveMemoryPath(project);
  const config: MemoryStoreConfig = {
    path: memPath,
    maxSizeBytes: MAX_SIZE_BYTES,
    defaultTTLDays: DEFAULT_TTL_DAYS,
  };
  return new ManagedMemoryStore(config);
}
