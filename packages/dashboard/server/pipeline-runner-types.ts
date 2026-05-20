/**
 * Type declarations + module-level constants for `pipeline-runner.ts`.
 *
 * Split out as part of the dashboard pipeline-runner consolidation
 * follow-up — the runner file shrinks; the type surface stays put.
 *
 * Re-exported through `pipeline-runner.ts` so external consumers (the
 * frontend, dashboard-server.ts, fix-flow.ts) keep importing from
 * `./pipeline-runner.js` without churn.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolverTier } from '@esankhan3/anvil-agent-core';
import type { ProviderName } from '@esankhan3/anvil-agent-core';
import type { PlanBinding } from '@esankhan3/anvil-core-pipeline';

/** Dashboard's local alias for agent-core's `ResolverTier`. */
export type ModelTier = ResolverTier;

// ── Stage definitions ───────────────────────────────────────────────────

export interface StageDefinition {
  index: number;
  name: string;
  /** Human-friendly UI label. */
  label: string;
  persona: string;
  /** Whether this stage runs per-repo. */
  perRepo: boolean;
}

export const STAGES: StageDefinition[] = [
  { index: 0, name: 'clarify',           label: 'Understanding',         persona: 'clarifier',   perRepo: false },
  { index: 1, name: 'requirements',      label: 'Planning requirements', persona: 'analyst',     perRepo: false },
  { index: 2, name: 'repo-requirements', label: 'Repo requirements',     persona: 'analyst',     perRepo: true },
  { index: 3, name: 'specs',             label: 'Writing specs',         persona: 'architect',   perRepo: true },
  { index: 4, name: 'tasks',             label: 'Creating tasks',        persona: 'lead',        perRepo: true },
  { index: 5, name: 'build',             label: 'Writing code',          persona: 'engineer',    perRepo: true },
  { index: 6, name: 'test',              label: 'Generating tests',      persona: 'test-author', perRepo: true },
  { index: 7, name: 'validate',          label: 'Testing',               persona: 'tester',      perRepo: true },
  { index: 8, name: 'ship',              label: 'Shipping',              persona: 'engineer',    perRepo: false },
];

/** Stages whose artifacts can be fully derived from a Plan — skipped when planSeed is provided. */
export const PLAN_DERIVED_STAGES: string[] = ['requirements', 'repo-requirements', 'specs', 'tasks'];

// ── Per-stage output-token ceilings ─────────────────────────────────────

/**
 * Per-stage output-token ceilings (Phase 3 — TOKEN-OPTIMIZATION-PLAN).
 *
 * Caps how many tokens each stage's agent is allowed to emit so artifact
 * bloat (50KB BUILD.md narratives, recap dumps in REQUIREMENTS.md) stops
 * costing output tokens.
 */
export const STAGE_OUTPUT_LIMITS: Record<string, number> = {
  clarify: 2000,
  requirements: 4000,
  'repo-requirements': 4000,
  specs: 6000,
  tasks: 8000,
  build: 20000,
  test: 12000,
  // Validate now runs the full fix-loop inline: build → lint → tests,
  // editing source files between gates until everything's green. The
  // previous 8000-token cap starved the agent mid-fix — it would run
  // tests, see 12 failures, start editing, and run out before
  // re-running the suite. 20000 matches build (same shape of work:
  // many Edit tool calls + interleaved Bash output) and gives room for
  // the structured VERDICT block at the end.
  validate: 20000,
  // Ship runs 5 bash commands (build/lint, status, commit, push, gh pr
  // create) + emits the PR URL. 2000 tokens routinely starved the agent
  // before it reached `gh pr create`. 8000 leaves plenty of room for
  // tool-call argument overhead + the PR URL response without
  // re-introducing prose bloat.
  ship: 8000,
};
export const STAGE_OUTPUT_LIMIT_FALLBACK = 8000;

export function maxOutputTokensForStage(stageName: string): number {
  return STAGE_OUTPUT_LIMITS[stageName] ?? STAGE_OUTPUT_LIMIT_FALLBACK;
}

/** Read-only snapshot of pipeline stage names (test seam). */
export function listStageNames(): string[] {
  return STAGES.map((s) => s.name);
}

// ── Local-tier stage list (Phase 5 — Ollama) ───────────────────────────

/**
 * Stages eligible to be routed to a local Ollama model when
 * `process.env.ANVIL_LOCAL_MODEL` is set. Conservative — stages whose
 * output feeds engineer/architect/tester are excluded so a weaker
 * local model can't poison the rest of the pipeline.
 */
export const LOCAL_TIER_STAGES = new Set<string>(['clarify', 'ship']);

/**
 * Map a model id to its provider for the liveness chain walker.
 * Mirrors the heuristic in agent-core's `default-adapter-factory.
 * resolveProvider`.
 */
