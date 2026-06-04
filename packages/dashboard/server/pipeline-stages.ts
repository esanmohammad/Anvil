/**
 * `pipeline-stages` — per-stage execution logic.
 *
 * Houses `runOneStage` (the single-stage dispatcher driven by
 * `Pipeline.run()`) and its six sub-functions:
 * `runClarifyStage`, `runPerRepoStage`, `runBuildForRepo`,
 * `runSingleStage`, `runTestGenStage`, `runFixLoop`. Plus the
 * canonical-runner factories `makeAgentSession` /
 * `makeAgentRunner` and the rerun-state helper
 * `resetStagesForRerun`.
 *
 * Extracted from `pipeline-runner.ts` so the runner stays focused on
 * orchestration. Each function takes a `StageOpsDeps` opts bag that
 * bundles the runner's state, config, helpers, and side-effect hooks
 * — no FS state of its own; no module-level cache.
 *
 * # Durable execution boundary (Phases E1–E10)
 *
 * Each step-body function accepts an optional `ctx?: StepContext<string>`.
 * When provided (durable mode), every external touch — agent spawn,
 * artifact write, fix-loop attempt, deploy — flows through
 * `ctx.effect(...)` so a process crash mid-stage resumes from the
 * last completed effect on the next process. When `ctx` is undefined
 * (legacy callers / tests / non-durable mode), calls fire directly
 * — the contract is a transparent superset.
 *
 * **What is NOT wrapped:** state-mutation projections (e.g.
 * `state.stages[i].startedAt = new Date().toISOString()`) stay direct.
 * These are observable side effects on the dashboard's in-memory state
 * + state.json projection — re-writing them on replay is harmless +
 * intentional (the replay process IS live; the user expects to see
 * fresh timestamps as the run progresses through replay-completed
 * steps). The durable log is the workflow record; state.json is a
 * projection.
 *
 * **What stays outside the durable log on purpose:**
 *   - Telemetry (`writePerRepoTelemetry`) — JSONL appenders, idempotent.
 *   - Cost ledger writes — JSONL, replay re-records cleanly.
 *   - State broadcasts (`deps.broadcast()`) — recompute from state.
 *
 * See `docs/durable-effect-conversion-plan.md` for the full
 * conversion catalog.
 */
import { join } from 'node:path';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import type { WalkerConfig } from '@esankhan3/anvil-agent-core';
import {
  combinePerRepoArtifacts,
  runBuildForOneRepo,
  hasValidationFailures as hasValidationFailuresHelper,
  buildProjectPrompt as buildProjectPromptHelper,
  buildRepoProjectPrompt as buildRepoProjectPromptHelper,
  buildClarifyExplorePrompt as buildClarifyExplorePromptHelper,
  buildStagePrompt as buildStagePromptHelper,
  buildRepoStagePrompt as buildRepoStagePromptHelper,
  buildPerTaskPrompt as buildPerTaskPromptHelper,
  disallowedToolsForPersona,
  STAGE_QA_PROMPT_HEADER,
  parseStageQuestions,
  serializeAgentRunResult,
  artifactIdempotencyKey,
  parseFeatureScope,
  type ParsedTask,
  type PromptBuilderContext,
  type StepContext,
} from '@esankhan3/anvil-core-pipeline';
import { runClarifyForProject } from './steps/clarify-stage.step.js';
import { runFixLoop as runFixLoopStep } from './steps/fix-loop.step.js';
import { runTestGenForProject } from './steps/test-gen-stage.step.js';
import {
  runPostBuildGuards,
  deployProject,
  createFeatureBranches as createFeatureBranchesHelper,
} from './steps/workspace-ops.js';
import { buildTurnWiring, buildSessionTurnWiring } from './durable-turn-wiring.js';
import { AgentManagerRunner } from './runners/agent-manager-runner.js';
import { AgentManagerSession } from './runners/agent-manager-session.js';
import { stageAnswerChannel, clarifyAnswerChannel } from './pipeline-runner.js';
import { renderPlanDerivedArtifact as renderPlanDerivedArtifactBridge } from './manifest-bridge.js';
import { extractAndUpdateManifest as extractAndUpdateManifestBridge } from './manifest-bridge.js';
import { clearManifestFieldsForStages as clearManifestFieldsForStagesBridge } from './manifest-bridge.js';
import { manifestGetTouchedFiles } from './manifest-bridge.js';
import type { ManifestBridgeDeps } from './manifest-bridge.js';
import type { ArtifactIODeps } from './artifact-io.js';
import type { BootstrapDeps } from './pipeline-bootstrap.js';
import type { ReviewerControl } from './reviewer-control.js';
import type { PlanRiskCache } from './manifest-bridge.js';
import type { ProjectLoader } from './project-loader.js';
import type { FeatureStore } from './feature-store.js';
import type { MemoryStore } from './memory-store.js';
import {
  STAGES,
  PLAN_DERIVED_STAGES,
  maxOutputTokensForStage,
  zeroTokenStats,
  sumTokenStats,
  type AfterStageHook,
  type PipelineConfig,
  type PipelineRunState,
  type StageDefinition,
  type StageTokenStats,
} from './pipeline-runner-types.js';
import {
  loadStageArtifact as loadStageArtifactFn,
  writeStageArtifact as writeStageArtifactFn,
  writeRepoArtifact as writeRepoArtifactFn,
  loadRepoArtifacts as loadRepoArtifactsFn,
} from './artifact-io.js';
import { detectRepos as detectReposFn } from './pipeline-bootstrap.js';

export interface StageOpsDeps {
  // Read-only data
  config: PipelineConfig;
  state: PipelineRunState;
  workspaceDir: string;

  // Mutable ref accessors
  repoPaths: () => Record<string, string>;
  walkerConfig: () => WalkerConfig;
  runtimeBurnedModels: Set<string>;
  /** model id → reason burned (HTTP status + stage + ts). */
  burnedModelReasons: Map<string, string>;

  // Cancellation
  isCancelled: () => boolean;
  setCancelled: () => void;

  // Stores / managers
  agentManager: AgentManager;
  projectLoader: ProjectLoader;
  featureStore: FeatureStore;
  /** Wave 5 — memory store handle for the recall_memory tool callback. */
  memoryStore: MemoryStore;

  // Prompt context
  getPromptContext: () => PromptBuilderContext;

  // Reviewer + plan risk
  reviewer: ReviewerControl;
  setReviewNote: (note: string | null) => void;
  planRisk: PlanRiskCache;

  // After-stage hook (live read)
  afterStageHook: () => AfterStageHook | null;

  // Side-effect hooks
  broadcast: () => void;
  checkpoint: () => void;
  emit: (event: string, ...args: unknown[]) => void;

  // Resolved helpers from sibling modules (closures over the runner's deps)
  resolveModelForStage: (stageName: string) => string;
  allowedToolsForCurrentStage: (stageName: string) => string[];
  ensureAuth: (stageName: string) => Promise<void>;

  // Manifest / IO / bootstrap dep providers
  depsForManifest: () => ManifestBridgeDeps;
  depsForArtifactIO: () => ArtifactIODeps;
  depsForBootstrap: () => BootstrapDeps;

  // Telemetry helpers
  aggregateRunTokens: (t: StageTokenStats) => void;
  logCacheTelemetry: (stage: string, t: StageTokenStats) => void;
  handleOutputTruncation: (agentName: string, outputTokens: number) => void;
  writePerRepoTelemetry: (
    stageName: string,
    repoName: string,
    stats: {
      outputBytes: number;
      outputTokens: number;
      inputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd: number;
    },
  ) => void;

  // Clarify input resolver (writable slot)
  setInputResolve: (resolve: ((text: string) => void) | null) => void;
  /**
   * Register (or clear, with `null`) the durable signal channel for the
   * clarify question currently awaiting an answer. `provideInput` reads
   * this to enqueue the answer as a durable signal alongside the
   * in-process resolve — the backstop that keeps a dropped answer from
   * hanging clarify forever.
   */
  setActiveClarifyChannel: (channel: string | null) => void;

  // Stage Q&A controls.
  /** Read the project's Q&A policy block — disabled by default returns undefined. */
  getQAPolicy: () => { enabled?: boolean; maxQuestionsPerStage?: number } | undefined;
  /** Register an input resolver for a (stageIndex, repoName?) Q&A round. */
  setStageInputResolver: (stageIndex: number, repoName: string | null, resolve: ((text: string) => void) | null) => void;

  // Fix-loop session refs (mutable)
  fixLoopAgentByRepo: Map<string, string>;
  getFixLoopAgentSingle: () => string | null;
  setFixLoopAgentSingle: (id: string | null) => void;
}

