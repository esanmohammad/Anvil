/**
 * Checkpoint hook — durable resume contract.
 *
 * Subscribes to `pipeline:started`, `step:started`, `step:completed`,
 * `step:skipped`, `step:failed`, `pipeline:completed`, `pipeline:failed`
 * and persists a JSON snapshot via a caller-injected `CheckpointStore`.
 * Default file-backed store writes `~/.anvil/runs/<runId>/checkpoint.json`.
 *
 * The snapshot fields (`completedSteps`, `currentStepId`, `status`) are
 * the input contract for `Pipeline.run({ resumeFromStep, completedSteps,
 * rewindTo })` — feed them straight back to resume.
 *
 * Successful completion deletes the checkpoint by default; pass
 * `keepOnSuccess: true` to retain it (e.g., for run history).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { EventBus, EventListener, PipelineEvent } from '../types.js';

export type CheckpointStatus = 'running' | 'completed' | 'failed';

export interface CheckpointSnapshot {
  runId: string;
  status: CheckpointStatus;
  completedSteps: string[];
  currentStepId?: string;
  failedStepId?: string;
  lastEventTs?: string;
  /** Optional shared-state mirror; off by default. */
  shared?: Record<string, unknown>;
  /** Schema marker so future readers can migrate. */
  v: 1;
}

export interface CheckpointStore {
  write(runId: string, snapshot: CheckpointSnapshot): void | Promise<void>;
  read(runId: string): CheckpointSnapshot | null | Promise<CheckpointSnapshot | null>;
  delete(runId: string): void | Promise<void>;
}

export interface CheckpointHookOptions {
  /** Pluggable persistence — defaults to `createFileCheckpointStore()`. */
  store?: CheckpointStore;
  /** Run id to persist under. Required. */
  runId: string;
  /**
   * Optional callback to capture the run's `ctx.shared` snapshot. Off by
   * default — `ctx.shared` may carry runner handles that don't serialize.
   * When provided, the return value is included in `snapshot.shared`.
   */
  getShared?: () => Record<string, unknown> | undefined;
  /**
   * Keep the checkpoint after `pipeline:completed`. Default false —
   * successful runs delete their checkpoint so resume is unambiguous.
   * Failed runs always keep their checkpoint regardless.
   */
  keepOnSuccess?: boolean;
  /** Override priority. Default 90 (after audit=100, before learners=50). */
  priority?: number;
  /**
   * Optional error sink — fires when the store throws. Defaults to
   * swallow + record on the handle's `lastError`.
   */
  onError?: (err: unknown) => void;
}

export interface CheckpointHookHandle {
  unsubscribe: () => void;
  /** Most recent persisted snapshot. */
  readonly snapshot: CheckpointSnapshot | undefined;
  /** Number of writes that succeeded. */
  readonly writeCount: number;
  /** Most recent store error (read or write). */
  readonly lastError: unknown;
}

const HOOKS: ReadonlyArray<PipelineEvent['hook']> = [
  'pipeline:started',
  'step:started',
  'step:completed',
  'step:skipped',
  'step:failed',
  'pipeline:completed',
  'pipeline:failed',
];

export function attachCheckpointHook(
  bus: EventBus,
  opts: CheckpointHookOptions,
): CheckpointHookHandle {
  const store = opts.store ?? createFileCheckpointStore();
  const priority = opts.priority ?? 90;
  const onError = opts.onError;
  const keepOnSuccess = opts.keepOnSuccess ?? false;

  let snapshot: CheckpointSnapshot | undefined;
  let writeCount = 0;
  let lastError: unknown;

  const persist = async (): Promise<void> => {
    if (!snapshot) return;
    if (opts.getShared) {
      try {
        snapshot.shared = opts.getShared();
      } catch (err) {
        lastError = err;
        onError?.(err);
      }
    }
    try {
      await store.write(opts.runId, snapshot);
      writeCount += 1;
    } catch (err) {
      lastError = err;
      onError?.(err);
    }
  };

  const drop = async (): Promise<void> => {
    try {
      await store.delete(opts.runId);
    } catch (err) {
      lastError = err;
      onError?.(err);
    }
  };

  const update = (mutator: (snap: CheckpointSnapshot) => CheckpointSnapshot): void => {
    const seed: CheckpointSnapshot = snapshot ?? {
      runId: opts.runId,
      status: 'running',
      completedSteps: [],
      v: 1,
    };
    snapshot = mutator(seed);
  };

  const listener: EventListener = async (event) => {
    switch (event.hook) {
      case 'pipeline:started':
        update(() => ({
          runId: opts.runId,
          status: 'running',
          completedSteps: [],
          lastEventTs: event.ts,
          v: 1,
        }));
        await persist();
        break;
      case 'step:started':
        update((snap) => ({ ...snap, currentStepId: event.stepId, lastEventTs: event.ts }));
        await persist();
        break;
      case 'step:completed':
      case 'step:skipped':
        update((snap) => ({
          ...snap,
          completedSteps: event.stepId ? [...snap.completedSteps, event.stepId] : snap.completedSteps,
          currentStepId: undefined,
          lastEventTs: event.ts,
        }));
        await persist();
        break;
      case 'step:failed':
        update((snap) => ({
          ...snap,
          status: 'failed',
          failedStepId: event.stepId,
          currentStepId: undefined,
          lastEventTs: event.ts,
        }));
        await persist();
        break;
      case 'pipeline:completed':
        update((snap) => ({ ...snap, status: 'completed', currentStepId: undefined, lastEventTs: event.ts }));
        await persist();
        if (!keepOnSuccess) {
          await drop();
        }
        break;
      case 'pipeline:failed':
        update((snap) => ({ ...snap, status: 'failed', currentStepId: undefined, lastEventTs: event.ts }));
        await persist();
        break;
      default:
        break;
    }
  };

  const offs = HOOKS.map((hook) => bus.on(hook, listener, { priority }));

  return {
    unsubscribe: () => { for (const off of offs) off(); },
    get snapshot() { return snapshot; },
    get writeCount() { return writeCount; },
    get lastError() { return lastError; },
  };
}

// ---------------------------------------------------------------------------
// File-backed default store
// ---------------------------------------------------------------------------

export interface FileCheckpointStoreOptions {
  /** Override root. Defaults to `${ANVIL_HOME or $HOME/.anvil}/runs`. */
  rootDir?: string;
}

/**
 * Default file-backed `CheckpointStore`. Writes
 * `<rootDir>/<runId>/checkpoint.json` synchronously. Reads return null
 * if the file does not exist or fails to parse.
 */
export function createFileCheckpointStore(
  opts: FileCheckpointStoreOptions = {},
): CheckpointStore {
  const root = opts.rootDir ?? defaultRootDir();
  const pathFor = (runId: string): string => join(root, runId, 'checkpoint.json');

  return {
    write(runId, snapshot) {
      const path = pathFor(runId);
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf8');
    },
    read(runId) {
      const path = pathFor(runId);
      if (!existsSync(path)) return null;
      try {
        const txt = readFileSync(path, 'utf8');
        const parsed = JSON.parse(txt) as CheckpointSnapshot;
        return parsed.v === 1 ? parsed : null;
      } catch {
        return null;
      }
    },
    delete(runId) {
      const path = pathFor(runId);
      if (existsSync(path)) {
        rmSync(path, { force: true });
      }
    },
  };
}

function defaultRootDir(): string {
  const home = process.env.ANVIL_HOME ?? join(homedir(), '.anvil');
  return join(home, 'runs');
}