export function providerOfModelId(modelId: string): ProviderName {
  const id = modelId.toLowerCase();
  if (id.startsWith('ollama:')) return 'ollama';
  if (id.startsWith('gemini-')) return 'gemini';
  if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4') || id.startsWith('chatgpt-')) return 'openai';
  if (id.includes('/')) return 'openrouter';
  if (/^[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(id) && id !== 'claude' && !id.startsWith('claude-')) return 'ollama';
  return 'claude';
}

// ── Per-repo agent tracking ─────────────────────────────────────────────

/** A question an agent asked during a stage, with the user's answer if provided. */
export interface StageQuestion {
  index: number;            // 0-based position in the question list
  text: string;             // the agent's question
  answer?: string;          // undefined until user answers; trimmed string after
  answeredAt?: string;      // ISO timestamp
}

export interface RepoAgentState {
  repoName: string;
  agentId: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  cost: number;
  artifact: string;
  error: string | null;
  /** Per-repo Q&A — populated when the agent for this repo is in mid-Q&A. */
  questions?: StageQuestion[];
}

// ── Pipeline state ──────────────────────────────────────────────────────

/**
 * Per-stage token + cache breakdown. Surfaced so the dashboard can
 * render the cache-hit rate. All counts are aggregates across every
 * spawn the stage produced.
 */
export interface StageTokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function zeroTokenStats(): StageTokenStats {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function sumTokenStats(parts: ReadonlyArray<StageTokenStats>): StageTokenStats {
  const total = zeroTokenStats();
  for (const p of parts) {
    total.inputTokens += p.inputTokens;
    total.outputTokens += p.outputTokens;
    total.cacheReadTokens += p.cacheReadTokens;
    total.cacheWriteTokens += p.cacheWriteTokens;
  }
  return total;
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
  /** Model id resolved for this stage by the registry-driven resolver. */
  resolvedModel?: string;
  /** Tool-permission classes ('read' / 'write' / 'exec'). */
  permissionClasses?: ('read' | 'write' | 'exec')[];
  /** Stage-level Q&A — populated when the agent asks questions before producing the artifact. */
  questions?: StageQuestion[];
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

// ── Config ──────────────────────────────────────────────────────────────

export interface PipelineConfig {
  project: string;
  feature: string;
  model: string;
  /**
   * Optional run id. When omitted, the runner generates `run-<base36>`.
   * Callers (the dashboard) pass the same id used for the activeRuns
   * map + frontend URL (`build-<base36>`) so pauses, durable events,
   * audit logs, and the frontend's `urlRunId` filter all line up on
   * one identity.
   */
  runId?: string;
  /** Cost-aware tier — overrides single model with per-stage routing. */
  modelTier?: ModelTier;
  /** Base branch to checkout/PR against (default: auto-detect main/master). */
  baseBranch?: string;
  skipClarify?: boolean;
  /** When set and skipClarify=true, this replaces the Clarify artifact fed to the next stage. */
  clarifySeedArtifact?: string;
  /**
   * When set, stages 1–4 are derived deterministically from this Plan
   * instead of running agents.
   */
  planSeed?: {
    project: string;
    slug: string;
    version: number;
    /** Snapshot of the plan JSON. */
    plan: import('@esankhan3/anvil-core-pipeline').Plan;
  };
  skipShip?: boolean;
  /** Deploy after shipping. */
  deploy?: 'local' | 'remote' | false;
  /** Explicit repo list (overrides auto-detection). */
  repos?: string[];
  // ── Resume support ────────────────────────────────────────────────────
  /** Stage index to resume from (skip completed stages before this). */
  resumeFromStage?: number;
  /** Existing feature slug (to load prior artifacts). */
  featureSlug?: string;
  /** What went wrong in the previous run. */
  failureContext?: string;
  actionType?: 'feature' | 'bugfix' | 'fix' | 'spike' | 'review';
  /**
   * Phase D — plan binding for the run. When present, every stage
   * receives `ctx.shared.planBinding` so build / validate / ship can
   * verify their output against the approved plan + stamp PR bodies.
   */
  planBinding?: PlanBinding;
}

// ── Checkpoint — persisted pipeline state for crash recovery ───────────

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

/** Read a checkpoint file from disk. */
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

/** Find all incomplete pipelines across all projects (interrupted, failed, or waiting). */
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
            incomplete.push({ ...cp, status: 'failed' as PipelineRunState['status'] });
          } else if (cp.status === 'failed' || cp.status === 'cancelled') {
            incomplete.push(cp);
          }
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch { /* skip */ }
  return incomplete;
}

// ── After-stage hook ────────────────────────────────────────────────────

/**
 * Hook fired after each stage completes. Returning a rejected promise
 * cancels the pipeline; resolving with `{ pause: true }` suspends
 * execution until `resume()` is called.
 *
 * The `waitForReviewerDecision` callback is the durable-signal-aware
 * pause primitive (Phase F1 of the durable execution rollout). When
 * the after-stage hook needs to block the pipeline pending a
 * reviewer decision, it MUST call this callback rather than
 * polling — the callback is wired to `ctx.waitForSignal(channel)`
 * when durable mode is on, falling back to caller-supplied polling
 * when off. Crash-recovery: a reviewer decision recorded before the
 * crash returns immediately on replay; the user doesn't have to
 * re-decide.
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
    /**
     * Block until a reviewer decision lands on the named channel.
     * Returns the decision payload (caller-supplied shape) or null on
     * timeout / cancellation. Idempotent on replay — a previously
     * recorded decision returns immediately.
     */
    waitForReviewerDecision?: (channel: string) => Promise<unknown>;
  }): Promise<void>;
}
