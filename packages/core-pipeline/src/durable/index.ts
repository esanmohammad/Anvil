/**
 * Public surface for durable execution. The `core-pipeline` barrel
 * re-exports from here.
 */

export type {
  RunStatus,
  NewRunRecord,
  RunRecord,
  DurableEventKind,
  NewEventRecord,
  EventRecord,
  EffectEventPair,
  SignalRecord,
} from './types.js';

export {
  DeterminismViolationError,
  DurableStoreUnavailableError,
  EffectResultNotSerialisableError,
  Pattern1MigrationError,
} from './types.js';

export type { DurableStore, VacuumStats } from './store.js';
export { InMemoryDurableStore } from './in-memory-store.js';
export { SQLiteDurableStore } from './sqlite-store.js';
export type { SQLiteDurableStoreOptions } from './sqlite-store.js';
export { lintStepSource } from './lint.js';
export type { LintViolation } from './lint.js';