/**
 * Resolve the effective repo list for a given stage given the run's
 * feature scope. Order of precedence:
 *
 *   1. User pre-selected `config.repos` at Build time → state.repoNames
 *      (user intent always wins; ignore LLM scoping entirely).
 *   2. Stages BEFORE scope is decided (`clarify`, `requirements`) →
 *      state.repoNames (the scope artifact doesn't exist yet).
 *   3. `state.featureScope` present → state.repoNames ∩ targetRepos.
 *   4. No scope present → state.repoNames (historical default).
 *
 * Never mutates `state.repoNames` — the UI still needs the full list
 * to render out-of-scope repos as 'skipped' (vs. invisible).
 */
function effectiveRepoNames(deps: StageOpsDeps, stageName: string): string[] {
  if (deps.config.repos && deps.config.repos.length > 0) return deps.state.repoNames;
  if (stageName === 'clarify' || stageName === 'requirements') return deps.state.repoNames;
  const scope = deps.state.featureScope;
  if (!scope || scope.targetRepos.length === 0) return deps.state.repoNames;
  return deps.state.repoNames.filter((r) => scope.targetRepos.includes(r));
}

/**
 * Build a `PromptBuilderContext` whose `repoNames` is scoped for the
 * given stage. The base context (from `deps.getPromptContext()`) keeps
 * every other field intact — this is a shallow override on `repoNames`
 * only.
 */
function scopedPromptContext(deps: StageOpsDeps, stageName: string): PromptBuilderContext {
  const base = deps.getPromptContext();
  const scoped = effectiveRepoNames(deps, stageName);
  if (scoped.length === base.repoNames.length) return base;
  return { ...base, repoNames: scoped };
}

/** Reset stage state for indices [fromIndex .. toIndex] for replay. */
export function resetStagesForRerun(deps: StageOpsDeps, fromIndex: number, toIndex: number): void {
  for (let j = fromIndex; j <= toIndex; j++) {
    const s = deps.state.stages[j];
    if (!s) continue;
    s.status = 'pending';
    s.artifact = '';
    s.error = null;
    s.cost = 0;
    s.startedAt = null;
    s.completedAt = null;
    s.agentId = null;
    s.tokens = undefined;
    if (Array.isArray(s.repos)) {
      for (const r of s.repos) {
        r.status = 'pending';
        r.artifact = '';
        r.cost = 0;
        r.error = null;
        r.agentId = null;
      }
    }
  }
}

/**
 * Construct a multi-turn `AgentManagerSession`.
 *
 * `turnCtx` (the H3 durable turn channel) flips the session into BURN-AWARE
 * mode: per-phase chain-fallback + a session-spanning turn recorder (under a
 * dedicated `${stage}:session` substep) + coarse `ctx.effect` per-phase wraps
 * for crash-resume. clarify + QA pass it. fix-loop passes `undefined` (THIN
 * mode — the step body owns its per-repo fallback + recorder, threaded via
 * the AgentRunRequest).
 */
export function makeAgentSession(
  deps: StageOpsDeps,
  turnCtx?: StepContext<string>,
  sessionOpts?: { coarseWrap?: boolean },
): AgentManagerSession {
  return new AgentManagerSession({
    agentManager: deps.agentManager,
    project: deps.config.project,
    workspaceDir: deps.workspaceDir,
    isCancelled: () => deps.isCancelled(),
    resolveModel: (stageName) => deps.resolveModelForStage(stageName),
    onTruncation: (agentName, outputTokens) => deps.handleOutputTruncation(agentName, outputTokens),
    fallback: turnCtx
      ? {
          ctx: turnCtx,
          resolveModel: (stageName) => deps.resolveModelForStage(stageName),
          burnedModels: deps.runtimeBurnedModels,
          maxAttempts: deps.walkerConfig().max_attempts,
          onBurn: ({ model, status }) => {
            deps.runtimeBurnedModels.add(model);
            deps.emit('project-event', {
              source: 'routing',
              message: `${model} unavailable (HTTP ${status}); falling back to next chain entry`,
              level: 'warn',
            });
          },
          buildWiring: buildSessionTurnWiring(turnCtx),
          warn: (message) => deps.emit('project-event', { source: 'routing', message, level: 'warn' }),
          // fix-loop runs N per-repo sessions in parallel over one ctx → skip
          // the coarse wrap (idx race); clarify/QA (single session) keep it.
          coarseWrap: sessionOpts?.coarseWrap,
        }
      : undefined,
  });
}

/** Construct a one-shot `AgentManagerRunner` scoped to one stage. */
export function makeAgentRunner(deps: StageOpsDeps, stageName: string): AgentManagerRunner {
  return new AgentManagerRunner({
    agentManager: deps.agentManager,
    project: deps.config.project,
    workspaceDir: deps.workspaceDir,
    isCancelled: () => deps.isCancelled(),
    resolveModel: () => deps.resolveModelForStage(stageName),
    burnedModels: deps.runtimeBurnedModels,
    maxAttempts: deps.walkerConfig().max_attempts,
    onSpawn: (agentId, req) => {
      const stageIdx = deps.state.stages.findIndex((s) => s.name === stageName);
      if (stageIdx !== -1) {
        if (req.repoName) {
          const repo = deps.state.stages[stageIdx].repos.find((r) => r.repoName === req.repoName);
          if (repo) repo.agentId = agentId;
        } else {
          deps.state.stages[stageIdx].agentId = agentId;
          deps.emit('stage-start', stageIdx, agentId);
        }
        deps.broadcast();
      }
      const tag = req.repoName ? `${stageName}/${req.repoName}` : stageName;
      deps.emit('project-event', {
        source: 'pipeline',
        stage: stageName,
        message: `[${tag}] ${req.persona} agent spawned — awaiting first response…`,
      });
    },
    onTruncation: (agentName, outputTokens) => deps.handleOutputTruncation(agentName, outputTokens),
    onBurn: ({ model, status }) => {
      deps.runtimeBurnedModels.add(model);
      deps.emit('project-event', {
        source: 'routing',
        message: `${model} unavailable (HTTP ${status}); falling back to next chain entry`,
        level: 'warn',
      });
    },
    // Wave 5 — project-scoped recall_memory callback. Hits memory-core's
    // hybridSearch over the run's project namespace; returns compact JSON
    // the model can consume. Budget enforcement lives inside the executor.
    recallMemory: async (query, opts) => {
      try {
        const { hybridSearch } = await import('@esankhan3/anvil-memory-core');
        const store = deps.memoryStore.unwrap();
        const hits = await hybridSearch(store, query, {
          namespace: { scope: 'project', projectId: deps.config.project },
          limit: opts.limit ?? 5,
        });
        const filtered = hits.filter((m) => {
          if (opts.kind && m.kind !== opts.kind) return false;
          if (opts.subtype && m.subtype !== opts.subtype) return false;
          return true;
        });
        const trimmed = filtered.map((m) => ({
          id: m.id,
          kind: m.kind,
          subtype: m.subtype,
          content: m.content,
          tags: m.tags,
          createdAt: m.provenance.createdAt,
        }));
        return JSON.stringify(trimmed, null, 2);
      } catch (err) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });
}

/**
 * Shared `.catch` handler for a durable `ctx.waitForSignal` raced against an
 * in-process resolver (used by both clarify and the planning-stage Q&A).
 *
 * When durable is disabled (ANVIL_DURABLE_DISABLED) the Pipeline gets no store
 * → `ctx.waitForSignal` is the passthrough that THROWS — that specific
 * rejection is swallowed (defer to the in-process resolver). A cancellation
 * abort of the durable wait is likewise swallowed (matched on the error tag,
 * message substring as fallback). Both return a never-settling promise so the
 * losing branch of the `Promise.race` can't surface as an unhandled rejection
 * after the resolver wins. A genuine durable-wait failure (store error /
 * DeterminismViolation) propagates so the stage fails LOUD rather than hanging.
 */
function deferToInProcessResolver(err: unknown): Promise<string> {
  const msg = err instanceof Error ? err.message : String(err);
  const cancelled = (err as { __anvilSignalCancelled?: boolean })?.__anvilSignalCancelled === true;
  if (msg.includes('without a durable store') || cancelled || msg.includes('cancelled while waiting')) {
    return new Promise<string>(() => { /* never settles — resolver wins the race */ });
  }
  return Promise.reject(err instanceof Error ? err : new Error(msg));
}

// ── Interactive Clarify (one question at a time) ─────────────────────

async function runClarifyStage(
  deps: StageOpsDeps,
  index: number,
  ctx?: StepContext<string>,
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  // H3 burn-aware session: per-phase chain-fallback + a session-spanning turn
  // recorder + coarse `${stage}:session:pN` ctx.effect crash-resume wraps all
  // live INSIDE the session now (`ctx` → fallback config). So clarify calls
  // runClarifyForProject ONCE — no outer runWithChainFallback / coarse wrap.
  // Burn during EXPLORE continues from its partial (cross-model where the
  // next model is prefill-capable); SYNTHESIZE (resume) carries the full prior
  // conversation (§Tier 2): claude uses native --resume; a non-claude model
  // spawns fresh with reconstructed `priorMessages` (the completed explore +
  // Q&A turns), composing with the current phase's prefill.
  const session = makeAgentSession(deps, ctx);
  const result = await runClarifyForProject({
    agentSession: session,
    project: deps.config.project,
    workspaceDir: deps.workspaceDir,
    model: deps.resolveModelForStage('clarify'),
    allowedTools: deps.allowedToolsForCurrentStage('clarify'),
    maxOutputTokens: maxOutputTokensForStage('clarify'),
    explorePrompt: buildClarifyExplorePromptHelper(deps.getPromptContext()),
    projectPrompt: buildProjectPromptHelper(deps.getPromptContext(), STAGES[0]),
    isCancelled: () => deps.isCancelled(),
    onAgentSpawned: (agentId) => {
      deps.state.stages[index].agentId = agentId;
      deps.broadcast();
      deps.emit('stage-start', index, agentId);
      deps.emit('project-event', {
        source: 'pipeline',
        stage: 'clarify',
        message: `[clarify] clarifier agent spawned — awaiting first response…`,
      });
    },
    onTruncation: (agentName, outputTokens) => deps.handleOutputTruncation(agentName, outputTokens),
    onClarifyQuestion: (questionIndex, totalQuestions, question) => {
      deps.emit('clarify-question', {
        stageIndex: index,
        questionIndex,
        totalQuestions,
        question,
      });
    },
    onWaitingForInput: (agentId) => {
      deps.state.stages[index].status = 'waiting';
      deps.state.status = 'waiting';
      deps.state.waitingForInput = true;
      deps.broadcast();
      deps.emit('waiting-for-input', index, agentId);
    },
    onAnswerReceived: (answer) => {
      deps.emit('user-input', { stageIndex: index, text: answer });
      deps.state.waitingForInput = false;
      deps.broadcast();
    },
    onClarifyAck: (questionIndex, totalQuestions, hasMore) => {
      deps.emit('clarify-ack', {
        stageIndex: index,
        questionIndex,
        totalQuestions,
        hasMore,
      });
    },
    onSynthesizeStart: () => {
      deps.state.stages[index].status = 'running';
      deps.state.status = 'running';
      deps.state.waitingForInput = false;
      deps.broadcast();
    },
    inputResolver: (_question, qIndex) => {
      // Dual-path answer wait (mirrors `runStageWithQA`). The in-process
      // resolver (fired by `provideInput` via the WS `send-input` handler) is
      // the live fast path. The durable signal on `clarifyAnswerChannel` is
      // the backstop: `provideInput` enqueues the answer there too, so a
      // dropped/misrouted in-process resolve still lands AND the wait survives
      // a crash. Registering the channel arms `provideInput`'s enqueue for
      // THIS question; it's per-(stage, question) so answering Q2 can't
      // satisfy Q1. Without a durable store (`ctx` undefined / disabled),
      // `ctx.waitForSignal` throws the passthrough → swallowed → in-process
      // resolver wins (legacy behaviour preserved).
      const inProcess = new Promise<string>((resolve) => {
        deps.setInputResolve(resolve);
      });
      if (!ctx) return inProcess;
      const channel = clarifyAnswerChannel(index, qIndex);
      deps.setActiveClarifyChannel(channel);
      return Promise.race([
        ctx.waitForSignal<string>(channel).catch(deferToInProcessResolver),
        inProcess,
      ]);
    },
  });

  return {
    artifact: result.artifact,
    cost: result.cost,
    tokens: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
    },
  };
}

