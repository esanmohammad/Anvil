/**
 * `@anvil/core-pipeline` canonical types.
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
  /** Run this step against `ctx.input`; return the result for downstream steps. */
  run(ctx: StepContext<I>): Promise<O>;
  /**
   * Optional retry policy for transient failures. Driven by Step error
   * classification — same shape as the LLM router's RetryPolicy but applied
   * at the step level (NOT inside the LLM call).
   */
  retryPolicy?: StepRetryPolicy;
  /** Optional sub-steps; runs as a sequence within this step's frame. */
  subSteps?: Step<unknown, unknown>[];
  /** Per-project parallelism hint. Default 'serial'. */
  parallelism?: 'serial' | 'per-project';
}

export interface StepContext<I> {
  /** Stable run id (matches today's `~/.anvil/runs/<runId>/`). */
  runId: string;
  /** Workspace root. */
  workspaceDir: string;
  /** Per-project paths (preserved from today's StageContext). */
  repoPaths?: Record<string, string>;
  /** Strongly-typed input — output of the previous step. */
  input: I;
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
  | 'artifact:emitted';

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
}

export type EventListener = (event: PipelineEvent) => void | Promise<void>;

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
