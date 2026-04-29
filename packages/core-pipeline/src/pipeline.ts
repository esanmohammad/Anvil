/**
 * `Pipeline` runner — Phase 3 walker, extended in Phase 7 with sub-step
 * recursion + per-step retry policy.
 *
 * Walks the registered steps in order, threading each step's output into
 * the next step's `StepContext.input`. Emits the lifecycle events that
 * cross-cutting hooks (audit, dashboard, learners, cost) subscribe to.
 *
 * Event order per run:
 *   - pipeline:started   (once)
 *   - per step: step:started → [for sub-steps: sub-step:started →
 *     sub-step:completed] → step:completed | step:failed | step:retried
 *   - pipeline:completed | pipeline:failed | pipeline:aborted (once)
 *
 * Sub-step semantics (Phase 7):
 *   - When a Step declares `subSteps: Step<unknown, unknown>[]`, the
 *     walker runs each sub-step in sequence before invoking the parent
 *     step's `run()`. Each sub-step emits `sub-step:started` and
 *     `sub-step:completed` (the payload carries `parentStepId`).
 *   - Sub-step failures bubble up: the parent step's `run` is skipped
 *     and the parent emits `step:failed`.
 *
 * Retry semantics (Phase 7):
 *   - When a Step (parent or sub) declares `retryPolicy`, transient
 *     failures trigger up to `attempts` retries with exponential /
 *     linear / constant backoff (see `computeBackoff`).
 *   - `retryOn` is consulted before each retry; if it returns false the
 *     error is treated as terminal.
 *   - `step:retried` fires before each retry attempt.
 */

import { InMemoryArtifactStore } from './artifacts.js';
import type {
  EventBus,
  LlmHandles,
  MemoryHandles,
  PipelineEvent,
  PipelineRunResult,
  Step,
  StepContext,
  StepHookPoint,
  StepRegistry,
  StepRetryPolicy,
} from './types.js';

export interface PipelineDeps {
  registry: StepRegistry;
  bus: EventBus;
  runId: string;
  workspaceDir: string;
  /** Optional initial input for the first step. Defaults to `undefined`. */
  initialInput?: unknown;
  /** Optional repo paths exposed to every step. */
  repoPaths?: Record<string, string>;
  /** Optional memory handles forwarded to every step. */
  memory?: MemoryHandles;
  /** Optional LLM handles forwarded to every step. */
  llm?: LlmHandles;
  /** Aborts mid-run when the signal fires. */
  signal?: AbortSignal;
  /** Optional clock — defaults to `Date.now`. Test-injectable. */
  now?: () => number;
  /** Optional sleep — defaults to `setTimeout`. Test-injectable. */
  sleep?: (ms: number) => Promise<void>;
}

export class Pipeline {
  private readonly artifacts = new InMemoryArtifactStore();

  constructor(private readonly deps: PipelineDeps) {}

  /**
   * Read-only view of artifacts the run has emitted so far. Useful for
   * tests and post-run inspection.
   */
  getArtifacts(): InMemoryArtifactStore {
    return this.artifacts;
  }

  async run(): Promise<PipelineRunResult> {
    const { registry, bus, runId, signal } = this.deps;
    const now = this.deps.now ?? Date.now;
    const startedAt = now();
    const completedSteps: string[] = [];
    let costUsd = 0;
    let failedStep: string | undefined;
    let status: PipelineRunResult['status'] = 'success';
    let lastError: unknown;
    let prevOutput: unknown = this.deps.initialInput;

    await this.emit(bus, {
      hook: 'pipeline:started',
      runId,
      ts: this.iso(now),
      payload: { stepCount: registry.steps().length },
    });

    for (const step of registry.steps()) {
      if (signal?.aborted) {
        status = 'aborted';
        break;
      }

      await this.emit(bus, {
        hook: 'step:started',
        runId,
        stepId: step.id,
        ts: this.iso(now),
      });

      const stepStart = now();
      try {
        const out = await this.runStepWithSubSteps(step, prevOutput);
        const stepDurationMs = now() - stepStart;
        completedSteps.push(step.id);
        prevOutput = out;
        await this.emit(bus, {
          hook: 'step:completed',
          runId,
          stepId: step.id,
          ts: this.iso(now),
          payload: { durationMs: stepDurationMs },
        });
      } catch (err) {
        failedStep = step.id;
        status = 'failed';
        lastError = err;
        await this.emit(bus, {
          hook: 'step:failed',
          runId,
          stepId: step.id,
          ts: this.iso(now),
          error: this.serializeError(err),
        });
        break;
      }
    }

    const durationMs = now() - startedAt;

    if (status === 'success') {
      await this.emit(bus, {
        hook: 'pipeline:completed',
        runId,
        ts: this.iso(now),
        payload: { completedSteps, durationMs, costUsd },
      });
    } else if (status === 'failed') {
      await this.emit(bus, {
        hook: 'pipeline:failed',
        runId,
        ts: this.iso(now),
        payload: { completedSteps, failedStep, durationMs, costUsd },
        error: this.serializeError(lastError),
      });
    }

    return { runId, status, completedSteps, failedStep, durationMs, costUsd };
  }