// ── Per-repo stage execution ───────────────────────────────────────

async function runPerRepoStage(
  deps: StageOpsDeps,
  index: number,
  stage: StageDefinition,
  prevArtifact: string,
  ctx?: StepContext<string>,
  /**
   * H3 durable turn channel (see runOneStage). Each repo's agent run gets
   * a per-repo SCOPED EffectRuntime (scopeTokens [repo]) so the concurrent
   * Promise.all fan-out doesn't share one idx counter — turn sub-effects
   * stay deterministic per repo on replay. Build's per-TASK path is NOT
   * covered here (it needs per-task isolation inside the scheduler) and
   * stays inert. Undefined → byte-identical pre-H3.
   */
  turnCtx?: StepContext<string>,
  /**
   * Extra scope token appended after [repoName] for the turn recorder, so a
   * stage RE-RUN within one run (the validate→fix→REVALIDATE loop) records
   * under a DISTINCT effect prefix (`repo:revalidate-N:`) instead of colliding
   * with the initial run's `repo:turn:0:*` (a fresh scoped runtime would read
   * the initial turns back → idempotency-hash mismatch → DeterminismViolation).
   * The `validate` rollup is prefix-tolerant, so all runs still sum together.
   */
  scopeSuffix?: string,
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  // Honor feature.scope — out-of-scope repos already marked 'skipped'
  // by P4. We iterate only the in-scope subset so the dispatch loop
  // doesn't spawn agents for skipped repos. The full `state.repoNames`
  // stays intact for UI rendering.
  const repos = effectiveRepoNames(deps, stage.name);

  if (repos.length === 0) {
    // Single-repo fallback is effectively single-stage (sequential) →
    // hand it the durable turn ctx.
    return runSingleStage(deps, index, stage, prevArtifact, turnCtx);
  }

  const promises: Promise<{
    repoName: string;
    artifact: string;
    cost: number;
    tokens: StageTokenStats;
  }>[] = [];

  for (let r = 0; r < repos.length; r++) {
    const repoName = repos[r];
    const repoPath = deps.repoPaths()[repoName] || join(deps.workspaceDir, repoName);
    // Lookup is BY NAME, not filtered index — when scope is in effect
    // the filtered loop index drifts from the original `stages[i].repos[]`
    // order (which mirrors state.repoNames). Same applies to every
    // `repos[repoIdx]` read further down.
    const repoIdx = deps.state.stages[index].repos.findIndex((rr) => rr.repoName === repoName);

    if (repoIdx >= 0 && deps.state.stages[index].repos[repoIdx]) {
      deps.state.stages[index].repos[repoIdx].status = 'running';
    }

    const projectPrompt = buildRepoProjectPromptHelper(scopedPromptContext(deps, stage.name), stage, repoName);

    if (stage.name === 'build' && stage.persona === 'engineer') {
      promises.push(
        runBuildForRepo(deps, index, repoIdx, stage, repoName, repoPath, projectPrompt, ctx, turnCtx)
          .then((res) => ({
            repoName,
            artifact: res.artifact,
            cost: res.cost,
            tokens: res.tokens,
          }))
          .catch((err) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            const repoState = deps.state.stages[index].repos[repoIdx];
            if (repoState) {
              repoState.status = 'failed';
              repoState.error = errorMsg;
            }
            deps.broadcast();
            return {
              repoName,
              artifact: '',
              cost: 0,
              tokens: zeroTokenStats(),
            };
          }),
      );
      continue;
    }

    const prompt = buildRepoStagePromptHelper(scopedPromptContext(deps, stage.name), stage, repoName, prevArtifact);

    const runner = makeAgentRunner(deps, stage.name);
    promises.push(
      (async () => {
        // H3: per-repo durable turn recording. scopeTokens [repoName] →
        // an isolated EffectRuntime + idx sequence for THIS repo, so racing
        // repos don't collide under the shared step id. resolvePrefill
        // reads this repo's partial back on a burn.
        const wiring = await buildTurnWiring({
          ctx: turnCtx,
          eventStepId: stage.name,
          scopeTokens: scopeSuffix ? [repoName, scopeSuffix] : [repoName],
        });
        let result;
        try {
          const runOnce = async () => {
            const r = await runner.run({
              persona: stage.persona,
              projectPrompt,
              userPrompt: prompt,
              workingDir: repoPath,
              stage: stage.name,
              allowedTools: deps.allowedToolsForCurrentStage(stage.name),
              maxOutputTokens: maxOutputTokensForStage(stage.name),
              repoName,
              turnRecorder: wiring.turnRecorder,
              resolvePrefill: wiring.resolvePrefill,
            });
            if (!r.output || r.output.trim().length < 50) {
              const err = new Error(
                `[per-repo:${stage.name}/${repoName}] empty artifact (${r.output?.length ?? 0} chars)`,
              );
              (err as Error & { name: string; retryable: boolean; status: number }).name = 'UpstreamError';
              (err as Error & { name: string; retryable: boolean; status: number }).retryable = true;
              (err as Error & { name: string; retryable: boolean; status: number }).status = 503;
              throw err;
            }
            return r;
          };
          // Phase E3: durable wrap for per-repo spawn. Effect name
          // includes the repo so per-repo crashes resume per-repo.
          // Empty-artifact retry preserved — the throw inside fn
          // surfaces as effect:failed (retryable upstream error)
          // and the outer chain-fallback in surrounding code path
          // re-resolves the model.
          result = ctx
            ? await ctx.effect(
                `${stage.name}:spawn-${repoName}`,
                async () => serializeAgentRunResult(await runOnce() as unknown as Record<string, unknown>) as unknown as Awaited<ReturnType<typeof runOnce>>,
              )
            : await runOnce();
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const repoState = deps.state.stages[index].repos[repoIdx];
          if (repoState) {
            repoState.status = 'failed';
            repoState.error = errorMsg;
          }
          deps.broadcast();
          return {
            repoName,
            artifact: '',
            cost: 0,
            tokens: zeroTokenStats(),
          };
        }

        const repoState = deps.state.stages[index].repos[repoIdx];
        const repoCost = result.costUsd ?? 0;
        if (repoState) {
          repoState.status = 'completed';
          repoState.cost = repoCost;
          repoState.artifact = result.output;
        }
        // Live aggregation — bump the run-level totalCost the moment
        // this repo finishes so the dashboard's top-of-screen total
        // ticks up across the stage instead of jumping at the end.
        // The post-stage block at the end of runOneStage skips its
        // `totalCost += result.cost` for per-repo stages to avoid
        // double-counting.
        deps.state.totalCost += repoCost;
        deps.broadcast();
        deps.checkpoint();

        // Phase E3: durable wrap for per-repo artifact write.
        if (ctx) {
          await ctx.effect(
            `${stage.name}:write-${repoName}`,
            async () => {
              writeRepoArtifactFn(deps.depsForArtifactIO(), stage, repoName, result.output);
              return null;
            },
            { idempotencyKey: artifactIdempotencyKey(stage.name, repoName, result.output) },
          );
        } else {
          writeRepoArtifactFn(deps.depsForArtifactIO(), stage, repoName, result.output);
        }

        deps.writePerRepoTelemetry(stage.name, repoName, {
          outputBytes: result.output?.length ?? 0,
          outputTokens: result.outputTokens ?? 0,
          inputTokens: result.inputTokens ?? 0,
          cacheReadTokens: result.cacheReadTokens ?? 0,
          cacheWriteTokens: result.cacheWriteTokens ?? 0,
          costUsd: result.costUsd ?? 0,
        });

        return {
          repoName,
          artifact: result.output,
          cost: result.costUsd ?? 0,
          tokens: {
            inputTokens: result.inputTokens ?? 0,
            outputTokens: result.outputTokens ?? 0,
            cacheReadTokens: result.cacheReadTokens ?? 0,
            cacheWriteTokens: result.cacheWriteTokens ?? 0,
          },
        };
      })(),
    );
  }

  const results = await Promise.all(promises);
  const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
  const tokens = sumTokenStats(results.map((r) => r.tokens));
  const successResults = results.filter((r) => r.artifact);
  const failedRepos = results.filter((r) => !r.artifact).map((r) => r.repoName);

  const combined = combinePerRepoArtifacts(successResults);

  if (failedRepos.length > 0) {
    throw new Error(
      `Per-repo stage "${stage.name}" failed on ${failedRepos.length} of ${repos.length} repo(s): ${failedRepos.join(', ')}. ` +
      `Stage cannot advance — retry the run or rerun this stage after fixing the underlying error.`,
    );
  }

  return { artifact: combined, cost: totalCost, tokens };
}

