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
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync, spawn as cpSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentManager } from '@esankhan3/anvil-agent-core';
import {
  extractConventions as coreExtractConventions,
  loadConventions as coreLoadConventions,
} from '@esankhan3/anvil-convention-core';
import { ProjectLoader } from './project-loader.js';
import type { ProjectInfo } from './project-loader.js';
import { FeatureStore } from './feature-store.js';
import { MemoryStore } from './memory-store.js';
import { KnowledgeBaseManager } from './knowledge-base-manager.js';
import { resolveModelByTier } from '@esankhan3/anvil-agent-core';
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
  LOCAL_TIER_STAGES,
  providerOfModelId,
  zeroTokenStats,
  sumTokenStats,
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
import {
  resolveModelForStage as registryResolveStage,
  ModelResolutionError,
  UnknownStageError,
  allowedToolsForStage,
  permissionClassesForStage,
  runWithChainFallback,
  writePerRepoTelemetry as writePerRepoTelemetryShared,
  formatTelemetrySummary,
} from '@esankhan3/anvil-core-pipeline';
import { AgentManagerRunner } from './runners/agent-manager-runner.js';
import { AgentManagerSession } from './runners/agent-manager-session.js';
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
} from '@esankhan3/anvil-core-pipeline';
import { pickAliveModelFromChainSync, prefetchLiveness, setLivenessTtlMs } from './provider-liveness.js';
import { loadModelRegistry, DEFAULT_WALKER_CONFIG } from '@esankhan3/anvil-agent-core';
import type { ModelRegistry, ProviderName, WalkerConfig } from '@esankhan3/anvil-agent-core';
import { parseTasks, bundleFiles, type ParsedTask } from '@esankhan3/anvil-core-pipeline';
import { sliceSpecForRefs } from '@esankhan3/anvil-core-pipeline';
import { enforceBudget, type PromptSection } from '@esankhan3/anvil-core-pipeline';
import { scorePlan, computeRiskTier } from '@esankhan3/anvil-core-pipeline';
import {
  FeatureManifestStore,
  renderManifestForPrompt,
  type PlannedFile,
  type TestBehavior,
} from './feature-manifest.js';
import {
  combinePerRepoArtifacts,
  disallowedToolsForPersona,
  runBuildForOneRepo,
  hasValidationFailures as hasValidationFailuresHelper,
  buildProjectPrompt as buildProjectPromptHelper,
  buildRepoProjectPrompt as buildRepoProjectPromptHelper,
  buildClarifyExplorePrompt as buildClarifyExplorePromptHelper,
  buildStagePrompt as buildStagePromptHelper,
  buildRepoStagePrompt as buildRepoStagePromptHelper,
  buildPerTaskPrompt as buildPerTaskPromptHelper,
  type PromptBuilderContext,
} from '@esankhan3/anvil-core-pipeline';
// Adapters (legacy agentManager → AgentSession bridge) — stay in dashboard.
import { runClarifyForProject } from './steps/clarify-stage.step.js';
import { runFixLoop } from './steps/fix-loop.step.js';
import { runTestGenForProject } from './steps/test-gen-stage.step.js';
import {
  pullBaseBranchForRepos,
  runPostBuildGuards,
  deployProject,
  createFeatureBranches as createFeatureBranchesHelper,
} from './steps/workspace-ops.js';
import {
  extractAcceptanceCriteria,
  extractAffectedRepos,
  extractApiEndpoints,
  extractChangeBrief,
  extractFilesPlanned,
  extractOpenQuestions,
  extractTablesTouched,
  extractTestBehaviors,
  type ManifestExtractor,
} from '@esankhan3/anvil-core-pipeline';

// ── Claude CLI binary ────────────────────────────────────────────────

const CLAUDE_BIN = process.env.ANVIL_AGENT_CMD ?? process.env.FF_AGENT_CMD ?? process.env.CLAUDE_BIN ?? 'claude';

// ── Auth helpers ─────────────────────────────────────────────────────

/**
 * Check if the Claude CLI is authenticated.
 * Returns true if logged in, false otherwise.
 */
/**
 * Render a Memory.content value (object | string) for prompt injection.
 * BM25 retrieval returns typed Memory<T> rows; pre-rewire we only ever
 * stored strings, so the JSON path is the post-rewire shape.
 */
function formatContent(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 280);
  try {
    return JSON.stringify(content).slice(0, 280);
  } catch {
    return '';
  }
}

