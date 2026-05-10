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
 */
import { join } from 'node:path';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import type { WalkerConfig } from '@esankhan3/anvil-agent-core';
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
  type ParsedTask,
  type PromptBuilderContext,
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
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  const session = makeAgentSession(deps);
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
    (model) => runClarifyForProject({
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
    }),
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
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  const repos = deps.state.repoNames;

  if (repos.length === 0) {
    return runSingleStage(deps, index, stage, prevArtifact);
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
        runBuildForRepo(deps, index, repoIdx, stage, repoName, repoPath, projectPrompt)
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
          result = await runOnce();
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

        writeRepoArtifactFn(deps.depsForArtifactIO(), stage, repoName, result.output);

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
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  const repoArtifacts = loadRepoArtifactsFn(deps.depsForArtifactIO(), repoName);

  const runner = makeAgentRunner(deps, stage.name);
  const result = await runBuildForOneRepo({
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
    onProjectEvent: (level, message) => {
      deps.emit('project-event', { source: 'pipeline', message, level });
    },
  });

  const repoStateDone = deps.state.stages[stageIndex].repos[repoIdx];
  if (repoStateDone) {
    repoStateDone.status = 'completed';
    repoStateDone.cost = result.cost;
    repoStateDone.artifact = result.artifact;
  }
  deps.broadcast();
  deps.checkpoint();
  writeRepoArtifactFn(deps.depsForArtifactIO(), stage, repoName, result.artifact);

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

async function runSingleStage(
  deps: StageOpsDeps,
  index: number,
  stage: StageDefinition,
  prevArtifact: string,
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  const prompt = buildStagePromptHelper(deps.getPromptContext(), stage, prevArtifact);
  const projectPrompt = buildProjectPromptHelper(deps.getPromptContext(), stage);

  const runner = makeAgentRunner(deps, stage.name);
  const result = await runner.run({
    persona: stage.persona,
    projectPrompt,
    userPrompt: prompt,
    workingDir: deps.workspaceDir,
    stage: stage.name,
    allowedTools: deps.allowedToolsForCurrentStage(stage.name),
    disallowedTools: disallowedToolsForPersona(stage.persona),
    maxOutputTokens: maxOutputTokensForStage(stage.name),
  });

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

async function runTestGenStage(deps: StageOpsDeps, stageIndex: number): Promise<string> {
  const repoNames = deps.state.repoNames.length
    ? deps.state.repoNames
    : Object.keys(deps.repoPaths());
  const repoLocalPaths: Record<string, string> = {};
  for (const r of repoNames) repoLocalPaths[r] = deps.repoPaths()[r] ?? join(deps.workspaceDir, r);

  return runTestGenForProject({
    planSeed: deps.config.planSeed ?? null,
    project: deps.config.project,
    model: deps.config.model,
    workspaceDir: deps.workspaceDir,
    repoLocalPaths,
    onConventionsDetected: (artifact) => {
      deps.state.stages[stageIndex].artifact = artifact;
    },
    onArtifactWritten: (event) => {
      deps.emit('artifact-written', event);
    },
  });
}

// ── Validate→fix loop ──────────────────────────────────────────────

async function runFixLoop(
  deps: StageOpsDeps,
  _validateStageIndex: number,
  validateArtifact: string,
  attempt: number,
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  const buildStage = STAGES.find((s) => s.name === 'build')!;
  const repoPaths: Record<string, string> = {};
  for (const repoName of deps.state.repoNames) {
    repoPaths[repoName] = deps.repoPaths()[repoName] || join(deps.workspaceDir, repoName);
  }
  const session = makeAgentSession(deps);
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
    (model) => runFixLoopStep({
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
    }),
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
        const artifact = await runTestGenStage(deps, i);
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
        result = await runClarifyStage(deps, i);
      } else if (stage.perRepo && deps.state.repoNames.length > 0) {
        result = await runPerRepoStage(deps, i, stage, prevArtifact);
      } else {
        result = await runSingleStage(deps, i, stage, prevArtifact);
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
        writeStageArtifactFn(deps.depsForArtifactIO(), stage, result.artifact);
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
        deployProject({
          project: deps.config.project,
          mode: deps.config.deploy,
          workspaceDir: deps.workspaceDir,
          configDeployCmd: deps.projectLoader.getConfig(deps.config.project)?.pipeline?.ship?.deploy,
          envDeployCmd: process.env.ANVIL_DEPLOY_CMD || process.env.FF_DEPLOY_CMD,
          onArtifact: (artifact) => deps.emit('artifact-written', artifact),
          onLog: (level, message) => {
            if (level === 'info') console.log(`[pipeline] ${message}`);
            else console.warn(`[pipeline] ${message}`);
          },
        });
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

          const fixResult = await runFixLoop(deps, i, validateArtifact, fixAttempts);
          deps.state.totalCost += fixResult.cost;
          deps.aggregateRunTokens(fixResult.tokens);
          deps.logCacheTelemetry(`${stage.name}:fix-${fixAttempts}`, fixResult.tokens);

          if (deps.isCancelled()) return { control: 'cancelled', prevArtifact };

          const revalidateResult = await runPerRepoStage(deps, i, stage, fixResult.artifact);
          validateArtifact = revalidateResult.artifact;
          deps.state.stages[i].artifact = validateArtifact;
          deps.state.stages[i].cost += revalidateResult.cost;
          deps.state.totalCost += revalidateResult.cost;
          deps.aggregateRunTokens(revalidateResult.tokens);
          deps.logCacheTelemetry(`${stage.name}:revalidate-${fixAttempts}`, revalidateResult.tokens);
          deps.broadcast();

          writeStageArtifactFn(deps.depsForArtifactIO(), stage, validateArtifact);
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
