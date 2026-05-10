/**
 * Server-side pipeline runner — the dashboard IS the orchestrator.
 *
 * Runs the 8-stage pipeline directly using AgentManager.
 * Key features:
 *   - Interactive clarify: pauses for user input before advancing
 *   - Per-repo parallelism: stages 2-6 spawn agents per repository
 *   - Feature folder integration: writes artifacts to feature store
 *   - Project config integration: resolves repos from ProjectLoader
 */

import { EventEmitter } from 'node:events';
import { AgentManager } from '@esankhan3/anvil-agent-core';
import { ProjectLoader } from './project-loader.js';
import type { ProjectInfo } from './project-loader.js';
import { FeatureStore } from './feature-store.js';
import { MemoryStore } from './memory-store.js';
import { KnowledgeBaseManager } from './knowledge-base-manager.js';
import {
  writePipelineCheckpoint,
  clearPipelineCheckpoint,
} from './pipeline-checkpoint.js';
import { ReviewerControl } from './reviewer-control.js';
import { PromptContextCache } from './prompt-context-cache.js';
import {
  PlanRiskCache,
  type ManifestBridgeDeps,
} from './manifest-bridge.js';
import { prepareRun, resolveWorkspaceDir } from './runner-prep.js';
import {
  resolveModelForStage as resolveModelForStageBridge,
  allowedToolsForCurrentStage as allowedToolsForCurrentStageBridge,
  prefetchProviderLiveness as prefetchProviderLivenessBridge,
  type ModelResolutionDeps,
} from './model-resolution.js';
import {
  ensureAuth as ensureAuthBridge,
  writePerRepoTelemetry as writePerRepoTelemetryFn,
  handleOutputTruncation as handleOutputTruncationFn,
  aggregateRunTokens as aggregateRunTokensFn,
  logCacheTelemetry as logCacheTelemetryFn,
  type RunnerTelemetryDeps,
} from './runner-telemetry.js';
import {
  setupWorkspace as setupWorkspaceFn,
  getBaseBranch as getBaseBranchFn,
  type BootstrapDeps,
} from './pipeline-bootstrap.js';
import {
  loadRepoArtifacts as loadRepoArtifactsFn,
  loadHighLevelRequirements as loadHighLevelRequirementsFn,
  writeStageArtifact as writeStageArtifactFn,
  type ArtifactIODeps,
} from './artifact-io.js';
import { type StageOpsDeps } from './pipeline-stages.js';
// Type declarations + module-level constants live in a sibling file
// so this orchestrator stays focused on logic. Re-exported below for
// back-compat with consumers that import these from `./pipeline-runner.js`.
import type {
  ModelTier,
  StageDefinition,
  RepoAgentState,
  StageTokenStats,
  PipelineStageState,
  PipelineRunState,
  PipelineRunnerEvents,
  PipelineConfig,
  PipelineCheckpoint,
  AfterStageHook,
} from './pipeline-runner-types.js';
import {
  STAGES,
  STAGE_OUTPUT_LIMITS,
  STAGE_OUTPUT_LIMIT_FALLBACK,
  maxOutputTokensForStage,
  listStageNames,
  zeroTokenStats,
  readCheckpoint,
  findInterruptedPipelines,
} from './pipeline-runner-types.js';
export type {
  ModelTier,
  StageDefinition,
  RepoAgentState,
  StageTokenStats,
  PipelineStageState,
  PipelineRunState,
  PipelineRunnerEvents,
  PipelineConfig,
  PipelineCheckpoint,
  AfterStageHook,
};
export {
  STAGES,
  STAGE_OUTPUT_LIMITS,
  STAGE_OUTPUT_LIMIT_FALLBACK,
  maxOutputTokensForStage,
  listStageNames,
  readCheckpoint,
  findInterruptedPipelines,
};
import { InMemoryEventBus, formatStageAnswers as formatStageAnswersHelper, attachDurableLogHook, LeaseManager } from '@esankhan3/anvil-core-pipeline';
import { attachPipelineHooks } from './pipeline-hooks.js';
import { runPipelineLoop } from './pipeline-loop.js';
import { getDurableStore, durableHolderId } from './durable-store-singleton.js';
import { DEFAULT_WALKER_CONFIG } from '@esankhan3/anvil-agent-core';
import type { WalkerConfig } from '@esankhan3/anvil-agent-core';
import { type PromptBuilderContext } from '@esankhan3/anvil-core-pipeline';
import { FeatureManifestStore } from './feature-manifest.js';

