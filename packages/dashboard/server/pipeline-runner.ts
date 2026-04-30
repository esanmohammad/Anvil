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
import { AgentManager } from '@anvil/agent-core';
import { ProjectLoader } from './project-loader.js';
import type { ProjectInfo } from './project-loader.js';
import { FeatureStore } from './feature-store.js';
import { MemoryStore } from './memory-store.js';
import { KnowledgeBaseManager } from './knowledge-base-manager.js';
import { resolveModelByTier } from './model-tier-resolver.js';
import { parseTasks, bundleFiles } from './engineer-task-bundler.js';
import type { ParsedTask } from './engineer-task-bundler.js';
import { sliceSpecForRefs } from './engineer-spec-slicer.js';
import { enforceBudget } from './prompt-budget.js';
import type { PromptSection } from './prompt-budget.js';
import { scorePlan, computeRiskTier } from './plan-risk-scorer.js';
import {
  FeatureManifestStore,
  renderManifestForPrompt,
  type PlannedFile,
  type TestBehavior,
} from './feature-manifest.js';
import {
  spawnAndWait,
} from './steps/agent-spawner.js';
import {
  runPerRepoStageForRepo,
  combinePerRepoArtifacts,
  disallowedToolsForPersona,
} from './steps/per-repo-stage.step.js';
import {
  runBuildForOneRepo,
} from './steps/per-repo-build.step.js';
import {
  runClarifyForProject,
} from './steps/clarify-stage.step.js';
import {
  runFixLoop,
  hasValidationFailures as hasValidationFailuresHelper,
} from './steps/fix-loop.step.js';
import {
  runTestGenForProject,
} from './steps/test-gen-stage.step.js';
import {
  pullBaseBranchForRepos,
  runPostBuildGuards,
  deployProject,
  createFeatureBranches as createFeatureBranchesHelper,
} from './steps/workspace-ops.js';
import {
  buildProjectPrompt as buildProjectPromptHelper,
  buildRepoProjectPrompt as buildRepoProjectPromptHelper,
  buildClarifyExplorePrompt as buildClarifyExplorePromptHelper,
  buildStagePrompt as buildStagePromptHelper,
  buildRepoStagePrompt as buildRepoStagePromptHelper,
  buildPerTaskPrompt as buildPerTaskPromptHelper,
  type PromptBuilderContext,
} from './steps/prompt-builders.js';
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
} from './feature-manifest-extractors.js';

// ── Claude CLI binary ────────────────────────────────────────────────

const CLAUDE_BIN = process.env.ANVIL_AGENT_CMD ?? process.env.FF_AGENT_CMD ?? process.env.CLAUDE_BIN ?? 'claude';

// ── Auth helpers ─────────────────────────────────────────────────────

/**
 * Check if the Claude CLI is authenticated.
 * Returns true if logged in, false otherwise.
 */
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

// ── Stage definitions ─────────────────────────────────────────────────

interface StageDefinition {
  index: number;
  name: string;
  label: string;         // human-friendly label for UI
  persona: string;
  perRepo: boolean;       // whether this stage runs per-repo
}

const STAGES: StageDefinition[] = [
  { index: 0, name: 'clarify',           label: 'Understanding',        persona: 'clarifier',   perRepo: false },
  { index: 1, name: 'requirements',      label: 'Planning requirements', persona: 'analyst',    perRepo: false },
  { index: 2, name: 'repo-requirements', label: 'Repo requirements',    persona: 'analyst',     perRepo: true },
  { index: 3, name: 'specs',             label: 'Writing specs',        persona: 'architect',   perRepo: true },
  { index: 4, name: 'tasks',             label: 'Creating tasks',       persona: 'lead',        perRepo: true },
  { index: 5, name: 'build',             label: 'Writing code',         persona: 'engineer',    perRepo: true },
  { index: 6, name: 'test',              label: 'Generating tests',     persona: 'test-author', perRepo: true },
  { index: 7, name: 'validate',          label: 'Testing',              persona: 'tester',      perRepo: true },
  { index: 8, name: 'ship',              label: 'Shipping',             persona: 'engineer',    perRepo: false },
];

