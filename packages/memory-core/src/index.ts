/**
 * @anvil/memory-core — public barrel.
 *
 * Phase 1: v2 canonical types (this file's `./types.js` re-export).
 * Phase 2: legacy primitives hoisted from `cli/src/memory/` — accessible
 *          via the subpath import `@anvil/memory-core/legacy/index.js` to
 *          avoid name collisions with the v2 schema (`MemoryKind` is
 *          different in legacy vs v2).
 *
 * Subsequent phases populate:
 *   - Phase 3: SQLite hot index + FTS5
 *   - Phase 4: namespace API + factory + v2 store
 *   - Phase 5: bi-temporal model
 *   - Phase 6: code-fact drift detection
 *   - Phase 7: PII/secret scrubber
 *   - Phase 8: vector + graph linking
 *   - Phase 9: Personalized PageRank retrieval
 *   - Phase 10: sleeptime + proposal queue
 *   - Phase 11: reflection on CI/PR completion
 *   - Phase 12: PR-as-episode primitive
 *   - Phase 13: migration importer
 *   - Phase 14: dashboard inspector + tests + docs
 *
 * See MEMORY-CORE-EXTRACT-PLAN.md + MEMORY-CORE-ADR.md for the canonical
 * decisions and per-phase scope.
 */

export * from './types.js';
export * from './storage/index.js';
export * from './namespace/index.js';
export * from './drift/index.js';
export * from './scrubber/index.js';
export * from './retrieve/index.js';
export * from './sleeptime/index.js';
export { VERSION } from './version.js';