// ── Build stage: per-task spawning ─────────────────────────────────

async function runBuildForRepo(
  deps: StageOpsDeps,
  stageIndex: number,
  repoIdx: number,
  stage: StageDefinition,
  repoName: string,
  repoPath: string,
  projectPrompt: string,
  ctx?: StepContext<string>,
  /**
   * H3 durable turn channel (per-task isolation). Build fans tasks out
   * concurrently within a repo (maxConcurrent) AND repos run concurrently,
   * so each task gets a recorder scoped `[repo, taskId]` (fallback `[repo]`)
   * via `makeTurnWiring`. This REPLACES the old single-effect-per-task /
   * per-repo wraps (which nested + were never durably exercised). Undefined
   * → NullTurnRecorder (byte-identical pre-H3).
   */
  turnCtx?: StepContext<string>,
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  const repoArtifacts = loadRepoArtifactsFn(deps.depsForArtifactIO(), repoName);

  const runner = makeAgentRunner(deps, stage.name);
  const buildOpts = {
    runner,
    project: deps.config.project,
    stageName: stage.name,
    persona: stage.persona,
    allowedTools: deps.allowedToolsForCurrentStage(stage.name),
    maxOutputTokens: maxOutputTokensForStage(stage.name),
    repoName,
    repoPath,
    projectPrompt,
    tasksMarkdown: repoArtifacts.tasks,
    buildPerTaskPrompt: (task: ParsedTask) =>
      buildPerTaskPromptHelper(deps.getPromptContext(), repoName, repoPath, task, repoArtifacts.specs),
    buildFallbackPrompt: () => buildRepoStagePromptHelper(deps.getPromptContext(), stage, repoName, ''),
    isCancelled: () => deps.isCancelled(),
    onProjectEvent: (level: 'info' | 'warn' | 'error', message: string) => {
      deps.emit('project-event', { source: 'pipeline', message, level });
    },
    // Per-task durable wiring: scope [repo, taskId] (task) or [repo]
    // (fallback). The scoped recorder's turn:N:* sub-effects become the
    // top-level effects for that task — no outer wrap to nest inside.
    makeTurnWiring: (taskId: string | null) =>
      buildTurnWiring({
        ctx: turnCtx,
        eventStepId: 'build',
        scopeTokens: taskId ? [repoName, taskId] : [repoName],
      }),
  };
  const result = await runBuildForOneRepo(buildOpts);

  const repoStateDone = deps.state.stages[stageIndex].repos[repoIdx];
  if (repoStateDone) {
    repoStateDone.status = 'completed';
    repoStateDone.cost = result.cost;
    repoStateDone.artifact = result.artifact;
  }
  // Same live-aggregation rule as the inline per-repo path: bump
  // totalCost the moment this build repo finishes; the post-stage
  // block skips for per-repo so this isn't double-counted.
  deps.state.totalCost += result.cost;
  deps.broadcast();
  deps.checkpoint();
  if (ctx) {
    await ctx.effect(
      `build:write-${repoName}`,
      async () => {
        writeRepoArtifactFn(deps.depsForArtifactIO(), stage, repoName, result.artifact);
        return null;
      },
      { idempotencyKey: artifactIdempotencyKey('build', repoName, result.artifact) },
    );
  } else {
    writeRepoArtifactFn(deps.depsForArtifactIO(), stage, repoName, result.artifact);
  }

  return {
    artifact: result.artifact,
    cost: result.cost,
    tokens: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
    },
  };
}

// ── Single-agent stage execution ───────────────────────────────────

/**
 * Stage names whose agents may pause to ask the user clarifying
 * questions before producing the artifact. Hard-coded so users can't
 * enable Q&A on `build` (a known anti-pattern: see plan §2 non-goals).
 */
const STAGES_WITH_QA: ReadonlySet<string> = new Set([
  'requirements',
  'repo-requirements',
  'specs',
]);

function isQAEnabled(deps: StageOpsDeps, stageName: string): { enabled: boolean; max: number } {
  if (!STAGES_WITH_QA.has(stageName)) return { enabled: false, max: 0 };
  const policy = deps.getQAPolicy();
  if (!policy || policy.enabled === false) return { enabled: false, max: 0 };
  const max = typeof policy.maxQuestionsPerStage === 'number' && policy.maxQuestionsPerStage > 0
    ? policy.maxQuestionsPerStage
    : 5;
  return { enabled: true, max };
}

/**
 * Q&A-aware single-stage runner. Spawns a multi-turn session with a
 * `<questions>...</questions>` opt-in header in the prompt. If the agent
 * emits questions, the runner pauses, broadcasts each question to the
 * dashboard, awaits user answers via the per-stage input resolver, then
 * resumes the session with an `<answers>...</answers>` block. The
 * session's second response is the artifact.
 *
 * Confident agents skip the Q&A block entirely; the first response IS
 * the artifact and we return immediately.
 */
