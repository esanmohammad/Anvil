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
 *
 * Per-repo fanout (Phase 4a of the dashboard consolidation):
 *   - When a Step declares `parallelism: 'per-repo'`, the walker runs
 *     `step.run()` once per key in `deps.repoPaths` in parallel. Each
 *     invocation receives a `StepContext` with `repoName` populated.
 *   - The step's output is aggregated into `Record<string, O>` keyed by
 *     repo name. Mono-repo projects (no `repoPaths` keys) fall back to a
 *     single serial run with `repoName` undefined.
 *   - Per-repo + sub-steps is not yet supported and throws.
 *   - Promise.all semantics: if any repo's run() rejects, the step fails.
 *     Steps that need per-repo failure tolerance handle it inside `run()`.
 */

import { randomUUID } from 'node:crypto';

import { InMemoryArtifactStore } from './artifacts.js';
import type {
  EffectOptions,
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
  StepSkipContext,
} from './types.js';
import type { DurableStore } from './durable/store.js';
import { EffectRuntime } from './durable/effect-runtime.js';
import { DeterminismViolationError } from './durable/types.js';

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
  /**
   * Initial value for `ctx.shared` — the mutable shared-state record
   * threaded through every step. Defaults to `{}`. Phase 3 of the
   * core-pipeline consolidation.
   */
  initialShared?: Record<string, unknown>;
  /**
   * Resume from a specific step ID. Steps registered before this one in
   * the registry are emitted as `step:skipped` and not invoked. Phase 2
   * of the core-pipeline consolidation.
   *
   * If `resumeFromStep` is set but the ID is not found in the registry,
   * `Pipeline.run()` rejects synchronously with an error.
   */
  resumeFromStep?: string;
  /**
   * Step IDs that are considered already completed in a prior run.
   * Walker emits `step:skipped` for these and does not invoke `run()`.
   * Combined with `resumeFromStep`: union of the two skip sets.
   *
   * The cli `feature-store` helper populates this from the on-disk
   * artifact directory; downstream steps that need the prior outputs
   * read them from `ctx.shared` (Phase 3).
   */
  completedSteps?: string[];
  /**
   * Re-run from a specific step ID (reviewer rewind). Differs from
   * `resumeFromStep` in that it ALSO drops every `completedSteps` entry
   * at-or-after the rewind index — those steps re-run.
   *
   *   prior completedSteps: [clarify, requirements, specs, tasks, build]
   *   rewindTo: 'specs'
   *   →  clarify + requirements skip with reason 'rewind';
   *      specs, tasks, build re-run.
   *
   * Mutually exclusive with `resumeFromStep`. Throws if both are set or
   * if `rewindTo` is not in the registry. Phase A2 of the dashboard
   * pipeline-consolidation — replaces the dashboard's sentinel-error
   * `__anvilRewind` flow.
   */
  rewindTo?: string;
  /**
   * Optional `DurableStore` — when supplied, every step gets an
   * effect runtime that records `ctx.effect` calls into the
   * durable log, and on resume those calls return recorded
   * results without re-running. See
   * `docs/durable-execution-plan.md` §F for the replay protocol.
   *
   * When omitted, `ctx.effect`/`now`/`uuid`/`random`/`sleep`/
   * `waitForSignal` become trivial wrappers — `effect(name, fn)`
   * just calls `fn()`, `now()` returns `Date.now()`, etc. The
   * walker behaviour is byte-identical to the pre-D2 contract.
   * Phase D2 of the durable execution rollout.
   */
  durableStore?: DurableStore;
  /**
   * Identity of the holding process — used by the durable log
   * hook + lease arbitration. Defaults to `${pid}@${hostname}`.
   * Phase D2.
   */
  durableHolder?: string;
}

export class Pipeline {
  private readonly artifacts = new InMemoryArtifactStore();
  private readonly shared: Record<string, unknown>;
  /**
   * Per-step recorded output, populated as steps complete. Used by
   * the compensation walker (Phase D4) to feed each step's
   * `step.compensate(ctx, output)` hook the right value.
   */
  private readonly stepOutputs = new Map<string, unknown>();

  constructor(private readonly deps: PipelineDeps) {
    this.shared = deps.initialShared ?? {};
  }

  /**
   * Read-only view of artifacts the run has emitted so far. Useful for
   * tests and post-run inspection.
   */
  getArtifacts(): InMemoryArtifactStore {
    return this.artifacts;
  }