// Claude auth helpers live in `./claude-auth.ts`; the runner consumes
// them indirectly through `runner-telemetry.ensureAuth`.

// Phase 4f.7: Persona prompt loader + injectTemplateVars now live in
// `./steps/prompt-builders.ts` so the lifted prompt-builder functions can
// share them. Kept as a re-export below for legacy callsites until 4f.8+.

// Stage definitions, type declarations, token-stat helpers, checkpoint
// reader, and after-stage hook contract live in `./pipeline-runner-types.js`.
// Re-exported above for back-compat.

// ── Pipeline Runner ───────────────────────────────────────────────────

/** Build the lookup key for a per-(stage, repo) Q&A input resolver. */
function stageInputKey(stageIndex: number, repoName: string | null): string {
  return `${stageIndex}|${repoName ?? '__'}`;
}

export class PipelineRunner extends EventEmitter {
  private agentManager: AgentManager;
  private projectLoader: ProjectLoader;
  private featureStore: FeatureStore;
  private manifestStore: FeatureManifestStore;
  private state: PipelineRunState;
  private config: PipelineConfig;
  private workspaceDir: string;
  private projectYaml: string;
  private projectInfo: ProjectInfo | null = null;
  private repoPaths: Record<string, string> = {};
  private cancelled = false;
  /** Retryable-upstream-burn set; chain walker skips these after a fail. */
  private runtimeBurnedModels = new Set<string>();
  private readonly pipelineBus = new InMemoryEventBus();
  /** De-dupe so proactive liveness fallback notices fire once per pair. */
  private livenessFallbackNotified = new Set<string>();
  /** Walker block from `~/.anvil/models.yaml`; loaded by prefetchProviderLiveness. */
  private walkerConfig: WalkerConfig = { ...DEFAULT_WALKER_CONFIG };
  private memoryStore: MemoryStore;
  private kbManager: KnowledgeBaseManager | null;
  private afterStageHook: AfterStageHook | null = null;

  setAfterStageHook(hook: AfterStageHook | null): void { this.afterStageHook = hook; }

  private reviewer = new ReviewerControl();

  setReviewNote(note: string | null): void {
    this.reviewer.setReviewNote(note);
  }

  /** Replace the just-completed stage's artifact with reviewer-edited markdown. */
  applyArtifactEdit(stageIndex: number, editedArtifact: string): void {
    const stage = STAGES[stageIndex];
    if (!stage) return;
    if (this.state.stages[stageIndex]) {
      this.state.stages[stageIndex].artifact = editedArtifact;
    }
    try {
      writeStageArtifactFn(this.depsForArtifactIO(), stage, editedArtifact);
    } catch (err) {
      console.warn(`[pipeline] applyArtifactEdit: writeStageArtifact failed: ${err instanceof Error ? err.message : err}`);
    }
    this.reviewer.setArtifactOverride(editedArtifact);
    this.broadcastState();
    this.checkpoint();
  }

  requestRerunFromStage(targetIndex: number, note: string | null): void {
    this.reviewer.requestRerunFromStage(targetIndex, STAGES.length, note);
  }

  iterateCurrentStageWithNote(currentStageIndex: number, note: string | null): void {
    this.reviewer.iterateCurrentStageWithNote(currentStageIndex, STAGES.length, note);
  }

  private planRisk = new PlanRiskCache();
  private promptCache!: PromptContextCache;

