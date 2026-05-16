/**
 * Dashboard-state rollup hook (CORE-PIPELINE-EXTRACT-ADR.md §4.5).
 *
 * Subscribes to the canonical pipeline events plus the four
 * dashboard-domain events (`stage:repo-progress`, `stage:cost-update`,
 * `stage:fix-attempt`, `reviewer:note`) and mutates a caller-supplied
 * mutable `state` object so the dashboard's `this.state` rollup stays
 * current. A debounced `broadcast()` callback fires after each
 * mutation batch — replaces the ~30 inline `this.broadcastState()`
 * calls scattered through `pipeline-runner.ts`.
 *
 * The hook is structural: any state shape satisfying
 * `DashboardRollupState` works (the dashboard's `PipelineRunState`
 * trivially does). The hook never throws; per-event errors land on
 * `lastError` for tests / diagnostics.
 *
 * Priority slot: 10 (same as `attachDashboardStateHook`). FIFO
 * tie-break preserves caller-supplied registration order.
 */
import type {
  EventBus,
  EventListener,
  PipelineEvent,
  StageRepoProgressPayload,
  StageCostUpdatePayload,
  StageFixAttemptPayload,
  ReviewerNotePayload,
} from '../types.js';

/** Structural shape a caller's state object must satisfy. */
export interface DashboardRollupState {
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting';
  currentStage: number;
  totalCost: number;
  stages: DashboardRollupStageState[];
}

/** Per-stage shape inside `state.stages`. */
export interface DashboardRollupStageState {
  /** Stable stage id — matches `Step.id`. */
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting';
  startedAt: string | null;
  completedAt: string | null;
  cost: number;
  artifact: string;
  error: string | null;
  repos: DashboardRollupRepoState[];
  /**
   * Most recent fix-attempt counter for the validate→fix loop. Absent
   * outside that loop. Updated on `stage:fix-attempt` events.
   */
  fixAttempt?: { attempt: number; maxAttempts: number; phase: 'fix' | 'revalidate' };
  /**
   * Most recent reviewer note armed for this stage. Cleared by the
   * caller once the next stage consumes it.
   */
  reviewerNote?: { note: string; source: 'pause-resolution' | 'edit-artifact' };
}

/** Per-repo shape inside `state.stages[i].repos`. */
export interface DashboardRollupRepoState {
  repoName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  cost: number;
  error?: string;
}

export interface DashboardStateRollupHookOptions {
  /** The mutable state object the hook updates in place. */
  state: DashboardRollupState;
  /**
   * Called (debounced) after each batch of mutations. The dashboard
   * passes its `this.broadcastState` here.
   */
  broadcast: () => void;
  /** Debounce window in ms for `broadcast()`. Default 50. */
  debounceMs?: number;
  /** Override priority. Default 10 (same slot as dashboard-state hook). */
  priority?: number;
  /** Test seam — defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Test seam — defaults to `clearTimeout`. */
  clearTimer?: (handle: unknown) => void;
}

export interface DashboardStateRollupHookHandle {
  unsubscribe: () => void;
  /** Force-flush a pending broadcast. */
  flush: () => void;
  /** Most recent error, for tests + diagnostics. */
  readonly lastError: Error | undefined;
  /** Number of broadcasts that have fired. */
  readonly broadcastCount: number;
}

const HOOKS: ReadonlyArray<PipelineEvent['hook']> = [
  'pipeline:started',
  'pipeline:completed',
  'pipeline:failed',
  'step:started',
  'step:completed',
  'step:failed',
  'step:skipped',
  'stage:repo-progress',
  'stage:cost-update',
  'stage:fix-attempt',
  'reviewer:note',
];