async function runStageWithQA(
  deps: StageOpsDeps,
  index: number,
  stage: StageDefinition,
  prevArtifact: string,
  maxQuestions: number,
  ctx?: StepContext<string>,
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  const baseUserPrompt = buildStagePromptHelper(deps.getPromptContext(), stage, prevArtifact);
  const projectPrompt = buildProjectPromptHelper(deps.getPromptContext(), stage);
  const qaPrompt = STAGE_QA_PROMPT_HEADER(maxQuestions) + baseUserPrompt;

  // H3 burn-aware session: per-phase chain-fallback + session-spanning turn
  // recorder + coarse `${stage}:session:pN` ctx.effect crash-resume wraps live
  // INSIDE the session (`ctx` → fallback config). The session's start() does
  // its own coarse wrap, so we no longer wrap here; the durable Q&A wait
  // (ctx.waitForSignal) stays between p0 (start) and p1 (resume).
  const session = makeAgentSession(deps, ctx);
  const startReq = {
    persona: stage.persona,
    projectPrompt,
    userPrompt: qaPrompt,
    workingDir: deps.workspaceDir,
    stage: stage.name,
    allowedTools: deps.allowedToolsForCurrentStage(stage.name),
    disallowedTools: disallowedToolsForPersona(stage.persona),
    maxOutputTokens: maxOutputTokensForStage(stage.name),
  };
  const first = await session.start(startReq);

  if (first.agentId) {
    deps.state.stages[index].agentId = first.agentId;
    deps.broadcast();
  }

  const questions = parseStageQuestions(first.output, maxQuestions);
  if (questions.length === 0) {
    // Agent was confident — first response is the artifact.
    return {
      artifact: first.output,
      cost: first.costUsd ?? 0,
      tokens: {
        inputTokens: first.inputTokens ?? 0,
        outputTokens: first.outputTokens ?? 0,
        cacheReadTokens: first.cacheReadTokens ?? 0,
        cacheWriteTokens: first.cacheWriteTokens ?? 0,
      },
    };
  }

  // Q&A path — populate state, broadcast each question, await answers.
  const stageState = deps.state.stages[index];
  stageState.questions = questions.map((text, qi) => ({ index: qi, text }));
  stageState.status = 'waiting';
  deps.state.status = 'waiting';
  deps.state.waitingForInput = true;
  deps.broadcast();
  for (let qi = 0; qi < questions.length; qi += 1) {
    deps.emit('stage-question', {
      stageIndex: index,
      stageName: stage.name,
      questionIndex: qi,
      totalQuestions: questions.length,
      question: questions[qi],
    });
  }
  deps.emit('waiting-for-input', index, first.agentId ?? null);

  // Dual-path answer wait. §H3 Fix A: on the FORWARD pass the dashboard
  // Pipeline now runs WITH the module-singleton durable store, so
  // `ctx.waitForSignal` reads the durable signals queue (Q&A survives a crash
  // mid-wait WITHIN the process; cross-restart resume currently mints a fresh
  // runId — see ADR §4.3.2 Fix A follow-up). When durable is disabled
  // (ANVIL_DURABLE_DISABLED) the Pipeline gets no store → `ctx.waitForSignal`
  // is the passthrough that THROWS — ONLY that specific rejection is swallowed
  // (defer to the in-process resolver); a REAL durable rejection (store error /
  // DeterminismViolation) propagates so the stage fails LOUD rather than
  // hanging forever on the resolver. The in-process resolver (fired
  // synchronously by provideStageAnswer alongside the signal enqueue) is the
  // live answer path and normally wins the race. `stageAnswerChannel` keeps
  // producer + consumer aligned (auto-suffixes `:<repo>` for a future per-repo Q&A).
  // `deferToInProcessResolver` (module scope) is shared with clarify's Q&A wait.
  const answersBlock = ctx
    ? await Promise.race([
        ctx.waitForSignal<string>(stageAnswerChannel(index, null)).catch(deferToInProcessResolver),
        new Promise<string>((resolve) => {
          deps.setStageInputResolver(index, null, resolve);
        }),
      ])
    : await new Promise<string>((resolve) => {
        deps.setStageInputResolver(index, null, resolve);
      });

  // Cancellation guard — the resolver fires with '' on cancel.
  if (!answersBlock) {
    return {
      artifact: '',
      cost: first.costUsd ?? 0,
      tokens: {
        inputTokens: first.inputTokens ?? 0,
        outputTokens: first.outputTokens ?? 0,
        cacheReadTokens: first.cacheReadTokens ?? 0,
        cacheWriteTokens: first.cacheWriteTokens ?? 0,
      },
    };
  }

  // Resume — the agent now has the answers and produces the artifact.
  stageState.status = 'running';
  deps.state.status = 'running';
  deps.state.waitingForInput = false;
  deps.broadcast();

  // Resume = phase p1. The session's sendInput does its own coarse
  // `${stage}:session:p1` ctx.effect (crash-resume) + per-phase fallback.
  // The answers block was already woven into the conversation by p0's
  // recorded turns, so replay returns the recorded artifact directly.
  const second = await session.sendInput(first.sessionId, answersBlock);

  return {
    artifact: second.output,
    cost: (first.costUsd ?? 0) + (second.costUsd ?? 0),
    tokens: {
      inputTokens: (first.inputTokens ?? 0) + (second.inputTokens ?? 0),
      outputTokens: (first.outputTokens ?? 0) + (second.outputTokens ?? 0),
      cacheReadTokens: (first.cacheReadTokens ?? 0) + (second.cacheReadTokens ?? 0),
      cacheWriteTokens: (first.cacheWriteTokens ?? 0) + (second.cacheWriteTokens ?? 0),
    },
  };
}

async function runSingleStage(
  deps: StageOpsDeps,
  index: number,
  stage: StageDefinition,
  prevArtifact: string,
  ctx?: StepContext<string>,
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  const qa = isQAEnabled(deps, stage.name);
  if (qa.enabled) {
    // Q&A is a multi-turn session (start → durable wait → sendInput). The
    // burn-aware session (turnCtx) records per-phase turns under `:session`,
    // wraps each phase in a coarse ctx.effect for crash-resume, and keeps
    // the durable Q&A wait between p0 and p1.
    return runStageWithQA(deps, index, stage, prevArtifact, qa.max, ctx);
  }

  const scopedCtx = scopedPromptContext(deps, stage.name);
  const prompt = buildStagePromptHelper(scopedCtx, stage, prevArtifact);
  const projectPrompt = buildProjectPromptHelper(scopedCtx, stage);

  const runner = makeAgentRunner(deps, stage.name);
  // H3 cutover: replace the single outer `${stage}:spawn-agent` effect
  // with turn-level recording. The recorder emits turn:N:* sub-effects
  // through ctx, so crash-resume skips completed turns + chain-fallback
  // continues a burned model from its partial. resolvePrefill reads that
  // partial back. Single-stage path → no scope tokens (one sequential
  // agent). Non-durable (ctx undefined) → wiring is empty → unchanged.
  const wiring = await buildTurnWiring({ ctx, eventStepId: stage.name });
  const runReq = {
    persona: stage.persona,
    projectPrompt,
    userPrompt: prompt,
    workingDir: deps.workspaceDir,
    stage: stage.name,
    allowedTools: deps.allowedToolsForCurrentStage(stage.name),
    disallowedTools: disallowedToolsForPersona(stage.persona),
    maxOutputTokens: maxOutputTokensForStage(stage.name),
    turnRecorder: wiring.turnRecorder,
    resolvePrefill: wiring.resolvePrefill,
  };
  const result = await runner.run(runReq);

  if (result.agentId) {
    deps.state.stages[index].agentId = result.agentId;
    deps.broadcast();
  }

  return {
    artifact: result.output,
    cost: result.costUsd ?? 0,
    tokens: {
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      cacheReadTokens: result.cacheReadTokens ?? 0,
      cacheWriteTokens: result.cacheWriteTokens ?? 0,
    },
  };
}

// ── Test-gen stage ─────────────────────────────────────────────────