  private async runStepWithSubSteps(
    step: Step<unknown, unknown>,
    input: unknown,
  ): Promise<unknown> {
    if (step.subSteps && step.subSteps.length > 0) {
      let subInput: unknown = input;
      for (const sub of step.subSteps) {
        subInput = await this.runSubStep(step.id, sub, subInput);
      }
      // After sub-steps, the parent's run still gets to synthesize.
      // The parent receives the final sub-step output as its input.
      return this.runStepWithRetry(step, subInput);
    }
    return this.runStepWithRetry(step, input);
  }

  private async runSubStep(
    parentStepId: string,
    sub: Step<unknown, unknown>,
    input: unknown,
  ): Promise<unknown> {
    const { bus, runId } = this.deps;
    const now = this.deps.now ?? Date.now;
    await this.emit(bus, {
      hook: 'sub-step:started',
      runId,
      stepId: sub.id,
      ts: this.iso(now),
      payload: { parentStepId },
    });
    try {
      const out = await this.runStepWithRetry(sub, input);
      await this.emit(bus, {
        hook: 'sub-step:completed',
        runId,
        stepId: sub.id,
        ts: this.iso(now),
        payload: { parentStepId },
      });
      return out;
    } catch (err) {
      await this.emit(bus, {
        hook: 'sub-step:completed',
        runId,
        stepId: sub.id,
        ts: this.iso(now),
        payload: { parentStepId, failed: true },
        error: this.serializeError(err),
      });
      throw err;
    }
  }

  private async runStepWithRetry(
    step: Step<unknown, unknown>,
    input: unknown,
  ): Promise<unknown> {
    const policy = step.retryPolicy;
    const ctx = this.buildContext(step, input);
    if (!policy || policy.attempts <= 0) {
      return step.run(ctx);
    }

    const sleep = this.deps.sleep ?? defaultSleep;
    const { bus, runId } = this.deps;
    const now = this.deps.now ?? Date.now;
    let attempt = 0;
    let lastErr: unknown;

    while (attempt <= policy.attempts) {
      try {
        return await step.run(ctx);
      } catch (err) {
        lastErr = err;
        attempt += 1;
        const shouldRetry = policy.retryOn ? policy.retryOn(err) : true;
        if (!shouldRetry || attempt > policy.attempts) {
          throw err;
        }
        await this.emit(bus, {
          hook: 'step:retried',
          runId,
          stepId: step.id,
          ts: this.iso(now),
          payload: { attempt, maxAttempts: policy.attempts },
          error: this.serializeError(err),
        });
        await sleep(computeBackoff(policy, attempt));
      }
    }
    throw lastErr;
  }

  private buildContext<I>(step: Step<I, unknown>, input: unknown): StepContext<I> {
    const { runId, workspaceDir, repoPaths, memory, llm, bus, signal } = this.deps;
    const sig = signal ?? new AbortController().signal;
    const artifactsView = this.artifacts;
    const emit = (artifactId: string, data: unknown): void => {
      artifactsView.write(artifactId, data);
      bus.emitFireAndForget({
        hook: 'artifact:emitted',
        runId,
        stepId: step.id,
        ts: new Date().toISOString(),
        payload: { artifactId, data },
      });
    };
    return {
      runId,
      workspaceDir,
      repoPaths,
      input: input as I,
      artifacts: artifactsView,
      emit,
      bus,
      memory,
      llm,
      signal: sig,
    };
  }

  private async emit(bus: EventBus, ev: PipelineEvent): Promise<void> {
    await bus.emit(ev);
  }

  private iso(now: () => number): string {
    return new Date(now()).toISOString();
  }

  private serializeError(err: unknown): NonNullable<PipelineEvent['error']> {
    if (err instanceof Error) {
      return { message: err.message, stack: err.stack };
    }
    return { message: String(err) };
  }
}

/**
 * Convenience helper for tests/hook factories: type-safe `PipelineEvent`
 * constructor that fills `ts` automatically.
 */
export function makePipelineEvent<P>(
  hook: StepHookPoint,
  runId: string,
  payload?: P,
  stepId?: string,
): PipelineEvent<P> {
  return { hook, runId, stepId, ts: new Date().toISOString(), payload };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function computeBackoff(policy: StepRetryPolicy, attempt: number): number {
  const base = policy.baseMs;
  let raw: number;
  switch (policy.backoff) {
    case 'exponential':
      raw = base * 2 ** (attempt - 1);
      break;
    case 'linear':
      raw = base * attempt;
      break;
    case 'constant':
    default:
      raw = base;
  }
  return policy.maxMs ? Math.min(raw, policy.maxMs) : raw;
}
