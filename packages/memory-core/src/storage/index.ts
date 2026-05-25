/**
 * @esankhan3/anvil-memory-core/storage — v2 hybrid storage barrel.
 *
 * JSONL append-only canonical + SQLite hot index per ADR §M1.
 */

export { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
export { SqliteHotIndex, type SearchOpts } from './sqlite-store.js';
export { JsonlAppendLog } from './jsonl-store.js';
export {
  HybridMemoryStore,
  type OpenHybridOptions,
  type RebuildResult,
  type NamespaceQueryOpts,
} from './hybrid-store.js';
export {
  MemoryVectorStore,
  setEmbedder,
  getEmbedder,
  type Embedder,
  type VectorHit,
} from './vector-store.js';
export {
  InjectionLog,
  type InjectionRecord,
  type HitStats,
} from './injection-log.js';
