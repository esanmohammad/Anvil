/**
 * `Pipeline` runner — Phase 3 walker.
 *
 * Walks the registered steps in order, threading each step's output into
 * the next step's `StepContext.input`. Emits the lifecycle events that
 * cross-cutting hooks (audit, dashboard, learners, cost) subscribe to.
 *
 * Event order per run:
 *   - pipeline:started   (once)
 *   - per step: step:started → step:completed | step:failed
 *   - pipeline:completed | pipeline:failed | pipeline:aborted (once)
 *
 * Sub-step recursion (Phase 7) and per-step retries are explicit
 * follow-ons: this Phase 3 impl runs each step once, no retries, no
 * subSteps — to stay surgical against the orchestrator's behavior at the
 * point Phase 4 starts strangling it.
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
        const ctx = this.buildContext(step, prevOutput);
        const out = await step.run(ctx);
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
