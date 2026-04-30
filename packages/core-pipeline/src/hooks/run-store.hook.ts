/**
 * Run-store hook — Phase 4 of core-pipeline consolidation.
 *
 * Subscribes to the pipeline lifecycle and updates a `RunStore`-shaped
 * record so cli's `~/.anvil/runs/<runId>/record.json` reflects in-flight
 * progress. Mirrors the legacy `updateStageRecord(...)` calls scattered
 * across the orchestrator's per-stage blocks (one block per stage in
 * `cli/src/pipeline/orchestrator.ts:1024, 1065, 1126, ...`).
 *
 * The hook accepts a structural `RunStoreLike` interface rather than
 * importing cli's concrete `RunStore` class — keeps core-pipeline free
 * of cli-side dependencies while still letting cli inject its real
 * store.
 */

import type { EventBus, EventListener, PipelineEvent } from '../types.js';

export interface RunStoreLike {
  /**
   * Persist a stage transition. The hook calls this for every
   * step:started / step:completed / step:failed / step:skipped event.
   */
  updateStage(args: {
    runId: string;
    stepId: string;
    status: 'running' | 'completed' | 'failed' | 'skipped';
    durationMs?: number;
    error?: { message: string };
  }): void | Promise<void>;
  /** Marks the overall run as completed/failed/aborted. */
  updateRun(args: {
    runId: string;
    status: 'completed' | 'failed' | 'aborted';
    durationMs?: number;
    error?: { message: string };
  }): void | Promise<void>;
}

export interface RunStoreHookOptions {
  runStore: RunStoreLike;
  runId: string;
  /** Override priority. Default 80 (runs after audit-log, before learners). */
  priority?: number;
  /** Logger for write failures (kept fault-tolerant). */
  onError?: (err: Error, event: PipelineEvent) => void;
}

export interface RunStoreHookHandle {
  unsubscribe: () => void;
  /** Most recent write error. */
  readonly lastError: Error | undefined;
  /** Number of runStore writes attempted. */
  readonly writeCount: number;
}

const RUN_STORE_HOOKS: ReadonlyArray<PipelineEvent['hook']> = [
  'pipeline:completed',
  'pipeline:failed',
  'step:started',
  'step:completed',
  'step:failed',
  'step:skipped',
];

export function attachRunStoreHook(
  bus: EventBus,
  opts: RunStoreHookOptions,
): RunStoreHookHandle {
  const priority = opts.priority ?? 80;
  let lastError: Error | undefined;
  let writeCount = 0;

  const safeWrite = async (work: () => void | Promise<void>, event: PipelineEvent): Promise<void> => {
    writeCount += 1;
    try {
      await work();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      opts.onError?.(lastError, event);
    }
  };

  const listener: EventListener = async (event) => {
    if (event.runId !== opts.runId) return;

    switch (event.hook) {
      case 'step:started':
        if (!event.stepId) return;
        await safeWrite(
          () => opts.runStore.updateStage({
            runId: event.runId, stepId: event.stepId!, status: 'running',
          }),
          event,
        );
        return;
      case 'step:completed':
        if (!event.stepId) return;
        await safeWrite(
          () => opts.runStore.updateStage({
            runId: event.runId,
            stepId: event.stepId!,
            status: 'completed',
            durationMs: (event.payload as { durationMs?: number } | undefined)?.durationMs,
          }),
          event,
        );
        return;
      case 'step:failed':
        if (!event.stepId) return;
        await safeWrite(
          () => opts.runStore.updateStage({
            runId: event.runId,
            stepId: event.stepId!,
            status: 'failed',
            error: event.error ? { message: event.error.message } : undefined,
          }),
          event,
        );
        return;
      case 'step:skipped':
        if (!event.stepId) return;
        await safeWrite(
          () => opts.runStore.updateStage({
            runId: event.runId, stepId: event.stepId!, status: 'skipped',
          }),
          event,
        );
        return;
      case 'pipeline:completed':
        await safeWrite(
          () => opts.runStore.updateRun({
            runId: event.runId,
            status: 'completed',
            durationMs: (event.payload as { durationMs?: number } | undefined)?.durationMs,
          }),
          event,
        );
        return;
      case 'pipeline:failed':
        await safeWrite(
          () => opts.runStore.updateRun({
            runId: event.runId,
            status: 'failed',
            durationMs: (event.payload as { durationMs?: number } | undefined)?.durationMs,
            error: event.error ? { message: event.error.message } : undefined,
          }),
          event,
        );
        return;
    }
  };

  const offs = RUN_STORE_HOOKS.map((hook) => bus.on(hook, listener, { priority }));

  return {
    unsubscribe: () => {
      for (const off of offs) off();
    },
    get lastError() { return lastError; },
    get writeCount() { return writeCount; },
  };
}
