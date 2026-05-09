/**
 * Phase F6 — `engineer-task-bundler` was promoted into
 * `core-pipeline/utils` so cli + dashboard build/test stages share one
 * canonical TASKS.md parser + dep-graph scheduler + file bundler. This
 * file is a back-compat re-export shim so any in-flight branch keeps
 * building.
 *
 * @deprecated Import from `@esankhan3/anvil-core-pipeline`:
 *   import {
 *     parseTasks, groupTasksForExecution, runTasksWithDependencyGraph,
 *     extractAllTaskFiles, bundleFiles,
 *     type ParsedTask, type ExecutionGroup, type BundleOptions,
 *     type SkipReason, type BundleResult, type RunTasksOptions,
 *     type RunTasksHooks,
 *   } from '@esankhan3/anvil-core-pipeline';
 */

export {
  parseTasks,
  groupTasksForExecution,
  runTasksWithDependencyGraph,
  extractAllTaskFiles,
  bundleFiles,
} from '@esankhan3/anvil-core-pipeline';
export type {
  ParsedTask,
  ExecutionGroup,
  BundleOptions,
  SkipReason,
  BundleResult,
  RunTasksOptions,
  RunTasksHooks,
} from '@esankhan3/anvil-core-pipeline';