function checkClaudeAuth(): boolean {
  try {
    const out = execSync(`${CLAUDE_BIN} auth status --json`, { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] });
    const status = JSON.parse(out.toString());
    return status.loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * Trigger an automatic re-login via `claude auth login`.
 * Opens the browser for OAuth and polls until auth succeeds or times out.
 * Returns true if re-auth succeeded.
 */
function refreshClaudeAuth(timeoutMs = 120_000): Promise<boolean> {
  return new Promise((resolve) => {
    // Spawn login process — opens browser automatically
    const loginProc = cpSpawn(CLAUDE_BIN, ['auth', 'login'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const deadline = Date.now() + timeoutMs;

    // Poll auth status until it succeeds or we time out
    const poll = () => {
      if (Date.now() > deadline) {
        loginProc.kill();
        resolve(false);
        return;
      }
      if (checkClaudeAuth()) {
        loginProc.kill();
        resolve(true);
        return;
      }
      setTimeout(poll, 2000);
    };

    // Give the browser a moment to open before polling
    setTimeout(poll, 3000);

    loginProc.on('exit', () => {
      // Check one final time after login process exits
      setTimeout(() => resolve(checkClaudeAuth()), 500);
    });

    loginProc.on('error', () => resolve(false));
  });
}

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
  /**
   * Review-time feedback from the most recent pause resume. Set by the
   * dashboard's after-stage hook when the user resumes with
   * `approve-with-note` (or any action carrying a `note`). Read once by
   * the next stage's prompt builders, then cleared so the note doesn't
   * leak into stages it wasn't intended for.
   */
  private pendingReviewNote: string | null = null;
  /**
   * Phase 2: feature manifest is rendered into the projectPrompt of every
   * stage so downstream agents stop re-deriving fields earlier stages already
   * produced. Memoised per-snapshot — invalidated whenever a stage patches
   * the manifest. Bytes are stable for all spawns of the same stage.
   */
  private cachedManifestBlock: string | null = null;

  setAfterStageHook(hook: AfterStageHook | null): void { this.afterStageHook = hook; }

  /**
   * Stash a reviewer's feedback note so the next stage's user prompt
   * gets a "User note from review:" block prepended. Called by the
   * dashboard-server after-stage hook the moment a pause resolves.
   *
   * Set in two phases so per-repo fanout (which calls getPromptContext
   * multiple times within a single stage) all sees the same note:
   *   1. After-stage hook calls `setReviewNote(note)` → pendingReviewNote
   *   2. Pipeline loop calls `armReviewNoteForCurrentStage()` once at
   *      stage entry → currentStageReviewNote (read by every prompt build)
   *   3. Pipeline loop calls `clearStageReviewNote()` once at stage exit
   */
  setReviewNote(note: string | null): void {
    const trimmed = note?.trim() ?? '';
    this.pendingReviewNote = trimmed.length > 0 ? trimmed : null;
  }
  private currentStageReviewNote: string | null = null;
  /** Move the most recent pause note onto the current stage. No-op when none. */
  private armReviewNoteForCurrentStage(): void {
    if (this.pendingReviewNote) {
      this.currentStageReviewNote = this.pendingReviewNote;
      this.pendingReviewNote = null;
    }
  }
  /** Clear the per-stage review note so it doesn't bleed into the next stage. */
  private clearStageReviewNote(): void {
    this.currentStageReviewNote = null;
  }
  /** Read the active review note (for prompt builders). Does NOT clear. */
  private peekReviewNote(): string | null {
    return this.currentStageReviewNote;
  }

  // ── Artifact override (Phase B — modify-artifact) ────────────────────

  /**
   * Set when the dashboard's after-stage hook resolves a pause with
   * `modify-artifact`. The pipeline loop reads this AFTER the hook
   * returns and uses it as the `prevArtifact` for the next stage,
   * superseding the agent's output. Cleared once consumed.
   */
  private prevArtifactOverride: string | null = null;

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
    this.prevArtifactOverride = editedArtifact;
    this.broadcastState();
    this.checkpoint();
  }

  /** Read-and-clear the artifact override. Returns null when unset. */
  private consumeArtifactOverride(): string | null {
    const v = this.prevArtifactOverride;
    this.prevArtifactOverride = null;
    return v;
  }

  // ── Rerun-from + Iterate-with-note (Phases C & F) ─────────────────────
  //
  // Both actions reset stage state and bounce the loop counter back; the
  // difference is *what* gets reset and how the note is framed:
  //
  //   rerun-from:
  //     - Resets stages [target..current] (could rewind multiple stages)
  //     - Clears manifest fields written by those stages
  //     - Note → failureContext ("RETRY. The previous run failed: …")
  //
  //   iterate-with-note:
  //     - Resets ONLY the current stage
  //     - Manifest fields untouched
  //     - Note → reviewNote ("User note from review (apply throughout)")
  //
  // Both share the same pending slot; `pendingRerunMode` decides which
  // semantics the loop applies on consume.

  private pendingRerunFromStage: number | null = null;
  private rerunFromNote: string | null = null;
  private pendingRerunMode: 'rerun-from' | 'iterate' | null = null;

  /**
   * Reviewer asked to roll the pipeline back to `targetIndex` and replay
   * with `note` as failure context.
   */
  requestRerunFromStage(targetIndex: number, note: string | null): void {
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= STAGES.length) {
      return;
    }
    this.pendingRerunFromStage = targetIndex;
    this.pendingRerunMode = 'rerun-from';
    const trimmed = note?.trim() ?? '';
    this.rerunFromNote = trimmed.length > 0 ? trimmed : null;
  }

  /**
   * Reviewer wants to refine the just-paused stage's output with feedback
   * — keep working-tree state, keep manifest, frame the note as
   * reviewer-feedback (not retry). The loop will reset just THIS stage
   * and re-spawn with `reviewNote` set.
   */
  iterateCurrentStageWithNote(currentStageIndex: number, note: string | null): void {
    if (!Number.isInteger(currentStageIndex) || currentStageIndex < 0 || currentStageIndex >= STAGES.length) {
      return;
    }
    this.pendingRerunFromStage = currentStageIndex;
    this.pendingRerunMode = 'iterate';
    const trimmed = note?.trim() ?? '';
    this.rerunFromNote = trimmed.length > 0 ? trimmed : null;
  }

  private consumeRerunRequest(): {
    targetIndex: number;
    note: string | null;
    mode: 'rerun-from' | 'iterate';
  } | null {
    if (this.pendingRerunFromStage === null || this.pendingRerunMode === null) return null;
    const v = {
      targetIndex: this.pendingRerunFromStage,
      note: this.rerunFromNote,
      mode: this.pendingRerunMode,
    };
    this.pendingRerunFromStage = null;
    this.rerunFromNote = null;
    this.pendingRerunMode = null;
    return v;
  }

  /**
   * Reset stage state for indices [fromIndex .. toIndex] inclusive so the
   * pipeline loop can replay them. Per-repo sub-state, costs, errors,
   * artifacts and agentIds all cleared.
   */
  private resetStagesForRerun(fromIndex: number, toIndex: number): void {
    for (let j = fromIndex; j <= toIndex; j++) {
      const s = this.state.stages[j];
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
   * Wipe manifest fields written by stages [fromIndex .. toIndex] so the
   * "do not re-derive" prefix doesn't carry stale claims into the rerun.
   */
  private clearManifestFieldsForStages(fromIndex: number, toIndex: number): void {
    const stageFields: Record<string, ReadonlyArray<string>> = {
      requirements: ['acceptanceCriteria', 'affectedRepos'],
      specs: ['apiEndpoints', 'tablesTouched', 'testBehaviors'],
      tasks: ['filesPlanned'],
      build: ['changeBrief'],
      validate: ['openQuestions'],
    };
    for (let j = fromIndex; j <= toIndex; j++) {
      const stage = STAGES[j];
      const fields = stageFields[stage.name];
      if (!fields) continue;
      for (const f of fields) {
        try {
          this.manifestStore.patchField(
            this.config.project, this.state.featureSlug,
            f as never, 'unset', null as never, `rerun-from-${stage.name}`,
          );
        } catch { /* best-effort — extractor may not have run */ }
      }
    }
    this.invalidateManifestBlock();
  }

  /**
   * Best-effort list of files modified by this run so far, prefixed with the
   * repo name so policy globs like `backend/internal/db/**` can match across
   * a multi-repo workspace. Uses `git status --porcelain` per repo and
   * silently skips repos that error.
   */
  private getTouchedFiles(): string[] {
    const files: string[] = [];
    for (const [repoName, repoPath] of Object.entries(this.repoPaths)) {
      if (!repoPath) continue;
      try {
        const out = execSync('git status --porcelain', {
          cwd: repoPath, encoding: 'utf-8', timeout: 10_000,
        });
        for (const line of out.split('\n')) {
          if (line.length < 4) continue;
          const path = (line.slice(3).trim().split(' -> ').pop() ?? '').trim();
          if (path) files.push(`${repoName}/${path}`);
        }
      } catch { /* per-repo best-effort */ }
    }
    return files;
  }

  /**
   * Risk tier + confidence from the plan seed (when present). Computed once
   * at runtime so every stage sees the same numbers; undefined when no plan
   * is available (the policy evaluator falls back to defaults).
   */
  private cachedRisk: { tier: 'low' | 'med' | 'high'; confidence: number } | null = null;
  private getPlanRisk(): { tier?: 'low' | 'med' | 'high'; confidence?: number } {
    if (this.cachedRisk) return this.cachedRisk;
    const seed = this.config.planSeed;
    if (!seed?.plan) return {};
    try {
      const score = scorePlan(seed.plan);
      const confidence = (seed.plan as unknown as { confidence?: number }).confidence;
      this.cachedRisk = {
        tier: computeRiskTier(score.overall),
        confidence: typeof confidence === 'number' ? confidence : 0.5,
      };
      return this.cachedRisk;
    } catch {
      return {};
    }
  }

  // ── Phase 1 cache-stability memoization ─────────────────────────────
  //
  // Stable inputs to the system prompt are computed ONCE per run so the
  // resulting bytes are byte-identical across stages — that's what lets the
  // provider's prompt cache fire (Anthropic explicit, OpenAI auto, Gemini
  // auto). Reset is implicit: a new PipelineRunner instance gets fresh caches.
  private cachedMemoryBlock: string | null = null;
  private cachedConventionsBlock: string | null = null;
  private cachedProjectYamlSlice: Map<number, string> = new Map();
  private cachedKbBlock: Map<string, string> = new Map();
  private lockedKbTierResolved: 'full' | 'repo-focused' | 'index-only' | null = null;

  /**
   * KB tier locked for the run. Stages 1–7 share one tier so the KB
   * subsection of `projectPrompt` is byte-stable across them — that's the
   * dominant byte mass and the dominant cache buster today. Clarify and
   * Ship keep their existing exceptions (clarify needs the big-picture
   * index; ship doesn't need any KB).
   */
  private getLockedKbTier(stage: StageDefinition): 'full' | 'repo-focused' | 'index-only' | 'none' {
    if (stage.name === 'ship') return 'none';
    if (stage.name === 'clarify') return 'index-only';
    if (this.lockedKbTierResolved !== null) return this.lockedKbTierResolved;
    // First lockable call wins. 'repo-focused' is the conservative balance:
    // big enough for analyst/architect needs, small enough that engineers
    // don't drown. Bump to 'full' here only if the project is unusually
    // multi-repo and benefits from cross-repo context every stage.
    this.lockedKbTierResolved = 'repo-focused';
    return this.lockedKbTierResolved;
  }

  /**
   * Memoised memory block (project + user profile, capped at 4KB).
   *
   * Retrieval is BM25-keyed by the run's feature description against
   * the SQLite hot index — top-K relevant entries. An empty block is
   * surfaced honestly when nothing relevant is found rather than
   * falling back to "newest 4KB blob," which leaked stale unrelated
   * notes into prompts.
   */
  private getStableMemoryBlock(): string {
    if (this.cachedMemoryBlock !== null) return this.cachedMemoryBlock;
    try {
      const store = this.memoryStore.unwrap();
      const projectNs = { scope: 'project' as const, projectId: this.config.project };
      const userNs = { scope: 'user' as const, projectId: this.config.project };
      const queryText = this.config.feature || '';

      const projectHits = queryText
        ? store.query(projectNs, { text: queryText, limit: 8 })
        : store.query(projectNs, { limit: 8 });
      const userHits = store.query(userNs, { limit: 5 });

      const projectBlock = projectHits.length > 0
        ? `## Recent project memories (BM25-ranked for "${queryText.slice(0, 60)}")\n` +
          projectHits.map((m) => `- [${m.kind}${m.subtype ? `:${m.subtype}` : ''}] ${formatContent(m.content)}`).join('\n')
        : '';
      const userBlock = userHits.length > 0
        ? `## User profile\n` +
          userHits.map((m) => `- ${formatContent(m.content)}`).join('\n')
        : '';

      const combined = [projectBlock, userBlock].filter(Boolean).join('\n\n');
      this.cachedMemoryBlock = combined.length > 4000
        ? combined.slice(0, 4000) + '\n... [memory truncated]'
        : combined;
    } catch (err) {
      console.warn('[pipeline] BM25 memory retrieval failed:', err);
      this.cachedMemoryBlock = '';
    }
    return this.cachedMemoryBlock;
  }

  /**
   * Memoised conventions block. Loads `<conventionsDir>/global.md` and
   * `<conventionsDir>/<project>/conventions.md` once per run via
   * @esankhan3/anvil-convention-core. Returns empty string on error or when the
   * project has no conventions extracted yet — auto-warm runs at pipeline
   * start to populate the file before clarify.
   */
  private getStableConventionsBlock(): string {
    if (this.cachedConventionsBlock !== null) return this.cachedConventionsBlock;
    try {
      // Synchronous read via require-style — convention-core's loadConventions
      // is async (matches the cli loader's fs/promises shape) so we handle
      // both. Since pipeline-runner pre-populates this cache via warmConventions
      // before stages fire, the synchronous fallback below should rarely run.
      const md = this.conventionsMarkdownSync ?? '';
      this.cachedConventionsBlock = md.length > 8000 ? md.slice(0, 8000) + '\n... [conventions truncated]' : md;
    } catch {
      this.cachedConventionsBlock = '';
    }
    return this.cachedConventionsBlock;
  }

  private conventionsMarkdownSync: string | null = null;

  /**
   * Warm the conventions cache before stage 1. If `<conventionsDir>/<project>/conventions.md`
   * is missing, extract it from the workspace; then load + cache the markdown.
   * Non-fatal — empty block is fine if extraction fails.
   */
  private async warmConventions(): Promise<void> {
    const anvilHome = process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
    const paths = {
      conventionsDir: join(anvilHome, 'conventions'),
      rulesDir: join(anvilHome, 'conventions', 'rules'),
    };
    const projectMd = join(paths.conventionsDir, this.config.project, 'conventions.md');

    if (!existsSync(projectMd)) {
      // Auto-warm — extract once. Workspace may not exist yet for fresh
      // projects; fail silently in that case.
      try {
        const repoPaths = Object.values(this.repoPaths);
        if (repoPaths.length > 0 && repoPaths.every((p) => existsSync(p))) {
          this.emit('project-event', {
            source: 'conventions',
            message: `Extracting conventions for "${this.config.project}" (first run)`,
          });
          coreExtractConventions(paths, this.config.project, repoPaths);
        }
      } catch (err) {
        console.warn('[pipeline] convention extract failed:', err);
      }
    }

    try {
      const md = await coreLoadConventions(paths, this.config.project);
      this.conventionsMarkdownSync = md;
    } catch {
      this.conventionsMarkdownSync = '';
    }
  }

  /** Memoised project YAML slice — same maxLen returns same bytes. */
  private getStableProjectYamlSlice(maxLen: number): string {
    const cached = this.cachedProjectYamlSlice.get(maxLen);
    if (cached !== undefined) return cached;
    const value = this.projectYaml.slice(0, maxLen) || '(not available)';
    this.cachedProjectYamlSlice.set(maxLen, value);
    return value;
  }

  /**
   * Memoised KB block keyed by (tier, repoName). Replaces inline kbManager
   * compositions that varied per stage even when inputs were identical.
   */
  private getStableKbBlock(
    tier: 'full' | 'repo-focused' | 'index-only' | 'none',
    repoName?: string,
  ): { content: string; sourceLabel: 'none' | 'repo-focused' | 'index-only' | 'full-with-index' | 'full-blob' } {
    if (tier === 'none') return { content: '', sourceLabel: 'none' };
    const key = `${tier}|${repoName ?? '__project__'}`;

    const cached = this.cachedKbBlock.get(key);
    if (cached !== undefined) {
      // Recover the source label from the cached body. Encoded as a
      // leading sentinel comment we strip on retrieval.
      const label = (cached.match(/^<!-- anvil:kb-src:(\w[\w-]*) -->/) ?? [])[1] as
        | 'repo-focused' | 'index-only' | 'full-with-index' | 'full-blob' | undefined;
      const content = cached.replace(/^<!-- anvil:kb-src:[\w-]+ -->\n?/, '');
      return { content, sourceLabel: label ?? 'none' };
    }

    let content = '';
    let sourceLabel: 'none' | 'repo-focused' | 'index-only' | 'full-with-index' | 'full-blob' = 'none';
    const indexPrompt = this.kbManager?.getIndexForPrompt(this.config.project) || '';

    if (repoName) {
      const repoKB = this.kbManager?.getGraphReport(this.config.project, repoName) || '';
      if (tier === 'repo-focused') {
        content = repoKB ? `## YOUR TARGET REPO: ${repoName}\n\n${repoKB}` : '';
        if (content) sourceLabel = 'repo-focused';
      } else if (tier === 'index-only') {
        content = indexPrompt;
        if (content) sourceLabel = 'index-only';
      } else if (indexPrompt) {
        const queryContext = this.kbManager?.getQueryContextForPrompt(this.config.project, this.config.feature) || '';
        content = `${indexPrompt}\n\n---\n\n## YOUR TARGET REPO: ${repoName}\n\n${repoKB || '(no repo-specific KB)'}\n\n---\n\n${queryContext}`;
        sourceLabel = 'full-with-index';
      } else {
        const fullKB = this.kbManager?.getAllGraphReports(this.config.project) || '';
        if (repoKB) {
          content = `## YOUR TARGET REPO: ${repoName}\n\n${repoKB}`;
          const otherRepos = fullKB.split('\n\n---\n\n').filter((s) => !s.includes(`## ${repoName}\n`));
          if (otherRepos.length > 0) {
            content += `\n\n---\n\n## OTHER REPOS (for cross-repo context)\n\n${otherRepos.join('\n\n---\n\n')}`;
          }
        } else {
          content = fullKB;
        }
        if (content) sourceLabel = 'full-blob';
      }
    } else {
      // Project-wide (non-repo) prompt path.
      if (indexPrompt) {
        const queryContext = this.kbManager?.getQueryContextForPrompt(this.config.project, this.config.feature) || '';
        content = `${indexPrompt}\n\n---\n\n${queryContext}`;
        sourceLabel = 'full-with-index';
      } else {
        content = this.kbManager?.getAllGraphReports(this.config.project) || '';
        if (content) sourceLabel = 'full-blob';
      }
    }

    if (content) {
      this.cachedKbBlock.set(key, `<!-- anvil:kb-src:${sourceLabel} -->\n${content}`);
    }
    return { content, sourceLabel };
  }

  // ── Phase 2 manifest helpers ────────────────────────────────────────

  /**
   * Render the current feature manifest as a stable text block. Cached
   * within a stage so multiple per-repo spawns reuse the same bytes; the
   * cache is invalidated whenever the manifest is patched.
   */
  private getStableManifestBlock(): string {
    if (this.cachedManifestBlock !== null) return this.cachedManifestBlock;
    try {
      const m = this.manifestStore.read(this.config.project, this.state.featureSlug);
      this.cachedManifestBlock = renderManifestForPrompt(m);
    } catch {
      this.cachedManifestBlock = '';
    }
    return this.cachedManifestBlock;
  }

  /** Discard the cached render so the next read picks up patched fields. */
  private invalidateManifestBlock(): void {
    this.cachedManifestBlock = null;
  }

  /**
   * Pre-fill the manifest from a plan seed. Called before stage 5 (build)
   * runs so engineers see acceptance criteria, repo impact, planned files,
   * and test behaviors as `final` and don't re-derive them. Plans don't
   * always have explicit API/table sections, so those are left `unset`.
   */
  private populateManifestFromPlan(plan: import('@esankhan3/anvil-core-pipeline').Plan): void {
    const project = this.config.project;
    const slug = this.state.featureSlug;
    this.manifestStore.ensure(project, slug, this.config.feature);

    const writer = 'plan-seed';

    // Acceptance criteria — derived from the plan's in-scope list when present.
    if (plan.scope?.inScope?.length) {
      this.manifestStore.patchField(
        project, slug, 'acceptanceCriteria', 'final',
        plan.scope.inScope.slice(),
        writer,
      );
    }

    // Affected repos — directly from plan.repos[].name.
    const repoNames = (plan.repos ?? []).map((r) => r.name).filter((n): n is string => !!n);
    if (repoNames.length > 0) {
      this.manifestStore.patchField(
        project, slug, 'affectedRepos', 'final',
        repoNames,
        writer,
      );
    }

    // Files planned — flatten plan.repos[].files into PlannedFile entries.
    // Plans don't track create/modify/delete kinds, so default to 'modify'.
    const filesPlanned: PlannedFile[] = [];
    for (const repo of plan.repos ?? []) {
      for (const file of repo.files ?? []) {
        filesPlanned.push({ repo: repo.name, path: file, kind: 'modify' });
      }
    }
    if (filesPlanned.length > 0) {
      this.manifestStore.patchField(
        project, slug, 'filesPlanned', 'final',
        filesPlanned,
        writer,
      );
    }

    // Test behaviors — synthesize from plan.tests buckets.
    const testBehaviors: TestBehavior[] = [];
    for (const desc of plan.tests?.unit ?? []) testBehaviors.push({ description: desc });
    for (const desc of plan.tests?.integration ?? []) testBehaviors.push({ description: desc });
    for (const desc of plan.tests?.manual ?? []) testBehaviors.push({ description: desc });
    if (testBehaviors.length > 0) {
      this.manifestStore.patchField(
        project, slug, 'testBehaviors', 'final',
        testBehaviors,
        writer,
      );
    }

    this.invalidateManifestBlock();
  }

  /**
   * Render plan-derived artifacts for stages that the walker skipped via
   * `skipIfByStage`. Mutates `this.state.stages[i]` and writes the
   * artifact through `featureStore` — same side effects the legacy
   * runOneStage branch did, just driven by the bus listener instead
   * of the inline `if (planSeed && PLAN_DERIVED_STAGES.includes(...))`.
   *
   * Phase D1. Idempotent — calling for a stage already populated does
   * the same writes again, which the featureStore tolerates.
   */
  private async renderPlanDerivedArtifact(stageName: string, stageIndex: number): Promise<void> {
    const seed = this.config.planSeed;
    if (!seed) return;
    const { plan } = seed;
    const { renderRequirements, renderRepoRequirements, renderRepoSpecs, renderRepoTasks }
      = await import('@esankhan3/anvil-core-pipeline');

    const project = this.config.project;
    const slug = this.state.featureSlug;
    const i = stageIndex;
    if (i < 0 || !this.state.stages[i]) return;

    if (stageName === 'requirements') {
      const artifact = renderRequirements(plan);
      this.state.stages[i].status = 'skipped';
      this.state.stages[i].artifact = artifact;
      try { this.featureStore.writeArtifact(project, slug, 'REQUIREMENTS.md', artifact); } catch { /* non-fatal */ }
    } else {
      const filenameByStage: Record<string, string> = {
        'repo-requirements': 'REQUIREMENTS.md',
        specs: 'SPECS.md',
        tasks: 'TASKS.md',
      };
      const rendererByStage: Record<string, (p: typeof plan, r: string) => string> = {
        'repo-requirements': renderRepoRequirements,
        specs: renderRepoSpecs,
        tasks: renderRepoTasks,
      };
      const filename = filenameByStage[stageName];
      const renderer = rendererByStage[stageName];
      if (!filename || !renderer) return;

      const combined: string[] = [];
      this.state.stages[i].repos = this.state.repoNames.map((repoName) => {
        const artifact = renderer(plan, repoName);
        try {
          this.featureStore.writeArtifact(project, slug, `repos/${repoName}/${filename}`, artifact);
        } catch { /* non-fatal */ }
        combined.push(`## ${repoName}\n${artifact}`);
        return {
          repoName,
          agentId: null,
          status: 'completed' as const,
          cost: 0,
          artifact,
          error: null,
        };
      });

      this.state.stages[i].status = 'skipped';
      this.state.stages[i].artifact = combined.join('\n\n');
    }

    this.state.stages[i].completedAt = new Date().toISOString();
    this.broadcastState();
    this.checkpoint();
  }

  /**
   * After a stage's artifact lands, extract structured fields and patch the
   * manifest. Uses a heuristic deterministic parser today — the cheap-model
   * extraction call is wired through later phases so we avoid an extra spawn
   * per stage while still capturing the obvious wins from plan-seeded runs
   * and from artifacts that already use predictable headings.
   */
  private async extractAndUpdateManifest(stage: StageDefinition, artifact: string): Promise<void> {
    const fieldsForStage: Partial<Record<string, ManifestExtractor[]>> = {
      requirements: [extractAcceptanceCriteria, extractAffectedRepos],
      specs: [extractApiEndpoints, extractTablesTouched, extractTestBehaviors],
      tasks: [extractFilesPlanned],
      build: [extractChangeBrief],
      validate: [extractOpenQuestions],
    };
    const extractors = fieldsForStage[stage.name];
    if (!extractors || extractors.length === 0) return;

    let mutated = false;
    for (const extractor of extractors) {
      try {
        const result = extractor(artifact);
        if (!result) continue;
        this.manifestStore.patchField(
          this.config.project, this.state.featureSlug,
          result.field, result.status, result.value as never,
          stage.name,
        );
        mutated = true;
      } catch (err) {
        console.warn(`[pipeline] manifest extractor ${stage.name} failed:`, err);
      }
    }
    if (mutated) this.invalidateManifestBlock();
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

  /**
   * Resolve which model to use for a given stage.
   * Priority: factory.yaml per-stage override → tier-based dynamic routing → single model fallback.
   *
   * Tier routing resolves model IDs from the provider registry at runtime,
   * so new models are picked up automatically without code changes.
   */
  private resolveModelForStage(stageName: string): string {
    const picked = this.pickModelForStage(stageName);
    this.recordResolvedStageState(stageName, picked);
    return picked;
  }

  /**
   * Pure resolution chain — no state mutation. Extracted so the public
   * resolver can layer on the state-recording side effect for UI surfacing.
   */
  private pickModelForStage(stageName: string): string {
    // 1. factory.yaml per-stage override always wins (project-specific
    //    pinning beats every other rule).
    const yamlModels = this.projectLoader.getConfig(this.config.project)?.pipeline?.models;
    if (yamlModels?.[stageName]) return yamlModels[stageName];

    // 2. Registry-driven resolver — reads stage-policy.yaml +
    //    ~/.anvil/models.yaml and picks the cheapest model that meets
    //    the stage's capability/complexity bar. This is where local
    //    routing finally kicks in for clarify/build/etc when Ollama
    //    is up; falls through to legacy paths if the registry is
    //    missing or doesn't cover the stage.
    try {
      const resolved = registryResolveStage(stageName);
      // Phase 11 — walk the resolved chain via the liveness cache,
      // skipping models burned earlier this run (retryable upstream
      // failures). When the primary's provider is dead OR its model
      // is burned, we fall to the next live tier instead of letting
      // the adapter throw mid-stage. The cache is pre-warmed at
      // run start; the burn-set is mutated by runStageWithFallback.
      const picked = pickAliveModelFromChainSync(
        resolved,
        providerOfModelId,
        this.runtimeBurnedModels,
      );
      if (picked.fellBackFrom) {
        console.warn(
          `[pipeline] ${stageName}: ${picked.fellBackFrom} skipped; falling back to ${picked.model}`,
        );
        const key = `${stageName}|${picked.fellBackFrom}->${picked.model}`;
        if (!this.livenessFallbackNotified.has(key)) {
          this.livenessFallbackNotified.add(key);
          this.emit('project-event', {
            source: 'routing',
            message: `${picked.fellBackFrom} unavailable for ${stageName} (provider auth/liveness); falling back to ${picked.model}`,
            level: 'warn',
          });
        }
      }
      return picked.model;
    } catch (err) {
      if (err instanceof UnknownStageError) {
        // Stage not declared in policy yaml — drop to legacy paths.
      } else if (err instanceof ModelResolutionError) {
        // Policy declares it but no model satisfies — log + fall through.
        console.warn(`[pipeline] resolver: ${err.message}; falling back to legacy chain`);
      } else {
        console.warn(`[pipeline] resolver crashed:`, err);
      }
    }

    // 3. ANVIL_LOCAL_MODEL legacy override — kept for deterministic
    //    local runs that bypass the registry entirely. Stays off by
    //    default; only fires when the env var is explicitly set.
    const localModel = process.env.ANVIL_LOCAL_MODEL?.trim();
    if (localModel && LOCAL_TIER_STAGES.has(stageName)) {
      return localModel;
    }

    // 4. If no tier selected, use the single model from the UI dropdown
    const tier = this.config.modelTier;
    if (!tier) return this.config.model;

    // 5. Tier-based legacy routing — last resort
    return resolveModelByTier(tier, stageName, this.config.model);
  }

  /**
   * Per-stage tool-permission set, populated into SpawnConfig.allowedTools
   * so the agent-core LanguageModelBridge can construct a properly-scoped
   * BuiltinToolExecutor for non-Claude providers. Claude CLI uses its own
   * tool allow/deny list (driven by persona); for Claude paths this
   * supplies the same intent but is harmless when Claude ignores it.
   *
   * Resolution: stage-policy default → factory.yaml allow extends →
   * factory.yaml deny strips. Empty result falls back to read-only so a
   * misconfigured deny list can't accidentally silence the agent.
   */
  private allowedToolsForCurrentStage(stageName: string): string[] {
    const base = new Set(allowedToolsForStage(stageName));
    const overrides = this.projectLoader
      .getConfig(this.config.project)?.pipeline?.permissions?.[stageName];
    if (overrides?.allow_tools) for (const t of overrides.allow_tools) base.add(t);
    if (overrides?.deny_tools) for (const t of overrides.deny_tools) base.delete(t);
    if (base.size === 0) return ['read_file', 'grep', 'glob', 'list'];
    return [...base].sort();
  }

  /**
   * Pre-warm the provider-liveness cache so the sync resolver chain
   * walker has fresh data. Called once at pipeline start. Probes run
   * in parallel; failures are non-fatal.
   */
  protected async prefetchProviderLiveness(): Promise<void> {
    // Load the walker block from ~/.anvil/models.yaml + apply its TTL
    // override before any cache writes happen. Failures are non-fatal —
    // if the registry can't be read we keep the compiled-in defaults.
    let registry: ModelRegistry | null = null;
    try {
      registry = loadModelRegistry();
      this.walkerConfig = registry.walker;
      setLivenessTtlMs(this.walkerConfig.liveness_ttl_ms);
    } catch (err) {
      console.warn(`[pipeline] walker: registry load failed, using defaults: ${(err as Error).message}`);
      this.walkerConfig = { ...DEFAULT_WALKER_CONFIG };
    }

    // Auto-derive the prefetch list from registry providers. Falls back
    // to the canonical superset when the registry is empty so probes
    // still light up for clean installs.
    const providers = registry && registry.models.length > 0
      ? Array.from(new Set(registry.models.map((m) => m.provider)))
      : ['ollama', 'claude', 'openai', 'openrouter', 'gemini', 'gemini-cli', 'opencode', 'adk'] as ProviderName[];
    await prefetchLiveness(providers);
  }

  /**
   * Wrap a stage spawn with chain-fallback on retryable upstream
   * errors. When the inner attempt throws an UpstreamError-shape with
   * `retryable === true` (429 quota, rate-limit, 5xx), the failed
   * model is added to `runtimeBurnedModels` and the stage is retried
   * with the next chain entry. Caps at MAX_FALLBACK_ATTEMPTS so a
   * fully-broken chain surfaces quickly instead of looping forever.
   *
   * Non-retryable errors (auth, 400 bad request, the user's own
   * cancel) propagate unchanged — those need a config fix, not a
   * retry.
   */
  // runStageWithFallback removed — clarify + fix-loop now call
  // runWithChainFallback (from core-pipeline) directly with their own
  // resolver + onBurn closures.

  /**
   * Stamp the per-stage state with the resolved model + permission set
   * the moment the resolver is consulted. Called from resolveModelForStage
   * which fires once per stage entry, so the UI sees the routing
   * decision in real time.
   */
  private recordResolvedStageState(stageName: string, model: string): void {
    const stageIdx = this.state.stages.findIndex((s) => s.name === stageName);
    if (stageIdx === -1) return;
    const stage = this.state.stages[stageIdx];
    // Don't clobber an explicit override that's already been recorded
    // (e.g. by an earlier per-task call within the same stage).
    if (stage.resolvedModel && stage.resolvedModel === model) return;
    stage.resolvedModel = model;
    stage.permissionClasses = permissionClassesForStage(stageName);
    this.broadcastState();
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
      reviewNote: this.peekReviewNote() ?? undefined,
      actionType: this.config.actionType,
      repoNames: this.state.repoNames,
      featureSlug: this.state.featureSlug,
      projectYaml: this.projectYaml,
      projectInfo: this.projectInfo,
      repoPaths: this.repoPaths,
      getStableMemoryBlock: () => this.getStableMemoryBlock(),
      getStableConventionsBlock: () => this.getStableConventionsBlock(),
      getStableProjectYamlSlice: (n) => this.getStableProjectYamlSlice(n),
      getStableKbBlock: (tier, repoName) => this.getStableKbBlock(tier, repoName),
      getStableManifestBlock: () => this.getStableManifestBlock(),
      getLockedKbTier: (stage) => this.getLockedKbTier(stage as StageDefinition),
      loadRepoArtifacts: (repoName) => this.loadRepoArtifacts(repoName),
      loadHighLevelRequirements: () => this.loadHighLevelRequirements(),
      kbManager: this.kbManager,
      emit: (event, payload) => this.emit(event, payload),
    };
  }

  /** Persist pipeline state to disk for crash recovery */
  checkpoint(): void {
    try {
      const featureDir = this.featureStore.getFeatureDir(this.config.project, this.state.featureSlug);
      if (!existsSync(featureDir)) mkdirSync(featureDir, { recursive: true });

      const cp: PipelineCheckpoint = {
        version: 1,
        runId: this.state.runId,
        project: this.state.project,
        feature: this.state.feature,
        featureSlug: this.state.featureSlug,
        config: {
          model: this.config.model,
          modelTier: this.config.modelTier,
          baseBranch: this.config.baseBranch,
          skipClarify: this.config.skipClarify,
          skipShip: this.config.skipShip,
          actionType: this.config.actionType,
        },
        status: this.state.status,
        currentStage: this.state.currentStage,
        stages: this.state.stages.map((s) => ({
          name: s.name,
          label: s.label,
          status: s.status,
          cost: s.cost,
          error: s.error,
          repos: s.repos.map((r) => ({
            repoName: r.repoName,
            status: r.status,
            cost: r.cost,
            error: r.error,
          })),
        })),
        repoNames: this.state.repoNames,
        totalCost: this.state.totalCost,
        startedAt: this.state.startedAt,
        updatedAt: new Date().toISOString(),
      };

      // Atomic write
      const path = join(featureDir, 'pipeline-state.json');
      const tmp = path + '.tmp';
      writeFileSync(tmp, JSON.stringify(cp, null, 2), 'utf-8');
      renameSync(tmp, path);
    } catch (err) {
      console.warn('[pipeline] Checkpoint write failed:', err);
    }
  }

  /** Clear checkpoint (called when pipeline completes successfully) */
  private clearCheckpoint(): void {
    try {
      const featureDir = this.featureStore.getFeatureDir(this.config.project, this.state.featureSlug);
      const path = join(featureDir, 'pipeline-state.json');
      if (existsSync(path)) {
        // Don't delete — update status so it's not detected as interrupted
        const cp = JSON.parse(readFileSync(path, 'utf-8'));
        cp.status = this.state.status;
        cp.updatedAt = new Date().toISOString();
        writeFileSync(path, JSON.stringify(cp, null, 2), 'utf-8');
      }
    } catch { /* non-critical */ }
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
      await this.warmConventions().catch((err: unknown) => {
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
          this.populateManifestFromPlan(this.config.planSeed.plan);
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
        await this.renderPlanDerivedArtifact(event.stepId, stageIdx);
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

  private async setupWorkspace(): Promise<void> {
    console.log(`[pipeline] Setting up workspace for ${this.config.project}...`);

    // Load project info from factory.yaml
    try {
      this.projectInfo = await this.projectLoader.getProject(this.config.project);
      this.emit('project-event', {
        source: 'project-context',
        message: `Project config loaded: "${this.config.project}" (${this.projectInfo!.repos.length} repos)`,
      });
    } catch {
      console.warn(`[pipeline] Could not load project config for ${this.config.project}`);
      this.emit('project-event', {
        source: 'project-context',
        message: `Could not load project config for "${this.config.project}" — falling back to workspace scan`,
        level: 'warn',
      });
    }

    // Ensure workspace exists
    const wsStatus = await this.projectLoader.ensureWorkspace(this.config.project);
    if (!wsStatus.exists) {
      console.warn(`[pipeline] Workspace not ready: ${wsStatus.path}`);
    } else {
      this.emit('project-event', {
        source: 'project-context',
        message: `Workspace ready at ${wsStatus.path}`,
      });
    }

    // Resolve repo paths
    this.repoPaths = this.projectLoader.getRepoLocalPaths(this.config.project);
    const repoNames = Object.keys(this.repoPaths);

    // Use explicit repos from config, or fall back to discovered repos
    if (this.config.repos && this.config.repos.length > 0) {
      this.state.repoNames = this.config.repos.filter((r) => repoNames.includes(r));
    } else if (repoNames.length > 0) {
      this.state.repoNames = repoNames;
    }

    // Initialize per-repo state for repo stages
    for (const stage of this.state.stages) {
      if (stage.perRepo) {
        stage.repos = this.state.repoNames.map((name) => ({
          repoName: name,
          agentId: null,
          status: 'pending',
          cost: 0,
          artifact: '',
          error: null,
        }));
      }
    }

    // Pull latest main branch for each repo so we start from up-to-date code
    await this.pullLatestMain();

    this.broadcastState();
    this.checkpoint(); // Save repos + workspace info
    console.log(`[pipeline] Workspace ready. Repos: ${this.state.repoNames.join(', ') || '(none — will use project root)'}`);
  }

  /** Get the resolved base branch name */
  private getBaseBranch(): string {
    return this.config.baseBranch || 'main';
  }

  /**
   * Checkout and pull the latest base branch for each repo before starting the pipeline.
   * Uses config.baseBranch, then tries main, then master as fallback.
   */
  private async pullLatestMain(): Promise<void> {
    await pullBaseBranchForRepos({
      baseBranch: this.config.baseBranch,
      repoPaths: this.repoPaths,
      repoNames: this.state.repoNames,
      workspaceDir: this.workspaceDir,
      onLog: (level, message) => {
        if (level === 'info') console.log(`[pipeline] ${message}`);
        else console.warn(`[pipeline] ${message}`);
      },
    });
  }

  // ── One-stage dispatcher ─────────────────────────────────────────
  //
  // Encodes the body of the legacy for-loop iteration as a single async
  // method. Returns a control-flow flag so the caller can map it to
  // `continue` / `break` / early-return / rewind. After verification,
  // this method is the slot driven by `Pipeline.run()` over an
  // `InMemoryStepRegistry` (each Step's `run()` calls this).
  private async runOneStage(
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
    if (this.cancelled) return { control: 'cancelled', prevArtifact };
    const stage = STAGES[i];

    try {
      // Skip completed stages when resuming
      if (isResume && i < resumeStage) {
        this.state.stages[i].status = 'completed';
        this.state.stages[i].completedAt = new Date().toISOString();
        const storedArtifact = this.loadStageArtifact(stage);
        this.state.stages[i].artifact = storedArtifact;
        this.broadcastState();
        this.checkpoint();
        return { control: 'continue', prevArtifact };
      }

      // Skip stages if configured
      if (stage.name === 'clarify' && this.config.skipClarify) {
        const seed = this.config.clarifySeedArtifact ?? 'Clarification skipped.';
        this.state.stages[i].status = 'skipped';
        this.state.stages[i].artifact = seed;
        prevArtifact = seed;
        if (this.config.clarifySeedArtifact) {
          try {
            this.featureStore.writeArtifact(
              this.config.project,
              this.state.featureSlug,
              'CLARIFICATION.md',
              this.config.clarifySeedArtifact,
            );
          } catch { /* not fatal */ }
        }
        this.broadcastState();
        this.checkpoint();
        return { control: 'continue', prevArtifact };
      }
      if (stage.name === 'ship' && this.config.skipShip) {
        this.state.stages[i].status = 'skipped';
        this.broadcastState();
        this.checkpoint();
        return { control: 'continue', prevArtifact };
      }

      // Plan-seed skip: stages 1–4 derive deterministically from the
      // plan. Phase D1 — the rendering side-effects (artifact write,
      // state mutation, broadcast, checkpoint) live in a step:skipped
      // listener wired in `run()`. The skipIfByStage map activates
      // the walker-driven skip so this branch is unreachable when a
      // planSeed is present; we keep a guard log here as a tripwire.
      if (this.config.planSeed && PLAN_DERIVED_STAGES.includes(stage.name)) {
        console.warn(
          `[pipeline] runOneStage(${stage.name}) reached with planSeed — `
            + `skipIf path should have fired earlier. Falling through to `
            + `legacy renderer for safety.`,
        );
        await this.renderPlanDerivedArtifact(stage.name, i);
        prevArtifact = this.state.stages[i].artifact ?? prevArtifact;
        return { control: 'continue', prevArtifact };
      }

      // Test-gen stage
      if (stage.name === 'test') {
        if (!this.config.planSeed) {
          this.state.stages[i].status = 'skipped';
          this.state.stages[i].artifact = 'Test stage skipped (no plan seed).';
          prevArtifact = this.state.stages[i].artifact;
          this.state.stages[i].completedAt = new Date().toISOString();
          this.broadcastState();
          this.checkpoint();
          return { control: 'continue', prevArtifact };
        }
        try {
          const artifact = await this.runTestGenStage(i);
          this.state.stages[i].status = 'completed';
          this.state.stages[i].artifact = artifact;
          this.state.stages[i].completedAt = new Date().toISOString();
          prevArtifact = artifact;
          this.broadcastState();
          this.checkpoint();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn('[pipeline] test-gen failed, continuing to validate:', msg);
          this.state.stages[i].status = 'skipped';
          this.state.stages[i].artifact = `Test stage skipped (${msg}).`;
          this.state.stages[i].completedAt = new Date().toISOString();
          this.broadcastState();
          this.checkpoint();
        }
        return { control: 'continue', prevArtifact };
      }

      console.log(`[pipeline] Entering stage "${stage.name}" (${i + 1}/${STAGES.length})`);

      this.armReviewNoteForCurrentStage();
      await this.ensureAuth(stage.name);

      if (stage.name === 'build') {
        this.createFeatureBranches();
      }
      if (stage.name === 'validate') {
        this.runPostBuildGuards();
      }

      this.state.currentStage = i;
      this.state.stages[i].status = 'running';
      this.state.stages[i].startedAt = new Date().toISOString();
      this.broadcastState();
      this.checkpoint();
      this.emit('stage-start', i, '');

      try {
        let result: { artifact: string; cost: number; tokens: StageTokenStats };

        if (stage.name === 'clarify') {
          result = await this.runClarifyStage(i);
        } else if (stage.perRepo && this.state.repoNames.length > 0) {
          result = await this.runPerRepoStage(i, stage, prevArtifact);
        } else {
          result = await this.runSingleStage(i, stage, prevArtifact);
        }

        if (this.cancelled) return { control: 'cancelled', prevArtifact };

        this.state.stages[i].status = 'completed';
        this.state.stages[i].completedAt = new Date().toISOString();
        this.state.stages[i].artifact = result.artifact;
        this.state.stages[i].cost = result.cost;
        this.state.stages[i].tokens = result.tokens;
        this.state.totalCost += result.cost;
        this.aggregateRunTokens(result.tokens);
        this.logCacheTelemetry(stage.name, result.tokens);
        prevArtifact = result.artifact;
        this.broadcastState();
        this.checkpoint();
        this.emit('stage-complete', i, result.artifact, result.cost);

        if (this.afterStageHook) {
          try {
            const risk = this.getPlanRisk();
            await this.afterStageHook({
              runId: this.state.runId,
              project: this.config.project,
              stageIndex: i,
              stageName: stage.name,
              artifact: result.artifact,
              cost: result.cost,
              totalCost: this.state.totalCost,
              touchedFiles: this.getTouchedFiles(),
              riskTier: risk.tier,
              confidence: risk.confidence,
            });
            if (this.cancelled) return { control: 'cancelled', prevArtifact };
          } catch (err) {
            console.warn(`[pipeline] after-stage hook rejected at ${stage.name}:`, err);
            this.cancelled = true;
            return { control: 'cancelled', prevArtifact };
          }
        }

        // Reviewer rerun-from / iterate handling.
        const rerun = this.consumeRerunRequest();
        if (rerun !== null) {
          const target = rerun.targetIndex;
          if (rerun.mode === 'iterate') {
            this.resetStagesForRerun(target, target);
            if (rerun.note) this.setReviewNote(rerun.note);
            console.log(`[pipeline] Iterate requested → re-running stage ${target} (${STAGES[target].name}) with reviewer feedback`);
          } else {
            this.resetStagesForRerun(target, i);
            this.clearManifestFieldsForStages(target, i);
            if (rerun.note) {
              this.config.failureContext =
                `Rerun requested by reviewer at stage "${STAGES[target].name}":\n${rerun.note}`;
            }
            console.log(`[pipeline] Rerun-from requested → resetting to stage ${target} (${STAGES[target].name})`);
          }
          prevArtifact = target > 0
            ? (this.state.stages[target - 1]?.artifact ?? '')
            : '';
          this.broadcastState();
          this.checkpoint();
          return { control: 'rewind', rewindTo: target, prevArtifact };
        }

        const edited = this.consumeArtifactOverride();
        if (edited !== null) {
          prevArtifact = edited;
        } else {
          this.writeStageArtifact(i, stage, result.artifact);
        }

        try {
          await this.extractAndUpdateManifest(stage, result.artifact);
        } catch (err) {
          console.warn(`[pipeline] manifest extraction at ${stage.name} failed:`, err);
        }

        if (stage.name === 'build' && this.config.planSeed && !this.cancelled) {
          try {
            const { captureDeviation, updateLearnings } = await import('./plan-deviation.js');
            const featureDir = this.featureStore.getFeatureDir(this.config.project, this.state.featureSlug);
            const repoLocalPaths: Record<string, string> = {};
            for (const r of this.state.repoNames) repoLocalPaths[r] = this.repoPaths[r] ?? '';
            const deviation = captureDeviation(this.config.planSeed.plan, {
              featureDir,
              repoLocalPaths,
              baseBranch: this.config.baseBranch ?? 'main',
              branch: `anvil/${this.state.featureSlug}`,
            });
            const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME
              || (await import('node:os')).homedir() + '/.anvil';
            updateLearnings(
              anvilHome,
              this.config.project,
              deviation,
              this.state.totalCost,
              this.config.planSeed.plan.estimate.usd,
            );
            this.emit('artifact-written', {
              stage: 'build',
              file: `${featureDir}/plan-deviation.json`,
              summary: `Plan match rate: ${(deviation.summary.matchRate * 100).toFixed(0)}%`,
              content: JSON.stringify(deviation, null, 2),
            });
          } catch (err) {
            console.warn('[pipeline] Plan deviation capture failed:', err);
          }
        }

        if (stage.name === 'ship' && this.config.deploy && !this.cancelled) {
          this.deployToRemote();
        }

        if (stage.name === 'requirements' && this.state.repoNames.length === 0) {
          this.detectRepos(result.artifact);
        }

        if (stage.name === 'validate' && !this.cancelled) {
          let validateArtifact = result.artifact;
          let fixAttempts = 0;
          const MAX_FIX_ATTEMPTS = 3;

          while (fixAttempts < MAX_FIX_ATTEMPTS && this.hasValidationFailures(validateArtifact)) {
            fixAttempts++;
            console.log(`[pipeline] Validation failed — fix attempt ${fixAttempts}/${MAX_FIX_ATTEMPTS}`);

            const fixResult = await this.runFixLoop(i, validateArtifact, fixAttempts);
            this.state.totalCost += fixResult.cost;
            this.aggregateRunTokens(fixResult.tokens);
            this.logCacheTelemetry(`${stage.name}:fix-${fixAttempts}`, fixResult.tokens);

            if (this.cancelled) return { control: 'cancelled', prevArtifact };

            const revalidateResult = await this.runPerRepoStage(i, stage, fixResult.artifact);
            validateArtifact = revalidateResult.artifact;
            this.state.stages[i].artifact = validateArtifact;
            this.state.stages[i].cost += revalidateResult.cost;
            this.state.totalCost += revalidateResult.cost;
            this.aggregateRunTokens(revalidateResult.tokens);
            this.logCacheTelemetry(`${stage.name}:revalidate-${fixAttempts}`, revalidateResult.tokens);
            this.broadcastState();

            this.writeStageArtifact(i, stage, validateArtifact);
          }

          if (this.hasValidationFailures(validateArtifact)) {
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
        this.state.stages[i].status = 'failed';
        this.state.stages[i].completedAt = new Date().toISOString();
        this.state.stages[i].error = errorMsg;
        this.state.status = 'failed';
        this.broadcastState();
        this.checkpoint();
        this.emit('stage-fail', i, errorMsg);
        this.emit('pipeline-fail', this.state);
        this.featureStore.updateFeature(this.config.project, this.state.featureSlug, {
          status: 'failed',
        });
        return { control: 'fail-early-return', prevArtifact };
      }
    } finally {
      this.clearStageReviewNote();
    }
  }

  // ── Interactive Clarify (one question at a time) ─────────────────

  private async runClarifyStage(index: number): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
    // Build a per-stage AgentManagerSession so explore + synthesize share
    // the same multi-turn agent. Chain-fallback semantics aren't yet
    // expressed in the session interface (the model is locked at
    // `start()`); the runStageWithFallback wrapper still drives the
    // outer retry loop for transient explore-phase failures.
    const session = this.makeAgentSession();
    const result = await runWithChainFallback(
      {
        stageName: 'clarify',
        maxAttempts: this.walkerConfig.max_attempts,
        resolveModel: () => this.resolveModelForStage('clarify'),
        onBurn: ({ model, status }) => {
          this.runtimeBurnedModels.add(model);
          console.warn(`[pipeline] clarify: ${model} hit ${status} (retryable); burning + falling back`);
          this.emit('project-event', {
            source: 'routing',
            message: `${model} unavailable (HTTP ${status}); falling back to next chain entry`,
            level: 'warn',
          });
        },
      },
      (model) => runClarifyForProject({
      agentSession: session,
      project: this.config.project,
      workspaceDir: this.workspaceDir,
      model,
      allowedTools: this.allowedToolsForCurrentStage('clarify'),
      maxOutputTokens: maxOutputTokensForStage('clarify'),
      explorePrompt: this.buildClarifyExplorePrompt(),
      projectPrompt: this.buildProjectPrompt(STAGES[0]),
      isCancelled: () => this.cancelled,
      onAgentSpawned: (agentId) => {
        this.state.stages[index].agentId = agentId;
        this.broadcastState();
        this.emit('stage-start', index, agentId);
        this.emit('project-event', {
          source: 'pipeline',
          stage: 'clarify',
          message: `[clarify] clarifier agent spawned (model: ${model}) — awaiting first response…`,
        });
      },
      onTruncation: (agentName, outputTokens) => {
        this.handleOutputTruncation(agentName, outputTokens);
      },
      onClarifyQuestion: (questionIndex, totalQuestions, question) => {
        this.emit('clarify-question', {
          stageIndex: index,
          questionIndex,
          totalQuestions,
          question,
        });
      },
      onWaitingForInput: (agentId) => {
        this.state.stages[index].status = 'waiting';
        this.state.status = 'waiting';
        this.state.waitingForInput = true;
        this.broadcastState();
        this.emit('waiting-for-input', index, agentId);
      },
      onAnswerReceived: (answer) => {
        this.emit('user-input', { stageIndex: index, text: answer });
        this.state.waitingForInput = false;
        this.broadcastState();
      },
      onClarifyAck: (questionIndex, totalQuestions, hasMore) => {
        this.emit('clarify-ack', {
          stageIndex: index,
          questionIndex,
          totalQuestions,
          hasMore,
        });
      },
      onSynthesizeStart: () => {
        this.state.stages[index].status = 'running';
        this.state.status = 'running';
        this.state.waitingForInput = false;
        this.broadcastState();
      },
      inputResolver: () => new Promise<string>((resolve) => {
        this.inputResolve = resolve;
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

  private async runPerRepoStage(
    index: number,
    stage: StageDefinition,
    prevArtifact: string,
  ): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
    const repos = this.state.repoNames;

    if (repos.length === 0) {
      // Fallback to single-agent mode
      return this.runSingleStage(index, stage, prevArtifact);
    }

    // Spawn agents for all repos in parallel
    const promises: Promise<{
      repoName: string;
      artifact: string;
      cost: number;
      tokens: StageTokenStats;
    }>[] = [];

    for (let r = 0; r < repos.length; r++) {
      const repoName = repos[r];
      const repoPath = this.repoPaths[repoName] || join(this.workspaceDir, repoName);
      const repoIdx = r;

      // Mark repo as running
      if (this.state.stages[index].repos[r]) {
        this.state.stages[index].repos[r].status = 'running';
      }

      const projectPrompt = this.buildRepoProjectPrompt(stage, repoName);

      // ── Build stage: per-task spawning (P5) ──
      // When the engineer's repo has parseable TASKS.md, spawn one engineer per task
      // (in dependency-aware groups) instead of one engineer for the whole repo.
      // Each per-task spawn shares the same stable system prompt, which lets the
      // Claude CLI prompt cache hit across spawns.
      if (stage.name === 'build' && stage.persona === 'engineer') {
        promises.push(
          this.runBuildForRepo(index, repoIdx, stage, repoName, repoPath, projectPrompt)
            .then((res) => ({
              repoName,
              artifact: res.artifact,
              cost: res.cost,
              tokens: res.tokens,
            }))
            .catch((err) => {
              const errorMsg = err instanceof Error ? err.message : String(err);
              const repoState = this.state.stages[index].repos[repoIdx];
              if (repoState) {
                repoState.status = 'failed';
                repoState.error = errorMsg;
              }
              this.broadcastState();
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

      const prompt = this.buildRepoStagePrompt(stage, repoName, prevArtifact);

      // Delegate to the canonical AgentManagerRunner — it owns chain-
      // fallback, cancel, on-spawn telemetry, and onBurn surfacing. The
      // empty-artifact retry stays here because it's per-repo / per-call.
      const runner = this.makeAgentRunner(stage.name);
      promises.push(
        (async () => {
          let result;
          try {
            // Wrap the runner.run in our own retry layer so an empty
            // artifact (returned as success by the adapter when
            // claude-cli silent-emptied) triggers chain-fallback through
            // the runner's already-installed mechanism.
            const runOnce = async () => {
              const r = await runner.run({
                persona: stage.persona,
                projectPrompt,
                userPrompt: prompt,
                workingDir: repoPath,
                stage: stage.name,
                allowedTools: this.allowedToolsForCurrentStage(stage.name),
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
            const repoState = this.state.stages[index].repos[repoIdx];
            if (repoState) {
              repoState.status = 'failed';
              repoState.error = errorMsg;
            }
            this.broadcastState();
            return {
              repoName,
              artifact: '',
              cost: 0,
              tokens: zeroTokenStats(),
            };
          }

          // Mark repo as completed
          const repoState = this.state.stages[index].repos[repoIdx];
          if (repoState) {
            repoState.status = 'completed';
            repoState.cost = result.costUsd ?? 0;
            repoState.artifact = result.output;
          }
          this.broadcastState();
          this.checkpoint();

          this.writeRepoArtifact(stage, repoName, result.output);

          this.writePerRepoTelemetry(stage.name, repoName, {
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

    // Wait for all repos to complete
    const results = await Promise.all(promises);
    const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
    const tokens = sumTokenStats(results.map((r) => r.tokens));
    const successResults = results.filter((r) => r.artifact);
    const failedRepos = results.filter((r) => !r.artifact).map((r) => r.repoName);

    // Combine artifacts (legacy "## <repo>\n\n<artifact>" separator format).
    const combined = combinePerRepoArtifacts(successResults);

    // Per-repo stages are atomic: every repo must produce an artifact
    // before we advance. Previously this only threw when EVERY repo
    // failed (legacy partial-success behavior); a single-repo failure
    // would silently advance with the surviving repo's output, and the
    // next stage would run with missing context. The user observed
    // this directly — "frontend is not checked still moved to next
    // step". Fail-fast here so the dashboard surfaces the failure on
    // the failing repo's tile and the pipeline halts for retry.
    if (failedRepos.length > 0) {
      throw new Error(
        `Per-repo stage "${stage.name}" failed on ${failedRepos.length} of ${repos.length} repo(s): ${failedRepos.join(', ')}. ` +
        `Stage cannot advance — retry the run or rerun this stage after fixing the underlying error.`,
      );
    }

    return { artifact: combined, cost: totalCost, tokens };
  }

  // ── Build stage: per-task spawning ─────────────────────────────────

  /**
   * Run the build stage for one repo by spawning one engineer per task,
   * grouped into parallel batches by `groupTasksForExecution`.
   *
   * Falls back to a single repo-wide spawn when TASKS.md isn't parseable.
   * The fallback path keeps Read/Grep/Glob/Agent disabled (P1) so behaviour
   * matches the prior bundle-per-repo flow.
   */
  private async runBuildForRepo(
    stageIndex: number,
    repoIdx: number,
    stage: StageDefinition,
    repoName: string,
    repoPath: string,
    projectPrompt: string,
  ): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
    const repoArtifacts = this.loadRepoArtifacts(repoName);

    // Per-task spawns flow through AgentManagerRunner — chain-fallback,
    // empty-throw retry, and on-spawn telemetry are baked in.
    const runner = this.makeAgentRunner(stage.name);
    const result = await runBuildForOneRepo({
      runner,
      project: this.config.project,
      stageName: stage.name,
      persona: stage.persona,
      allowedTools: this.allowedToolsForCurrentStage(stage.name),
      maxOutputTokens: maxOutputTokensForStage(stage.name),
      repoName,
      repoPath,
      projectPrompt,
      tasksMarkdown: repoArtifacts.tasks,
      buildPerTaskPrompt: (task) =>
        this.buildPerTaskPrompt(stage, repoName, repoPath, task, repoArtifacts.specs),
      buildFallbackPrompt: () => this.buildRepoStagePrompt(stage, repoName, ''),
      isCancelled: () => this.cancelled,
      onProjectEvent: (level, message) => {
        this.emit('project-event', { source: 'pipeline', message, level });
      },
    });

    const repoStateDone = this.state.stages[stageIndex].repos[repoIdx];
    if (repoStateDone) {
      repoStateDone.status = 'completed';
      repoStateDone.cost = result.cost;
      repoStateDone.artifact = result.artifact;
    }
    this.broadcastState();
    this.checkpoint();
    this.writeRepoArtifact(stage, repoName, result.artifact);

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

  /**
   * Build the user prompt for ONE task: the task's own markdown block, the
   * spec sections it references, and the files it touches pre-bundled.
   */
  private buildPerTaskPrompt(
    _stage: StageDefinition,
    repoName: string,
    repoPath: string,
    task: ParsedTask,
    specsMd: string,
  ): string {
    return buildPerTaskPromptHelper(this.getPromptContext(), repoName, repoPath, task, specsMd);
  }

  // ── Single-agent stage execution ───────────────────────────────────

  private async runSingleStage(
    index: number,
    stage: StageDefinition,
    prevArtifact: string,
  ): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
    const prompt = this.buildStagePrompt(stage, prevArtifact);
    const projectPrompt = this.buildProjectPrompt(stage);

    // Delegate to the canonical AgentManagerRunner — same chain-fallback
    // semantics as before, just routed through the unified AgentRunner
    // surface so the same code path drives single-stage runs in both cli
    // (after R7 wires up its own runner) and dashboard.
    const runner = this.makeAgentRunner(stage.name);
    const result = await runner.run({
      persona: stage.persona,
      projectPrompt,
      userPrompt: prompt,
      workingDir: this.workspaceDir,
      stage: stage.name,
      allowedTools: this.allowedToolsForCurrentStage(stage.name),
      disallowedTools: disallowedToolsForPersona(stage.persona),
      maxOutputTokens: maxOutputTokensForStage(stage.name),
    });

    // Stamp the agentId on the stage record so the dashboard surface
    // links the activity feed back to this stage.
    if (result.agentId) {
      this.state.stages[index].agentId = result.agentId;
      this.broadcastState();
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

  /**
   * Construct an AgentManagerSession for stages that need multi-turn
   * agent semantics (clarify's explore→Q&A→synthesize, fix-loop). The
   * resolver picks the model on the initial `start()` call; subsequent
   * `sendInput` calls re-spawn an adapter against the same session id.
   */
  private makeAgentSession(): AgentManagerSession {
    return new AgentManagerSession({
      agentManager: this.agentManager,
      project: this.config.project,
      workspaceDir: this.workspaceDir,
      isCancelled: () => this.cancelled,
      resolveModel: (stageName) => this.resolveModelForStage(stageName),
      onTruncation: (agentName, outputTokens) => {
        this.handleOutputTruncation(agentName, outputTokens);
      },
    });
  }

  /**
   * Construct an AgentManagerRunner scoped to one stage. Threads the
   * dashboard's chain-fallback resolver, cancellation, on-spawn telemetry,
   * and truncation callback into the canonical runner shape.
   */
  private makeAgentRunner(stageName: string): AgentManagerRunner {
    return new AgentManagerRunner({
      agentManager: this.agentManager,
      project: this.config.project,
      workspaceDir: this.workspaceDir,
      isCancelled: () => this.cancelled,
      resolveModel: () => this.resolveModelForStage(stageName),
      burnedModels: this.runtimeBurnedModels,
      maxAttempts: this.walkerConfig.max_attempts,
      onSpawn: (agentId, req) => {
        // Find the stage by name + repo (when per-repo) and stamp agentId.
        const stageIdx = this.state.stages.findIndex((s) => s.name === stageName);
        if (stageIdx !== -1) {
          if (req.repoName) {
            const repo = this.state.stages[stageIdx].repos.find((r) => r.repoName === req.repoName);
            if (repo) repo.agentId = agentId;
          } else {
            this.state.stages[stageIdx].agentId = agentId;
            this.emit('stage-start', stageIdx, agentId);
          }
          this.broadcastState();
        }
        const tag = req.repoName ? `${stageName}/${req.repoName}` : stageName;
        this.emit('project-event', {
          source: 'pipeline',
          stage: stageName,
          message: `[${tag}] ${req.persona} agent spawned — awaiting first response…`,
        });
      },
      onTruncation: (agentName, outputTokens) => {
        this.handleOutputTruncation(agentName, outputTokens);
      },
      onBurn: ({ model, status }) => {
        this.runtimeBurnedModels.add(model);
        this.emit('project-event', {
          source: 'routing',
          message: `${model} unavailable (HTTP ${status}); falling back to next chain entry`,
          level: 'warn',
        });
      },
    });
  }

  // ── Auth helper ──────────────────────────────────────────────────────

  /**
   * Ensure Claude CLI auth is valid before spawning agents for a stage.
   * If the token has expired:
   *   1. Checkpoints current state so the pipeline is resumable
   *   2. Pauses the pipeline with a 'waiting-auth' status
   *   3. Sends a browser notification to alert the user
   *   4. Opens the login flow automatically
   *   5. Polls until auth succeeds, then resumes
   */
  private async ensureAuth(stageName: string): Promise<void> {
    // Only relevant for Claude CLI models
    const model = this.resolveModelForStage(stageName);
    if (!model.startsWith('claude-') && model !== 'claude') return;

    if (checkClaudeAuth()) return; // Still valid

    console.warn(`[pipeline] Auth expired before "${stageName}" — pausing for re-login...`);

    // Checkpoint so the pipeline can be resumed even if the server restarts
    this.checkpoint();

    // Update pipeline state to reflect auth-waiting status
    this.state.status = 'waiting';
    this.state.waitingForInput = true;
    this.broadcastState();

    // Emit events — dashboard-server will broadcast to frontend for notification
    this.emit('auth-required', {
      stageName,
      message: `Authentication expired before "${stageName}" stage. Opening browser for re-login — pipeline will resume automatically.`,
    });

    this.emit('project-event', {
      source: 'auth',
      message: `Authentication expired — opening browser for re-login. Pipeline will resume automatically once logged in.`,
      level: 'warn',
    });

    // Auto-open the login flow and poll until it succeeds
    const ok = await refreshClaudeAuth(600_000); // 10 min timeout

    if (!ok) {
      // Checkpoint as failed so user can resume later
      this.state.status = 'failed';
      this.state.waitingForInput = false;
      this.broadcastState();
      this.checkpoint();
      throw new Error(
        `Authentication expired and automatic re-login timed out after 10 minutes. ` +
        `Run "claude auth login" manually, then resume the pipeline from the "${stageName}" stage.`
      );
    }

    // Auth restored — resume pipeline
    console.log(`[pipeline] Re-authentication successful — resuming "${stageName}"`);
    this.state.status = 'running';
    this.state.waitingForInput = false;
    this.broadcastState();

    this.emit('project-event', {
      source: 'auth',
      message: `Re-authentication successful — resuming pipeline.`,
    });
  }

  /**
   * Phase 3 — Output-truncation telemetry hook. Called when an agent's
   * stop_reason indicates the max-tokens ceiling was reached. Surfaces a
   * warning so users can raise the per-stage limit in STAGE_OUTPUT_LIMITS
   * if a stage repeatedly hits its cap. No-op when no stopReason is set.
   */
  /**
   * Persist per-repo agent stats next to the run record so silent-empty
   * artifacts (status: 'completed', cost: 0, error: null) leave a
   * forensic trail. File format is JSONL — appended once per repo per
   * stage. Failures are non-fatal so a write hiccup never breaks a run.
   */
  private writePerRepoTelemetry(
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
  ): void {
    // Delegates to the canonical writer in core-pipeline. The on-record
    // callback turns the JSONL line into a project-event so the dashboard
    // activity log surfaces silent-empty failures without grepping disk.
    writePerRepoTelemetryShared(
      {
        runId: this.state.runId,
        onRecord: (record) => {
          this.emit('project-event', {
            source: 'pipeline',
            message: formatTelemetrySummary(record),
          });
        },
      },
      { stage: stageName, repo: repoName, ...stats },
    );
  }

  private handleOutputTruncation(agentName: string, outputTokens: number): void {
    const message = `[pipeline] Output truncated for ${agentName} at ${outputTokens} tokens (max_tokens reached). Consider raising STAGE_OUTPUT_LIMITS.`;
    if (process.env.ANVIL_LOG_OUTPUT_TRUNCATIONS === '1') {
      console.warn(message);
    }
    try {
      this.emit('project-event', {
        source: 'pipeline',
        message,
      });
    } catch {
      /* defensive — emit must never break the run */
    }
  }

  // ── Token / cache telemetry (Phase 1 of TOKEN-OPTIMIZATION-PLAN) ──────

  /**
   * Roll a single stage's token totals into the run-level aggregate. The
   * cache-hit ratio is computed against the BILLABLE side (input tokens
   * sent fresh + cache reads) — output and cache writes are excluded since
   * they don't represent prompt-cache opportunities.
   */
  private aggregateRunTokens(t: StageTokenStats): void {
    const prev = this.state.tokens ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitRatio: 0,
    };
    const inputTokens = prev.inputTokens + t.inputTokens;
    const outputTokens = prev.outputTokens + t.outputTokens;
    const cacheReadTokens = prev.cacheReadTokens + t.cacheReadTokens;
    const cacheWriteTokens = prev.cacheWriteTokens + t.cacheWriteTokens;
    const denom = inputTokens + cacheReadTokens;
    this.state.tokens = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheHitRatio: denom > 0 ? cacheReadTokens / denom : 0,
    };
  }

  /**
   * Log the cache-hit ratio for one stage. The denominator is the billable
   * input side (input + cache reads); cache writes pay one full price the
   * first call and amortise for `cacheTtlSeconds` after, so we surface
   * them but don't include them in the ratio.
   */
  private logCacheTelemetry(stageName: string, t: StageTokenStats): void {
    const denom = t.inputTokens + t.cacheReadTokens;
    const ratio = denom > 0 ? t.cacheReadTokens / denom : 0;
    const pct = (ratio * 100).toFixed(1);
    console.log(
      `[cache] stage=${stageName} hit=${t.cacheReadTokens}/${denom} (${pct}%)`
      + ` write=${t.cacheWriteTokens} input=${t.inputTokens} output=${t.outputTokens}`,
    );
    try {
      this.emit('project-event', {
        source: 'cache',
        message: `Stage "${stageName}" cache hit ${pct}% (${t.cacheReadTokens.toLocaleString()} of ${denom.toLocaleString()} input-side tokens served from cache)`,
      });
    } catch { /* defensive */ }
  }

  // ── Validate-fix helpers ────────────────────────────────────────────

  /** Check if validation artifact indicates failures */
  private hasValidationFailures(artifact: string): boolean {
    return hasValidationFailuresHelper(artifact);
  }

  /**
   * Deterministic test-generation stage: fingerprint per repo → extract behaviors
   * from plan → ground → emit test cases → write to repos → persist TestSpec +
   * TestCase artifacts. No LLM calls in Phase 1; validate runs whatever lands.
   */
  private async runTestGenStage(stageIndex: number): Promise<string> {
    const repoNames = this.state.repoNames.length
      ? this.state.repoNames
      : Object.keys(this.repoPaths);
    const repoLocalPaths: Record<string, string> = {};
    for (const r of repoNames) repoLocalPaths[r] = this.repoPaths[r] ?? join(this.workspaceDir, r);

    return runTestGenForProject({
      planSeed: this.config.planSeed ?? null,
      project: this.config.project,
      model: this.config.model,
      workspaceDir: this.workspaceDir,
      repoLocalPaths,
      onConventionsDetected: (artifact) => {
        this.state.stages[stageIndex].artifact = artifact;
      },
      onArtifactWritten: (event) => {
        this.emit('artifact-written', event);
      },
    });
  }

  /** Run engineer agents to fix validation issues, then return */
  /** Per-repo agent ids carried across fix-loop attempts so attempt 2+ resumes the prior session (P9). */
  private fixLoopAgentByRepo: Map<string, string> = new Map();
  private fixLoopAgentSingle: string | null = null;

  private async runFixLoop(
    _validateStageIndex: number,
    validateArtifact: string,
    attempt: number,
  ): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
    const buildStage = STAGES.find((s) => s.name === 'build')!;
    const repoPaths: Record<string, string> = {};
    for (const repoName of this.state.repoNames) {
      repoPaths[repoName] = this.repoPaths[repoName] || join(this.workspaceDir, repoName);
    }
    const session = this.makeAgentSession();
    const result = await runWithChainFallback(
      {
        stageName: 'fix-loop',
        maxAttempts: this.walkerConfig.max_attempts,
        resolveModel: () => this.resolveModelForStage('fix-loop'),
        onBurn: ({ model, status }) => {
          this.runtimeBurnedModels.add(model);
          console.warn(`[pipeline] fix-loop: ${model} hit ${status} (retryable); burning + falling back`);
          this.emit('project-event', {
            source: 'routing',
            message: `${model} unavailable (HTTP ${status}); falling back to next chain entry`,
            level: 'warn',
          });
        },
      },
      (model) => runFixLoop({
        agentSession: session,
        project: this.config.project,
        model,
        allowedTools: this.allowedToolsForCurrentStage('fix-loop'),
        maxOutputTokens: maxOutputTokensForStage('build'),
        workspaceDir: this.workspaceDir,
        repoNames: this.state.repoNames,
        repoPaths,
        validateArtifact,
        attempt,
        priorByRepo: this.fixLoopAgentByRepo,
        priorSingleId: this.fixLoopAgentSingle,
        buildProjectPromptForBuildStage: () => this.buildProjectPrompt(buildStage),
        buildRepoProjectPromptForBuildStage: (repoName: string) =>
          this.buildRepoProjectPrompt(buildStage, repoName),
        isCancelled: () => this.cancelled,
      }),
    );
    if (result.newSingleId !== null) {
      this.fixLoopAgentSingle = result.newSingleId;
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

  // ── Artifact loading (for resume) ──────────────────────────────────

  /** Load all prior stage artifacts to build context for resume */
  private loadPriorArtifacts(_upToStage: number): string {
    const project = this.config.project;
    const slug = this.state.featureSlug;
    const parts: string[] = [];

    // Load main artifacts
    const mainArtifacts = ['CLARIFICATION.md', 'REQUIREMENTS.md'];
    for (const file of mainArtifacts) {
      const content = this.featureStore.readArtifact(project, slug, file);
      if (content) parts.push(`## ${file}\n${content}`);
    }

    // Load per-repo artifacts
    for (const repoName of this.state.repoNames) {
      const repoArtifacts = ['REQUIREMENTS.md', 'SPECS.md', 'TASKS.md', 'BUILD.md', 'VALIDATE.md'];
      for (const file of repoArtifacts) {
        const content = this.featureStore.readArtifact(project, slug, `repos/${repoName}/${file}`);
        if (content) parts.push(`## ${repoName}/${file}\n${content}`);
      }
    }

    // Add failure context if available
    if (this.config.failureContext) {
      parts.push(`## Previous Failure\n${this.config.failureContext}`);
    }

    return parts.join('\n\n---\n\n');
  }

  /** Load a single stage's artifact from the feature store */
  private loadStageArtifact(stage: StageDefinition): string {
    const project = this.config.project;
    const slug = this.state.featureSlug;

    const mainArtifactMap: Record<string, string> = {
      clarify: 'CLARIFICATION.md',
      requirements: 'REQUIREMENTS.md',
      ship: 'SHIP.md',
    };

    const repoArtifactMap: Record<string, string> = {
      'repo-requirements': 'REQUIREMENTS.md',
      specs: 'SPECS.md',
      tasks: 'TASKS.md',
      build: 'BUILD.md',
      validate: 'VALIDATE.md',
    };

    // Try main artifact
    const mainFile = mainArtifactMap[stage.name];
    if (mainFile) {
      return this.featureStore.readArtifact(project, slug, mainFile) ?? '';
    }

    // Try per-repo artifacts (combine all repos)
    const repoFile = repoArtifactMap[stage.name];
    if (repoFile && this.state.repoNames.length > 0) {
      const parts: string[] = [];
      for (const repoName of this.state.repoNames) {
        const content = this.featureStore.readArtifact(project, slug, `repos/${repoName}/${repoFile}`);
        if (content) parts.push(`## ${repoName}\n${content}`);
      }
      return parts.join('\n\n');
    }

    return '';
  }

  // ── Repo detection ─────────────────────────────────────────────────

  private detectRepos(_requirementsArtifact: string): void {
    // If we already have repos from project info, use those
    if (this.state.repoNames.length > 0) return;

    // Try to detect from workspace directory — only directories that are actual git repos
    try {
      const entries = readdirSync(this.workspaceDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => {
          if (!e.isDirectory() || e.name.startsWith('.')) return false;
          // Must contain a .git directory to be a real repo
          const gitDir = join(this.workspaceDir, e.name, '.git');
          return existsSync(gitDir);
        })
        .map((e) => e.name);
      if (dirs.length > 0) {
        this.state.repoNames = dirs;
        // Also populate repoPaths so agents get the correct cwd
        for (const dir of dirs) {
          this.repoPaths[dir] = join(this.workspaceDir, dir);
        }
        console.log(`[pipeline] Detected repos from workspace: ${dirs.join(', ')}`);
        // Re-initialize per-repo state
        for (const stage of this.state.stages) {
          if (stage.perRepo) {
            stage.repos = dirs.map((name) => ({
              repoName: name,
              agentId: null,
              status: 'pending',
              cost: 0,
              artifact: '',
              error: null,
            }));
          }
        }
        this.broadcastState();
      }
    } catch {
      // Workspace might not exist
    }
  }

  // ── Silent post-build guards (format + lint auto-fix) ──────────────

  /**
   * Run formatters and linters with auto-fix in each repo after build.
   * Runs silently — no UI stage, no agent. Just cleans up the code
   * so validate starts with formatted, lint-clean code.
   */
  private runPostBuildGuards(): void {
    console.log('[pipeline] Running post-build guards (format + lint auto-fix)...');
    const repos = this.state.repoNames.length > 0
      ? this.state.repoNames.map((r) => ({ name: r, path: this.repoPaths[r] || join(this.workspaceDir, r) }))
      : [{ name: this.config.project, path: this.workspaceDir }];
    runPostBuildGuards({
      repos,
      getRepoCommands: (repoName) => this.projectLoader.getRepoCommands(this.config.project, repoName),
      onLog: (level, message) => {
        if (level === 'info') console.log(`[pipeline] ${message}`);
        else console.warn(`[pipeline] ${message}`);
      },
    });
    console.log('[pipeline] Post-build guards complete.');
  }

  // ── Remote sandbox deployment ──────────────────────────────────────

  /**
   * Deploy the project to a sandbox.
   * Resolution order:
   *   1. pipeline.ship.deploy from factory.yaml
   *   2. ANVIL_DEPLOY_CMD env var
   *   3. Skip deployment entirely (just create PRs)
   * Runs after ship stage. Non-blocking — pipeline completes even if deploy fails.
   */
  private deployToRemote(): void {
    deployProject({
      project: this.config.project,
      mode: this.config.deploy,
      workspaceDir: this.workspaceDir,
      configDeployCmd: this.projectLoader.getConfig(this.config.project)?.pipeline?.ship?.deploy,
      envDeployCmd: process.env.ANVIL_DEPLOY_CMD || process.env.FF_DEPLOY_CMD,
      onArtifact: (artifact) => this.emit('artifact-written', artifact),
      onLog: (level, message) => {
        if (level === 'info') console.log(`[pipeline] ${message}`);
        else console.warn(`[pipeline] ${message}`);
      },
    });
  }

  // ── Feature branch creation ────────────────────────────────────────

  /**
   * Create a feature branch in each repo before the build stage.
   * Branch name: anvil/<feature-slug>
   */
  private createFeatureBranches(): void {
    const branchName = `anvil/${this.state.featureSlug}`;
    console.log(`[pipeline] Creating feature branch "${branchName}" in all repos...`);
    createFeatureBranchesHelper({
      featureSlug: this.state.featureSlug,
      repoPaths: this.repoPaths,
      repoNames: this.state.repoNames,
      workspaceDir: this.workspaceDir,
      onLog: (level, message) => {
        if (level === 'info') console.log(`[pipeline] ${message}`);
        else console.warn(`[pipeline] ${message}`);
      },
    });
  }

  // ── Artifact writing ───────────────────────────────────────────────

  private writeStageArtifact(_index: number, stage: StageDefinition, artifact: string): void {
    try {
      const artifactMap: Record<string, string> = {
        clarify: 'CLARIFICATION.md',
        requirements: 'REQUIREMENTS.md',
        ship: 'SHIP.md',
      };

      const filename = artifactMap[stage.name];
      if (filename) {
        const featureDir = this.featureStore.getFeatureDir(this.config.project, this.state.featureSlug);
        this.featureStore.writeArtifact(this.config.project, this.state.featureSlug, filename, artifact);
        // Emit so dashboard can show in changes tab
        this.emit('artifact-written', {
          stage: stage.name,
          file: `${featureDir}/${filename}`,
          summary: `${stage.label} artifact`,
          content: artifact,
        });
      }
    } catch (err) {
      console.warn(`[pipeline] Failed to write artifact for ${stage.name}:`, err);
    }
  }

  private writeRepoArtifact(stage: StageDefinition, repoName: string, artifact: string): void {
    try {
      const artifactMap: Record<string, string> = {
        'repo-requirements': 'REQUIREMENTS.md',
        specs: 'SPECS.md',
        tasks: 'TASKS.md',
        build: 'BUILD.md',
        validate: 'VALIDATE.md',
      };

      const filename = artifactMap[stage.name];
      if (filename) {
        const relativePath = `repos/${repoName}/${filename}`;
        const featureDir = this.featureStore.getFeatureDir(this.config.project, this.state.featureSlug);
        this.featureStore.writeArtifact(this.config.project, this.state.featureSlug, relativePath, artifact);
        this.emit('artifact-written', {
          stage: stage.name,
          file: `${featureDir}/${relativePath}`,
          repo: repoName,
          summary: `${stage.label} for ${repoName}`,
          content: artifact,
        });
      }
    } catch (err) {
      console.warn(`[pipeline] Failed to write repo artifact for ${stage.name}/${repoName}:`, err);
    }
  }

  // ── Prompt building ─────────────────────────────────────────────────

  private buildProjectPrompt(stage: StageDefinition): string {
    return buildProjectPromptHelper(this.getPromptContext(), stage);
  }

  private buildRepoProjectPrompt(stage: StageDefinition, repoName: string): string {
    return buildRepoProjectPromptHelper(this.getPromptContext(), stage, repoName);
  }

  private buildClarifyExplorePrompt(): string {
    return buildClarifyExplorePromptHelper(this.getPromptContext());
  }

  private buildStagePrompt(stage: StageDefinition, prevArtifact: string): string {
    return buildStagePromptHelper(this.getPromptContext(), stage, prevArtifact);
  }

  /**
   * Load artifacts specific to a single repo from the feature store.
   * Returns structured context the agent can work from.
   */
  private loadRepoArtifacts(repoName: string): { requirements: string; specs: string; tasks: string; build: string } {
    const project = this.config.project;
    const slug = this.state.featureSlug;
    return {
      requirements: this.featureStore.readArtifact(project, slug, `repos/${repoName}/REQUIREMENTS.md`) ?? '',
      specs: this.featureStore.readArtifact(project, slug, `repos/${repoName}/SPECS.md`) ?? '',
      tasks: this.featureStore.readArtifact(project, slug, `repos/${repoName}/TASKS.md`) ?? '',
      build: this.featureStore.readArtifact(project, slug, `repos/${repoName}/BUILD.md`) ?? '',
    };
  }

  /**
   * Load the high-level requirements artifact (shared across repos).
   */
  private loadHighLevelRequirements(): string {
    const project = this.config.project;
    const slug = this.state.featureSlug;
    return this.featureStore.readArtifact(project, slug, 'REQUIREMENTS.md') ?? '';
  }

  private buildRepoStagePrompt(stage: StageDefinition, repoName: string, prevArtifact: string): string {
    return buildRepoStagePromptHelper(this.getPromptContext(), stage, repoName, prevArtifact);
  }

  private broadcastState(): void {
    this.emit('state-change', this.state);
  }
}
