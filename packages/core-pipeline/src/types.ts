/**
 * `@esankhan3/anvil-core-pipeline` canonical types.
 *
 * Locked verbatim in CORE-PIPELINE-EXTRACT-ADR.md §4 / PLAN §5. Phases 2-9
 * implement the runtime against these contracts; do not change shapes here
 * without an ADR amendment.
 */

// ---------------------------------------------------------------------------
// Step contract
// ---------------------------------------------------------------------------

/** Canonical Step contract — one per pipeline stage. */
export interface Step<I, O> {
  /** Stable id; used for insertBefore / insertAfter / replace / remove. */
  id: string;
  /** Human label; not load-bearing. */
  name?: string;
  /**
   * Schema version. Recorded on `step:started`; mismatch on replay
   * surfaces `DeterminismViolationError(reason: 'version-mismatch')`.
   * Default `1`. Bump when the step's effect order or input/output
   * shape changes in a way that invalidates prior recorded events.
   *
   * Phase D4 of the durable execution rollout
   * (`docs/durable-execution-plan.md` §F).
   */
  version?: number;
  /** Run this step against `ctx.input`; return the result for downstream steps. */
  run(ctx: StepContext<I>): Promise<O>;
  /**
   * Optional rollback hook. Invoked during compensation walk after
   * the run transitions to `failed` / `cancelled`. Receives the
   * step's recorded output so external effects can be unwound. Same
   * effect-runtime contract as `run()` — every external touch must
   * go through `ctx.effect`.
   *
   * Phase D4 of the durable execution rollout.
   */
  compensate?(ctx: StepContext<I>, output: O): Promise<void>;
  /**
   * Optional retry policy for transient failures. Driven by Step error
   * classification — same shape as the LLM router's RetryPolicy but applied
   * at the step level (NOT inside the LLM call).
   */
  retryPolicy?: StepRetryPolicy;
  /** Optional sub-steps; runs as a sequence within this step's frame. */
  subSteps?: Step<unknown, unknown>[];
  /**
   * Parallelism hint:
   *   - 'serial'      (default) — single run() call, ctx.repoName undefined.
   *   - 'per-project' — registry hint only; the walker does not fan out yet.
   *   - 'per-repo'    — walker fans run() across `ctx.repoPaths`, populating
   *                     `ctx.repoName` per call. Output is a
   *                     `Record<string, O>` keyed by repo name. Phase 4a.
   */
  parallelism?: 'serial' | 'per-project' | 'per-repo';
  /**
   * Optional declarative skip predicate. Evaluated by the walker just
   * before this step would run, AFTER the resume / completedSteps skip
   * set has been consulted. When it returns true the walker emits
   * `step:skipped` with `payload.reason === 'skipIf'`, threads the
   * previous step's output into the next step (input passes through
   * unchanged), and continues.
   *
   * Use cases:
   *   - "plan-derived" stages that should be skipped when a planSeed is
   *     present (`ctx.shared.planSeed != null`).
   *   - Stages that should be skipped on a per-feature flag in
   *     `ctx.shared` without forcing every consumer to call
   *     `Pipeline.run({ resumeFromStep })`.
   *
   * The predicate sees a stripped-down `StepSkipContext` — no bus,
   * emit, or signal — to keep skip decisions side-effect-free. If
   * `skipIf` throws, the walker treats it as a terminal failure
   * (emits `step:failed`); the walker does NOT silently fall through
   * and run the step, since a thrown predicate signals a bug, not a
   * "skip negative" answer.
   */
  skipIf?: (ctx: StepSkipContext) => boolean | Promise<boolean>;
}

/**
 * Context handed to `Step.skipIf` predicates. Subset of `StepContext`
 * with no mutation seams (no `emit`, no `bus`, no `signal`) so skip
 * decisions are forced to be pure reads.
 */
export type StepSkipContext = Pick<
  StepContext<unknown>,
  'runId' | 'workspaceDir' | 'repoPaths' | 'shared' | 'artifacts' | 'input'
>;

