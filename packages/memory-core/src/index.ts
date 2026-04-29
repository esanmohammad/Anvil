/**
 * @anvil/memory-core — public barrel.
 *
 * Phase 1: canonical types only. Subsequent phases populate:
 *   - Phase 2: hoisted JSONL store + queries + learners from cli/memory
 *   - Phase 3: SQLite hot index + FTS5
 *   - Phase 4: namespace API + factory
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
export { VERSION } from './version.js';
