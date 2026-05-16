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
  extractRepoSection,
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
  /** model id → reason burned (HTTP status + stage + ts). */
  burnedModelReasons: Map<string, string>;

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
      deps.burnedModelReasons.set(model, `HTTP ${status} (per-task stage)`);
      deps.emit('project-event', {
        source: 'routing',
        message: `${model} burned: HTTP ${status}; chain walker will skip on next call`,
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
        deps.burnedModelReasons.set(model, `HTTP ${status} (clarify stage)`);
        console.warn(`[pipeline] clarify: ${model} burned (HTTP ${status} retryable)`);
        deps.emit('project-event', {
          source: 'routing',
          message: `${model} burned: HTTP ${status} during clarify; chain walker will skip on next call`,
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

/**
 * Per-promise timeout (default 30 min) that fires if a single repo's
 * runner never resolves. Without this, `Promise.all` waits forever on
 * a hung agent, freezing the parent stage. Override via
 * `ANVIL_REPO_STAGE_TIMEOUT_MS`. The timeout rejects the wait but
 * does NOT kill the underlying agent — that requires plumbing
 * `isCancelled` per-repo, deferred. Acceptable token leak in exchange
 * for unblocking the parent.
 */
function repoStageTimeoutMs(): number {
  const raw = parseInt(process.env.ANVIL_REPO_STAGE_TIMEOUT_MS ?? '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 30 * 60 * 1000;
}

async function runPerRepoStage(
  deps: StageOpsDeps,
  index: number,
  stage: StageDefinition,
  prevArtifact: string,
  opts: { repoFilter?: ReadonlySet<string> } = {},
): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
  const allRepos = deps.state.repoNames;
  const filter = opts.repoFilter;
  const repos = filter ? allRepos.filter((r) => filter.has(r)) : allRepos;

  if (repos.length === 0) {
    if (filter && allRepos.length > 0) {
      // Filter eliminated every repo. Nothing to do this pass; preserve
      // the prior per-repo artifacts so the combined output is the
      // last-good state.
      const carried = allRepos
        .map((repoName) => {
          const repoIdx = allRepos.indexOf(repoName);
          const r = deps.state.stages[index].repos[repoIdx];
          return { repoName, artifact: r?.artifact ?? '' };
        })
        .filter((r) => r.artifact);
      return {
        artifact: combinePerRepoArtifacts(carried),
        cost: 0,
        tokens: zeroTokenStats(),
      };
    }
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
    // Map back to the canonical index in `state.stages[index].repos`
    // — that array is keyed on `state.repoNames`, not the filtered
    // subset, so writes to the wrong slot would clobber a different
    // repo's state.
    const repoIdx = allRepos.indexOf(repoName);

    if (deps.state.stages[index].repos[repoIdx]) {
      deps.state.stages[index].repos[repoIdx].status = 'running';
    }
    // Broadcast on every repo status flip so the dashboard's per-repo
    // chips light up immediately. Without this, all N repos stay
    // grayed-out until each one completes silently — which can be
    // minutes for a build fanning out across 4 repos.
    deps.broadcast();
    deps.emit('artifact-written', {
      stage: stage.name,
      repo: repoName,
      file: '',
      summary: `[${repoName}] Preparing ${stage.name}…`,
      content: '',
    });

    const projectPrompt = buildRepoProjectPromptHelper(deps.getPromptContext(), stage, repoName);

    if (stage.name === 'build' && stage.persona === 'engineer') {
      deps.emit('artifact-written', {
        stage: 'build',
        repo: repoName,
        file: '',
        summary: `[${repoName}] Loading tasks + bundling files for engineer agent…`,
        content: '',
      });
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
          // Accumulate, don't overwrite — the validate→fix loop calls
          // `runPerRepoStage` more than once per repo and the prior
          // attempt's cost is real money already spent. Setting `=`
          // here hides the first-pass cost the moment a revalidate
          // overwrites it.
          repoState.cost = (repoState.cost ?? 0) + (result.costUsd ?? 0);
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

  // Wrap each per-repo promise in `Promise.race` against a per-repo
  // timeout. Without this, a hung runner (no resolve, no reject) leaves
  // `Promise.all` waiting forever and wedges the parent stage. The
  // timeout marks the repo's `repoState.status='failed'` so the
  // `failedRepos.length > 0` check below throws cleanly. The underlying
  // agent is NOT killed here — that requires per-repo plumbing of
  // `isCancelled`, deferred.
  const timeoutMs = repoStageTimeoutMs();
  const timedPromises = promises.map((promise, idx) => {
    const repoName = repos[idx];
    const canonicalIdx = allRepos.indexOf(repoName);
    return Promise.race<{
      repoName: string;
      artifact: string;
      cost: number;
      tokens: StageTokenStats;
    }>([
      promise,
      new Promise((_resolve, reject) => {
        const handle = setTimeout(() => {
          const repoState = deps.state.stages[index].repos[canonicalIdx];
          if (repoState && repoState.status === 'running') {
            repoState.status = 'failed';
            repoState.error = `Timed out after ${Math.round(timeoutMs / 60000)} min — agent never produced output. Underlying agent may still be running (token leak); cancel the run to reclaim.`;
          }
          deps.broadcast();
          reject(new Error(`Per-repo stage "${stage.name}/${repoName}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        (handle as { unref?: () => void }).unref?.();
      }),
    ]).catch(() => ({
      repoName,
      artifact: '',
      cost: 0,
      tokens: zeroTokenStats(),
    }));
  });

  const results = await Promise.all(timedPromises);
  const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
  const tokens = sumTokenStats(results.map((r) => r.tokens));
  const successResults = results.filter((r) => r.artifact);
  const failedRepos = results.filter((r) => !r.artifact).map((r) => r.repoName);

  // When a filter is in effect (validate fix-loop revalidation), carry
  // forward the artifacts of the repos we skipped this pass so the
  // combined output is the full validate report, not just the
  // re-validated subset.
  const carriedResults: Array<{ repoName: string; artifact: string }> = [];
  if (filter) {
    for (const repoName of allRepos) {
      if (filter.has(repoName)) continue;
      const repoIdx = allRepos.indexOf(repoName);
      const r = deps.state.stages[index].repos[repoIdx];
      if (r?.artifact) carriedResults.push({ repoName, artifact: r.artifact });
    }
  }

  const combined = combinePerRepoArtifacts([...carriedResults, ...successResults]);

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
  // Tell the dashboard how many tasks we're about to dispatch + give
  // it a chance to render before the first agent spawn (task bundling
  // can itself take a second or two for a large task graph).
  const taskCount = (repoArtifacts.tasks?.match(/^- \[ \]/gm) ?? []).length;
  deps.emit('artifact-written', {
    stage: 'build',
    repo: repoName,
    file: '',
    summary: taskCount > 0
      ? `[${repoName}] Dispatching ${taskCount} task(s) to engineer agent…`
      : `[${repoName}] Spawning engineer agent…`,
    content: '',
  });

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
    // Accumulate across passes (see same note in `runPerRepoStage`).
    repoStateDone.cost = (repoStateDone.cost ?? 0) + (result.cost ?? 0);
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
        deps.burnedModelReasons.set(model, `HTTP ${status} (fix-loop stage)`);
        console.warn(`[pipeline] fix-loop: ${model} burned (HTTP ${status} retryable)`);
        deps.emit('project-event', {
          source: 'routing',
          message: `${model} burned: HTTP ${status} during fix-loop; chain walker will skip on next call`,
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

    // Flip stage to running IMMEDIATELY on entry so the dashboard chip
    // lights up before the pre-spawn prep work (auth probe, feature
    // branches, format/lint guards) runs. Without this, the chip sits
    // grayed-out for ~30s while git + linters run silently — the user
    // sees nothing happening on the dashboard.
    deps.state.currentStage = i;
    deps.state.stages[i].status = 'running';
    deps.state.stages[i].startedAt = new Date().toISOString();
    deps.broadcast();

    deps.reviewer.armForCurrentStage();
    deps.emit('artifact-written', {
      stage: stage.name,
      file: '',
      summary: `Checking ${stage.name} provider auth…`,
      content: '',
    });
    await deps.ensureAuth(stage.name);

    if (stage.name === 'build') {
      const branchName = `anvil/${deps.state.featureSlug}`;
      console.log(`[pipeline] Creating feature branch "${branchName}" in all repos...`);
      deps.emit('artifact-written', {
        stage: 'build',
        file: '',
        summary: `Creating feature branch "${branchName}" across ${deps.state.repoNames.length} repo(s)…`,
        content: '',
      });
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
      deps.emit('artifact-written', {
        stage: 'validate',
        file: '',
        summary: 'Running format + lint auto-fix guards…',
        content: '',
      });
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

    // Stage is already flipped to running above (hoisted from here so
    // the chip lights up during prep work). Persist + emit start now.
    deps.checkpoint();
    deps.emit('stage-start', i, '');
    deps.emit('artifact-written', {
      stage: stage.name,
      file: '',
      summary: `Spawning ${stage.persona} agent for ${stage.name}…`,
      content: '',
    });

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

        // Phase E — deterministic build-compliance check.
        // Stores the report on shared state so the ship stage can stamp
        // PR bodies + auto-draft when compliance < 100%.
        if (deps.config.planBinding) {
          try {
            const { runBuildCompliance, renderBuildComplianceMarkdown } =
              await import('./plan-compliance-bridge.js');
            const featureDir = deps.featureStore.getFeatureDir(deps.config.project, deps.state.featureSlug);
            const repoLocalPaths: Record<string, string> = {};
            for (const r of deps.state.repoNames) repoLocalPaths[r] = deps.repoPaths()[r] ?? '';
            const report = runBuildCompliance({
              binding: deps.config.planBinding,
              repoLocalPaths,
              reposChecked: deps.state.repoNames,
              baseBranch: deps.config.baseBranch ?? 'main',
            });
            const md = renderBuildComplianceMarkdown(report);
            const { writeFileSync } = await import('node:fs');
            const { join } = await import('node:path');
            writeFileSync(join(featureDir, 'BUILD_COMPLIANCE.md'), md, 'utf-8');
            writeFileSync(join(featureDir, 'build-compliance.json'), JSON.stringify(report, null, 2), 'utf-8');
            // Stash on the runner state so the ship stage can read it
            // without re-running the check.
            (deps.state as unknown as { __buildCompliance?: typeof report }).__buildCompliance = report;
            deps.emit('artifact-written', {
              stage: 'build',
              file: `${featureDir}/BUILD_COMPLIANCE.md`,
              summary: `Build compliance: ${report.passed}/${report.total}`,
              content: md,
            });
          } catch (err) {
            console.warn('[pipeline] Build compliance check failed:', err);
          }
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

        // The 1st pass at line 887 set `state.stages[i].status='completed'`.
        // If the artifact has failure markers we're about to re-open the
        // stage via the fix-loop, so re-flip to 'running' here. Without
        // this, the UI shows the stage as done even while the fix-loop
        // churns through per-repo revalidate spawns. The post-loop block
        // below re-flips back to 'completed'.
        const reopened = hasValidationFailuresHelper(validateArtifact);
        if (reopened) {
          deps.state.stages[i].status = 'running';
          deps.broadcast();
        }

        while (fixAttempts < MAX_FIX_ATTEMPTS && hasValidationFailuresHelper(validateArtifact)) {
          fixAttempts++;
          console.log(`[pipeline] Validation failed — fix attempt ${fixAttempts}/${MAX_FIX_ATTEMPTS}`);

          const fixResult = await runFixLoop(deps, i, validateArtifact, fixAttempts);
          deps.state.totalCost += fixResult.cost;
          deps.aggregateRunTokens(fixResult.tokens);
          deps.logCacheTelemetry(`${stage.name}:fix-${fixAttempts}`, fixResult.tokens);

          if (deps.isCancelled()) return { control: 'cancelled', prevArtifact };

          // Compute the subset of repos whose validate sections still
          // contain failure markers. Pass that subset as a filter to
          // `runPerRepoStage` so we only re-pay validation for repos
          // that need it. Repos whose 1st-pass output was clean keep
          // their `repoState.status='completed'` + prior cost. If we
          // can't isolate per-repo failure (extractRepoSection returned
          // empty for all repos), fall back to revalidating everyone.
          const failingRepos = new Set<string>();
          for (const repoName of deps.state.repoNames) {
            const section = extractRepoSection(validateArtifact, repoName);
            if (!section || hasValidationFailuresHelper(section)) {
              failingRepos.add(repoName);
            }
          }
          const repoFilter = failingRepos.size > 0 && failingRepos.size < deps.state.repoNames.length
            ? failingRepos
            : undefined;
          if (repoFilter) {
            console.log(
              `[pipeline] Revalidating ${repoFilter.size}/${deps.state.repoNames.length} repo(s): ${[...repoFilter].join(', ')}`,
            );
          }

          const revalidateResult = await runPerRepoStage(deps, i, stage, fixResult.artifact, { repoFilter });
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

        // Re-flip the parent stage to 'completed' once the fix-loop is
        // truly done. Pairs with the 'running' flip above so the
        // sidebar doesn't get stuck on a ghost-completed validate
        // while children are still in flight.
        if (reopened) {
          deps.state.stages[i].status = 'completed';
          deps.state.stages[i].completedAt = new Date().toISOString();
          deps.broadcast();
          deps.checkpoint();
        }

        // Phase F — plan-compliance pass after the test suite. Reads
        // the validate stage's outcome to decide which tests
        // passed/failed/skipped, then verifies every plan TestCaseSpec,
        // contract reference, and migration file is honored. Stored on
        // shared state for the ship stage's PR-body stamp.
        if (deps.config.planBinding) {
          try {
            const { runValidateCompliance, renderValidateComplianceMarkdown } =
              await import('./plan-compliance-bridge.js');
            const repoLocalPaths: Record<string, string> = {};
            for (const r of deps.state.repoNames) repoLocalPaths[r] = deps.repoPaths()[r] ?? '';
            // Parse passing/failing/skipped tests out of the artifact
            // text — Go's "--- FAIL: TestX" / "--- PASS: TestX", plus
            // "--- SKIP:" lines. Conservative — empty sets keep the
            // verifier from making false negative claims.
            const passingTests = new Set<string>();
            const failingTests = new Set<string>();
            const skippedTests = new Set<string>();
            const PASS_RE = /---\s+PASS:\s+(\S+)/g;
            const FAIL_RE = /---\s+FAIL:\s+(\S+)/g;
            const SKIP_RE = /---\s+SKIP:\s+(\S+)/g;
            let m: RegExpExecArray | null;
            while ((m = PASS_RE.exec(validateArtifact))) passingTests.add(m[1]);
            while ((m = FAIL_RE.exec(validateArtifact))) failingTests.add(m[1]);
            while ((m = SKIP_RE.exec(validateArtifact))) skippedTests.add(m[1]);

            const report = runValidateCompliance({
              binding: deps.config.planBinding,
              repoLocalPaths,
              passingTests,
              failingTests,
              skippedTests,
            });
            const md = renderValidateComplianceMarkdown(report);
            const featureDir = deps.featureStore.getFeatureDir(deps.config.project, deps.state.featureSlug);
            const { writeFileSync } = await import('node:fs');
            const { join } = await import('node:path');
            writeFileSync(join(featureDir, 'PLAN_COMPLIANCE.md'), md, 'utf-8');
            writeFileSync(join(featureDir, 'plan-compliance.json'), JSON.stringify(report, null, 2), 'utf-8');
            (deps.state as unknown as { __validateCompliance?: typeof report }).__validateCompliance = report;
            deps.emit('artifact-written', {
              stage: 'validate',
              file: `${featureDir}/PLAN_COMPLIANCE.md`,
              summary: `Plan compliance: ${report.passed}/${report.total}`,
              content: md,
            });
          } catch (err) {
            console.warn('[pipeline] Validate compliance check failed:', err);
          }
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
