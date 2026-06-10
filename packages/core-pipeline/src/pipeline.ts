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
import { EffectRuntime, effectKeyMatchesScope } from './durable/effect-runtime.js';
import { DeterminismViolationError } from './durable/types.js';
import { rollupStepCostAcrossSubsteps, rollupIsEmpty } from './durable/cost-rollup.js';
import {
  computeSkipSetDivergence,
  hasSkipSetDivergence,
  formatSkipSetDivergence,
} from './durable/skip-reconcile.js';

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
    console.log(`[trace] ${runId} pipeline.run entry`);
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

      // FO1-1b — reconcile the disk-based skip set against the durable
      // replay-completed set. Both fire for the same steps once resume
      // reuses the original runId (Fix A finding 7); a divergence means
      // they disagree about what finished. Durable already won via the
      // `set()` above (it's the replay source of truth) — the `set()`
      // calls are idempotent so no step is ever skipped twice (subsumes
      // finding-3's dedup concern). Here we only make a disagreement
      // VISIBLE rather than silently masking it.
      //
      // Only meaningful when BOTH sources exist for a reused runId:
      //   - durableCompleted non-empty: an EMPTY durable log means a
      //     fresh runId was minted (no reuse) — every disk step would
      //     then falsely read as `onlyDisk`, so suppress the compare.
      //   - priorCompleted non-empty: no disk side to diff against.
      //   - not a rewind: rewindTo deliberately drops steps ≥ rewindIdx
      //     below, so they are not a divergence. (Via the dashboard,
      //     rewind passes carry no durableStore at all — this guards the
      //     cli/test callers that may pass both.)
      const durableCompleted: string[] = [];
      for (const [id, reason] of skipReason) {
        if (reason === 'replay-completed') durableCompleted.push(id);
      }
      if (!rewindTo && priorCompleted && priorCompleted.length > 0 && durableCompleted.length > 0) {
        const divergence = computeSkipSetDivergence(priorCompleted, durableCompleted);
        if (hasSkipSetDivergence(divergence)) {
          console.warn(formatSkipSetDivergence(runId, divergence));
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

    console.log(`[trace] ${runId} before pipeline:started emit (listeners may include await:true)`);
    await this.emit(bus, {
      hook: 'pipeline:started',
      runId,
      ts: this.iso(now),
      payload: { stepCount: orderedSteps.length },
    });

    console.log(`[trace] ${runId} pipeline:started emitted, entering step loop (${orderedSteps.length} steps)`);
    for (const step of orderedSteps) {
      if (signal?.aborted) {
        status = 'aborted';
        break;
      }
      console.log(`[trace] ${runId} step iter: ${step.id} (skip=${skipSet.has(step.id)})`);

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

      // step:started is emitted unconditionally — including when a
      // reused-runId resume re-runs a previously-failed step. The second
      // `step:started` in the durable log is intentional (the step
      // genuinely ran twice) and harmless to replay: effect replay keys
      // on the unique effectKey with last-write-wins dedup, the version
      // check above uses `.find` (first match), and resume-stage
      // derivation is Set-based. It MUST still fire so in-process
      // subscribers (dashboard stage render, audit log, cost hooks) see
      // the re-run start.
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
        // §2.6 per-model cost rollup. Reads turn:*:assistant-end +
        // assistant-partial events for this step and buckets cost by
        // model. Empty (fields omitted) for stages still on the legacy
        // single-effect path — those report cost via `artifact:emitted`
        // as before, so this is byte-identical until a stage is ported.
        let costFields: Record<string, unknown> = {};
        if (durableStore) {
          try {
            const rollup = await rollupStepCostAcrossSubsteps(durableStore, runId, step.id);
            if (!rollupIsEmpty(rollup)) {
              costFields = {
                costByModel: rollup.costByModel,
                prefillReinjectionUsd: rollup.prefillReinjectionUsd,
                totalCostUsd: rollup.totalCostUsd,
              };
            }
          } catch {
            // Cost rollup is best-effort telemetry — never fail a step on it.
          }
        }
        await this.emit(bus, {
          hook: 'step:completed',
          runId,
          stepId: step.id,
          ts: this.iso(now),
          payload: { durationMs: stepDurationMs, version: step.version ?? 1, ...costFields },
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
    let peekRecordedFn: StepContext<I>['peekRecorded'];

    if (durableStore) {
      const recorded = await durableStore.readEffectEvents(runId, step.id);
      // Phase F6: per-repo scope filter. When the walker is in
      // per-repo fanout mode, parallel runtimes share `step.id`
      // but each effect key embeds the repo name (e.g.
      // `specs:spawn-service-a`). Each runtime sees only the
      // effects matching its repoName so the per-step idx
      // counter stays in sync across replays.
      const repoName = fanoutOpts?.repoName;
      const runtime = new EffectRuntime({
        store: durableStore,
        runId,
        stepId: step.id,
        recordedEffects: recorded,
        signal: sig,
        ...(repoName
          ? { effectFilter: (pair) => effectKeyMatchesScope(pair.started.effectKey, repoName) }
          : {}),
      });
      effectFn = (name, fn, opts) => runtime.effect(name, fn, opts);
      nowFn = () => runtime.now();
      uuidFn = () => runtime.uuid();
      randomFn = () => runtime.random();
      sleepFn = (ms) => runtime.sleep(ms);
      waitForSignalFn = (channel) => runtime.waitForSignal(channel);
      peekRecordedFn = <T>(name: string) => runtime.peekRecorded<T>(name);
    } else {
      effectFn = passthroughEffect;
      nowFn = passthroughNow;
      uuidFn = passthroughUuid;
      randomFn = passthroughRandom;
      sleepFn = passthroughSleep;
      waitForSignalFn = passthroughWaitForSignal;
      // Non-durable: nothing recorded → peek always misses → adapter
      // always runs live (byte-identical to pre-H3).
      peekRecordedFn = () => undefined;
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
      peekRecorded: peekRecordedFn,
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

/**
 * Phase F6 — match an effectKey against a per-repo scope token.
 * Effect keys produced by the dashboard's pipeline-stages embed the
 * repo name as a `-` / `:`-delimited token, e.g.
 *   specs:spawn-service-a            → matches scope "service-a"
 *   build:write-service-a            → matches "service-a"
 *   build:spawn-task-service-a-T1    → matches "service-a" (followed by "-T1")
 *   build:repo-data                  → matches "data" but NOT "data-x"
 *
 * We use boundary-aware substring matching: the scope must appear
 * surrounded by `-`, `:`, or string boundaries on both sides so
 * "a" doesn't spuriously match "service-a", and "data" doesn't
 * match "metadata".
 *
 * System primitives (`__anvil_*`) and signals (`__signal:*`) are
 * scope-shared — they ride along on whichever per-repo runtime
 * happens to call them.
 */
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