async function runTestGenStage(
  deps: StageOpsDeps,
  stageIndex: number,
  ctx?: StepContext<string>,
): Promise<string> {
  const scopedRepos = effectiveRepoNames(deps, 'test');
  const repoNames = scopedRepos.length
    ? scopedRepos
    : Object.keys(deps.repoPaths());
  const repoLocalPaths: Record<string, string> = {};
  for (const r of repoNames) repoLocalPaths[r] = deps.repoPaths()[r] ?? join(deps.workspaceDir, r);

  const opts = {
    planSeed: deps.config.planSeed ?? null,
    project: deps.config.project,
    model: deps.config.model,
    workspaceDir: deps.workspaceDir,
    repoLocalPaths,
    onConventionsDetected: (artifact: string) => {
      deps.state.stages[stageIndex].artifact = artifact;
    },
    onArtifactWritten: (event: unknown) => {
      deps.emit('artifact-written', event);
    },
  };
  // Phase E7: durable wrap for test-gen. Single effect — the
  // test-gen path inside runTestGenForProject is already
  // serial-per-repo internally; per-repo granularity is a future
  // refinement that would require threading ctx into core-pipeline.
  return ctx
    ? ctx.effect('test:spawn-testgen', async () => runTestGenForProject(opts))
    : runTestGenForProject(opts);
}

// ── Validate→fix loop ──────────────────────────────────────────────

async function runFixLoop(
  deps: StageOpsDeps,
  validateStageIndex: number,
  validateArtifact: string,
  attempt: number,
  ctx: StepContext<string> | undefined,
  fixSessions: Map<string, AgentManagerSession>,
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  const buildStage = STAGES.find((s) => s.name === 'build')!;
  // Fix-loop runs against build's effective set — no point fixing a
  // repo the build never touched.
  const fixRepos = effectiveRepoNames(deps, 'build');
  const repoPaths: Record<string, string> = {};
  for (const repoName of fixRepos) {
    repoPaths[repoName] = deps.repoPaths()[repoName] || join(deps.workspaceDir, repoName);
  }

  // §H3 fix-loop turn recording (per-repo step-body fallback). Each repo (and
  // the single-repo path) gets its OWN burn-aware session: per-phase
  // chain-fallback + a per-repo-scoped turn recorder (cost/provenance) +
  // cross-attempt resume — moving the fallback INTO the per-repo loop (was a
  // step-level outer `runWithChainFallback`, which couldn't carry a per-repo
  // prefill/recorder). Sessions are cached across attempts (`fixSessions`,
  // owned by the validate while-loop) so each recorder's turn counter stays
  // monotonic across `sendInput` resumes. `coarseWrap:false` — the sessions run
  // in parallel over one shared `ctx`, so the per-repo `ownRuntime` recorder is
  // the isolation boundary (a coarse `ctx.effect` per repo would race). When
  // `ctx` is undefined (non-durable) the session is inert (NullTurnRecorder),
  // byte-identical to the legacy thin path. The enclosing stage label
  // ('validate') makes fix-loop turns roll up under the validate step's
  // `step:completed` cost (the runner reads `validate` + `validate:session`).
  const sessionStage = STAGES[validateStageIndex]?.name ?? 'validate';
  const sessionForRepo = (repoName: string | null): AgentManagerSession => {
    const key = repoName ?? '__single__';
    let session = fixSessions.get(key);
    if (!session) {
      session = makeAgentSession(deps, ctx, { coarseWrap: false });
      fixSessions.set(key, session);
    }
    return session;
  };

  const result = await runFixLoopStep({
    sessionForRepo,
    project: deps.config.project,
    model: deps.resolveModelForStage('fix-loop'),
    allowedTools: deps.allowedToolsForCurrentStage('fix-loop'),
    maxOutputTokens: maxOutputTokensForStage('build'),
    workspaceDir: deps.workspaceDir,
    repoNames: fixRepos,
    repoPaths,
    validateArtifact,
    attempt,
    sessionStage,
    // Record under the enclosing 'validate' step (sessionStage) so cost rolls
    // up there, but keep burn-fallback on the 'fix-loop' model chain.
    fallbackStage: 'fix-loop',
    priorByRepo: deps.fixLoopAgentByRepo,
    priorSingleId: deps.getFixLoopAgentSingle(),
    buildProjectPromptForBuildStage: () => buildProjectPromptHelper(deps.getPromptContext(), buildStage),
    buildRepoProjectPromptForBuildStage: (repoName: string) =>
      buildRepoProjectPromptHelper(deps.getPromptContext(), buildStage, repoName),
    isCancelled: () => deps.isCancelled(),
  });
  if (result.newSingleId !== null) {
    deps.setFixLoopAgentSingle(result.newSingleId);
  }
  return {
    artifact: result.artifact,
    cost: result.cost,
    tokens: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
    },
  };
}