  private depsForManifest(): ManifestBridgeDeps {
    return {
      project: this.config.project,
      feature: this.config.feature,
      featureSlug: () => this.state.featureSlug,
      manifestStore: this.manifestStore,
      featureStore: this.featureStore,
      state: this.state,
      config: this.config,
      repoPaths: () => this.repoPaths,
      invalidateManifestCache: () => this.promptCache.invalidateManifestBlock(),
      broadcast: () => this.broadcastState(),
      checkpoint: () => this.checkpoint(),
    };
  }

  // For interactive clarify — resolves when user provides input
  private inputResolve: ((text: string) => void) | null = null;

  /**
   * Per-(stageIndex, repoName?) input resolvers for stage Q&A. The
   * resolver fires once every question for the stage has an answer; the
   * server resolves it with a `<answers>...</answers>` block ready to
   * paste back into the agent session via `agentSession.sendInput`.
   *
   * Key: `${stageIndex}|${repoName ?? '__'}`.
   */
  private stageInputResolvers = new Map<string, (text: string) => void>();

  /** Project Q&A policy snapshot — set by the dashboard before run() starts. */
  private qaPolicy: { enabled?: boolean; maxQuestionsPerStage?: number } | undefined;

  /** Wire the project's Q&A policy block into the runner before `run()`. */
  setQAPolicy(policy: { enabled?: boolean; maxQuestionsPerStage?: number } | undefined): void {
    this.qaPolicy = policy;
  }

  constructor(
    agentManager: AgentManager,
    projectLoader: ProjectLoader,
    featureStore: FeatureStore,
    config: PipelineConfig,
    memoryStore?: MemoryStore,
    kbManager?: KnowledgeBaseManager,
  ) {
    super();
    this.agentManager = agentManager;
    this.projectLoader = projectLoader;
    this.featureStore = featureStore;
    this.manifestStore = new FeatureManifestStore(featureStore);
    this.config = config;
    this.memoryStore = memoryStore ?? new MemoryStore();
    this.kbManager = kbManager ?? null;

    this.workspaceDir = resolveWorkspaceDir(config.project);
    this.projectYaml = this.projectLoader.getProjectYamlRaw(config.project);

    this.promptCache = new PromptContextCache({
      project: config.project,
      feature: config.feature,
      memoryStore: this.memoryStore,
      kbManager: this.kbManager,
      manifestStore: this.manifestStore,
      projectYaml: this.projectYaml,
      repoPaths: () => this.repoPaths,
      featureSlug: () => this.state.featureSlug,
      emitProjectEvent: (level, message) => {
        this.emit('project-event', { source: 'conventions', message, level });
      },
    });

    const featureSlug = FeatureStore.slugify(config.feature);
    const runId = `run-${Date.now().toString(36)}`;

    this.state = {
      runId,
      project: config.project,
      feature: config.feature,
      featureSlug,
      status: 'running',
      currentStage: 0,
      stages: STAGES.map((s) => ({
        name: s.name,
        label: s.label,
        status: 'pending',
        agentId: null,
        cost: 0,
        startedAt: null,
        completedAt: null,
        artifact: '',
        error: null,
        perRepo: s.perRepo,
        repos: [],
      })),
      startedAt: new Date().toISOString(),
      totalCost: 0,
      model: config.model,
      repoNames: [],
      waitingForInput: false,
      tokens: { ...zeroTokenStats(), cacheHitRatio: 0 },
    };
  }

  getState(): PipelineRunState {
    return this.state;
  }

  /** Bundle the model-resolution dep set. Lazy refs; one-time per call. */
  private depsForResolution(): ModelResolutionDeps {
    return {
      config: this.config,
      projectLoader: this.projectLoader,
      state: this.state,
      runtimeBurnedModels: this.runtimeBurnedModels,
      livenessFallbackNotified: this.livenessFallbackNotified,
      emitProjectEvent: (payload) => this.emit('project-event', payload),
      broadcast: () => this.broadcastState(),
    };
  }

  private resolveModelForStage(stageName: string): string {
    return resolveModelForStageBridge(this.depsForResolution(), stageName);
  }