/** Stages whose artifacts can be fully derived from a Plan — skipped when planSeed is provided. */
const PLAN_DERIVED_STAGES: string[] = ['requirements', 'repo-requirements', 'specs', 'tasks'];

/**
 * Per-stage output-token ceilings (Phase 3 — TOKEN-OPTIMIZATION-PLAN).
 *
 * Caps how many tokens each stage's agent is allowed to emit so that artifact
 * bloat (50KB BUILD.md narratives, recap dumps in REQUIREMENTS.md) stops
 * costing output tokens. The numbers below are conservative starting points
 * tuned to typical artifact sizes in this repo:
 *
 *   - clarify / ship — short Q-and-A or git ops, ≤ 2K
 *   - requirements / repo-requirements / validate — bullet lists, ≤ 4K
 *   - specs — APIs + schema + behaviors, ≤ 6K
 *   - tasks — task breakdown, ≤ 8K
 *   - test — generated tests across files, ≤ 12K
 *   - build — real codegen, ≤ 16K (highest because the engineer writes diffs)
 *
 * Adapter behavior:
 *   - api-adapter: passes `max_tokens` in the request body.
 *   - claude-adapter / gemini-cli-adapter: capabilities.maxOutputTokens=false
 *     today (CLIs don't expose a flag) — the call is a no-op.
 *
 * STAGE_OUTPUT_LIMIT_FALLBACK is used for any stage not present in the table.
 */
export const STAGE_OUTPUT_LIMITS: Record<string, number> = {
  clarify: 2000,
  requirements: 4000,
  'repo-requirements': 4000,
  specs: 6000,
  tasks: 8000,
  build: 16000,
  test: 12000,
  validate: 4000,
  ship: 2000,
};
export const STAGE_OUTPUT_LIMIT_FALLBACK = 8000;

export function maxOutputTokensForStage(stageName: string): number {
  return STAGE_OUTPUT_LIMITS[stageName] ?? STAGE_OUTPUT_LIMIT_FALLBACK;
}

/** Exposed for tests — read-only snapshot of pipeline stage names. */
export function listStageNames(): string[] {
  return STAGES.map((s) => s.name);
}

// ── Per-repo agent tracking ───────────────────────────────────────────

export interface RepoAgentState {
  repoName: string;
  agentId: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  cost: number;
  artifact: string;
  error: string | null;
}

// ── Pipeline state ────────────────────────────────────────────────────

/**
 * Per-stage token + cache breakdown. Surfaced so the dashboard can render
 * the cache-hit rate (Phase 1 of TOKEN-OPTIMIZATION-PLAN). All counts are
 * aggregates across every spawn the stage produced (single agent for
 * project-wide stages, all repos × tasks for per-repo stages).
 */
export interface StageTokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface PipelineStageState {
  name: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting';
  agentId: string | null;
  cost: number;
  startedAt: string | null;
  completedAt: string | null;
  artifact: string;
  error: string | null;
  perRepo: boolean;
  repos: RepoAgentState[];
  /** Token breakdown for this stage; absent for skipped/pending stages. */
  tokens?: StageTokenStats;
}

export interface PipelineRunState {
  runId: string;
  project: string;
  feature: string;
  featureSlug: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting';
  currentStage: number;
  stages: PipelineStageState[];
  startedAt: string;
  totalCost: number;
  model: string;
  repoNames: string[];
  waitingForInput: boolean;
  /** Run-level token aggregate. cacheHitRatio = cacheReadTokens / (inputTokens + cacheReadTokens). */
  tokens?: StageTokenStats & { cacheHitRatio: number };
}

export interface PipelineRunnerEvents {
  'state-change': (state: PipelineRunState) => void;
  'stage-start': (stageIndex: number, agentId: string) => void;
  'stage-complete': (stageIndex: number, artifact: string, cost: number) => void;
  'stage-fail': (stageIndex: number, error: string) => void;
  'pipeline-complete': (state: PipelineRunState) => void;
  'pipeline-fail': (state: PipelineRunState) => void;
  'waiting-for-input': (stageIndex: number, agentId: string) => void;
}