// ── One-stage dispatcher ───────────────────────────────────────────
//
// Encodes the body of the pipeline-loop iteration as a single async
// function. Returns a control-flow flag the caller (the registry's
// `runStage` callback) maps to `continue` / `next` / `cancelled` /
// `fail-early-return` / `rewind`. The walker (Pipeline.run) drives one
// invocation per stage.
export async function runOneStage(
  deps: StageOpsDeps,
  i: number,
  isResume: boolean,
  resumeStage: number,
  prevArtifactIn: string,
  /**
   * Walker StepContext. Optional so legacy callers / tests that
   * invoke `runOneStage` directly keep working. When supplied, the
   * stage's effect-bearing calls go through `ctx.effect(...)` so
   * a durable store records them. When undefined, calls fire
   * directly — the contract is a transparent superset.
   *
   * Phase E1+ of the effect-site conversion plan.
   */
  ctx?: StepContext<string>,
  /**
   * H3 cutover — durable turn-level recording channel. SEPARATE from
   * `ctx` (which the dashboard loop still leaves undefined, so every
   * pre-existing `ctx.effect` / `ctx.waitForSignal` site in this body
   * keeps its exact pre-H3 behavior). `turnCtx` is forwarded ONLY to the
   * sequential single-stage path, which runs one agent at a time and is
   * therefore replay-safe. The per-repo (parallel → shared idx), build
   * (nested repo+task wraps) and session (multi-turn) paths need per-unit
   * EffectRuntime isolation before they can emit interleaved turn
   * sub-effects deterministically; until that lands they receive neither
   * `ctx` nor `turnCtx`. See docs/TURN-LEVEL-DURABLE-RESUME-ADR.md §2.4.
   */
  turnCtx?: StepContext<string>,
): Promise<{
  control: 'continue' | 'next' | 'cancelled' | 'fail-early-return' | 'rewind';
  rewindTo?: number;
  prevArtifact: string;
}> {
  let prevArtifact = prevArtifactIn;
  if (deps.isCancelled()) return { control: 'cancelled', prevArtifact };
  const stage = STAGES[i];

  try {
    if (isResume && i < resumeStage) {
      deps.state.stages[i].status = 'completed';
      deps.state.stages[i].completedAt = new Date().toISOString();
      const storedArtifact = loadStageArtifactFn(deps.depsForArtifactIO(), stage);
      deps.state.stages[i].artifact = storedArtifact;
      deps.broadcast();
      deps.checkpoint();
      return { control: 'continue', prevArtifact };
    }

    if (stage.name === 'clarify' && deps.config.skipClarify) {
      const seed = deps.config.clarifySeedArtifact ?? 'Clarification skipped.';
      deps.state.stages[i].status = 'skipped';
      deps.state.stages[i].artifact = seed;
      prevArtifact = seed;
      if (deps.config.clarifySeedArtifact) {
        try {
          deps.featureStore.writeArtifact(
            deps.config.project,
            deps.state.featureSlug,
            'CLARIFICATION.md',
            deps.config.clarifySeedArtifact,
          );
        } catch { /* not fatal */ }
      }
      deps.broadcast();
      deps.checkpoint();
      return { control: 'continue', prevArtifact };
    }
    if (stage.name === 'ship' && deps.config.skipShip) {
      deps.state.stages[i].status = 'skipped';
      deps.broadcast();
      deps.checkpoint();
      return { control: 'continue', prevArtifact };
    }

    if (deps.config.planSeed && PLAN_DERIVED_STAGES.includes(stage.name)) {
      console.warn(
        `[pipeline] runOneStage(${stage.name}) reached with planSeed — `
          + `skipIf path should have fired earlier. Falling through to `
          + `legacy renderer for safety.`,
      );
      await renderPlanDerivedArtifactBridge(deps.depsForManifest(), stage.name, i);
      prevArtifact = deps.state.stages[i].artifact ?? prevArtifact;
      return { control: 'continue', prevArtifact };
    }

    if (stage.name === 'test') {
      if (!deps.config.planSeed) {
        deps.state.stages[i].status = 'skipped';
        deps.state.stages[i].artifact = 'Test stage skipped (no plan seed).';
        prevArtifact = deps.state.stages[i].artifact;
        deps.state.stages[i].completedAt = new Date().toISOString();
        deps.broadcast();
        deps.checkpoint();
        return { control: 'continue', prevArtifact };
      }
      try {
        // H3 staged activation: test-gen has its own per-spawn effect
        // path; keep it inert (undefined) until ported. See dispatch note.
        const artifact = await runTestGenStage(deps, i, undefined);
        deps.state.stages[i].status = 'completed';
        deps.state.stages[i].artifact = artifact;
        deps.state.stages[i].completedAt = new Date().toISOString();
        prevArtifact = artifact;
        deps.broadcast();
        deps.checkpoint();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[pipeline] test-gen failed, continuing to validate:', msg);
        deps.state.stages[i].status = 'skipped';
        deps.state.stages[i].artifact = `Test stage skipped (${msg}).`;
        deps.state.stages[i].completedAt = new Date().toISOString();
        deps.broadcast();
        deps.checkpoint();
      }
      return { control: 'continue', prevArtifact };
    }

    console.log(`[pipeline] Entering stage "${stage.name}" (${i + 1}/${STAGES.length})`);

    deps.reviewer.armForCurrentStage();
    await deps.ensureAuth(stage.name);

    if (stage.name === 'build') {
      const branchName = `anvil/${deps.state.featureSlug}`;
      const branchRepos = effectiveRepoNames(deps, 'build');
      console.log(`[pipeline] Creating feature branch "${branchName}" in ${branchRepos.length} repo(s)...`);
      createFeatureBranchesHelper({
        featureSlug: deps.state.featureSlug,
        repoPaths: deps.repoPaths(),
        repoNames: branchRepos,
        workspaceDir: deps.workspaceDir,
        onLog: (level, message) => {
          if (level === 'info') console.log(`[pipeline] ${message}`);
          else console.warn(`[pipeline] ${message}`);
        },
      });
    }
    if (stage.name === 'validate') {
      console.log('[pipeline] Running post-build guards (format + lint auto-fix)...');
      const guardRepos = effectiveRepoNames(deps, 'validate');
      const reposForGuards = guardRepos.length > 0
        ? guardRepos.map((r) => ({ name: r, path: deps.repoPaths()[r] || join(deps.workspaceDir, r) }))
        : [{ name: deps.config.project, path: deps.workspaceDir }];
      runPostBuildGuards({
        repos: reposForGuards,
        getRepoCommands: (repoName) => deps.projectLoader.getRepoCommands(deps.config.project, repoName),
        onLog: (level, message) => {
          if (level === 'info') console.log(`[pipeline] ${message}`);
          else console.warn(`[pipeline] ${message}`);
        },
      });
      console.log('[pipeline] Post-build guards complete.');
    }

    deps.state.currentStage = i;
    deps.state.stages[i].status = 'running';
    deps.state.stages[i].startedAt = new Date().toISOString();
    deps.broadcast();
    deps.checkpoint();
    deps.emit('stage-start', i, '');

    try {
      let result: { artifact: string; cost: number; tokens: StageTokenStats };

      // H3 cutover — staged activation. `ctx` carries durable turn-level
      // recording. It is forwarded ONLY to the single-stage path, which is
      // SEQUENTIAL (one agent at a time) and therefore replay-safe. The
      // per-repo path (parallel Promise.all → shared idx counter) and the
      // session paths (multi-turn clarify/fix-loop) require per-unit
      // EffectRuntime isolation before they can safely emit interleaved
      // turn sub-effects; until that lands they run with ctx=undefined,
      // i.e. byte-identical to pre-H3. See docs/TURN-LEVEL-DURABLE-RESUME-ADR.md §2.4.
      if (stage.name === 'clarify') {
        result = await runClarifyStage(deps, i, turnCtx);
      } else if (stage.perRepo && deps.state.repoNames.length > 0) {
        result = await runPerRepoStage(deps, i, stage, prevArtifact, undefined, turnCtx);
      } else {
        // Only the sequential single-stage path gets the durable turn ctx.
        result = await runSingleStage(deps, i, stage, prevArtifact, turnCtx);
      }

      if (deps.isCancelled()) return { control: 'cancelled', prevArtifact };

      deps.state.stages[i].status = 'completed';
      deps.state.stages[i].completedAt = new Date().toISOString();
      deps.state.stages[i].artifact = result.artifact;
      deps.state.stages[i].cost = result.cost;
      deps.state.stages[i].tokens = result.tokens;
      // Per-repo stages already incremented totalCost incrementally
      // as each repo finished (see `runPerRepoStage` + `runBuildForRepo`).
      // Adding `result.cost` again here would double-count.
      if (!stage.perRepo) {
        deps.state.totalCost += result.cost;
      }
      deps.aggregateRunTokens(result.tokens);
      deps.logCacheTelemetry(stage.name, result.tokens);
      prevArtifact = result.artifact;
      deps.broadcast();
      deps.checkpoint();
      deps.emit('stage-complete', i, result.artifact, result.cost);

      const afterStageHook = deps.afterStageHook();
      if (afterStageHook) {
        try {
          const risk = deps.planRisk.get(deps.config.planSeed);
          // Phase F1: durable-signal-aware reviewer pause. When ctx
          // is provided, the after-stage hook can call
          // waitForReviewerDecision(channel) which delegates to
          // ctx.waitForSignal — a recorded decision on replay
          // returns immediately without re-blocking on the user.
          const waitForReviewerDecision = ctx
            ? (channel: string) => ctx.waitForSignal(channel)
            : undefined;
          await afterStageHook({
            runId: deps.state.runId,
            project: deps.config.project,
            stageIndex: i,
            stageName: stage.name,
            artifact: result.artifact,
            cost: result.cost,
            totalCost: deps.state.totalCost,
            touchedFiles: manifestGetTouchedFiles(deps.depsForManifest()),
            riskTier: risk.tier,
            confidence: risk.confidence,
            ...(waitForReviewerDecision ? { waitForReviewerDecision } : {}),
          });
          if (deps.isCancelled()) return { control: 'cancelled', prevArtifact };
        } catch (err) {
          console.warn(`[pipeline] after-stage hook rejected at ${stage.name}:`, err);
          deps.setCancelled();
          return { control: 'cancelled', prevArtifact };
        }
      }

      const rerun = deps.reviewer.consumeRerunRequest();
      if (rerun !== null) {
        const target = rerun.targetIndex;
        if (rerun.mode === 'iterate') {
          resetStagesForRerun(deps, target, target);
          if (rerun.note) deps.setReviewNote(rerun.note);
          console.log(`[pipeline] Iterate requested → re-running stage ${target} (${STAGES[target].name}) with reviewer feedback`);
        } else {
          resetStagesForRerun(deps, target, i);
          clearManifestFieldsForStagesBridge(deps.depsForManifest(), target, i);
          if (rerun.note) {
            deps.config.failureContext =
              `Rerun requested by reviewer at stage "${STAGES[target].name}":\n${rerun.note}`;
          }
          console.log(`[pipeline] Rerun-from requested → resetting to stage ${target} (${STAGES[target].name})`);
        }
        prevArtifact = target > 0
          ? (deps.state.stages[target - 1]?.artifact ?? '')
          : '';
        deps.broadcast();
        deps.checkpoint();
        return { control: 'rewind', rewindTo: target, prevArtifact };
      }

      const edited = deps.reviewer.consumeArtifactOverride();
      if (edited !== null) {
        prevArtifact = edited;
      } else {
        // Phase E2: durable wrap for stage artifact write. Idempotency key
        // includes the content hash so re-runs with the same body collapse;
        // re-runs with a different body surface as a determinism violation.
        if (ctx) {
          await ctx.effect(
            `${stage.name}:write-artifact`,
            async () => {
              writeStageArtifactFn(deps.depsForArtifactIO(), stage, result.artifact);
              return null;
            },
            { idempotencyKey: artifactIdempotencyKey(stage.name, 'stage', result.artifact) },
          );
        } else {
          writeStageArtifactFn(deps.depsForArtifactIO(), stage, result.artifact);
        }
      }

      try {
        await extractAndUpdateManifestBridge(deps.depsForManifest(), stage, result.artifact);
      } catch (err) {
        console.warn(`[pipeline] manifest extraction at ${stage.name} failed:`, err);
      }

      if (stage.name === 'build' && deps.config.planSeed && !deps.isCancelled()) {
        try {
          const { captureDeviation, updateLearnings } = await import('./plan-deviation.js');
          const featureDir = deps.featureStore.getFeatureDir(deps.config.project, deps.state.featureSlug);
          const repoLocalPaths: Record<string, string> = {};
          for (const r of deps.state.repoNames) repoLocalPaths[r] = deps.repoPaths()[r] ?? '';
          const deviation = captureDeviation(deps.config.planSeed.plan, {
            featureDir,
            repoLocalPaths,
            baseBranch: deps.config.baseBranch ?? 'main',
            branch: `anvil/${deps.state.featureSlug}`,
          });
          const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME
            || (await import('node:os')).homedir() + '/.anvil';
          updateLearnings(
            anvilHome,
            deps.config.project,
            deviation,
            deps.state.totalCost,
            deps.config.planSeed.plan.estimate.usd,
          );
          deps.emit('artifact-written', {
            stage: 'build',
            file: `${featureDir}/plan-deviation.json`,
            summary: `Plan match rate: ${(deviation.summary.matchRate * 100).toFixed(0)}%`,
            content: JSON.stringify(deviation, null, 2),
          });
        } catch (err) {
          console.warn('[pipeline] Plan deviation capture failed:', err);
        }
      }

      if (stage.name === 'ship' && deps.config.deploy && !deps.isCancelled()) {
        const deployOpts = {
          project: deps.config.project,
          mode: deps.config.deploy,
          workspaceDir: deps.workspaceDir,
          configDeployCmd: deps.projectLoader.getConfig(deps.config.project)?.pipeline?.ship?.deploy,
          envDeployCmd: process.env.ANVIL_DEPLOY_CMD || process.env.FF_DEPLOY_CMD,
          onArtifact: (artifact: unknown) => deps.emit('artifact-written', artifact),
          onLog: (level: string, message: string) => {
            if (level === 'info') console.log(`[pipeline] ${message}`);
            else console.warn(`[pipeline] ${message}`);
          },
        };
        // Phase E8: durable wrap for nexus deploy. Idempotency
        // key includes runId so a re-run of the same project +
        // mode replays cleanly. Note: deployProject's external
        // idempotency (e.g. nexus dedup on deploy id) lives in
        // deployProject itself; this wrap protects against
        // re-spawning the deploy command on resume.
        if (ctx) {
          await ctx.effect(
            'ship:deploy',
            async () => {
              deployProject(deployOpts);
              return null;
            },
            { idempotencyKey: `${ctx.runId}:${deps.config.project}:${deps.config.deploy ?? 'local'}` },
          );
        } else {
          deployProject(deployOpts);
        }
      }

      if (stage.name === 'requirements' && deps.state.repoNames.length === 0) {
        detectReposFn(deps.depsForBootstrap());
      }

      // Feature scope decision — only applies when (a) requirements
      // just completed, (b) the user didn't pre-select repos at Build
      // time (user intent wins), and (c) more than one repo is in
      // play. Failure to parse / validate falls through silently
      // (every repo runs, the historical default).
      if (
        stage.name === 'requirements'
        && !deps.isCancelled()
        && !(deps.config.repos && deps.config.repos.length > 0)
        && deps.state.repoNames.length > 1
        && !deps.state.featureScope
      ) {
        const scope = parseFeatureScope(result.artifact, deps.state.repoNames);
        if (scope) {
          deps.state.featureScope = scope;
          // Mark off-scope repos as 'skipped' on every per-repo stage
          // so the UI surfaces the decision instead of showing them
          // as silently-stuck 'pending'.
          const targetSet = new Set(scope.targetRepos);
          for (const s of deps.state.stages) {
            if (s.perRepo) {
              for (const r of s.repos) {
                if (!targetSet.has(r.repoName) && r.status === 'pending') {
                  r.status = 'skipped';
                }
              }
            }
          }
          // Persist for resume — feature-store sidecar.
          try {
            deps.featureStore.writeArtifact(
              deps.config.project,
              deps.state.featureSlug,
              'feature.scope.json',
              JSON.stringify(scope, null, 2),
            );
          } catch (err) {
            console.warn('[pipeline] failed to persist feature.scope.json:', err);
          }
          // Loud surfacing: console, activity feed (project-event),
          // and an artifact-written event so the scope sidecar shows
          // up in the run's artifact stream alongside REQUIREMENTS.md.
          const skipped = deps.state.repoNames.filter((r) => !targetSet.has(r));
          const msg = `requirements: scoped to [${scope.targetRepos.join(', ')}] of [${deps.state.repoNames.join(', ')}] — skipped [${skipped.join(', ')}] (${scope.rationale})`;
          console.log(`[pipeline] ${msg}`);
          deps.emit('project-event', {
            source: 'feature-scope',
            message: msg,
            level: 'info',
          });
          deps.emit('artifact-written', {
            stage: 'requirements',
            file: 'feature.scope.json',
            summary: `Scoped to ${scope.targetRepos.length}/${deps.state.repoNames.length} repo(s)`,
            content: JSON.stringify(scope, null, 2),
          });
          deps.broadcast();
          deps.checkpoint();
        }
      }

      if (stage.name === 'validate' && !deps.isCancelled()) {
        let validateArtifact = result.artifact;
        let fixAttempts = 0;
        const MAX_FIX_ATTEMPTS = 3;
        // §H3: per-repo burn-aware fix-loop sessions, cached ACROSS attempts so
        // each repo's turn recorder stays monotonic over `sendInput` resumes.
        const fixSessions = new Map<string, AgentManagerSession>();

        while (fixAttempts < MAX_FIX_ATTEMPTS && hasValidationFailuresHelper(validateArtifact)) {
          fixAttempts++;
          console.log(`[pipeline] Validation failed — fix attempt ${fixAttempts}/${MAX_FIX_ATTEMPTS}`);

          // §H3: fix-loop now records turn-level cost/provenance via per-repo
          // burn-aware sessions (turnCtx threaded). The revalidate per-repo
          // fan-out already records via `turnCtx`.
          const fixResult = await runFixLoop(deps, i, validateArtifact, fixAttempts, turnCtx, fixSessions);
          deps.state.totalCost += fixResult.cost;
          deps.aggregateRunTokens(fixResult.tokens);
          deps.logCacheTelemetry(`${stage.name}:fix-${fixAttempts}`, fixResult.tokens);

          if (deps.isCancelled()) return { control: 'cancelled', prevArtifact };

          // §H3 blocker fix: the revalidate records under a DISTINCT effect
          // prefix per attempt (`repo:revalidate-N:`) so its scoped runtime
          // doesn't read the initial validate's `repo:turn:0:*` back and trip
          // a DeterminismViolation. The validate rollup is prefix-tolerant.
          const revalidateResult = await runPerRepoStage(deps, i, stage, fixResult.artifact, undefined, turnCtx, `revalidate-${fixAttempts}`);
          validateArtifact = revalidateResult.artifact;
          deps.state.stages[i].artifact = validateArtifact;
          deps.state.stages[i].cost += revalidateResult.cost;
          // totalCost is already incremented per-repo inside runPerRepoStage —
          // adding revalidateResult.cost here would double-count.
          deps.aggregateRunTokens(revalidateResult.tokens);
          deps.logCacheTelemetry(`${stage.name}:revalidate-${fixAttempts}`, revalidateResult.tokens);
          deps.broadcast();

          // Phase E6: wrap revalidate write. Effect name includes
          // the attempt count so successive revalidates land as
          // distinct events.
          if (ctx) {
            await ctx.effect(
              `validate:revalidate-write-${fixAttempts}`,
              async () => {
                writeStageArtifactFn(deps.depsForArtifactIO(), stage, validateArtifact);
                return null;
              },
              { idempotencyKey: artifactIdempotencyKey('validate', `revalidate-${fixAttempts}`, validateArtifact) },
            );
          } else {
            writeStageArtifactFn(deps.depsForArtifactIO(), stage, validateArtifact);
          }
        }

        if (hasValidationFailuresHelper(validateArtifact)) {
          console.warn(`[pipeline] Validation still failing after ${MAX_FIX_ATTEMPTS} fix attempts`);
        } else if (fixAttempts > 0) {
          console.log(`[pipeline] Validation recovered after ${fixAttempts} fix attempt(s)`);
        } else {
          console.log(`[pipeline] Validation clean — proceeding to Ship`);
        }

        prevArtifact = validateArtifact;
      }

      return { control: 'next', prevArtifact };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      deps.state.stages[i].status = 'failed';
      deps.state.stages[i].completedAt = new Date().toISOString();
      deps.state.stages[i].error = errorMsg;
      deps.state.status = 'failed';
      deps.broadcast();
      deps.checkpoint();
      deps.emit('stage-fail', i, errorMsg);
      deps.emit('pipeline-fail', deps.state);
      deps.featureStore.updateFeature(deps.config.project, deps.state.featureSlug, {
        status: 'failed',
      });
      return { control: 'fail-early-return', prevArtifact };
    }
  } finally {
    deps.reviewer.clearForCurrentStage();
  }
}
