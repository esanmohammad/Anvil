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
import { setCurrentStepContext, withCurrentStepContext } from '@esankhan3/anvil-agent-core';
import {
  runWithChainFallback,
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
import { AgentManagerRunner } from './runners/agent-manager-runner.js';
import { AgentManagerSession } from './runners/agent-manager-session.js';
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

  // Cancellation
  isCancelled: () => boolean;
  setCancelled: () => void;

  // Stores / managers
  agentManager: AgentManager;
  projectLoader: ProjectLoader;
  featureStore: FeatureStore;

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

/** Construct a multi-turn `AgentManagerSession` (clarify + fix-loop). */
export function makeAgentSession(deps: StageOpsDeps): AgentManagerSession {
  return new AgentManagerSession({
    agentManager: deps.agentManager,
    project: deps.config.project,
    workspaceDir: deps.workspaceDir,
    isCancelled: () => deps.isCancelled(),
    resolveModel: (stageName) => deps.resolveModelForStage(stageName),
    onTruncation: (agentName, outputTokens) => deps.handleOutputTruncation(agentName, outputTokens),
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
  });
}

// ── Interactive Clarify (one question at a time) ─────────────────────

async function runClarifyStage(
  deps: StageOpsDeps,
  index: number,
  ctx?: StepContext<string>,
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  const session = makeAgentSession(deps);
  const runOnce = (model: string) => runClarifyForProject({
    agentSession: session,
    project: deps.config.project,
    workspaceDir: deps.workspaceDir,
    model,
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
        message: `[clarify] clarifier agent spawned (model: ${model}) — awaiting first response…`,
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
    inputResolver: () => new Promise<string>((resolve) => {
      deps.setInputResolve(resolve);
    }),
  });

  // Phase E1: wrap the chain-fallback in ctx.effect when a durable
  // store is wired. Effect name includes the model identifier so a
  // chain rotation between runs surfaces as DeterminismViolationError
  // (caller reruns from-stage with the same chain). The system effect
  // is the *outer* runWithChainFallback call — each model attempt
  // inside the chain stays a single recorded effect.
  const result = await runWithChainFallback(
    {
      stageName: 'clarify',
      maxAttempts: deps.walkerConfig().max_attempts,
      resolveModel: () => deps.resolveModelForStage('clarify'),
      onBurn: ({ model, status }) => {
        deps.runtimeBurnedModels.add(model);
        console.warn(`[pipeline] clarify: ${model} hit ${status} (retryable); burning + falling back`);
        deps.emit('project-event', {
          source: 'routing',
          message: `${model} unavailable (HTTP ${status}); falling back to next chain entry`,
          level: 'warn',
        });
      },
    },
    ctx
      ? (model) => ctx.effect(
          `clarify:run-for-project:${model}`,
          async () => serializeAgentRunResult(await runOnce(model) as unknown as Record<string, unknown>) as unknown as Awaited<ReturnType<typeof runOnce>>,
        )
      : runOnce,
  );

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
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  const repos = deps.state.repoNames;

  if (repos.length === 0) {
    return runSingleStage(deps, index, stage, prevArtifact, ctx);
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
    const repoIdx = r;

    if (deps.state.stages[index].repos[r]) {
      deps.state.stages[index].repos[r].status = 'running';
    }

    const projectPrompt = buildRepoProjectPromptHelper(deps.getPromptContext(), stage, repoName);

    if (stage.name === 'build' && stage.persona === 'engineer') {
      promises.push(
        runBuildForRepo(deps, index, repoIdx, stage, repoName, repoPath, projectPrompt, ctx)
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

    const prompt = buildRepoStagePromptHelper(deps.getPromptContext(), stage, repoName, prevArtifact);

    const runner = makeAgentRunner(deps, stage.name);
    promises.push(
      (async () => {
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
        if (repoState) {
          repoState.status = 'completed';
          repoState.cost = result.costUsd ?? 0;
          repoState.artifact = result.output;
        }
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
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  const repoArtifacts = loadRepoArtifactsFn(deps.depsForArtifactIO(), repoName);

  const runner = makeAgentRunner(deps, stage.name);
  // Phase F2: per-task wrapper threads ctx.effect into the
  // dependency-graph scheduler so each task spawn is its own
  // recorded effect. The wrapper closes over ctx + repoName
  // so the effect name disambiguates per-(repo, task).
  const wrapTaskRun = ctx
    ? <R>(taskId: string, fn: () => Promise<R>) => ctx.effect(
        `build:spawn-task-${repoName}-${taskId}`,
        async () => serializeAgentRunResult(await fn() as unknown as Record<string, unknown>) as unknown as R,
        { idempotencyKey: `${ctx.runId}:${repoName}:${taskId}` },
      )
    : undefined;
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
    ...(wrapTaskRun ? { wrapTaskRun } : {}),
  };
  // Phase E5: durable wrap for per-repo build. Idempotency key
  // includes the runId + repo to scope replay to this run.
  // Per-task granularity is a future refinement (would require
  // threading ctx through runBuildForOneRepo in core-pipeline).
  const result = ctx
    ? await ctx.effect(
        `build:repo-${repoName}`,
        async () => serializeAgentRunResult(await runBuildForOneRepo(buildOpts) as unknown as Record<string, unknown>) as unknown as Awaited<ReturnType<typeof runBuildForOneRepo>>,
        { idempotencyKey: `${ctx.runId}:${repoName}:build` },
      )
    : await runBuildForOneRepo(buildOpts);

  const repoStateDone = deps.state.stages[stageIndex].repos[repoIdx];
  if (repoStateDone) {
    repoStateDone.status = 'completed';
    repoStateDone.cost = result.cost;
    repoStateDone.artifact = result.artifact;
  }
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

  const session = makeAgentSession(deps);
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
  // Phase E2: durable wrap for the Q&A session start. On replay the
  // recorded first.output (questions or artifact) returns directly,
  // skipping the agent spawn.
  const first = ctx
    ? await ctx.effect(
        `${stage.name}:session-start`,
        async () => serializeAgentRunResult(await session.start(startReq) as unknown as Record<string, unknown>) as unknown as Awaited<ReturnType<typeof session.start>>,
      )
    : await session.start(startReq);

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

  // Phase E9: dual-path answer wait. When durable mode is on,
  // ctx.waitForSignal reads from the durable signals queue (which
  // `provideStageAnswer` populates alongside the in-process
  // resolver Map for back-compat). This lets Q&A survive a
  // process crash mid-wait — on replay the recorded answer
  // payload returns without re-prompting the user.
  //
  // Non-durable mode keeps the resolver-Map behaviour unchanged.
  const answersBlock = ctx
    ? await Promise.race([
        ctx.waitForSignal<string>(`stage-answer-${index}`),
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

  // Phase E2: durable wrap for Q&A session resume. On replay the
  // recorded artifact returns directly; the answers block was
  // already in the recorded session-start payload so the agent
  // doesn't see it twice.
  const second = ctx
    ? await ctx.effect(
        `${stage.name}:session-resume`,
        async () => serializeAgentRunResult(await session.sendInput(first.sessionId, answersBlock) as unknown as Record<string, unknown>) as unknown as Awaited<ReturnType<typeof session.sendInput>>,
      )
    : await session.sendInput(first.sessionId, answersBlock);

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
    return runStageWithQA(deps, index, stage, prevArtifact, qa.max, ctx);
  }

  const prompt = buildStagePromptHelper(deps.getPromptContext(), stage, prevArtifact);
  const projectPrompt = buildProjectPromptHelper(deps.getPromptContext(), stage);

  const runner = makeAgentRunner(deps, stage.name);
  const runReq = {
    persona: stage.persona,
    projectPrompt,
    userPrompt: prompt,
    workingDir: deps.workspaceDir,
    stage: stage.name,
    allowedTools: deps.allowedToolsForCurrentStage(stage.name),
    disallowedTools: disallowedToolsForPersona(stage.persona),
    maxOutputTokens: maxOutputTokensForStage(stage.name),
  };
  // Phase E2/E4: durable wrap for single-stage agent spawns
  // (requirements when Q&A disabled, tasks, validate-without-fanout).
  const result = ctx
    ? await ctx.effect(
        `${stage.name}:spawn-agent`,
        async () => serializeAgentRunResult(await runner.run(runReq) as unknown as Record<string, unknown>) as unknown as Awaited<ReturnType<typeof runner.run>>,
      )
    : await runner.run(runReq);

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
  const repoNames = deps.state.repoNames.length
    ? deps.state.repoNames
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
  _validateStageIndex: number,
  validateArtifact: string,
  attempt: number,
  ctx?: StepContext<string>,
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  const buildStage = STAGES.find((s) => s.name === 'build')!;
  const repoPaths: Record<string, string> = {};
  for (const repoName of deps.state.repoNames) {
    repoPaths[repoName] = deps.repoPaths()[repoName] || join(deps.workspaceDir, repoName);
  }
  const session = makeAgentSession(deps);
  const runFixOnce = (model: string) => runFixLoopStep({
    agentSession: session,
    project: deps.config.project,
    model,
    allowedTools: deps.allowedToolsForCurrentStage('fix-loop'),
    maxOutputTokens: maxOutputTokensForStage('build'),
    workspaceDir: deps.workspaceDir,
    repoNames: deps.state.repoNames,
    repoPaths,
    validateArtifact,
    attempt,
    priorByRepo: deps.fixLoopAgentByRepo,
    priorSingleId: deps.getFixLoopAgentSingle(),
    buildProjectPromptForBuildStage: () => buildProjectPromptHelper(deps.getPromptContext(), buildStage),
    buildRepoProjectPromptForBuildStage: (repoName: string) =>
      buildRepoProjectPromptHelper(deps.getPromptContext(), buildStage, repoName),
    isCancelled: () => deps.isCancelled(),
  });
  // Phase E6: durable wrap for fix-loop attempts. Effect name
  // includes the attempt number so successive fix iterations
  // record distinct events; the per-step idx counter would also
  // disambiguate, but the explicit attempt index is more
  // diagnostic in the durable log.
  const result = await runWithChainFallback(
    {
      stageName: 'fix-loop',
      maxAttempts: deps.walkerConfig().max_attempts,
      resolveModel: () => deps.resolveModelForStage('fix-loop'),
      onBurn: ({ model, status }) => {
        deps.runtimeBurnedModels.add(model);
        console.warn(`[pipeline] fix-loop: ${model} hit ${status} (retryable); burning + falling back`);
        deps.emit('project-event', {
          source: 'routing',
          message: `${model} unavailable (HTTP ${status}); falling back to next chain entry`,
          level: 'warn',
        });
      },
    },
    ctx
      ? (model) => ctx.effect(
          `validate:fix-attempt-${attempt}:${model}`,
          async () => serializeAgentRunResult(await runFixOnce(model) as unknown as Record<string, unknown>) as unknown as Awaited<ReturnType<typeof runFixOnce>>,
        )
      : runFixOnce,
  );
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
): Promise<{
  control: 'continue' | 'next' | 'cancelled' | 'fail-early-return' | 'rewind';
  rewindTo?: number;
  prevArtifact: string;
}> {
  // Phase H3 — register the current StepContext so the WebToolExecutor
  // can wrap web_search/web_fetch in `ctx.effect(...)`. Wrapping the
  // body in `withCurrentStepContext(ctx, fn)` propagates via
  // AsyncLocalStorage so concurrent per-repo fanout doesn't trample
  // the global. Falls through to the raw body when ctx is undefined.
  if (ctx) {
    return withCurrentStepContext(ctx, () =>
      runOneStageBody(deps, i, isResume, resumeStage, prevArtifactIn, ctx),
    );
  }
  return runOneStageBody(deps, i, isResume, resumeStage, prevArtifactIn, ctx);
}

async function runOneStageBody(
  deps: StageOpsDeps,
  i: number,
  isResume: boolean,
  resumeStage: number,
  prevArtifactIn: string,
  ctx?: StepContext<string>,
): Promise<{
  control: 'continue' | 'next' | 'cancelled' | 'fail-early-return' | 'rewind';
  rewindTo?: number;
  prevArtifact: string;
}> {
  let prevArtifact = prevArtifactIn;
  if (deps.isCancelled()) return { control: 'cancelled', prevArtifact };
  const stage = STAGES[i];

  // Synchronous global as well — covers the legacy callers + any
  // third-party adapter that doesn't await through the ALS chain.
  if (ctx) setCurrentStepContext(ctx);

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
        const artifact = await runTestGenStage(deps, i, ctx);
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
      console.log(`[pipeline] Creating feature branch "${branchName}" in all repos...`);
      createFeatureBranchesHelper({
        featureSlug: deps.state.featureSlug,
        repoPaths: deps.repoPaths(),
        repoNames: deps.state.repoNames,
        workspaceDir: deps.workspaceDir,
        onLog: (level, message) => {
          if (level === 'info') console.log(`[pipeline] ${message}`);
          else console.warn(`[pipeline] ${message}`);
        },
      });
    }
    if (stage.name === 'validate') {
      console.log('[pipeline] Running post-build guards (format + lint auto-fix)...');
      const reposForGuards = deps.state.repoNames.length > 0
        ? deps.state.repoNames.map((r) => ({ name: r, path: deps.repoPaths()[r] || join(deps.workspaceDir, r) }))
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

      if (stage.name === 'clarify') {
        result = await runClarifyStage(deps, i, ctx);
      } else if (stage.perRepo && deps.state.repoNames.length > 0) {
        result = await runPerRepoStage(deps, i, stage, prevArtifact, ctx);
      } else {
        result = await runSingleStage(deps, i, stage, prevArtifact, ctx);
      }

      if (deps.isCancelled()) return { control: 'cancelled', prevArtifact };

      deps.state.stages[i].status = 'completed';
      deps.state.stages[i].completedAt = new Date().toISOString();
      deps.state.stages[i].artifact = result.artifact;
      deps.state.stages[i].cost = result.cost;
      deps.state.stages[i].tokens = result.tokens;
      deps.state.totalCost += result.cost;
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

      if (stage.name === 'validate' && !deps.isCancelled()) {
        let validateArtifact = result.artifact;
        let fixAttempts = 0;
        const MAX_FIX_ATTEMPTS = 3;

        while (fixAttempts < MAX_FIX_ATTEMPTS && hasValidationFailuresHelper(validateArtifact)) {
          fixAttempts++;
          console.log(`[pipeline] Validation failed — fix attempt ${fixAttempts}/${MAX_FIX_ATTEMPTS}`);

          const fixResult = await runFixLoop(deps, i, validateArtifact, fixAttempts, ctx);
          deps.state.totalCost += fixResult.cost;
          deps.aggregateRunTokens(fixResult.tokens);
          deps.logCacheTelemetry(`${stage.name}:fix-${fixAttempts}`, fixResult.tokens);

          if (deps.isCancelled()) return { control: 'cancelled', prevArtifact };

          const revalidateResult = await runPerRepoStage(deps, i, stage, fixResult.artifact, ctx);
          validateArtifact = revalidateResult.artifact;
          deps.state.stages[i].artifact = validateArtifact;
          deps.state.stages[i].cost += revalidateResult.cost;
          deps.state.totalCost += revalidateResult.cost;
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
    if (ctx) setCurrentStepContext(undefined);
  }
}