// ── Local-tier stage list (Phase 5 — Ollama) ──────────────────────────

/**
 * Stages eligible to be routed to a local Ollama model when
 * `process.env.ANVIL_LOCAL_MODEL` is set. The list is conservative —
 * stages whose output feeds engineer/architect/tester are excluded so a
 * weaker local model can't poison the rest of the pipeline. Manifest
 * extraction is heuristic (no LLM call today) so it's not in the list;
 * if/when Phase 4b grows an LLM extractor, append it here.
 */
const LOCAL_TIER_STAGES = new Set<string>(['clarify', 'ship']);

// ── Token-stats helpers ───────────────────────────────────────────────

function zeroTokenStats(): StageTokenStats {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function sumTokenStats(parts: ReadonlyArray<StageTokenStats>): StageTokenStats {
  const total = zeroTokenStats();
  for (const p of parts) {
    total.inputTokens += p.inputTokens;
    total.outputTokens += p.outputTokens;
    total.cacheReadTokens += p.cacheReadTokens;
    total.cacheWriteTokens += p.cacheWriteTokens;
  }
  return total;
}

// ── Config ────────────────────────────────────────────────────────────

export type ModelTier = 'fast' | 'balanced' | 'thorough';

export interface PipelineConfig {
  project: string;
  feature: string;
  model: string;
  modelTier?: ModelTier;     // cost-aware tier — overrides single model with per-stage routing
  baseBranch?: string;       // base branch to checkout/PR against (default: auto-detect main/master)
  skipClarify?: boolean;
  /** When set and skipClarify=true, this replaces the Clarify artifact fed to the next stage. Used by the Plan flow. */
  clarifySeedArtifact?: string;
  /**
   * When set, stages 1–4 (requirements, repo-requirements, specs, tasks) are
   * derived deterministically from this Plan instead of running agents.
   * The Plan flow uses this to skip straight to Build.
   */
  planSeed?: {
    project: string;
    slug: string;
    version: number;
    /** Snapshot of the plan JSON (so changes after execute don't affect the run). */
    plan: import('./plan-store.js').Plan;
  };
  skipShip?: boolean;
  deploy?: 'local' | 'remote' | false;  // deploy after shipping
  repos?: string[];          // explicit repo list (overrides auto-detection)
  // Resume support
  resumeFromStage?: number;  // stage index to resume from (skip completed stages before this)
  featureSlug?: string;      // existing feature slug (to load prior artifacts)
  failureContext?: string;   // what went wrong in the previous run
  actionType?: 'feature' | 'bugfix' | 'fix' | 'spike' | 'review';
}

// ── Checkpoint — persisted pipeline state for crash recovery ──────────

export interface PipelineCheckpoint {
  version: 1;
  runId: string;
  project: string;
  feature: string;
  featureSlug: string;
  config: {
    model: string;
    modelTier?: ModelTier;
    baseBranch?: string;
    skipClarify?: boolean;
    skipShip?: boolean;
    actionType?: string;
  };
  status: PipelineRunState['status'];
  currentStage: number;
  stages: Array<{
    name: string;
    label: string;
    status: string;
    cost: number;
    error: string | null;
    repos: Array<{
      repoName: string;
      status: string;
      cost: number;
      error: string | null;
    }>;
  }>;
  repoNames: string[];
  totalCost: number;
  startedAt: string;
  updatedAt: string;
}

/** Read a checkpoint file from disk */
export function readCheckpoint(featureDir: string): PipelineCheckpoint | null {
  const path = join(featureDir, 'pipeline-state.json');
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    const cp = JSON.parse(raw) as PipelineCheckpoint;
    if (cp.version !== 1) return null;
    return cp;
  } catch {
    return null;
  }
}

