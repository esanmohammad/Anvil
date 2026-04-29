/**
 * Dashboard-state hook — debounced JSON snapshot of pipeline progress.
 *
 * Subscribes to `step:started`, `step:completed`, `step:failed`,
 * `pipeline:started`, `pipeline:completed`, `pipeline:failed`. The state
 * file is written via the supplied `writer` (defaults to `writeFileSync`)
 * after a `debounceMs` window — matches the legacy `state-file.ts`
 * 100ms debounce.
 *
 * Path defaults to `~/.anvil/state.json`. The hook never throws; failures
 * surface via `lastError` for tests + diagnostics.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventBus, EventListener, PipelineEvent } from '../types.js';

export interface DashboardStateSnapshot {
  runId: string;
  status: 'running' | 'completed' | 'failed';
  currentStepId?: string;
  completedStepIds: string[];
  failedStepId?: string;
  lastEventTs?: string;
}

export interface DashboardStateHookOptions {
  /** Absolute path to the state JSON. */
  path: string;
  /** Debounce window in ms. Default 100. */
  debounceMs?: number;
  /** Override priority. Default 10. */
  priority?: number;
  /** Test seam — defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Test seam — defaults to `clearTimeout`. */
  clearTimer?: (handle: unknown) => void;
  /** Test seam — defaults to `writeFileSync`. */
  writer?: (path: string, contents: string) => void;
}

export interface DashboardStateHookHandle {
  unsubscribe: () => void;
  /** Force-flush any pending debounced write. */
  flush: () => void;
  /** Most recent write error, for tests + diagnostics. */
  readonly lastError: Error | undefined;
  /** Number of state writes that have been flushed. */
  readonly writeCount: number;
  /** Latest snapshot the hook has seen (in-memory). */
  readonly snapshot: DashboardStateSnapshot | undefined;
}

const HOOKS: ReadonlyArray<PipelineEvent['hook']> = [
  'pipeline:started',
  'pipeline:completed',
  'pipeline:failed',
  'step:started',
  'step:completed',
  'step:failed',
];

export function attachDashboardStateHook(
  bus: EventBus,
  opts: DashboardStateHookOptions,
): DashboardStateHookHandle {
  const debounceMs = opts.debounceMs ?? 100;
  const priority = opts.priority ?? 10;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const writer = opts.writer ?? ((p, c) => writeFileSync(p, c, 'utf8'));

  let snapshot: DashboardStateSnapshot | undefined;
  let pending: unknown;
  let lastError: Error | undefined;
  let writeCount = 0;

  ensureDir(opts.path);

  const writeNow = (): void => {
    if (!snapshot) return;
    pending = undefined;
    try {
      writer(opts.path, JSON.stringify(snapshot, null, 2));
      writeCount += 1;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  };

  const scheduleWrite = (): void => {
    if (pending !== undefined) clearTimer(pending);
    pending = setTimer(writeNow, debounceMs);
  };

  const update = (mutator: (snap: DashboardStateSnapshot) => DashboardStateSnapshot): void => {
    const seed: DashboardStateSnapshot = snapshot ?? {
      runId: '',
      status: 'running',
      completedStepIds: [],
    };
    snapshot = mutator(seed);
    scheduleWrite();
  };

  const listener: EventListener = (event) => {
    switch (event.hook) {
      case 'pipeline:started':
        update(() => ({
          runId: event.runId,
          status: 'running',
          completedStepIds: [],
          lastEventTs: event.ts,
        }));
        break;
      case 'pipeline:completed':
        update((snap) => ({ ...snap, status: 'completed', lastEventTs: event.ts }));
        break;
      case 'pipeline:failed':
        update((snap) => ({ ...snap, status: 'failed', lastEventTs: event.ts }));
        break;
      case 'step:started':
        update((snap) => ({
          ...snap,
          currentStepId: event.stepId,
          lastEventTs: event.ts,
        }));
        break;
      case 'step:completed':
        update((snap) => ({
          ...snap,
          completedStepIds: event.stepId
            ? [...snap.completedStepIds, event.stepId]
            : snap.completedStepIds,
          currentStepId: undefined,
          lastEventTs: event.ts,
        }));
        break;
      case 'step:failed':
        update((snap) => ({
          ...snap,
          failedStepId: event.stepId,
          currentStepId: undefined,
          lastEventTs: event.ts,
        }));
        break;
      default:
        break;
    }
  };

  const offs = HOOKS.map((hook) => bus.on(hook, listener, { priority }));

  return {
    unsubscribe: () => {
      for (const off of offs) off();
      if (pending !== undefined) clearTimer(pending);
    },
    flush: () => {
      if (pending !== undefined) {
        clearTimer(pending);
        writeNow();
      }
    },
    get lastError() {
      return lastError;
    },
    get writeCount() {
      return writeCount;
    },
    get snapshot() {
      return snapshot;
    },
  };
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