  private allowedToolsForCurrentStage(stageName: string): string[] {
    return allowedToolsForCurrentStageBridge(this.depsForResolution(), stageName);
  }

  protected async prefetchProviderLiveness(): Promise<void> {
    this.walkerConfig = await prefetchProviderLivenessBridge();
  }

  private getPromptContext(): PromptBuilderContext {
    return {
      project: this.config.project,
      feature: this.config.feature,
      model: this.config.model,
      workspaceDir: this.workspaceDir,
      baseBranch: getBaseBranchFn(this.config),
      failureContext: this.config.failureContext,
      // Surfaced for the immediate next stage only — pipeline loop arms
      // it on stage entry and clears it on stage exit, so per-repo fanout
      // sees the same note across calls.
      reviewNote: this.reviewer.peekReviewNote() ?? undefined,
      actionType: this.config.actionType,
      repoNames: this.state.repoNames,
      featureSlug: this.state.featureSlug,
      projectYaml: this.projectYaml,
      projectInfo: this.projectInfo,
      repoPaths: this.repoPaths,
      getStableMemoryBlock: () => this.promptCache.getStableMemoryBlock(),
      getStableConventionsBlock: () => this.promptCache.getStableConventionsBlock(),
      getStableProjectYamlSlice: (n) => this.promptCache.getStableProjectYamlSlice(n),
      getStableKbBlock: (tier, repoName) => this.promptCache.getStableKbBlock(tier, repoName),
      getStableManifestBlock: () => this.promptCache.getStableManifestBlock(),
      getLockedKbTier: (stage) => this.promptCache.getLockedKbTier(stage as StageDefinition),
      loadRepoArtifacts: (repoName) => loadRepoArtifactsFn(this.depsForArtifactIO(), repoName),
      loadHighLevelRequirements: () => loadHighLevelRequirementsFn(this.depsForArtifactIO()),
      kbManager: this.kbManager,
      emit: (event, payload) => this.emit(event, payload),
    };
  }

  /** Persist pipeline state to disk for crash recovery. */
  checkpoint(): void {
    writePipelineCheckpoint({
      state: this.state,
      config: this.config,
      featureStore: this.featureStore,
    });
  }

  /** Clear checkpoint (called when pipeline completes successfully). */
  private clearCheckpoint(): void {
    clearPipelineCheckpoint({
      state: this.state,
      config: this.config,
      featureStore: this.featureStore,
    });
  }

  /** Get the agentId for a specific stage (for sendInput) */
  getStageAgentId(stageIndex: number): string | null {
    return this.state.stages[stageIndex]?.agentId ?? null;
  }

  /** Get the currently running stage's agentId */
  getCurrentAgentId(): string | null {
    return this.getStageAgentId(this.state.currentStage);
  }

  /** Provide user input (for interactive clarify or any waiting stage) */
  provideInput(text: string): void {
    if (this.inputResolve) {
      this.inputResolve(text);
      this.inputResolve = null;
      this.state.waitingForInput = false;
      this.broadcastState();
    } else {
      // Fallback: send input to current agent via --resume
      const agentId = this.getCurrentAgentId();
      if (agentId) {
        this.agentManager.sendInput(agentId, text);
      }
    }
  }