  async run(): Promise<PipelineRunResult> {
    const { registry, bus, runId, signal, resumeFromStep, completedSteps: priorCompleted, rewindTo, durableStore } = this.deps;
    const now = this.deps.now ?? Date.now;
    const startedAt = now();
    const completedSteps: string[] = [];
    let costUsd = 0;
    let failedStep: string | undefined;
    let status: PipelineRunResult['status'] = 'success';
    let lastError: unknown;
    let prevOutput: unknown = this.deps.initialInput;

    if (rewindTo && resumeFromStep) {
      throw new Error(
        `Pipeline.run: rewindTo and resumeFromStep are mutually exclusive ` +
          `(rewindTo="${rewindTo}", resumeFromStep="${resumeFromStep}").`,
      );
    }

    // Resolve the skip set from resumeFromStep + completedSteps + rewindTo.
    const orderedSteps = registry.steps();
    const skipReason: Map<string, 'completed' | 'resume' | 'rewind' | 'replay-completed'> = new Map();
    if (priorCompleted) {
      for (const id of priorCompleted) skipReason.set(id, 'completed');
    }

    // Durable replay: every step that has `step:completed` in the
    // log on entry skips with reason 'replay-completed'. This is
    // additive to priorCompleted/resumeFromStep — replay survives
    // even when the caller didn't pass those flags.
    if (durableStore) {
      const events = await durableStore.readEvents(runId);
      for (const ev of events) {
        if (ev.kind === 'step:completed' && ev.stepId) {
          skipReason.set(ev.stepId, 'replay-completed');
        }
      }
    }

    if (resumeFromStep) {
      const resumeIdx = orderedSteps.findIndex((s) => s.id === resumeFromStep);
      if (resumeIdx < 0) {
        throw new Error(
          `Pipeline.run: resumeFromStep "${resumeFromStep}" is not in the registry. ` +
            `Known steps: ${orderedSteps.map((s) => s.id).join(', ')}`,
        );
      }
      for (let i = 0; i < resumeIdx; i++) {
        if (!skipReason.has(orderedSteps[i].id)) skipReason.set(orderedSteps[i].id, 'resume');
      }
    }

    if (rewindTo) {
      const rewindIdx = orderedSteps.findIndex((s) => s.id === rewindTo);
      if (rewindIdx < 0) {
        throw new Error(
          `Pipeline.run: rewindTo "${rewindTo}" is not in the registry. ` +
            `Known steps: ${orderedSteps.map((s) => s.id).join(', ')}`,
        );
      }
      // Re-run rewindTo and everything after it: drop their priorCompleted
      // entries from the skip map, AND mark the prefix as 'rewind' so the
      // emitted reason is accurate.
      for (let i = 0; i < orderedSteps.length; i++) {
        const id = orderedSteps[i].id;
        if (i < rewindIdx) {
          skipReason.set(id, priorCompleted?.includes(id) ? 'rewind' : skipReason.get(id) ?? 'rewind');
        } else {
          skipReason.delete(id);
        }
      }
    }
    const skipSet = new Set<string>(skipReason.keys());

    await this.emit(bus, {
      hook: 'pipeline:started',
      runId,
      ts: this.iso(now),
      payload: { stepCount: orderedSteps.length },
    });

    for (const step of orderedSteps) {
      if (signal?.aborted) {
        status = 'aborted';
        break;
      }

      if (skipSet.has(step.id)) {
        const reason = skipReason.get(step.id) ?? (resumeFromStep ? 'resume' : 'completed');
        // Don't double-record `step:skipped` for replay-completed
        // steps — the original `step:completed` is already in the
        // durable log. Emit the event for in-process consumers
        // (audit log, dashboard) but skip the durable hook will
        // see the duplicate runId+stepId and elide.
        await this.emit(bus, {
          hook: 'step:skipped',
          runId,
          stepId: step.id,
          ts: this.iso(now),
          payload: { reason },
        });
        // Track in completedSteps so the result reflects what the run "saw".
        completedSteps.push(step.id);
        continue;
      }

      if (step.skipIf) {
        try {
          const shouldSkip = await step.skipIf(this.buildSkipContext(prevOutput));
          if (shouldSkip) {
            await this.emit(bus, {
              hook: 'step:skipped',
              runId,
              stepId: step.id,
              ts: this.iso(now),
              payload: { reason: 'skipIf' },
            });
            completedSteps.push(step.id);
            continue;
          }
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

      // Phase D4: durable version check. On replay (durableStore
      // present) compare the step's declared version against the
      // recorded version of any prior `step:started` event for this
      // step. A bumped version invalidates the recorded effects;
      // the user must rerun from the affected stage.
      if (durableStore) {
        const events = await durableStore.readEvents(runId);
        const priorStarted = events.find(
          (e) => e.kind === 'step:started' && e.stepId === step.id,
        );
        const priorVersion =
          priorStarted && typeof priorStarted.payload === 'object' && priorStarted.payload !== null
            ? (priorStarted.payload as { version?: number }).version
            : undefined;
        const currentVersion = step.version ?? 1;
        if (priorVersion !== undefined && priorVersion !== currentVersion) {
          throw new DeterminismViolationError(
            runId,
            step.id,
            'version-mismatch',
            `step "${step.id}" replayed at version=${currentVersion} but log records version=${priorVersion}`,
          );
        }
      }

      await this.emit(bus, {
        hook: 'step:started',
        runId,
        stepId: step.id,
        ts: this.iso(now),
        payload: { version: step.version ?? 1 },
      });

      const stepStart = now();
      try {
        const out = await this.runStepWithSubSteps(step, prevOutput);
        const stepDurationMs = now() - stepStart;
        completedSteps.push(step.id);
        prevOutput = out;
        // Track output for compensation (D4).
        this.stepOutputs.set(step.id, out);
        await this.emit(bus, {
          hook: 'step:completed',
          runId,
          stepId: step.id,
          ts: this.iso(now),
          payload: { durationMs: stepDurationMs, version: step.version ?? 1 },
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
      // Phase D4: compensation walk. After a non-success terminal
      // status, walk the completed steps in reverse and invoke
      // each step's `compensate(ctx, output)` hook if defined.
      // Compensation effects flow through the same EffectRuntime,
      // so a crash mid-rollback resumes the rollback (not the
      // forward path) on the next process — that's what makes
      // Pattern-2 compensation durable.
      await this.runCompensationWalk(orderedSteps, completedSteps, failedStep, prevOutput);
    }

    return { runId, status, completedSteps, failedStep, durationMs, costUsd };
  }

  /**
   * Reverse-walk completed steps, invoking compensate(ctx, output)
   * on each step that defines one. Errors during compensation are
   * recorded but don't halt the walk — best-effort rollback.
   */
  private async runCompensationWalk(
    orderedSteps: ReadonlyArray<Step<unknown, unknown>>,
    completedIds: string[],
    failedStepId: string | undefined,
    prevOutput: unknown,
  ): Promise<void> {
    const { bus, runId } = this.deps;
    const now = this.deps.now ?? Date.now;
    // Reverse order, skipping the step that actually failed (it
    // never produced an output to roll back).
    const toCompensate = [...completedIds].reverse().filter((id) => id !== failedStepId);
    for (const id of toCompensate) {
      const step = orderedSteps.find((s) => s.id === id);
      if (!step?.compensate) continue;
      const output = this.stepOutputs.get(id);
      if (output === undefined) continue;
      try {
        const ctx = await this.buildContext(step, prevOutput);
        await step.compensate(ctx, output);
      } catch (err) {
        // Best-effort: surface as a fire-and-forget event but keep walking.
        bus.emitFireAndForget({
          hook: 'step:failed',
          runId,
          stepId: step.id,
          ts: this.iso(now),
          payload: { phase: 'compensate' },
          error: this.serializeError(err),
        });
      }
    }
  }

  private async runStepWithSubSteps(
    step: Step<unknown, unknown>,
    input: unknown,
  ): Promise<unknown> {
    if (step.parallelism === 'per-repo') {
      return this.runPerRepoFanout(step, input);
    }
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

  /**
   * Per-repo fanout — Phase 4a of the dashboard consolidation.
   *
   * For a step declared `parallelism: 'per-repo'`, runs `step.run()` once per
   * key in `deps.repoPaths` in parallel (Promise.all — first failure rejects
   * the step). Each invocation gets its own `StepContext` with `repoName`
   * populated so the step can scope its work.
   *
   * Output: a `Record<string, O>` keyed by repo name. Downstream serial steps
   * receive this map as their input; downstream per-repo steps read their own
   * slice via `ctx.input[ctx.repoName]`.
   *
   * If `repoPaths` is empty or undefined, falls back to a single serial run
   * with `ctx.repoName` undefined — keeps mono-repo projects working.
   *
   * Sub-steps under a per-repo parent are not yet supported (Phase 4a). They
   * throw rather than silently running with mismatched semantics.
   */
  private async runPerRepoFanout(
    step: Step<unknown, unknown>,
    input: unknown,
  ): Promise<Record<string, unknown> | unknown> {
    if (step.subSteps && step.subSteps.length > 0) {
      throw new Error(
        `Step "${step.id}" declares parallelism: 'per-repo' AND has sub-steps; `
          + 'this combination is not supported.',
      );
    }
    const repoPaths = this.deps.repoPaths;
    const repoNames = repoPaths ? Object.keys(repoPaths) : [];
    if (repoNames.length === 0) {
      return this.runStepWithRetry(step, input);
    }

    const promises = repoNames.map((repoName) =>
      this.runStepWithRetry(step, input, { repoName }).then((out) => [repoName, out] as const),
    );
    const settled = await Promise.all(promises);
    return Object.fromEntries(settled);
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
    fanoutOpts?: { repoName?: string },
  ): Promise<unknown> {
    const policy = step.retryPolicy;
    const ctx = await this.buildContext(step, input, fanoutOpts);
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

  private async buildContext<I>(
    step: Step<I, unknown>,
    input: unknown,
    fanoutOpts?: { repoName?: string },
  ): Promise<StepContext<I>> {
    const { runId, workspaceDir, repoPaths, memory, llm, bus, signal, durableStore } = this.deps;
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

    let effectFn: StepContext<I>['effect'];
    let nowFn: StepContext<I>['now'];
    let uuidFn: StepContext<I>['uuid'];
    let randomFn: StepContext<I>['random'];
    let sleepFn: StepContext<I>['sleep'];
    let waitForSignalFn: StepContext<I>['waitForSignal'];

    if (durableStore) {
      const recorded = await durableStore.readEffectEvents(runId, step.id);
      const runtime = new EffectRuntime({
        store: durableStore,
        runId,
        stepId: step.id,
        recordedEffects: recorded,
        signal: sig,
      });
      effectFn = (name, fn, opts) => runtime.effect(name, fn, opts);
      nowFn = () => runtime.now();
      uuidFn = () => runtime.uuid();
      randomFn = () => runtime.random();
      sleepFn = (ms) => runtime.sleep(ms);
      waitForSignalFn = (channel) => runtime.waitForSignal(channel);
    } else {
      effectFn = passthroughEffect;
      nowFn = passthroughNow;
      uuidFn = passthroughUuid;
      randomFn = passthroughRandom;
      sleepFn = passthroughSleep;
      waitForSignalFn = passthroughWaitForSignal;
    }

    return {
      runId,
      workspaceDir,
      repoPaths,
      repoName: fanoutOpts?.repoName,
      input: input as I,
      shared: this.shared,
      artifacts: artifactsView,
      emit,
      bus,
      memory,
      llm,
      signal: sig,
      effect: effectFn,
      now: nowFn,
      uuid: uuidFn,
      random: randomFn,
      sleep: sleepFn,
      waitForSignal: waitForSignalFn,
    };
  }

  /**
   * Build a stripped-down `StepSkipContext` for `Step.skipIf` predicates.
   * No bus / emit / signal so the predicate cannot mutate run state.
   */
  private buildSkipContext(input: unknown): StepSkipContext {
    return {
      runId: this.deps.runId,
      workspaceDir: this.deps.workspaceDir,
      repoPaths: this.deps.repoPaths,
      shared: this.shared,
      artifacts: this.artifacts,
      input,
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

// ── Non-durable mode passthroughs (Phase D2) ──────────────────────
async function passthroughEffect<T>(_name: string, fn: () => Promise<T>, _opts?: EffectOptions): Promise<T> {
  return fn();
}
async function passthroughNow(): Promise<number> {
  return Date.now();
}
async function passthroughUuid(): Promise<string> {
  return randomUUID();
}
async function passthroughRandom(): Promise<number> {
  return Math.random();
}
async function passthroughSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
async function passthroughWaitForSignal<T>(_channel: string): Promise<T> {
  throw new Error(
    'StepContext.waitForSignal called without a durable store. '
      + 'Pass `durableStore` to Pipeline.run() to enable durable signal channels.',
  );
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
