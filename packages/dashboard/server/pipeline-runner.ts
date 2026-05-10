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
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
  manifestGetTouchedFiles,
  populateManifestFromPlan as populateManifestFromPlanBridge,
  renderPlanDerivedArtifact as renderPlanDerivedArtifactBridge,
  extractAndUpdateManifest as extractAndUpdateManifestBridge,
  clearManifestFieldsForStages as clearManifestFieldsForStagesBridge,
  type ManifestBridgeDeps,
} from './manifest-bridge.js';
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
  detectRepos as detectReposFn,
  pullLatestMain as pullLatestMainFn,
  getBaseBranch as getBaseBranchFn,
  type BootstrapDeps,
} from './pipeline-bootstrap.js';
import {
  loadPriorArtifacts as loadPriorArtifactsFn,
  loadStageArtifact as loadStageArtifactFn,
  loadRepoArtifacts as loadRepoArtifactsFn,
  loadHighLevelRequirements as loadHighLevelRequirementsFn,
  writeStageArtifact as writeStageArtifactFn,
  writeRepoArtifact as writeRepoArtifactFn,
  type ArtifactIODeps,
} from './artifact-io.js';
import {
  runOneStage as runOneStageFn,
  type StageOpsDeps,
} from './pipeline-stages.js';
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
  PLAN_DERIVED_STAGES,
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
import { buildStandardStepRegistry } from '@esankhan3/anvil-core-pipeline';
import {
  Pipeline,
  InMemoryEventBus,
  attachAuditLogHook,
  attachCostTrackerHook,
  attachStreamHook,
  attachCheckpointHook,
  createFileCheckpointStore,
  attachLivenessPrefetchHook,
  attachDashboardStateRollupHook,
} from '@esankhan3/anvil-core-pipeline';
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
  /**
   * Models that hit a retryable UpstreamError this run (429 quota,
   * rate-limit, 5xx). Skipped by the chain walker on subsequent
   * resolves so we don't keep hammering a model whose upstream is
   * out of capacity. Reset only by starting a new run.
   */
  private runtimeBurnedModels = new Set<string>();
  /** Event bus used by the Pipeline.run()-driven dispatcher (G7). */
  private readonly pipelineBus = new InMemoryEventBus();
  /**
   * Per-stage de-dupe so the proactive liveness fallback nudge fires
   * once per (stage, original→fallback) pair instead of on every
   * `resolveModelForStage` call.
   */
  private livenessFallbackNotified = new Set<string>();
  /**
   * Walker tunables loaded from `~/.anvil/models.yaml`'s top-level
   * `walker:` block (with compiled-in defaults for missing keys). Cached
   * once at run start by `prefetchProviderLiveness` so chain-walking +
   * retry policy don't re-read the yaml on every stage entry.
   */
  private walkerConfig: WalkerConfig = { ...DEFAULT_WALKER_CONFIG };
  private memoryStore: MemoryStore;
  private kbManager: KnowledgeBaseManager | null;
  private afterStageHook: AfterStageHook | null = null;

  setAfterStageHook(hook: AfterStageHook | null): void { this.afterStageHook = hook; }

  // Reviewer-control state (note slot, artifact override, rerun-from /
  // iterate-with-note) lives in a sibling helper. The runner owns the
  // FS / state-mutation side effects of those actions; this helper owns
  // the pure state machine.
  private reviewer = new ReviewerControl();

  setReviewNote(note: string | null): void {
    this.reviewer.setReviewNote(note);
  }

  /**
   * Replace the just-completed stage's artifact with reviewer-edited
   * markdown. Updates in-memory state, the on-disk artifact, broadcasts
   * the change, and arms the override so the next stage's `prevArtifact`
   * is the edited body.
   */
  applyArtifactEdit(stageIndex: number, editedArtifact: string): void {
    const stage = STAGES[stageIndex];
    if (!stage) return;
    if (this.state.stages[stageIndex]) {
      this.state.stages[stageIndex].artifact = editedArtifact;
    }
    try {
      this.writeStageArtifact(stageIndex, stage, editedArtifact);
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

  /** Per-run plan risk cache (lazy compute, share across stages). */
  private planRisk = new PlanRiskCache();

  // ── Phase 1 cache-stability memoization ─────────────────────────────
  //
  // PromptContextCache owns memoised inputs to the system prompt
  // (memory block, conventions, project YAML slice, KB block, manifest).
  // Constructed in the runner constructor with the small dep set the
  // cache needs.
  private promptCache!: PromptContextCache;

  /** Bundle the manifest-bridge dep set. One-time per call; lazy refs. */
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

    // Resolve workspace: prefer factory.yaml config, then env var, then default
    const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
    const configCandidates = [
      join(anvilHome, 'projects', config.project, 'factory.yaml'),
      join(anvilHome, 'projects', config.project, 'project.yaml'),
    ];
    let resolvedWs: string | null = null;
    for (const cp of configCandidates) {
      if (existsSync(cp)) {
        try {
          const raw = readFileSync(cp, 'utf-8');
          const wsMatch = raw.match(/^workspace:\s+(.+)$/m);
          if (wsMatch) {
            resolvedWs = wsMatch[1].replace(/^["']|["']$/g, '').trim().replace(/^~/, homedir());
            break;
          }
        } catch { /* ignore */ }
      }
    }
    if (resolvedWs && existsSync(resolvedWs)) {
      this.workspaceDir = resolvedWs;
    } else {
      const wsRoot = process.env.ANVIL_WORKSPACE_ROOT || process.env.FF_WORKSPACE_ROOT || join(homedir(), 'workspace');
      this.workspaceDir = join(wsRoot, config.project);
    }

    // Load project YAML for context
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

  /**
   * Soft guardrail (P12): warn if a system prompt exceeds 60KB. Caching
   * efficiency degrades when prefixes balloon, so this fires a project-event
   * to flag regressions before they pile up. Pure telemetry — does not trim.
   */
  /**
   * Build the bundled-dependency snapshot the lifted prompt-builders
   * (Phase 4f.7) consume. Closes over PipelineRunner state so the cache
   * stability invariants (P1 — byte-identical bytes across stages of one
   * run) flow through unchanged.
   */
  private getPromptContext(): PromptBuilderContext {
    return {
      project: this.config.project,
      feature: this.config.feature,
      model: this.config.model,
      workspaceDir: this.workspaceDir,
      baseBranch: this.getBaseBranch(),
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
      loadRepoArtifacts: (repoName) => this.loadRepoArtifacts(repoName),
      loadHighLevelRequirements: () => this.loadHighLevelRequirements(),
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
      // Phase 0: Ensure workspace exists
      await this.setupWorkspace();

      // Pre-warm provider liveness so the sync resolver chain walker
      // (called per stage) reads fresh data. Wired via
      // `attachLivenessPrefetchHook` further down — it fires the
      // caller-supplied probe on `pipeline:started`, with `await: true`
      // blocking stage 0 until the probe completes. Non-blocking
      // failure mode preserved: probe errors are caught by the hook
      // and surfaced via onError, never fail the run.

      // Pre-warm conventions block — extracts on first run if missing,
      // then loads the markdown into the run-scoped cache so every
      // stage prompt's {{conventions}} slot is populated identically.
      await this.promptCache.warmConventions().catch((err: unknown) => {
        console.warn('[pipeline] convention warm failed:', err);
      });

      // Create or resume feature record
      const isResume = this.config.resumeFromStage != null && this.config.featureSlug;
      let featureRecord;
      if (isResume) {
        featureRecord = this.featureStore.getFeature(this.config.project, this.config.featureSlug!);
        if (!featureRecord) {
          // Fallback: create new
          featureRecord = this.featureStore.createFeature(this.config.project, this.config.feature, this.config.model);
        }
        this.state.featureSlug = this.config.featureSlug!;
      } else {
        featureRecord = this.featureStore.createFeature(this.config.project, this.config.feature, this.config.model);
        this.state.featureSlug = featureRecord.slug;
      }

      // Phase 2: ensure a manifest exists for the feature, then pre-fill from
      // the plan seed when present so stage 5 (build) sees acceptanceCriteria,
      // affectedRepos, filesPlanned, and testBehaviors as `final`.
      this.manifestStore.ensure(this.config.project, this.state.featureSlug, this.config.feature);
      if (this.config.planSeed?.plan) {
        try {
          populateManifestFromPlanBridge(this.depsForManifest(), this.config.planSeed.plan);
        } catch (err) {
          console.warn('[pipeline] populateManifestFromPlan failed:', err);
        }
      }

      // Load prior artifacts if resuming
      let prevArtifact = '';
      const resumeStage = this.config.resumeFromStage ?? 0;

      if (isResume) {
        prevArtifact = this.loadPriorArtifacts(resumeStage);
        console.log(`[pipeline] Resuming from stage ${resumeStage} (${STAGES[resumeStage]?.name}), loaded ${prevArtifact.length} chars of prior context`);
      }

      // Prefetch hybrid-retriever context once per run. Sync prompt
      // builders can then read it from the KBManager cache without an
      // await on the hot path; if the LanceDB store is empty/missing,
      // the cache stays empty and the legacy keyword path takes over.
      try {
        await this.kbManager?.prefetchHybridContext(this.config.project, this.config.feature);
      } catch (err) {
        console.warn(`[pipeline] prefetchHybridContext failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Check knowledge base status — agents will explore from scratch if not built (slower + costlier)
      const kbCheck = this.kbManager?.getIndexForPrompt(this.config.project) || this.kbManager?.getAllGraphReports(this.config.project) || '';
      if (!kbCheck) {
        console.warn(`[pipeline] WARNING: No knowledge base for "${this.config.project}" — agents will explore codebase manually. Build the KB from the dashboard for faster, cheaper runs.`);
        this.emit('warning', {
          message: `Knowledge base not built for "${this.config.project}". Agents will explore the codebase manually, which is slower and more expensive. Build the KB from the Knowledge Graph page for better results.`,
        });
        this.emit('project-event', {
          source: 'knowledge-base',
          message: `No Knowledge Base found for "${this.config.project}" — agents will explore codebase manually (slower + costlier). Build the KB from the Knowledge Graph page.`,
          level: 'warn',
        });
      } else {
        this.emit('project-event', {
          source: 'knowledge-base',
          message: `Knowledge Base ready for "${this.config.project}" (${kbCheck.length} chars) — will inject into agent prompts for faster, cheaper runs`,
        });
      }

      // Walker — drives `Pipeline.run()` from core-pipeline over an
      // `InMemoryStepRegistry` built from the canonical STAGES list.
      // Each Step's `run()` calls `runOneStage(i)` (which encodes the
      // legacy for-loop body) and translates the returned control flag:
      //   - 'continue' / 'next'           → return the next prevArtifact
      //   - 'cancelled'                    → throw RewindOrAbortError to
      //                                      abort Pipeline.run cleanly
      //   - 'fail-early-return'            → throw FailEarlyReturnError
      //                                      so the outer try captures
      //                                      and returns this.state
      //   - 'rewind' (reviewer-triggered)  → throw RewindError carrying
      //                                      target index; outer loop
      //                                      catches and re-runs
      //                                      Pipeline.run with
      //                                      completedSteps trimmed.
      const stageState = { prevArtifact, isResume: !!isResume, resumeStage };
      let pipelineEarlyReturn = false;

      // Attach the canonical lifecycle hooks from core-pipeline. They
      // subscribe to `step:*` and `pipeline:*` events fired by
      // Pipeline.run() and persist a forensic audit trail + accumulate
      // cost. The dashboard's existing inline state-file persistence
      // and broadcastState() calls remain — these hooks are additive
      // observation, not replacement.
      const auditLogPath = join(
        process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil'),
        'runs',
        this.state.runId,
        'audit.jsonl',
      );
      const auditLogHandle = attachAuditLogHook(this.pipelineBus, { path: auditLogPath });
      const costTrackerHandle = attachCostTrackerHook(this.pipelineBus);
      // Phase C1 — debounced WS broadcast driven by step:* lifecycle
      // events. Coalesces the burst of mutations inside a stage into a
      // single broadcast per ~100ms window. Existing inline
      // broadcastState() calls remain for now (events the bus doesn't
      // carry today: reviewer edits, mid-stage progress, repo discovery,
      // etc.); subsequent C-tasks migrate those one by one.
      const streamHandle = attachStreamHook(this.pipelineBus, {
        onSnapshot: () => this.broadcastState(),
        debounceMs: 100,
      });
      // Phase C2 — bus-driven forensic checkpoint at
      // ~/.anvil/runs/<runId>/checkpoint.json. Lives alongside the
      // dashboard's pipeline-state.json (which has a richer shape and
      // is read by resume-from-stage). Once reviewer rewind moves to
      // Pipeline.run({ rewindTo }) (Phase C5), the existing
      // checkpoint()/clearCheckpoint() pair retires in favor of this.
      const checkpointHandle = attachCheckpointHook(this.pipelineBus, {
        store: createFileCheckpointStore(),
        runId: this.state.runId,
        keepOnSuccess: true,
        getShared: () => ({
          project: this.state.project,
          feature: this.state.feature,
          featureSlug: this.state.featureSlug,
          totalCost: this.state.totalCost,
          repoNames: this.state.repoNames,
        }),
      });
      // Step 1 of pipeline-runner slimming — rollup hook subscribes to
      // `pipeline:*` / `step:*` / `stage:repo-progress` / `stage:cost-update`
      // / `stage:fix-attempt` / `reviewer:note` and mutates `this.state`
      // in place. Existing inline state mutations remain for the moment;
      // each can be replaced with a `bus.emit(...)` call site-by-site
      // without breaking the WS event vocabulary (the rollup hook also
      // calls `broadcastState` so consumers see no behavior change).
      // Dashboard's RepoAgentState.error is `string | null`; the canonical
      // DashboardRollupRepoState uses `string | undefined`. Both shapes are
      // structurally compatible at the assignment sites the hook actually
      // touches (the hook only writes `string` or deletes the field).
      // Cast through `unknown` to bridge the nullable difference.
      const rollupHandle = attachDashboardStateRollupHook(this.pipelineBus, {
        state: this.state as unknown as Parameters<typeof attachDashboardStateRollupHook>[1]['state'],
        broadcast: () => this.broadcastState(),
        debounceMs: 50,
      });
      // Phase C4 — provider liveness probe wired via the bus. Runs
      // once on `pipeline:started`, BEFORE stage 0 spawns (await:true).
      // Replaces the inline `await this.prefetchProviderLiveness()`
      // call; same fire-and-tolerant semantics — probe failures are
      // caught and never fail the pipeline.
      const livenessHandle = attachLivenessPrefetchHook(this.pipelineBus, {
        probe: () => this.prefetchProviderLiveness(),
        await: true,
      });
      // Phase D1 — when the walker skips a plan-derived stage via
      // skipIfByStage, render the artifact + mutate state here.
      // Listener is awaited inside bus.emit so the next step's
      // input threading sees the rendered artifact.
      const planSkipUnsub = this.pipelineBus.on('step:skipped', async (event) => {
        if (event.payload && (event.payload as { reason?: string }).reason !== 'skipIf') return;
        if (!event.stepId || !PLAN_DERIVED_STAGES.includes(event.stepId)) return;
        const stageIdx = STAGES.findIndex((s) => s.name === event.stepId);
        if (stageIdx < 0) return;
        await renderPlanDerivedArtifactBridge(this.depsForManifest(), event.stepId, stageIdx);
        // Thread the rendered artifact into stageState so subsequent
        // non-skipped stages see it as their prevArtifact.
        const rendered = this.state.stages[stageIdx]?.artifact;
        if (rendered) stageState.prevArtifact = rendered;
      });

      // Outer loop handles rewind. The walker drives forward; on
      // reviewer rewind we set `rewindToStep` and Pipeline.run handles
      // the prefix-skip + suffix-rerun automatically (Phase A2 +
      // Phase C5 — replaces the manual `completedStepIds` trim that
      // never actually populated, since no `step:completed` listener
      // was wired). The runOneStage internal short-circuit on
      // `state.stages[i].status === 'completed'` keeps the rewind
      // economical even when the walker re-fires every prior step.
      let rewindToStep: string | undefined;
      while (true) {
        if (this.cancelled) break;
        const stagePipelineRegistry = buildStandardStepRegistry({
          // Phase D1 — plan-derived stages skip when a planSeed is
          // present. The skipIf predicate is pure (just a config
          // read); the rendering side effects live in the
          // `step:skipped` listener attached above.
          skipIfByStage: {
            requirements: () => this.config.planSeed != null,
            'repo-requirements': () => this.config.planSeed != null,
            specs: () => this.config.planSeed != null,
            tasks: () => this.config.planSeed != null,
          },
          runStage: async (stageName, _prevForStep) => {
            // Map name → index. STAGES is the canonical ordering.
            const idx = STAGES.findIndex((s) => s.name === stageName);
            if (idx < 0) throw new Error(`Unknown stage in registry: ${stageName}`);
            const ctrl = await this.runOneStage(idx, stageState.isResume, stageState.resumeStage, stageState.prevArtifact);
            stageState.prevArtifact = ctrl.prevArtifact;
            if (ctrl.control === 'cancelled') {
              const err = new Error('cancelled');
              (err as Error & { __anvilCancel: boolean }).__anvilCancel = true;
              throw err;
            }
            if (ctrl.control === 'fail-early-return') {
              // Embed the originating stage error in the sentinel message so
              // the audit log and pipeline:failed payload show the real cause
              // (e.g. "claude 503: Claude CLI exited 0...") instead of just
              // the bare sentinel string.
              const stageErr = this.state.stages[idx]?.error ?? 'unknown';
              const err = new Error(`fail-early-return: ${stageErr}`);
              (err as Error & { __anvilFailReturn: boolean }).__anvilFailReturn = true;
              throw err;
            }
            if (ctrl.control === 'rewind' && ctrl.rewindTo !== undefined) {
              const err = new Error('rewind');
              (err as Error & { __anvilRewind: number }).__anvilRewind = ctrl.rewindTo;
              throw err;
            }
            // 'continue' or 'next' — record completion and return artifact
            // so the next Step receives it as ctx.input.
            return { artifact: stageState.prevArtifact, cost: 0 };
          },
        });
        try {
          const pipeline = new Pipeline({
            registry: stagePipelineRegistry,
            bus: this.pipelineBus,
            runId: this.state.runId,
            workspaceDir: this.workspaceDir,
            initialInput: stageState.prevArtifact,
            repoPaths: this.repoPaths,
            ...(rewindToStep ? { rewindTo: rewindToStep } : {}),
          });
          await pipeline.run();
          // No exceptions → walker ran cleanly to the end.
          break;
        } catch (err) {
          const e = err as Error & {
            __anvilCancel?: boolean;
            __anvilFailReturn?: boolean;
            __anvilRewind?: number;
          };
          // Pipeline wraps thrown errors — peek at message for our markers.
          const msg = e?.message ?? String(err);
          if (e.__anvilCancel || msg.includes('cancelled')) {
            break;
          }
          if (e.__anvilFailReturn || msg.includes('fail-early-return')) {
            pipelineEarlyReturn = true;
            break;
          }
          if (e.__anvilRewind !== undefined || msg.includes('rewind')) {
            // Phase C5 — translate the runOneStage rewind sentinel into
            // a Pipeline.run({ rewindTo }) for the next iteration. The
            // walker auto-handles the prefix skip + suffix re-run so
            // we don't need to maintain a parallel completedStepIds set.
            const target = e.__anvilRewind ?? -1;
            if (target < 0) break;
            const targetName = STAGES[target]?.name;
            if (!targetName) break;
            rewindToStep = targetName;
            continue;
          }
          // Unexpected — re-throw so the outer try/catch handles it.
          throw err;
        }
      }
      prevArtifact = stageState.prevArtifact;
      // Persist the final cost rollup before unsubscribing the hooks. The
      // dashboard's existing this.state.totalCost ledger is canonical;
      // this is a parity check we can extend later.
      const auditEntries = auditLogHandle.entryCount;
      const costTotals = costTrackerHandle.totals();
      void auditEntries; void costTotals;
      auditLogHandle.unsubscribe();
      costTrackerHandle.unsubscribe();
      streamHandle.flush();
      streamHandle.unsubscribe();
      checkpointHandle.unsubscribe();
      livenessHandle.unsubscribe();
      rollupHandle.flush();
      rollupHandle.unsubscribe();
      planSkipUnsub();
      if (pipelineEarlyReturn) return this.state;

      if (!this.cancelled) {
        this.state.status = 'completed';
        this.broadcastState();
        this.clearCheckpoint(); // Mark checkpoint as completed
        this.emit('pipeline-complete', this.state);
        this.featureStore.updateFeature(this.config.project, this.state.featureSlug, {
          status: 'completed',
          totalCost: this.state.totalCost,
        });
      }
    } catch (err) {
      console.error('[pipeline-runner] Fatal error:', err);
      this.state.status = 'failed';
      this.broadcastState();
      this.checkpoint(); // Save: fatal failure
      this.emit('pipeline-fail', this.state);
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

  private setupWorkspace(): Promise<void> {
    return setupWorkspaceFn(this.depsForBootstrap());
  }

  private getBaseBranch(): string {
    return getBaseBranchFn(this.config);
  }

  private pullLatestMain(): Promise<void> {
    return pullLatestMainFn(this.depsForBootstrap());
  }

  // runOneStage + 6 sub-functions + makeAgentRunner + makeAgentSession
  // live in `./pipeline-stages.ts`. The runner exposes a thin
  // `runOneStage` wrapper that bundles the dep set on each call.

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
      fixLoopAgentByRepo: this.fixLoopAgentByRepo,
      getFixLoopAgentSingle: () => this.fixLoopAgentSingle,
      setFixLoopAgentSingle: (id) => { this.fixLoopAgentSingle = id; },
    };
  }

  private runOneStage(
    i: number,
    isResume: boolean,
    resumeStage: number,
    prevArtifactIn: string,
  ): Promise<{
    control: "continue" | "next" | "cancelled" | "fail-early-return" | "rewind";
    rewindTo?: number;
    prevArtifact: string;
  }> {
    return runOneStageFn(this.depsForStageOps(), i, isResume, resumeStage, prevArtifactIn);
  }

  // ── Artifact + repo I/O — delegate to siblings ─────────────────────

  /** Bundle the artifact-io dep set. */
  private depsForArtifactIO(): ArtifactIODeps {
    return {
      config: this.config,
      state: this.state,
      featureStore: this.featureStore,
      emit: (event, payload) => this.emit(event, payload),
    };
  }

  private loadPriorArtifacts(_upToStage: number): string {
    return loadPriorArtifactsFn(this.depsForArtifactIO());
  }

  private loadStageArtifact(stage: StageDefinition): string {
    return loadStageArtifactFn(this.depsForArtifactIO(), stage);
  }

  private detectRepos(_requirementsArtifact: string): void {
    detectReposFn(this.depsForBootstrap());
  }

  private writeStageArtifact(_index: number, stage: StageDefinition, artifact: string): void {
    writeStageArtifactFn(this.depsForArtifactIO(), stage, artifact);
  }

  private writeRepoArtifact(stage: StageDefinition, repoName: string, artifact: string): void {
    writeRepoArtifactFn(this.depsForArtifactIO(), stage, repoName, artifact);
  }

  private loadRepoArtifacts(repoName: string): { requirements: string; specs: string; tasks: string; build: string } {
    return loadRepoArtifactsFn(this.depsForArtifactIO(), repoName);
  }

  private loadHighLevelRequirements(): string {
    return loadHighLevelRequirementsFn(this.depsForArtifactIO());
  }

  private broadcastState(): void {
    this.emit('state-change', this.state);
  }
}