  /**
   * Record the user's answer for one Q&A question on a specific stage
   * (and repo, when the stage is per-repo). Mutates state, broadcasts a
   * `stage-answer-recorded` event, and — once every question for this
   * (stage, repo) has an answer — resolves the agent's input promise
   * with a formatted `<answers>` block. Returns the new "remaining"
   * count so the WS handler can echo it back.
   */
  provideStageAnswer(stageIndex: number, repoName: string | null, questionIndex: number, text: string): {
    remaining: number;
    accepted: boolean;
  } {
    const stage = this.state.stages[stageIndex];
    if (!stage) return { remaining: 0, accepted: false };
    const list = repoName
      ? stage.repos.find((r) => r.repoName === repoName)?.questions
      : stage.questions;
    if (!list) return { remaining: 0, accepted: false };
    const target = list.find((q) => q.index === questionIndex);
    if (!target) return { remaining: 0, accepted: false };
    target.answer = text.trim();
    target.answeredAt = new Date().toISOString();
    const remaining = list.filter((q) => !q.answer).length;
    this.broadcastState();
    this.emit('stage-answer-recorded', { stageIndex, repoName, questionIndex, remaining });
    if (remaining === 0) {
      const key = stageInputKey(stageIndex, repoName);
      const resolve = this.stageInputResolvers.get(key);
      const answersBlock = formatStageAnswersHelper(list.map((q) => ({
        question: q.text,
        answer: q.answer ?? '',
      })));
      if (resolve) {
        this.stageInputResolvers.delete(key);
        resolve(answersBlock);
      }
      // Phase E9: enqueue a durable signal so a crashed process
      // resumes Q&A without re-prompting. The receiver
      // (runStageWithQA) races the in-process resolver against
      // ctx.waitForSignal — first one to land wins.
      const durableStore = getDurableStore();
      if (durableStore) {
        void durableStore
          .enqueueSignal(this.state.runId, `stage-answer-${stageIndex}`, answersBlock)
          .catch((err) => {
            console.warn(
              `[pipeline-runner] enqueueSignal failed for stage-answer-${stageIndex}: ${err instanceof Error ? err.message : err}`,
            );
          });
      }
    }
    return { remaining, accepted: true };
  }

  /** Read-only view of the questions for a (stage, repo) — used by the dashboard. */
  getStageQuestions(stageIndex: number, repoName: string | null = null) {
    const stage = this.state.stages[stageIndex];
    if (!stage) return [];
    return repoName
      ? stage.repos.find((r) => r.repoName === repoName)?.questions ?? []
      : stage.questions ?? [];
  }

  cancel(): void {
    this.cancelled = true;
    // Kill all running agents
    for (const stage of this.state.stages) {
      if (stage.agentId) this.agentManager.kill(stage.agentId);
      for (const repo of stage.repos) {
        if (repo.agentId) this.agentManager.kill(repo.agentId);
      }
    }
    if (this.inputResolve) {
      this.inputResolve('');
      this.inputResolve = null;
    }
    this.state.status = 'cancelled';
    this.state.waitingForInput = false;
    this.broadcastState();
    this.checkpoint(); // Save: cancelled state for resume later
  }

  // ── Run the pipeline ────────────────────────────────────────────────