export function attachDashboardStateRollupHook(
  bus: EventBus,
  opts: DashboardStateRollupHookOptions,
): DashboardStateRollupHookHandle {
  const debounceMs = opts.debounceMs ?? 50;
  const priority = opts.priority ?? 10;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const { state } = opts;
  let pending: unknown;
  let lastError: Error | undefined;
  let broadcastCount = 0;

  const fireNow = (): void => {
    pending = undefined;
    try {
      opts.broadcast();
      broadcastCount += 1;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  };

  const schedule = (): void => {
    if (pending !== undefined) clearTimer(pending);
    pending = setTimer(fireNow, debounceMs);
  };

  const findStage = (stepId: string | undefined): DashboardRollupStageState | undefined => {
    if (!stepId) return undefined;
    return state.stages.find((s) => s.name === stepId);
  };

  const findStageByIndex = (idx: number): DashboardRollupStageState | undefined =>
    state.stages[idx];

  const upsertRepo = (
    stage: DashboardRollupStageState,
    repoName: string,
  ): DashboardRollupRepoState => {
    let repo = stage.repos.find((r) => r.repoName === repoName);
    if (!repo) {
      repo = { repoName, status: 'pending', cost: 0 };
      stage.repos.push(repo);
    }
    return repo;
  };

  const listener: EventListener = (event) => {
    try {
      switch (event.hook) {
        case 'pipeline:started':
          state.runId = event.runId;
          state.status = 'running';
          schedule();
          break;
        case 'pipeline:completed':
          state.status = 'completed';
          schedule();
          break;
        case 'pipeline:failed':
          state.status = 'failed';
          schedule();
          break;
        case 'step:started': {
          const stage = findStage(event.stepId);
          if (stage) {
            stage.status = 'running';
            stage.startedAt = event.ts;
            stage.error = null;
            const idx = state.stages.findIndex((s) => s.name === event.stepId);
            if (idx >= 0) state.currentStage = idx;
            schedule();
          }
          break;
        }
        case 'step:completed': {
          const stage = findStage(event.stepId);
          if (stage) {
            stage.status = 'completed';
            stage.completedAt = event.ts;
            schedule();
          }
          break;
        }
        case 'step:failed': {
          const stage = findStage(event.stepId);
          if (stage) {
            stage.status = 'failed';
            stage.completedAt = event.ts;
            stage.error = event.error?.message ?? 'unknown error';
            schedule();
          }
          break;
        }
        case 'step:skipped': {
          const stage = findStage(event.stepId);
          if (stage) {
            stage.status = 'skipped';
            stage.completedAt = event.ts;
            schedule();
          }
          break;
        }
        case 'stage:repo-progress': {
          const p = event.payload as StageRepoProgressPayload | undefined;
          if (!p) break;
          const stage = findStageByIndex(p.stageIndex) ?? findStage(p.stageId);
          if (!stage) break;
          const repo = upsertRepo(stage, p.repoName);
          repo.status = p.status;
          if (typeof p.costUsd === 'number') repo.cost = p.costUsd;
          if (p.error) repo.error = p.error.message;
          else if (p.status !== 'failed') delete repo.error;
          schedule();
          break;
        }
        case 'stage:cost-update': {
          const p = event.payload as StageCostUpdatePayload | undefined;
          if (!p) break;
          state.totalCost = p.totalUsd;
          const stage = findStageByIndex(p.stageIndex) ?? findStage(p.stageId);
          if (stage) stage.cost += p.deltaUsd;
          schedule();
          break;
        }
        case 'stage:fix-attempt': {
          const p = event.payload as StageFixAttemptPayload | undefined;
          if (!p) break;
          const stage = findStageByIndex(p.stageIndex) ?? findStage(p.stageId);
          if (!stage) break;
          stage.fixAttempt = {
            attempt: p.attempt,
            maxAttempts: p.maxAttempts,
            phase: p.phase,
          };
          schedule();
          break;
        }
        case 'reviewer:note': {
          const p = event.payload as ReviewerNotePayload | undefined;
          if (!p) break;
          const stage = findStageByIndex(p.stageIndex) ?? findStage(p.stageId);
          if (!stage) break;
          stage.reviewerNote = { note: p.note, source: p.source };
          schedule();
          break;
        }
        default:
          break;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
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
        fireNow();
      }
    },
    get lastError() {
      return lastError;
    },
    get broadcastCount() {
      return broadcastCount;
    },
  };
}