export interface StepContext<I> {
  /** Stable run id (matches today's `~/.anvil/runs/<runId>/`). */
  runId: string;
  /** Workspace root. */
  workspaceDir: string;
  /** Per-project paths (preserved from today's StageContext). */
  repoPaths?: Record<string, string>;
  /**
   * Populated only when the walker is running a `parallelism: 'per-repo'`
   * step's per-repo fanout. Identifies the current repo iteration so the
   * step's `run()` can scope its work. Undefined for serial steps.
   */
  repoName?: string;
  /** Strongly-typed input — output of the previous step. */
  input: I;
  /**
   * Mutable shared-state record threaded through every step in a run.
   * Used for cross-stage context that doesn't fit the strict I→O step
   * chain (project name, agent runner, run dir, etc.). cli defines a
   * typed `CliPipelineState` interface and casts at the boundary;
   * dashboard steps that have natural I→O chains can ignore this field.
   *
   * Phase 3 of the core-pipeline consolidation. The walker passes the
   * same reference to every step, so writes from step A are visible to
   * step B. Per-repo fanouts share the reference too — steps that fan
   * out are responsible for their own concurrent-write safety.
   */
  shared: Record<string, unknown>;
  /** Pipeline-wide read-only artifacts ledger; downstream steps can read prior outputs by id. */
  artifacts: ReadonlyArtifactStore;
  /** Step can write artifacts; persisted to runDir. */
  emit: (artifactId: string, data: unknown) => void;
  /** Pub/sub bus — for cross-cutting concerns only, NOT primary flow control. */
  bus: EventBus;
  /** Memory-core integration: run-scoped queue handle. */
  memory?: MemoryHandles;
  /** LLM router integration: tag-driven dispatch. */
  llm?: LlmHandles;
  /** Aborts the run on .signal. */
  signal: AbortSignal;
  // ── Durable execution surface (Phase D2+) ──────────────────────────
  /**
   * Run a side effect once per workflow execution. Result is recorded
   * in the durable log; on replay the recorded result is returned
   * without re-running `fn`.
   *
   * `name` MUST be unique within the step body, stable across
   * replays. Multiple calls with the same name (e.g. inside a loop)
   * are disambiguated by a per-step counter (`idx`) maintained by
   * the runtime.
   *
   * When the engine is running in non-durable mode (no
   * `durableStore` passed to `Pipeline.run`), `effect` becomes a
   * thin wrapper: it just runs `fn()` and returns the result. Step
   * bodies don't need to branch on the mode.
   *
   * Throws on cancellation. On non-retryable failure, the effect is
   * recorded as `failed` and the same error is replayed.
   *
   * See `docs/durable-execution-plan.md` §E for the full contract.
   */
  effect<T>(name: string, fn: () => Promise<T>, opts?: EffectOptions): Promise<T>;
  /** Deterministic clock (`Date.now()`-equivalent). Recorded once; replays return the recorded value. */
  now(): Promise<number>;
  /** Deterministic UUID. */
  uuid(): Promise<string>;
  /** Deterministic `Math.random()`-equivalent. Returns a value in `[0, 1)`. */
  random(): Promise<number>;
  /** Durable timer — survives crashes; on replay returns immediately if the deadline already elapsed. */
  sleep(ms: number): Promise<void>;
  /**
   * Wait for an external signal (reviewer decision, Q&A answer,
   * etc.). Persisted; on replay returns the recorded payload
   * without blocking. The dashboard / cli enqueues signals via
   * `DurableStore.enqueueSignal(...)`.
   */
  waitForSignal<T = unknown>(channel: string): Promise<T>;
  /**
   * H3 turn-level resume seam (ADR §2.5). Peek the recorded payload of a
   * COMPLETED effect by name WITHOUT advancing the replay cursor or the
   * per-step idx counter — a pure read over the already-loaded recorded
   * effects. Returns undefined in non-durable mode or when the effect
   * hasn't been recorded yet (live execution). The turn-recorder uses it
   * to detect a finished turn (`turn:N:assistant-end` present) so the
   * adapter skips the upstream call on crash-resume. Satisfies
   * agent-core's structural `EffectRuntimeLike.peekRecorded`.
   */
  peekRecorded?<T = unknown>(name: string): T | undefined;
}

