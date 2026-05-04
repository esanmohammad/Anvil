/**
 * Legacy memory primitives — hoisted from `cli/src/memory/` in Phase 2.
 *
 * These types pre-date the v2 schema in `../types.ts`. Per ADR §M4, the
 * legacy `MemoryKind` values (`fix-pattern`, `success`, `approach`,
 * `flaky-test`, `performance`, `manual`) become `SemanticSubtype` in v2,
 * but the relocation in Phase 2 is **pure file movement** — no semantic
 * change. Phase 4 ports callers onto the v2 schema.
 *
 * Imported by:
 *   - cli/src/memory/index.ts (re-exports under canonical names so existing
 *     consumers keep working)
 *   - cli/src/conventions/promotion/violation-tracker.ts (uses jsonl.ts
 *     directly)
 */

export type {
  MemoryKind,
  MemoryEntry,
  MemoryQueryOpts,
  MemoryStoreConfig,
} from './types.js';
export { DEFAULT_TTL_DAYS, MAX_SIZE_BYTES } from './types.js';
export { readJSONL, appendJSONL, writeJSONL } from './jsonl.js';
export { MemoryStore } from './memory-store.js';
export { createMemoryEntry, type CreateMemoryOpts } from './entry-factory.js';
export { pruneExpired } from './expiration.js';
export { pruneBySize } from './size-prune.js';
export { queryByTags } from './query-by-tags.js';
export { queryByContent } from './query-by-content.js';
export { selectTopK } from './top-k.js';