  async run(): Promise<PipelineRunState> {
    try {
      await setupWorkspaceFn(this.depsForBootstrap());

      // Pre-warm provider liveness so the sync resolver chain walker
      // (called per stage) reads fresh data. Wired via
      // `attachLivenessPrefetchHook` further down — it fires the
      // caller-supplied probe on `pipeline:started`, with `await: true`
      // blocking stage 0 until the probe completes. Non-blocking
      // failure mode preserved: probe errors are caught by the hook
      // and surfaced via onError, never fail the run.

      await this.promptCache.warmConventions().catch((err: unknown) => {
        console.warn('[pipeline] convention warm failed:', err);
      });

      const { isResume, resumeStage, prevArtifact } = await prepareRun({
        config: this.config,
        state: this.state,
        featureStore: this.featureStore,
        manifestStore: this.manifestStore,
        kbManager: this.kbManager,
        depsForManifest: () => this.depsForManifest(),
        depsForArtifactIO: () => this.depsForArtifactIO(),
        emit: (event, payload) => this.emit(event, payload),
      });

      // Hooks + Pipeline.run() loop live in `pipeline-hooks` + `pipeline-loop`.
      const hooksHandle = attachPipelineHooks({
        bus: this.pipelineBus,
        state: this.state,
        broadcast: () => this.broadcastState(),
        prefetchProviderLiveness: () => this.prefetchProviderLiveness(),
      });

      // Phase D3: durable store integration. Open the singleton,
      // create/upsert a `runs` row for this runId, attach the
      // durable-log hook so step:* events are persisted, and
      // pass the store down to the Pipeline walker so step
      // bodies that opt into ctx.effect get checkpointed.
      const durableStore = getDurableStore();
      const durableHolder = durableHolderId();
      let durableHookHandle: { unsubscribe(): void } | null = null;
      let leaseManager: LeaseManager | null = null;
      if (durableStore) {
        try {
          await durableStore.createRun({
            runId: this.state.runId,
            project: this.config.project,
            feature: this.config.feature,
            featureSlug: this.state.featureSlug,
          });
          await durableStore.acquireLease(this.state.runId, durableHolder, 60_000);
          await durableStore.updateRunStatus(this.state.runId, 'running', null);
          durableHookHandle = attachDurableLogHook(
            this.pipelineBus,
            durableStore,
            this.state.runId,
          );
          // Phase D6: heartbeat the lease so a crashed process's
          // lease expires within ttlMs and a peer (or this process
          // restarted) can take over.
          leaseManager = new LeaseManager({
            store: durableStore,
            runId: this.state.runId,
            holder: durableHolder,
            ttlMs: 60_000,
          });
          leaseManager.on('lost', () => {
            console.warn(`[pipeline-runner] Lost durable lease for ${this.state.runId} — another process took over.`);
          });
          leaseManager.on('error', (err: Error) => {
            console.warn(`[pipeline-runner] Lease heartbeat error: ${err.message}`);
          });
          leaseManager.start();
        } catch (err) {
          console.warn(
            `[pipeline-runner] Durable store wiring failed; continuing in non-durable mode: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      let loopResult;
      try {
        loopResult = await runPipelineLoop({
          stageOps: this.depsForStageOps(),
          bus: this.pipelineBus,
          runId: this.state.runId,
          workspaceDir: this.workspaceDir,
          repoPaths: () => this.repoPaths,
          config: this.config,
          isResume,
          resumeStage,
          initialPrevArtifact: prevArtifact,
          isCancelled: () => this.cancelled,
          ...(durableStore ? { durableStore, durableHolder } : {}),
        });
      } finally {
        hooksHandle.detach();
        durableHookHandle?.unsubscribe();
        if (leaseManager) {
          await leaseManager.stop();
        } else if (durableStore) {
          try {
            await durableStore.releaseLease(this.state.runId, durableHolder);
          } catch {
            /* swallow — best-effort release */
          }
        }
      }
      if (loopResult.pipelineEarlyReturn) {
        if (durableStore) {
          try {
            await durableStore.updateRunStatus(this.state.runId, 'failed');
          } catch {
            /* swallow */
          }
        }
        return this.state;
      }

      if (!this.cancelled) {
        this.state.status = 'completed';
        this.broadcastState();
        this.clearCheckpoint(); // Mark checkpoint as completed
        this.emit('pipeline-complete', this.state);
        this.featureStore.updateFeature(this.config.project, this.state.featureSlug, {
          status: 'completed',
          totalCost: this.state.totalCost,
        });
        if (durableStore) {
          try {
            await durableStore.updateRunStatus(this.state.runId, 'completed');
          } catch {
            /* swallow */
          }
        }
      } else if (durableStore) {
        try {
          await durableStore.updateRunStatus(this.state.runId, 'cancelled');
        } catch {
          /* swallow */
        }
      }
    } catch (err) {
      console.error('[pipeline-runner] Fatal error:', err);
      this.state.status = 'failed';
      this.broadcastState();
      this.checkpoint(); // Save: fatal failure
      this.emit('pipeline-fail', this.state);
      const fallbackStore = getDurableStore();
      if (fallbackStore) {
        try {
          await fallbackStore.updateRunStatus(this.state.runId, 'failed');
        } catch {
          /* swallow */
        }
      }
    }

    return this.state;
  }

  // ── Workspace setup ────────────────────────────────────────────────

  /** Bundle the bootstrap dep set. Lazy refs; one-time per call. */
  private depsForBootstrap(): BootstrapDeps {
    return {
      config: this.config,
      projectLoader: this.projectLoader,
      state: this.state,
      workspaceDir: this.workspaceDir,
      emitProjectEvent: (payload) => this.emit('project-event', payload),
      setProjectInfo: (info) => { this.projectInfo = info; },
      setRepoPaths: (paths) => { this.repoPaths = paths; },
      getRepoPaths: () => this.repoPaths,
      broadcast: () => this.broadcastState(),
      checkpoint: () => this.checkpoint(),
    };
  }

  /** Per-run fix-loop session refs, threaded into the validate→fix loop. */
  private fixLoopAgentByRepo: Map<string, string> = new Map();
  private fixLoopAgentSingle: string | null = null;

  /** Bundle the runner-telemetry dep set. */
  private depsForTelemetry(): RunnerTelemetryDeps {
    return {
      state: this.state,
      broadcast: () => this.broadcastState(),
      checkpoint: () => this.checkpoint(),
      emit: (event, payload) => this.emit(event as 'auth-required' | 'project-event', payload as never),
      resolveModel: (stageName) => resolveModelForStageBridge(this.depsForResolution(), stageName),
    };
  }

  /** Bundle the stage-ops dep set. Lazy refs; one-time per call. */
  private depsForStageOps(): StageOpsDeps {
    return {
      config: this.config,
      state: this.state,
      workspaceDir: this.workspaceDir,
      repoPaths: () => this.repoPaths,
      walkerConfig: () => this.walkerConfig,
      runtimeBurnedModels: this.runtimeBurnedModels,
      isCancelled: () => this.cancelled,
      setCancelled: () => { this.cancelled = true; },
      agentManager: this.agentManager,
      projectLoader: this.projectLoader,
      featureStore: this.featureStore,
      getPromptContext: () => this.getPromptContext(),
      reviewer: this.reviewer,
      setReviewNote: (note) => this.setReviewNote(note),
      planRisk: this.planRisk,
      afterStageHook: () => this.afterStageHook,
      broadcast: () => this.broadcastState(),
      checkpoint: () => this.checkpoint(),
      emit: (event, ...args) => this.emit(event as never, ...args as never[]),
      resolveModelForStage: (stageName) => resolveModelForStageBridge(this.depsForResolution(), stageName),
      allowedToolsForCurrentStage: (stageName) => allowedToolsForCurrentStageBridge(this.depsForResolution(), stageName),
      ensureAuth: (stageName) => ensureAuthBridge(this.depsForTelemetry(), stageName),
      depsForManifest: () => this.depsForManifest(),
      depsForArtifactIO: () => this.depsForArtifactIO(),
      depsForBootstrap: () => this.depsForBootstrap(),
      aggregateRunTokens: (t) => aggregateRunTokensFn(this.depsForTelemetry(), t),
      logCacheTelemetry: (stage, t) => logCacheTelemetryFn(this.depsForTelemetry(), stage, t),
      handleOutputTruncation: (agentName, outputTokens) => handleOutputTruncationFn(this.depsForTelemetry(), agentName, outputTokens),
      writePerRepoTelemetry: (stage, repo, stats) => writePerRepoTelemetryFn(this.depsForTelemetry(), stage, repo, stats),
      setInputResolve: (resolve) => { this.inputResolve = resolve; },
      getQAPolicy: () => this.qaPolicy,
      setStageInputResolver: (stageIndex, repoName, resolve) => {
        const key = stageInputKey(stageIndex, repoName);
        if (resolve) this.stageInputResolvers.set(key, resolve);
        else this.stageInputResolvers.delete(key);
      },
      fixLoopAgentByRepo: this.fixLoopAgentByRepo,
      getFixLoopAgentSingle: () => this.fixLoopAgentSingle,
      setFixLoopAgentSingle: (id) => { this.fixLoopAgentSingle = id; },
    };
  }

  /** Bundle the artifact-io dep set. */
  private depsForArtifactIO(): ArtifactIODeps {
    return {
      config: this.config,
      state: this.state,
      featureStore: this.featureStore,
      emit: (event, payload) => this.emit(event, payload),
    };
  }

  private broadcastState(): void {
    this.emit('state-change', this.state);
  }
}