/** Per-call options for `ctx.effect`. */
export interface EffectOptions {
  /** Caller-supplied retry policy. Same shape as `Step.retryPolicy`. */
  retry?: StepRetryPolicy;
  /**
   * External-system idempotency key. Hashed into the recorded
   * input_hash so external duplicates collapse on the receiving
   * side. Optional — internal effects without external visibility
   * don't need one.
   */
  idempotencyKey?: string;
  /** Soft timeout in ms — fires `EffectTimeoutError` to the step body. */
  timeoutMs?: number;
  /** When true, store the full result in the event payload (small enough not to need a blob). Default false. */
  smallResult?: boolean;
  /**
   * Optional transform applied to the result *before* it is persisted to
   * the durable log. The live caller still receives the original (full)
   * result; only the stored copy — and therefore the value replayed on
   * resume — is transformed. Used to cap very large effect payloads
   * (e.g. multi-MB tool outputs) so a single agentic turn doesn't block
   * the event loop serialising file dumps into SQLite. Resume then sees
   * the capped copy — a deliberate cross-vendor-resume fidelity tradeoff,
   * not a correctness change for a fresh run. Omit (the default) to
   * persist the full result verbatim.
   */
  persistTransform?: (result: unknown) => unknown;
}

export interface StepRetryPolicy {
  attempts: number;
  backoff: 'exponential' | 'linear' | 'constant';
  baseMs: number;
  maxMs?: number;
  retryOn?: (error: unknown) => boolean;
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

export type StepHookPoint =
  | 'pipeline:started'
  | 'pipeline:completed'
  | 'pipeline:failed'
  | 'step:started'
  | 'step:completed'
  | 'step:failed'
  | 'step:retried'
  | 'step:skipped'
  | 'sub-step:started'
  | 'sub-step:completed'
  | 'artifact:emitted'
  // ── Dashboard-domain events (CORE-PIPELINE-EXTRACT-ADR.md §4.5) ──
  /**
   * Fires when a single repo within a `parallelism: 'per-repo'` stage
   * transitions status (running / completed / failed). Replaces the
   * dashboard's inline `state.stages[i].repos[r].status = ...` mutations.
   *
   * Payload: `StageRepoProgressPayload`.
   */
  | 'stage:repo-progress'
  /**
   * Fires when the run's cumulative USD ledger increments — once per
   * spawn / per fix attempt / per repo task. Replaces the scattered
   * `this.state.totalCost += result.cost` increments in pipeline-runner.
   *
   * Payload: `StageCostUpdatePayload`.
   */
  | 'stage:cost-update'
  /**
   * Fires at the start of each iteration of the validate→fix loop
   * (capped at `maxFixAttempts`, default 3). The dashboard surfaces
   * this so users see "fix attempt 2 of 3" without polling.
   *
   * Payload: `StageFixAttemptPayload`.
   */
  | 'stage:fix-attempt'
  /**
   * Fires when a reviewer-supplied note is armed for a stage — either
   * from a pause-resolution path or from a reviewer artifact edit.
   * Replaces the dashboard's private `pendingReviewNote` /
   * `currentStageReviewNote` plumbing.
   *
   * Payload: `ReviewerNotePayload`.
   */
  | 'reviewer:note';

// ---------------------------------------------------------------------------
// Dashboard-domain event payload shapes (CORE-PIPELINE-EXTRACT-ADR.md §4.5)
// ---------------------------------------------------------------------------

/** `stage:repo-progress` payload. */
export interface StageRepoProgressPayload {
  stageId: string;
  stageIndex: number;
  repoName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** USD attributed to this repo's portion of the stage; present on `completed`. */
  costUsd?: number;
  /** Failure detail; present on `failed`. */
  error?: { message: string };
}

/** `stage:cost-update` payload. */
export interface StageCostUpdatePayload {
  stageId: string;
  stageIndex: number;
  /** USD added to the run's running ledger by this update. */
  deltaUsd: number;
  /** Running total post-delta. */
  totalUsd: number;
}

/** `stage:fix-attempt` payload. */
export interface StageFixAttemptPayload {
  stageId: string;
  stageIndex: number;
  /** Set when the fix is per-repo; absent for stage-wide validate→fix. */
  repoName?: string;
  /** 1-indexed. */
  attempt: number;
  maxAttempts: number;
  /** Which half of the loop this attempt is — fix vs. revalidate. */
  phase: 'fix' | 'revalidate';
}

/** `reviewer:note` payload. */
export interface ReviewerNotePayload {
  stageId: string;
  stageIndex: number;
  /** Reviewer's free-form text. Trimmed; never empty (caller skips emission for empty). */
  note: string;
  /** Where the note came from — pause resolution vs. reviewer artifact edit. */
  source: 'pause-resolution' | 'edit-artifact';
}

export interface PipelineEvent<P = unknown> {
  hook: StepHookPoint;
  runId: string;
  stepId?: string;
  ts: string;
  payload?: P;
  error?: { message: string; stack?: string; cause?: unknown };
}

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

export interface EventListenerOptions {
  /**
   * Higher priority runs first. Default 0. Convention:
   *   - audit-log hook   → 100 (must persist before learners read it)
   *   - learners hook    → 50
   *   - dashboard state  → 10
   */
  priority?: number;
}

export interface EventBus {
  /** Subscribe; returns an unsubscribe handle. */
  on(hook: StepHookPoint, listener: EventListener, opts?: EventListenerOptions): () => void;
  /** Subscribe once; auto-unsubscribes after first emit. */
  once(hook: StepHookPoint, listener: EventListener, opts?: EventListenerOptions): () => void;
  /** Remove a previously-registered listener. */
  off(hook: StepHookPoint, listener: EventListener): void;
  /** Emit and await all listeners (back-pressure honored). */
  emit(event: PipelineEvent): Promise<void>;
  /** Emit without awaiting — for non-critical paths (telemetry, dashboard). */
  emitFireAndForget(event: PipelineEvent): void;

