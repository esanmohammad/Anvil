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
  NewAssistantPartialRecord,
  AssistantPartialRecord,
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
export { LeaseManager, tryTakeOverLease, findOrphanedRuns } from './lease-manager.js';
export type { LeaseManagerOptions, LeaseManagerEvents } from './lease-manager.js';
export { serializeAgentRunResult, contentHash, artifactIdempotencyKey } from './effect-helpers.js';
export {
  computeSkipSetDivergence,
  hasSkipSetDivergence,
  formatSkipSetDivergence,
} from './skip-reconcile.js';
export type { SkipSetDivergence } from './skip-reconcile.js';
export { seedStoreFromLog, throwingSpy, countingSpy, DURABLE_WRITE_OPS } from './replay-equivalence.js';
export type { CountingSpy, ThrowingSpyOptions } from './replay-equivalence.js';

// §2.5.1 / §2.4 turn-level resume helpers + §2.6 cost rollup.
export {
  readCompletedTurns,
  nextTurnSeed,
  buildPrefillFromPartial,
  reconstructSessionHistory,
  estimatePrefillTokens,
} from './turn-resume.js';
export {
  rollupStepCostByModel,
  rollupStepCostAcrossSubsteps,
  mergeRollups,
  rollupIsEmpty,
} from './cost-rollup.js';
export type { ModelCost, StepCostRollup, StepContinuation } from './cost-rollup.js';
export {
  EffectRuntime,
  createScopedEffectRuntime,
  effectKeyMatchesScope,
} from './effect-runtime.js';