/** Find all incomplete pipelines across all projects (interrupted, failed, or waiting) */
export function findInterruptedPipelines(anvilHome: string): PipelineCheckpoint[] {
  const featuresDir = join(anvilHome, 'features');
  if (!existsSync(featuresDir)) return [];

  const incomplete: PipelineCheckpoint[] = [];
  try {
    for (const project of readdirSync(featuresDir)) {
      const projectDir = join(featuresDir, project);
      if (!existsSync(projectDir)) continue;
      try {
        for (const slug of readdirSync(projectDir)) {
          const cp = readCheckpoint(join(projectDir, slug));
          if (!cp) continue;
          if (cp.status === 'running' || cp.status === 'waiting') {
            // Was in-progress when dashboard died — mark as interrupted
            incomplete.push({ ...cp, status: 'failed' as any });
          } else if (cp.status === 'failed' || cp.status === 'cancelled') {
            // Previously failed/cancelled — still resumable
            incomplete.push(cp);
          }
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch { /* skip */ }
  return incomplete;
}

// ── Pipeline Runner ───────────────────────────────────────────────────

/**
 * Hook fired after each stage completes. Returning a rejected promise cancels
 * the pipeline; resolving with `{ pause: true }` suspends execution until
 * `resume()` is called.
 */
export interface AfterStageHook {
  (info: {
    runId: string;
    project: string;
    stageIndex: number;
    stageName: string;
    artifact: string;
    cost: number;
    totalCost: number;
    touchedFiles?: string[];
    riskTier?: 'low' | 'med' | 'high';
    confidence?: number;
  }): Promise<void>;
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
  //
  // Set ANVIL_PROMPT_ENVELOPE_DISABLED=1 to bypass these wins and fall back
  // to per-stage recomputation (rollback hatch documented in the plan).
  private envelopeDisabled = process.env.ANVIL_PROMPT_ENVELOPE_DISABLED === '1';
  private cachedMemoryBlock: string | null = null;
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
    if (this.envelopeDisabled) return this.kbTierForStage(stage.persona, stage.name);
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

  /** Memoised memory block (project + user profile, capped at 4KB). */
  private getStableMemoryBlock(): string {
    if (this.envelopeDisabled) {
      const projectMemory = this.memoryStore.formatForPrompt(this.config.project, 'memory');
      const userProfile = this.memoryStore.formatForPrompt(this.config.project, 'user');
      const raw = [projectMemory, userProfile].filter(Boolean).join('\n\n');
      return raw.length > 4000 ? raw.slice(0, 4000) + '\n... [memory truncated]' : raw;
    }
    if (this.cachedMemoryBlock !== null) return this.cachedMemoryBlock;
    const projectMemory = this.memoryStore.formatForPrompt(this.config.project, 'memory');
    const userProfile = this.memoryStore.formatForPrompt(this.config.project, 'user');
    const raw = [projectMemory, userProfile].filter(Boolean).join('\n\n');
    this.cachedMemoryBlock = raw.length > 4000 ? raw.slice(0, 4000) + '\n... [memory truncated]' : raw;
    return this.cachedMemoryBlock;
  }

  /** Memoised project YAML slice — same maxLen returns same bytes. */
  private getStableProjectYamlSlice(maxLen: number): string {
    if (this.envelopeDisabled) {
      return this.projectYaml.slice(0, maxLen) || '(not available)';
    }
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

    if (!this.envelopeDisabled) {
      const cached = this.cachedKbBlock.get(key);
      if (cached !== undefined) {
        // Recover the source label from the cached body. Encoded as a
        // leading sentinel comment we strip on retrieval.
        const label = (cached.match(/^<!-- anvil:kb-src:(\w[\w-]*) -->/) ?? [])[1] as
          | 'repo-focused' | 'index-only' | 'full-with-index' | 'full-blob' | undefined;
        const content = cached.replace(/^<!-- anvil:kb-src:[\w-]+ -->\n?/, '');
        return { content, sourceLabel: label ?? 'none' };
      }
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

    if (!this.envelopeDisabled && content) {
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
  private populateManifestFromPlan(plan: import('./plan-store.js').Plan): void {
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
    // 1. factory.yaml per-stage override always wins
    const yamlModels = this.projectLoader.getConfig(this.config.project)?.pipeline?.models;
    if (yamlModels?.[stageName]) return yamlModels[stageName];

    // 2. Phase 5 of TOKEN-OPTIMIZATION-PLAN — opt-in local-model overlay.
    //    `ANVIL_LOCAL_MODEL=qwen2.5-coder:7b` (or similar) routes the
    //    cheap-tier stages (clarify + ship + manifest extraction) to a
    //    local Ollama model when the daemon is up. Stays off by default
    //    so production runs keep deterministic Claude behaviour.
    const localModel = process.env.ANVIL_LOCAL_MODEL?.trim();
    if (localModel && LOCAL_TIER_STAGES.has(stageName)) {
      return localModel;
    }

    // 3. If no tier selected, use the single model from the UI dropdown
    const tier = this.config.modelTier;
    if (!tier) return this.config.model;

    // 4. Tier-based routing — resolve from provider registry
    return resolveModelByTier(tier, stageName, this.config.model);
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

  /**
   * Pick how much KB context to inject for a given (persona, stage) pair (P2).
   *
   * - 'full'         — index + target repo + cross-repo + query context (design stages)
   * - 'repo-focused' — just the target repo's graph report (coding/test stages)
   * - 'index-only'   — just the cross-repo index (clarifier — needs the big picture
   *                    but doesn't need to dig into any single repo's internals)
   * - 'none'         — skip KB entirely (ship — git operations don't need it)
   *
   * Coding stages stay narrow on purpose: it shrinks the system prompt enough to
   * matter for prompt caching, and the engineer/tester already have the
   * authoritative source on disk plus a pre-bundled <files> block.
   */
  private kbTierForStage(persona: string, stageName: string): 'full' | 'repo-focused' | 'index-only' | 'none' {
    if (stageName === 'ship') return 'none';
    if (stageName === 'clarify') return 'index-only';
    if (persona === 'engineer' || persona === 'tester' || persona === 'test-author') {
      return 'repo-focused';
    }
    return 'full';
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

      for (let i = 0; i < STAGES.length; i++) {
        if (this.cancelled) break;

        const stage = STAGES[i];

        // Skip completed stages when resuming
        if (isResume && i < resumeStage) {
          this.state.stages[i].status = 'completed';
          this.state.stages[i].completedAt = new Date().toISOString();
          // Load the artifact from the feature store
          const storedArtifact = this.loadStageArtifact(stage);
          this.state.stages[i].artifact = storedArtifact;
          this.broadcastState();
          this.checkpoint();
          continue;
        }

        // Skip stages if configured
        if (stage.name === 'clarify' && this.config.skipClarify) {
          const seed = this.config.clarifySeedArtifact ?? 'Clarification skipped.';
          this.state.stages[i].status = 'skipped';
          this.state.stages[i].artifact = seed;
          prevArtifact = seed;
          // Persist seed as CLARIFICATION.md so downstream resume picks it up.
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
          continue;
        }
        if (stage.name === 'ship' && this.config.skipShip) {
          this.state.stages[i].status = 'skipped';
          this.broadcastState();
          this.checkpoint();
          continue;
        }

        // Plan-seed skip: stages 1–4 derive deterministically from the plan.
        if (this.config.planSeed && PLAN_DERIVED_STAGES.includes(stage.name)) {
          const { plan } = this.config.planSeed;
          const { renderRequirements, renderRepoRequirements, renderRepoSpecs, renderRepoTasks }
            = await import('./plan-to-artifacts.js');

          const project = this.config.project;
          const slug = this.state.featureSlug;

          if (stage.name === 'requirements') {
            const artifact = renderRequirements(plan);
            this.state.stages[i].status = 'skipped';
            this.state.stages[i].artifact = artifact;
            prevArtifact = artifact;
            try { this.featureStore.writeArtifact(project, slug, 'REQUIREMENTS.md', artifact); } catch { /* non-fatal */ }
          } else {
            // Per-repo: write one artifact per repo + populate repos[] entries
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
            const filename = filenameByStage[stage.name];
            const renderer = rendererByStage[stage.name];

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
            prevArtifact = this.state.stages[i].artifact;
          }

          this.state.stages[i].completedAt = new Date().toISOString();
          this.broadcastState();
          this.checkpoint();
          continue;
        }

        // Test-gen stage: deterministic behavior extraction + grounding + scaffold
        // emission. Opt-in via planSeed (we need Behaviors from somewhere); without
        // a plan, we skip so existing non-plan flows are unchanged.
        if (stage.name === 'test') {
          if (!this.config.planSeed) {
            this.state.stages[i].status = 'skipped';
            this.state.stages[i].artifact = 'Test stage skipped (no plan seed).';
            prevArtifact = this.state.stages[i].artifact;
            this.state.stages[i].completedAt = new Date().toISOString();
            this.broadcastState();
            this.checkpoint();
            continue;
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
            // Non-fatal: test-gen failure shouldn't block validate. Downgrade to skipped.
            const msg = err instanceof Error ? err.message : String(err);
            console.warn('[pipeline] test-gen failed, continuing to validate:', msg);
            this.state.stages[i].status = 'skipped';
            this.state.stages[i].artifact = `Test stage skipped (${msg}).`;
            this.state.stages[i].completedAt = new Date().toISOString();
            this.broadcastState();
            this.checkpoint();
          }
          continue;
        }

        console.log(`[pipeline] Entering stage "${stage.name}" (${i + 1}/${STAGES.length})`);

        // Move any pending reviewer note from the prior pause onto this
        // stage so every spawn (per-repo fanout, per-task build) sees the
        // same note. Cleared after the stage completes.
        this.armReviewNoteForCurrentStage();

        // Ensure Claude CLI auth is valid before spawning agents
        await this.ensureAuth(stage.name);

        // Create feature branch before build stage starts
        if (stage.name === 'build') {
          this.createFeatureBranches();
        }

        // Run silent post-build guards before validate starts
        if (stage.name === 'validate') {
          this.runPostBuildGuards();
        }

        // Mark stage as running
        this.state.currentStage = i;
        this.state.stages[i].status = 'running';
        this.state.stages[i].startedAt = new Date().toISOString();
        this.broadcastState();
        this.checkpoint(); // Save: stage started
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

          if (this.cancelled) break;

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
          this.checkpoint(); // Save: stage completed
          this.emit('stage-complete', i, result.artifact, result.cost);

          // ── After-stage hook — policy-driven pause / learning / etc. ──
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
              if (this.cancelled) break;
            } catch (err) {
              console.warn(`[pipeline] after-stage hook rejected at ${stage.name}:`, err);
              this.cancelled = true;
              break;
            }
          }

          // Phase B — modify-artifact: if the reviewer edited the artifact
          // during the after-stage pause, applyArtifactEdit has already
          // re-written disk state + broadcast. Pick up the edited body so
          // the next stage receives it as `prevArtifact`.
          const edited = this.consumeArtifactOverride();
          if (edited !== null) {
            prevArtifact = edited;
          } else {
            // No edit — write the agent's artifact (skipped on edit since
            // applyArtifactEdit already wrote the edited copy).
            this.writeStageArtifact(i, stage, result.artifact);
          }

          // Phase 2: extract structured fields from this stage's artifact and
          // patch the manifest. Best-effort — extractor failures degrade to
          // "field stays unset" rather than aborting the run.
          try {
            await this.extractAndUpdateManifest(stage, result.artifact);
          } catch (err) {
            console.warn(`[pipeline] manifest extraction at ${stage.name} failed:`, err);
          }

          // After build (plan-seeded runs only): capture what Build actually did
          // vs what the plan claimed. Feeds plan-learner.
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

          // After ship stage, optionally deploy to remote sandbox
          if (stage.name === 'ship' && this.config.deploy && !this.cancelled) {
            this.deployToRemote();
          }

          // After requirements stage, detect repos if not already set
          if (stage.name === 'requirements' && this.state.repoNames.length === 0) {
            this.detectRepos(result.artifact);
          }

          // Validate-fix loop: if validate fails, loop engineer→validate up to 3 times
          if (stage.name === 'validate' && !this.cancelled) {
            let validateArtifact = result.artifact;
            let fixAttempts = 0;
            const MAX_FIX_ATTEMPTS = 3;

            while (fixAttempts < MAX_FIX_ATTEMPTS && this.hasValidationFailures(validateArtifact)) {
              fixAttempts++;
              console.log(`[pipeline] Validation failed — fix attempt ${fixAttempts}/${MAX_FIX_ATTEMPTS}`);

              // Run engineer agent to fix the reported issues
              const fixResult = await this.runFixLoop(i, validateArtifact, fixAttempts);
              this.state.totalCost += fixResult.cost;
              this.aggregateRunTokens(fixResult.tokens);
              this.logCacheTelemetry(`${stage.name}:fix-${fixAttempts}`, fixResult.tokens);

              if (this.cancelled) break;

              // Re-run validate
              const revalidateResult = await this.runPerRepoStage(i, stage, fixResult.artifact);
              validateArtifact = revalidateResult.artifact;
              this.state.stages[i].artifact = validateArtifact;
              this.state.stages[i].cost += revalidateResult.cost;
              this.state.totalCost += revalidateResult.cost;
              this.aggregateRunTokens(revalidateResult.tokens);
              this.logCacheTelemetry(`${stage.name}:revalidate-${fixAttempts}`, revalidateResult.tokens);
              this.broadcastState();

              // Write updated validate artifact
              this.writeStageArtifact(i, stage, validateArtifact);
            }

            if (this.hasValidationFailures(validateArtifact)) {
              console.warn(`[pipeline] Validation still failing after ${MAX_FIX_ATTEMPTS} fix attempts`);
              // Don't fail the pipeline — ship stage will do a final check
            } else if (fixAttempts > 0) {
              console.log(`[pipeline] Validation recovered after ${fixAttempts} fix attempt(s)`);
            } else {
              console.log(`[pipeline] Validation clean — proceeding to Ship`);
            }

            prevArtifact = validateArtifact;
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.state.stages[i].status = 'failed';
          this.state.stages[i].completedAt = new Date().toISOString();
          this.state.stages[i].error = errorMsg;
          this.state.status = 'failed';
          this.broadcastState();
          this.checkpoint(); // Save: stage failed — enables resume
          this.emit('stage-fail', i, errorMsg);
          this.emit('pipeline-fail', this.state);
          this.featureStore.updateFeature(this.config.project, this.state.featureSlug, {
            status: 'failed',
          });
          return this.state;
        } finally {
          // The reviewer note (if any) applied to THIS stage only. Drop it
          // before advancing so the next stage starts fresh and can pick up
          // a brand-new note set by its own after-stage pause resolution.
          this.clearStageReviewNote();
        }
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

  // ── Interactive Clarify (one question at a time) ─────────────────

  private async runClarifyStage(index: number): Promise<{ artifact: string; cost: number; tokens: StageTokenStats }> {
    const result = await runClarifyForProject({
      agentManager: this.agentManager,
      project: this.config.project,
      workspaceDir: this.workspaceDir,
      model: this.resolveModelForStage('clarify'),
      maxOutputTokens: maxOutputTokensForStage('clarify'),
      explorePrompt: this.buildClarifyExplorePrompt(),
      projectPrompt: this.buildProjectPrompt(STAGES[0]),
      isCancelled: () => this.cancelled,
      onAgentSpawned: (agentId) => {
        this.state.stages[index].agentId = agentId;
        this.broadcastState();
        this.emit('stage-start', index, agentId);
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

      promises.push(
        runPerRepoStageForRepo({
          agentManager: this.agentManager,
          project: this.config.project,
          stageName: stage.name,
          persona: stage.persona,
          model: this.resolveModelForStage(stage.name),
          maxOutputTokens: maxOutputTokensForStage(stage.name),
          repoName,
          repoPath,
          projectPrompt,
          prompt,
          isCancelled: () => this.cancelled,
          onSpawn: (agentId) => {
            if (this.state.stages[index].repos[repoIdx]) {
              this.state.stages[index].repos[repoIdx].agentId = agentId;
            }
            this.broadcastState();
          },
          onTruncation: (agentName, outputTokens) => {
            this.handleOutputTruncation(agentName, outputTokens);
          },
        })
          .then((result) => {
            // Mark repo as completed
            const repoState = this.state.stages[index].repos[repoIdx];
            if (repoState) {
              repoState.status = 'completed';
              repoState.cost = result.cost;
              repoState.artifact = result.artifact;
            }
            this.broadcastState();
            this.checkpoint(); // Save: per-repo completion

            // Write per-repo artifact
            this.writeRepoArtifact(stage, repoName, result.artifact);

            return {
              repoName,
              artifact: result.artifact,
              cost: result.cost,
              tokens: {
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                cacheReadTokens: result.cacheReadTokens,
                cacheWriteTokens: result.cacheWriteTokens,
              },
            };
          })
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
    }

    // Wait for all repos to complete
    const results = await Promise.all(promises);
    const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
    const tokens = sumTokenStats(results.map((r) => r.tokens));
    const successResults = results.filter((r) => r.artifact);

    // Combine artifacts (legacy "## <repo>\n\n<artifact>" separator format).
    const combined = combinePerRepoArtifacts(successResults);

    // If all repos failed, throw
    if (successResults.length === 0 && repos.length > 0) {
      throw new Error(`All repo agents failed for ${stage.name}`);
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

    const result = await runBuildForOneRepo({
      agentManager: this.agentManager,
      project: this.config.project,
      stageName: stage.name,
      persona: stage.persona,
      model: this.resolveModelForStage(stage.name),
      maxOutputTokens: maxOutputTokensForStage(stage.name),
      repoName,
      repoPath,
      projectPrompt,
      tasksMarkdown: repoArtifacts.tasks,
      buildPerTaskPrompt: (task) =>
        this.buildPerTaskPrompt(stage, repoName, repoPath, task, repoArtifacts.specs),
      buildFallbackPrompt: () => this.buildRepoStagePrompt(stage, repoName, ''),
      isCancelled: () => this.cancelled,
      onAgentSpawned: (agentId) => {
        const repoState = this.state.stages[stageIndex].repos[repoIdx];
        if (repoState) repoState.agentId = agentId;
        this.broadcastState();
      },
      onTruncation: (agentName, outputTokens) => {
        this.handleOutputTruncation(agentName, outputTokens);
      },
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

    // Persona-driven tool gating (defined in per-repo-stage.step.ts):
    //   - engineer / tester: full toolbelt (mutate code, run tests).
    //   - analyst / architect / lead: KB-only (no Grep/Glob/Bash) so the
    //     model uses the injected Knowledge Base instead of re-exploring.
    //   - clarifier / others: read-only exploration allowed, no mutation.
    const disallowedTools = disallowedToolsForPersona(stage.persona);

    const result = await spawnAndWait({
      agentManager: this.agentManager,
      spec: {
        name: `${stage.persona}-${this.config.project}`,
        persona: stage.persona,
        project: this.config.project,
        stage: stage.name,
        prompt,
        model: this.resolveModelForStage(stage.name),
        cwd: this.workspaceDir,
        projectPrompt,
        permissionMode: 'bypassPermissions',
        disallowedTools,
        maxOutputTokens: maxOutputTokensForStage(stage.name),
      },
      isCancelled: () => this.cancelled,
      onSpawn: (agentId) => {
        this.state.stages[index].agentId = agentId;
        this.broadcastState();
        this.emit('stage-start', index, agentId);
      },
      onTruncation: (agentName, outputTokens) => {
        this.handleOutputTruncation(agentName, outputTokens);
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
    const result = await runFixLoop({
      agentManager: this.agentManager,
      project: this.config.project,
      model: this.resolveModelForStage('validate'),
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
      onTruncation: (agentName, outputTokens) => {
        this.handleOutputTruncation(agentName, outputTokens);
      },
    });
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