  /**
   * Issue a typed request on `channel` and await a response. Used for
   * human-in-the-loop steps (clarify Q&A, approval gates) so the *step*
   * declares its need for an answer and the consumer (cli/dashboard)
   * decides how to source it.
   *
   * Default timeout: 30 minutes. Pass `opts.timeoutMs` to override.
   * Pass `opts.signal` to cancel the request from the caller side.
   *
   * Throws `BusRequestTimeoutError` on timeout, `BusRequestAbortedError`
   * when `opts.signal` aborts. If no responder is attached and the
   * request times out, the promise rejects with the timeout error.
   */
  request<P, R>(channel: string, payload: P, opts?: BusRequestOptions): Promise<R>;
  /** Resolve a pending request. Called by responders attached via `onRequest`. */
  respond<R>(channel: string, requestId: string, response: R): void;
  /**
   * Subscribe to incoming requests on `channel`. Listener receives
   * `{ requestId, payload }` and should call `bus.respond(channel,
   * requestId, response)` to resolve the awaiting promise. Returns an
   * unsubscribe handle.
   */
  onRequest<P>(channel: string, listener: BusRequestListener<P>): () => void;
}

export type EventListener = (event: PipelineEvent) => void | Promise<void>;

export interface BusRequestOptions {
  /** Defaults to 30 minutes (1_800_000ms). */
  timeoutMs?: number;
  /** Aborts the request when the signal fires. */
  signal?: AbortSignal;
}

export interface BusRequest<P> {
  requestId: string;
  payload: P;
}

export type BusRequestListener<P> = (req: BusRequest<P>) => void | Promise<void>;

// ---------------------------------------------------------------------------
// StepRegistry
// ---------------------------------------------------------------------------

export interface StepRegistry {
  register(step: Step<unknown, unknown>): void;
  insertBefore(targetId: string, step: Step<unknown, unknown>): void;
  insertAfter(targetId: string, step: Step<unknown, unknown>): void;
  replace(targetId: string, step: Step<unknown, unknown>): void;
  remove(targetId: string): void;
  /** The ordered step list. */
  steps(): readonly Step<unknown, unknown>[];
}

// ---------------------------------------------------------------------------
// Artifact store
// ---------------------------------------------------------------------------

export interface ReadonlyArtifactStore {
  has(artifactId: string): boolean;
  read<T = unknown>(artifactId: string): T | undefined;
  ids(): readonly string[];
}

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

export interface PipelineRunResult {
  runId: string;
  status: 'success' | 'failed' | 'aborted';
  completedSteps: string[];
  failedStep?: string;
  durationMs: number;
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Cross-cutting integration handles (typed forward references)
// ---------------------------------------------------------------------------

/**
 * Memory-core handles passed through `StepContext.memory`. Kept as a thin
 * structural shape so core-pipeline can compile without pulling memory-core's
 * full surface; the actual handles are wired by the cli at run start.
 */
export interface MemoryHandles {
  /** Reserved — populated by cli's runner with a memory-core handle. */
  readonly opaque?: unknown;
}

/**
 * LLM router handles passed through `StepContext.llm`. Same opaque-shape
 * convention as `MemoryHandles`.
 */
export interface LlmHandles {
  readonly opaque?: unknown;
}
