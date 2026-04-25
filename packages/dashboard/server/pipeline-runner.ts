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
import { AgentManager } from './agent-manager.js';
import { ProjectLoader } from './project-loader.js';
import type { ProjectInfo } from './project-loader.js';
import { FeatureStore } from './feature-store.js';
import { MemoryStore } from './memory-store.js';
import { KnowledgeBaseManager } from './knowledge-base-manager.js';
import { estimateTokens, getModelTokenLimit, budgetPromptContext } from './context-budget.js';
import { resolveModelByTier } from './model-tier-resolver.js';
import { parseTasks, bundleFiles, groupTasksForExecution } from './engineer-task-bundler.js';
import type { ParsedTask } from './engineer-task-bundler.js';
import { sliceSpecForRefs } from './engineer-spec-slicer.js';
import { enforceBudget } from './prompt-budget.js';
import type { PromptSection } from './prompt-budget.js';

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

// ── Persona prompt loader ────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Persona prompt cache */
const personaPromptCache = new Map<string, string>();

/**
 * Load a persona prompt from the CLI persona prompts directory.
 * Checks user overrides at ~/.anvil/personas/ first,
 * then falls back to bundled prompts in packages/cli/src/personas/prompts/.
 */
function loadPersonaPromptSync(personaName: string): string {
  if (personaPromptCache.has(personaName)) return personaPromptCache.get(personaName)!;

  const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');

  // User override
  const userPath = join(anvilHome, 'personas', `${personaName}.md`);
  if (existsSync(userPath)) {
    const content = readFileSync(userPath, 'utf-8');
    personaPromptCache.set(personaName, content);
    return content;
  }

  // Resolution paths in order of likelihood. The CLI bundles prompts into
  // `cli/dist/personas/prompts/`; the monorepo dev tree keeps them in
  // `cli/src/personas/prompts/`. `__dirname` at runtime is either
  // `cli/dist/dashboard/server/` (bundled) or the original source tree.
  const bundledPaths = [
    // Bundled: cli/dist/dashboard/server/ → ../../personas/prompts/
    join(__dirname, '..', '..', 'personas', 'prompts', `${personaName}.md`),
    // Dev (from source): dashboard/server/ → ../../cli/src/personas/prompts/
    join(__dirname, '..', '..', 'cli', 'src', 'personas', 'prompts', `${personaName}.md`),
    // Monorepo tree: dashboard/server/ → ../../../packages/cli/src/personas/prompts/
    join(__dirname, '..', '..', '..', 'packages', 'cli', 'src', 'personas', 'prompts', `${personaName}.md`),
    // Bundled-but-deeper: cli/dist/dashboard/server/ → ../../../../packages/cli/src/personas/prompts/
    join(__dirname, '..', '..', '..', '..', 'packages', 'cli', 'src', 'personas', 'prompts', `${personaName}.md`),
    // Bundled running from cli/dist: cli/dist/dashboard/server/ → ../../../src/personas/prompts/ (when src still present)
    join(__dirname, '..', '..', '..', 'src', 'personas', 'prompts', `${personaName}.md`),
  ];

  for (const p of bundledPaths) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8');
      personaPromptCache.set(personaName, content);
      return content;
    }
  }

  console.warn(`[pipeline] Persona prompt not found for "${personaName}", using fallback. Checked: ${bundledPaths.join(', ')}`);
  return '';
}

/**
 * Inject template variables into a persona prompt.
 */
function injectTemplateVars(prompt: string, vars: Record<string, string>): string {
  let result = prompt;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

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
  }): Promise<void>;
}

export class PipelineRunner extends EventEmitter {
  private agentManager: AgentManager;
  private projectLoader: ProjectLoader;
  private featureStore: FeatureStore;
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

  setAfterStageHook(hook: AfterStageHook | null): void { this.afterStageHook = hook; }

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

    // 2. If no tier selected, use the single model from the UI dropdown
    const tier = this.config.modelTier;
    if (!tier) return this.config.model;

    // 3. Tier-based routing — resolve from provider registry
    return resolveModelByTier(tier, stageName, this.config.model);
  }

  /**
   * Soft guardrail (P12): warn if a system prompt exceeds 60KB. Caching
   * efficiency degrades when prefixes balloon, so this fires a project-event
   * to flag regressions before they pile up. Pure telemetry — does not trim.
   */
  private warnIfSystemPromptOversized(label: string, projectPrompt: string): void {
    const bytes = Buffer.byteLength(projectPrompt, 'utf8');
    if (bytes > 60_000) {
      this.emit('project-event', {
        source: 'context-budget',
        message: `[${label}] system prompt is ${(bytes / 1024).toFixed(1)}KB (>60KB) — review KB tier and memory blocks`,
        level: 'warn',
      });
    }
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
          let result: { artifact: string; cost: number };

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
          this.state.totalCost += result.cost;
          prevArtifact = result.artifact;
          this.broadcastState();
          this.checkpoint(); // Save: stage completed
          this.emit('stage-complete', i, result.artifact, result.cost);

          // ── After-stage hook — policy-driven pause / learning / etc. ──
          if (this.afterStageHook) {
            try {
              await this.afterStageHook({
                runId: this.state.runId,
                project: this.config.project,
                stageIndex: i,
                stageName: stage.name,
                artifact: result.artifact,
                cost: result.cost,
                totalCost: this.state.totalCost,
              });
              if (this.cancelled) break;
            } catch (err) {
              console.warn(`[pipeline] after-stage hook rejected at ${stage.name}:`, err);
              this.cancelled = true;
              break;
            }
          }

          // Write artifact to feature folder
          this.writeStageArtifact(i, stage, result.artifact);

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

              if (this.cancelled) break;

              // Re-run validate
              const revalidateResult = await this.runPerRepoStage(i, stage, fixResult.artifact);
              validateArtifact = revalidateResult.artifact;
              this.state.stages[i].artifact = validateArtifact;
              this.state.stages[i].cost += revalidateResult.cost;
              this.state.totalCost += revalidateResult.cost;
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
    const base = this.getBaseBranch();
    const repos = this.state.repoNames;

    const pullBranch = (cwd: string, label: string): boolean => {
      // If explicit baseBranch is set, only try that one
      if (this.config.baseBranch) {
        try {
          execSync(`git fetch origin && git checkout "${base}" && git pull origin "${base}"`, { cwd, timeout: 30000, stdio: 'pipe' });
          console.log(`[pipeline] ${label}: up to date with ${base}`);
          return true;
        } catch {
          console.warn(`[pipeline] ${label}: could not pull ${base} — continuing with current state`);
          return false;
        }
      }
      // Auto-detect: try main, then master
      try {
        execSync('git fetch origin && git checkout main && git pull origin main', { cwd, timeout: 30000, stdio: 'pipe' });
        console.log(`[pipeline] ${label}: up to date with main`);
        return true;
      } catch {
        try {
          execSync('git fetch origin && git checkout master && git pull origin master', { cwd, timeout: 30000, stdio: 'pipe' });
          console.log(`[pipeline] ${label}: up to date with master`);
          return true;
        } catch {
          console.warn(`[pipeline] ${label}: could not pull latest — continuing with current state`);
          return false;
        }
      }
    };

    if (repos.length === 0) {
      pullBranch(this.workspaceDir, 'workspace root');
      return;
    }

    for (const repoName of repos) {
      const repoPath = this.repoPaths[repoName];
      if (!repoPath || !existsSync(repoPath)) continue;
      pullBranch(repoPath, repoName);
    }
  }

  // ── Interactive Clarify (one question at a time) ─────────────────

  /**
   * Parse numbered questions from the clarifier agent's output.
   * Matches patterns like:
   *   1. **[Topic]**: Question text?
   *   2. Question text?
   *   1) Question text?
   */
  private parseQuestions(output: string): string[] {
    const lines = output.split('\n');
    const questions: string[] = [];
    let current = '';

    for (const line of lines) {
      // Detect start of a new numbered question
      const isNewQ = /^\s*\d+[\.\)]\s+/.test(line);
      if (isNewQ) {
        if (current.trim()) questions.push(current.trim());
        current = line.replace(/^\s*\d+[\.\)]\s+/, '');
      } else if (current) {
        // Continuation of current question (non-empty, not a closing line)
        const trimmed = line.trim();
        if (trimmed && !trimmed.toLowerCase().startsWith('please answer')) {
          current += '\n' + line;
        }
      }
    }
    if (current.trim()) questions.push(current.trim());

    // Deduplicate — agent may produce identical questions under different numbers
    const seen = new Set<string>();
    return questions.filter((q) => {
      if (q.length <= 10) return false; // skip very short fragments
      // Normalize: strip bold markers, whitespace, and leading topic labels for comparison
      const normalized = q.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  private async runClarifyStage(index: number): Promise<{ artifact: string; cost: number }> {
    // Phase A: Agent explores codebase and generates questions
    const explorePrompt = this.buildClarifyExplorePrompt();
    const projectPrompt = this.buildProjectPrompt(STAGES[0]);

    const agent = this.agentManager.spawn({
      name: `clarifier-${this.config.project}`,
      persona: 'clarifier',
      project: this.config.project,
      stage: 'clarify',
      prompt: explorePrompt,
      model: this.resolveModelForStage('clarify'),
      cwd: this.workspaceDir,
      projectPrompt,
      permissionMode: 'bypassPermissions',
      disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
    });

    this.state.stages[index].agentId = agent.id;
    this.broadcastState();
    this.emit('stage-start', index, agent.id);

    // Wait for agent to finish generating questions
    const exploreResult = await this.waitForAgent(agent.id);
    let totalCost = exploreResult.cost;

    // Phase B: Parse questions and ask them one by one
    const questions = this.parseQuestions(exploreResult.artifact);
    const qaPairs: Array<{ question: string; answer: string }> = [];

    if (questions.length === 0) {
      // Fallback: treat entire output as a single question block
      questions.push(exploreResult.artifact);
    }

    for (let qi = 0; qi < questions.length; qi++) {
      if (this.cancelled) break;

      const question = questions[qi];

      // Emit the question as a visible activity
      this.emit('clarify-question', {
        stageIndex: index,
        questionIndex: qi,
        totalQuestions: questions.length,
        question,
      });

      // Wait for user's answer
      this.state.stages[index].status = 'waiting';
      this.state.status = 'waiting';
      this.state.waitingForInput = true;
      this.broadcastState();
      this.emit('waiting-for-input', index, agent.id);

      const answer = await new Promise<string>((resolve) => {
        this.inputResolve = resolve;
      });

      if (this.cancelled || !answer) break;

      // Record the Q&A pair
      qaPairs.push({ question, answer });

      // Emit acknowledgment
      this.emit('user-input', { stageIndex: index, text: answer });
      this.emit('clarify-ack', {
        stageIndex: index,
        questionIndex: qi,
        totalQuestions: questions.length,
        hasMore: qi < questions.length - 1,
      });

      this.state.waitingForInput = false;
      this.broadcastState();
    }

    if (this.cancelled || qaPairs.length === 0) {
      return { artifact: exploreResult.artifact, cost: totalCost };
    }

    // Phase C: Resume agent with all Q&A pairs to synthesize clarification
    this.state.stages[index].status = 'running';
    this.state.status = 'running';
    this.state.waitingForInput = false;
    this.broadcastState();

    const qaText = qaPairs.map((qa, i) =>
      `**Q${i + 1}**: ${qa.question}\n**A${i + 1}**: ${qa.answer}`,
    ).join('\n\n');

    this.agentManager.sendInput(agent.id,
      `Here are the clarifying questions and the user's answers:\n\n${qaText}\n\nNow synthesize a CLARIFICATION.md document that combines the questions, answers, and your codebase understanding into clear context for the next stages. Output ONLY the markdown content.`,
    );

    // Wait for the resumed agent to finish
    const synthesizeResult = await this.waitForAgent(agent.id);
    totalCost += synthesizeResult.cost;

    return {
      artifact: synthesizeResult.artifact || exploreResult.artifact,
      cost: totalCost,
    };
  }

  // ── Per-repo stage execution ───────────────────────────────────────

  private async runPerRepoStage(
    index: number,
    stage: StageDefinition,
    prevArtifact: string,
  ): Promise<{ artifact: string; cost: number }> {
    const repos = this.state.repoNames;

    if (repos.length === 0) {
      // Fallback to single-agent mode
      return this.runSingleStage(index, stage, prevArtifact);
    }

    // Spawn agents for all repos in parallel
    const promises: Promise<{ repoName: string; artifact: string; cost: number }>[] = [];

    for (let r = 0; r < repos.length; r++) {
      const repoName = repos[r];
      const repoPath = this.repoPaths[repoName] || join(this.workspaceDir, repoName);

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
        const repoIdx = r;
        promises.push(
          this.runBuildForRepo(index, repoIdx, stage, repoName, repoPath, projectPrompt)
            .then((res) => ({ repoName, artifact: res.artifact, cost: res.cost }))
            .catch((err) => {
              const errorMsg = err instanceof Error ? err.message : String(err);
              const repoState = this.state.stages[index].repos[repoIdx];
              if (repoState) {
                repoState.status = 'failed';
                repoState.error = errorMsg;
              }
              this.broadcastState();
              return { repoName, artifact: '', cost: 0 };
            }),
        );
        continue;
      }

      const prompt = this.buildRepoStagePrompt(stage, repoName, prevArtifact);

      // Non-engineer/tester personas cannot write files — only engineers and testers modify code.
      // All non-clarifier personas have Agent disabled (P8) — sub-agents inherit context and
      // double the token cost; nothing in the pipeline benefits from them.
      let disallowedTools: string[] | undefined;
      if (stage.persona !== 'engineer' && stage.persona !== 'tester') {
        disallowedTools = ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Agent'];
      } else {
        disallowedTools = ['Agent'];
      }

      const agent = this.agentManager.spawn({
        name: `${stage.persona}-${repoName}`,
        persona: stage.persona,
        project: this.config.project,
        stage: `${stage.name}:${repoName}`,
        prompt,
        model: this.resolveModelForStage(stage.name),
        cwd: repoPath,
        projectPrompt,
        permissionMode: 'bypassPermissions',
        disallowedTools,
      });

      if (this.state.stages[index].repos[r]) {
        this.state.stages[index].repos[r].agentId = agent.id;
      }
      this.broadcastState();

      promises.push(
        this.waitForAgent(agent.id)
          .then((result) => {
            // Mark repo as completed
            const repoState = this.state.stages[index].repos[r];
            if (repoState) {
              repoState.status = 'completed';
              repoState.cost = result.cost;
              repoState.artifact = result.artifact;
            }
            this.broadcastState();
            this.checkpoint(); // Save: per-repo completion

            // Write per-repo artifact
            this.writeRepoArtifact(stage, repoName, result.artifact);

            return { repoName, artifact: result.artifact, cost: result.cost };
          })
          .catch((err) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            const repoState = this.state.stages[index].repos[r];
            if (repoState) {
              repoState.status = 'failed';
              repoState.error = errorMsg;
            }
            this.broadcastState();
            return { repoName, artifact: '', cost: 0 };
          }),
      );
    }

    // Wait for all repos to complete
    const results = await Promise.all(promises);
    const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
    const successResults = results.filter((r) => r.artifact);

    // Combine artifacts
    const combined = successResults
      .map((r) => `## ${r.repoName}\n\n${r.artifact}`)
      .join('\n\n---\n\n');

    // If all repos failed, throw
    if (successResults.length === 0 && repos.length > 0) {
      throw new Error(`All repo agents failed for ${stage.name}`);
    }

    return { artifact: combined, cost: totalCost };
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
  ): Promise<{ artifact: string; cost: number }> {
    const repoArtifacts = this.loadRepoArtifacts(repoName);
    const tasks = repoArtifacts.tasks ? parseTasks(repoArtifacts.tasks) : [];

    if (tasks.length === 0) {
      // Fallback: no parseable tasks → single repo-wide spawn (the existing P1 path).
      const prompt = this.buildRepoStagePrompt(stage, repoName, '');
      const agent = this.agentManager.spawn({
        name: `${stage.persona}-${repoName}`,
        persona: stage.persona,
        project: this.config.project,
        stage: `${stage.name}:${repoName}`,
        prompt,
        model: this.resolveModelForStage(stage.name),
        cwd: repoPath,
        projectPrompt,
        permissionMode: 'bypassPermissions',
        disallowedTools: ['Read', 'Grep', 'Glob', 'Agent'],
      });
      const repoStateForFallback = this.state.stages[stageIndex].repos[repoIdx];
      if (repoStateForFallback) repoStateForFallback.agentId = agent.id;
      this.broadcastState();
      const res = await this.waitForAgent(agent.id);
      const repoStateAfter = this.state.stages[stageIndex].repos[repoIdx];
      if (repoStateAfter) {
        repoStateAfter.status = 'completed';
        repoStateAfter.cost = res.cost;
        repoStateAfter.artifact = res.artifact;
      }
      this.broadcastState();
      this.checkpoint();
      this.writeRepoArtifact(stage, repoName, res.artifact);
      return res;
    }

    const groups = groupTasksForExecution(tasks);
    this.emit('project-event', {
      source: 'pipeline',
      message: `[build] ${repoName}: ${tasks.length} task${tasks.length === 1 ? '' : 's'} in ${groups.length} group${groups.length === 1 ? '' : 's'} (per-task spawning)`,
    });

    const taskOutputs: { id: string; title: string; artifact: string }[] = [];
    let totalCost = 0;

    for (const group of groups) {
      if (this.cancelled) throw new Error('Pipeline cancelled');

      const groupPromises = group.tasks.map((task) => {
        const prompt = this.buildPerTaskPrompt(stage, repoName, repoPath, task, repoArtifacts.specs);
        const agent = this.agentManager.spawn({
          name: `engineer-${repoName}-${task.id}`,
          persona: stage.persona,
          project: this.config.project,
          stage: `${stage.name}:${repoName}:${task.id}`,
          prompt,
          model: this.resolveModelForStage(stage.name),
          cwd: repoPath,
          projectPrompt,
          permissionMode: 'bypassPermissions',
          disallowedTools: ['Read', 'Grep', 'Glob', 'Agent'],
        });

        const repoStateForSpawn = this.state.stages[stageIndex].repos[repoIdx];
        if (repoStateForSpawn) repoStateForSpawn.agentId = agent.id;
        this.broadcastState();

        return this.waitForAgent(agent.id)
          .then((res) => {
            totalCost += res.cost;
            taskOutputs.push({ id: task.id, title: task.title, artifact: res.artifact });
            this.emit('project-event', {
              source: 'pipeline',
              message: `[build] ${repoName} ${task.id} done (${(res.cost * 100).toFixed(2)}¢)`,
            });
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            taskOutputs.push({
              id: task.id,
              title: task.title,
              artifact: `## Implementation: ${task.id} — ${task.title}\n\nUNRESOLVED: ${msg}\n`,
            });
            this.emit('project-event', {
              source: 'pipeline',
              message: `[build] ${repoName} ${task.id} failed: ${msg}`,
              level: 'warn',
            });
          });
      });

      await Promise.all(groupPromises);
    }

    // Sort outputs by original task order so the artifact reads top-to-bottom.
    const idOrder = new Map(tasks.map((t, i) => [t.id, i]));
    taskOutputs.sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));
    const combined = taskOutputs.map((t) => t.artifact.trim()).join('\n\n---\n\n');

    const repoStateDone = this.state.stages[stageIndex].repos[repoIdx];
    if (repoStateDone) {
      repoStateDone.status = 'completed';
      repoStateDone.cost = totalCost;
      repoStateDone.artifact = combined;
    }
    this.broadcastState();
    this.checkpoint();
    this.writeRepoArtifact(stage, repoName, combined);

    return { artifact: combined, cost: totalCost };
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
    // Header — feature + context. Always kept (non-truncatable, top priority).
    const headerLines: string[] = [
      `Feature: "${this.config.feature}"`,
      ``,
      `## Context`,
      `- Repository: "${repoName}" at ${repoPath}`,
      `- Feature branch: anvil/${this.state.featureSlug}`,
      `- You are implementing exactly one task: ${task.id}.`,
    ];
    if (task.prerequisites.length > 0) {
      headerLines.push(`- Prerequisite tasks already complete: ${task.prerequisites.join(', ')}.`);
    }

    // Build each block as its own enforceBudget section so we can drop/truncate
    // selectively when over budget. Priorities: header/instructions=100, task=90,
    // files=80, spec slice=60, retry context=70.
    const sections: PromptSection[] = [];
    sections.push({ id: 'header', text: headerLines.join('\n'), priority: 100 });
    sections.push({ id: 'task', text: `## Your task\n${task.block}`, priority: 90 });

    if (task.specRef && specsMd) {
      const slice = sliceSpecForRefs(specsMd, [task.specRef], { maxBytes: 8000, includeOverview: false });
      if (slice.text) {
        sections.push({ id: 'spec-slice', text: slice.text, priority: 60, truncatable: true });
      }
    }

    if (task.files.length > 0) {
      const bundle = bundleFiles({ repoPath, files: task.files, maxBytes: 80_000 });
      if (bundle.included.length > 0) {
        sections.push({
          id: 'files',
          text: `## Files for this task (pre-bundled — do NOT re-read)\n${bundle.block}`,
          priority: 80,
          truncatable: true,
        });
      }
      if (bundle.skipped.length > 0) {
        const lines = bundle.skipped.map((s) => `- ${s.path} (${s.reason})`).join('\n');
        sections.push({
          id: 'files-skipped',
          text: `## Files NOT in bundle\nIf you need any of these, output \`NEED_FILE: path\` and stop. Do not guess contents.\n${lines}`,
          priority: 75,
        });
      }
    }

    if (this.config.failureContext) {
      sections.push({
        id: 'retry-context',
        text: `IMPORTANT — This is a RETRY. Previous failure:\n${this.config.failureContext}`,
        priority: 70,
        truncatable: true,
      });
    }

    const instructionLines: string[] = [
      `## Instructions`,
      `Implement only ${task.id}. Read/Grep/Glob/Agent are disabled — every file you may need is in the <files> block above.`,
      `- Use Edit/Write to modify files; use Bash only to run tests/build.`,
      `- Bash discipline: run only the focused test for this task (e.g. \`npx vitest run path/to/file.test.ts\`, \`go test ./pkg/foo -run TestX\`). Do NOT run the full suite. Pipe verbose output through \`tail -50\` so the result fits in context.`,
      `- If a file you need is missing from the bundle, output \`NEED_FILE: <path>\` on its own line and stop.`,
      `- Output the tight summary format from your persona spec — do NOT dump file contents.`,
      `- Do NOT make git commits — that happens in the ship stage.`,
      `- Do NOT modify scope outside the files listed for this task. If you discover the task needs out-of-scope changes, flag them in the Notes section and stop.`,
    ];
    sections.push({ id: 'instructions', text: instructionLines.join('\n'), priority: 100 });

    const result = enforceBudget(sections, { maxBytes: 120_000 });
    if (result.trimmed) {
      const dropped = result.decisions.filter((d) => d.action !== 'kept').map((d) => `${d.id}=${d.action}`).join(', ');
      this.emit('project-event', {
        source: 'context-budget',
        message: `[build] ${repoName} ${task.id}: prompt over 120KB — ${dropped}`,
        level: 'warn',
      });
    }
    return result.text;
  }

  // ── Single-agent stage execution ───────────────────────────────────

  private async runSingleStage(
    index: number,
    stage: StageDefinition,
    prevArtifact: string,
  ): Promise<{ artifact: string; cost: number }> {
    const prompt = this.buildStagePrompt(stage, prevArtifact);
    const projectPrompt = this.buildProjectPrompt(stage);

    // Non-engineer/tester personas cannot write files. Agent tool always disabled (P8).
    const disallowedTools = (stage.persona !== 'engineer' && stage.persona !== 'tester')
      ? ['Write', 'Edit', 'NotebookEdit', 'Agent']
      : ['Agent'];

    const agent = this.agentManager.spawn({
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
    });

    this.state.stages[index].agentId = agent.id;
    this.broadcastState();
    this.emit('stage-start', index, agent.id);

    return this.waitForAgent(agent.id);
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

  // ── Agent completion helper ────────────────────────────────────────

  private waitForAgent(agentId: string): Promise<{ artifact: string; cost: number }> {
    return new Promise((resolve, reject) => {
      const checkDone = () => {
        if (this.cancelled) return reject(new Error('Pipeline cancelled'));

        const current = this.agentManager.getAgent(agentId);
        if (!current) return reject(new Error('Agent disappeared'));

        if (current.status === 'done') {
          resolve({
            artifact: current.output,
            cost: current.cost.totalUsd,
          });
        } else if (current.status === 'error' || current.status === 'killed') {
          reject(new Error(current.error ?? 'Agent failed'));
        } else {
          setTimeout(checkDone, 500);
        }
      };
      checkDone();
    });
  }

  // ── Validate-fix helpers ────────────────────────────────────────────

  /** Check if validation artifact indicates failures */
  private hasValidationFailures(artifact: string): boolean {
    if (!artifact) return false;

    // Explicit markers always win.
    if (/VERDICT:\s*FAIL/i.test(artifact)) return true;
    if (/\bUNRESOLVED\b/i.test(artifact)) return true;

    // Otherwise, check each line. A failure line looks like "tests failed",
    // "build failed", "typecheck failed", "lint errored" — tightly scoped,
    // NOT cross-line. Lines with PASS markers are explicitly excluded.
    for (const rawLine of artifact.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      // Tables / bullets with PASS are healthy.
      if (/\bPASS\b/.test(line) && !/\bFAIL\b/.test(line)) continue;
      // Explicit failure phrases near build/lint/test/typecheck subjects.
      if (/\b(?:build|lint|linting|typecheck|type[- ]?check|tests?)\s+(?:failed|failing|errored|broken|has\s+errors?|exits?\s+non-?zero)\b/i.test(line)) return true;
      // Common failure glyphs in CI output.
      if (/(?:^|\s)(?:✗|✖|❌|FAILED:|FAIL:)/.test(line)) return true;
      // Jest/Vitest-style "N failed" or "N failing" count summaries.
      if (/\b[1-9]\d*\s+(?:failed|failing)\b/i.test(line)) return true;
    }
    return false;
  }

  /**
   * Deterministic test-generation stage: fingerprint per repo → extract behaviors
   * from plan → ground → emit test cases → write to repos → persist TestSpec +
   * TestCase artifacts. No LLM calls in Phase 1; validate runs whatever lands.
   */
  private async runTestGenStage(stageIndex: number): Promise<string> {
    if (!this.config.planSeed) return 'Test stage skipped (no plan seed).';

    const { fingerprintConventions } = await import('./convention-fingerprinter.js');
    const { extractBehaviorsFromPlan } = await import('./behavior-extractor.js');
    const { groundBehaviors } = await import('./test-grounder.js');
    const { emitTestCase } = await import('./test-code-emitter.js');
    const { TestSpecStore } = await import('./test-spec-store.js');
    const { TestCaseStore } = await import('./test-case-store.js');

    const plan = this.config.planSeed.plan;
    const repoNames = this.state.repoNames.length ? this.state.repoNames : Object.keys(this.repoPaths);
    const repoLocalPaths: Record<string, string> = {};
    for (const r of repoNames) repoLocalPaths[r] = this.repoPaths[r] ?? join(this.workspaceDir, r);

    // Fingerprint conventions on the first repo that has code; that becomes the
    // reference for the whole spec. If a repo has its own fingerprint later,
    // individual test cases can be re-emitted per repo.
    let conventions = await fingerprintConventions(
      Object.values(repoLocalPaths).find((p) => existsSync(p)) ?? this.workspaceDir,
    );
    this.state.stages[stageIndex].artifact = `Detected runner: ${conventions.runner}\n`;

    // Extract Behaviors from the plan (deterministic).
    const behaviors = extractBehaviorsFromPlan(plan, { maxPerRepo: 20 });
    if (behaviors.length === 0) {
      return `Test stage skipped (no behaviors extracted from plan ${plan.slug}).`;
    }

    // Ground against disk in all repos.
    const grounded = await groundBehaviors(behaviors, repoLocalPaths);
    const resolvedBehaviors = grounded.map((g) => g.behavior);

    // Persist TestSpec (v1).
    const specStore = new TestSpecStore();
    const spec = specStore.createSpec(this.config.project, plan.title || plan.slug, plan.model ?? this.config.model, {
      title: `Tests for ${plan.title || plan.slug}`,
      source: {
        plan: { slug: plan.slug, version: plan.version },
        files: plan.repos.flatMap((r) => r.files ?? []),
      },
      behaviors: resolvedBehaviors,
      conventions,
    });

    // Emit deterministic TestCase scaffolds.
    const cases = resolvedBehaviors.map((b) =>
      emitTestCase(b, conventions, {
        specSlug: spec.slug,
        specVersion: spec.version,
        projectSlug: this.config.project,
      }),
    );
    const caseStore = new TestCaseStore();
    caseStore.writeCases(this.config.project, spec.slug, spec.version, cases);

    // Write each test file into the appropriate repo. The emitter picks a file
    // path relative to the target file's directory; we rebase onto each repo's
    // local clone by best-matching the target file against repo file trees.
    let writtenCount = 0;
    const notes: string[] = [];
    for (const c of cases) {
      const behavior = resolvedBehaviors.find((b) => b.id === c.behaviorId);
      if (!behavior) continue;
      const targetRepo = this.pickRepoForBehavior(behavior, repoLocalPaths);
      if (!targetRepo) {
        notes.push(`- ${behavior.intent}: no repo match for target ${behavior.target.file}`);
        continue;
      }
      const fullPath = join(repoLocalPaths[targetRepo], c.filePath);
      try {
        if (!existsSync(fullPath) || readFileSync(fullPath, 'utf-8').includes('// anvil-generated')) {
          mkdirSync(dirname(fullPath), { recursive: true });
          const header = `// anvil-generated — spec:${spec.slug}@v${spec.version} behavior:${c.behaviorId}\n`;
          const tmp = fullPath + '.tmp';
          writeFileSync(tmp, header + c.code, 'utf-8');
          renameSync(tmp, fullPath);
          writtenCount++;
        } else {
          notes.push(`- ${c.filePath}: existing hand-written test, not overwritten`);
        }
      } catch (err) {
        notes.push(`- ${c.filePath}: write failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    const summary = [
      `Runner: ${conventions.runner} · file layout: ${conventions.fileLayout}`,
      `Behaviors extracted: ${resolvedBehaviors.length} (${resolvedBehaviors.filter((b) => b.ground.confidence >= 1).length} fully grounded)`,
      `Test cases written: ${writtenCount}/${cases.length}`,
      `Spec: ${spec.slug}@v${spec.version}`,
      notes.length ? `\nNotes:\n${notes.join('\n')}` : '',
    ].join('\n');

    // Broadcast via pipeline state artifact — dashboard consumers can subscribe.
    this.emit('artifact-written', {
      stage: 'test',
      file: `tests/${spec.slug}/spec-v${spec.version}.json`,
      summary: `${writtenCount} test case${writtenCount !== 1 ? 's' : ''} generated`,
      content: summary,
    });

    return summary;
  }

  /** Pick the repo whose local path contains the behavior's target file. */
  private pickRepoForBehavior(
    behavior: { target: { file: string } },
    repoLocalPaths: Record<string, string>,
  ): string | null {
    const targetBase = behavior.target.file.split('/').pop() ?? '';
    for (const [repoName, path] of Object.entries(repoLocalPaths)) {
      if (!path || !existsSync(path)) continue;
      try {
        const full = join(path, behavior.target.file);
        if (existsSync(full)) return repoName;
      } catch { /* ignore */ }
    }
    // Fallback: first repo with any file matching the basename.
    if (!targetBase) return Object.keys(repoLocalPaths)[0] ?? null;
    for (const [repoName, path] of Object.entries(repoLocalPaths)) {
      if (!path || !existsSync(path)) continue;
      try {
        const found = execSync(`find "${path}" -name "${targetBase}" -not -path "*/node_modules/*" | head -1`, {
          encoding: 'utf-8', timeout: 5_000,
        }).trim();
        if (found) return repoName;
      } catch { /* continue */ }
    }
    return Object.keys(repoLocalPaths)[0] ?? null;
  }

  /** Run engineer agents to fix validation issues, then return */
  /** Per-repo agent ids carried across fix-loop attempts so attempt 2+ resumes the prior session (P9). */
  private fixLoopAgentByRepo: Map<string, string> = new Map();
  private fixLoopAgentSingle: string | null = null;

  private async runFixLoop(
    _validateStageIndex: number,
    validateArtifact: string,
    attempt: number,
  ): Promise<{ artifact: string; cost: number }> {
    const buildStage = STAGES.find((s) => s.name === 'build')!;
    const repos = this.state.repoNames;
    let totalCost = 0;

    if (repos.length === 0) {
      // Single-agent fix — resume the prior session on attempt ≥ 2 (P9).
      const issuesBlock = validateArtifact.slice(0, 6000);
      const priorId = this.fixLoopAgentSingle;
      if (priorId && attempt > 1 && this.agentManager.getAgent(priorId)) {
        const followUp = `Validation still failing after your last fix (attempt ${attempt}). Issues:\n\n${issuesBlock}\n\nFix the remaining errors and re-run tests.`;
        this.agentManager.sendInput(priorId, followUp);
        return this.waitForAgent(priorId);
      }
      const prompt = `The validation stage found issues that need to be fixed (attempt ${attempt}):\n\n${issuesBlock}\n\nFix ALL build errors, lint errors, and test failures. Run the build and tests again to verify. Do NOT make git commits.`;
      const agent = this.agentManager.spawn({
        name: `fixer-${this.config.project}-${attempt}`,
        persona: 'engineer',
        project: this.config.project,
        stage: `fix-${attempt}`,
        prompt,
        model: this.resolveModelForStage('validate'),
        cwd: this.workspaceDir,
        projectPrompt: this.buildProjectPrompt(buildStage),
        permissionMode: 'bypassPermissions',
        disallowedTools: ['Agent'],
      });
      this.fixLoopAgentSingle = agent.id;
      return this.waitForAgent(agent.id);
    }

    // Per-repo fix
    const promises = repos.map(async (repoName) => {
      const repoPath = this.repoPaths[repoName] || join(this.workspaceDir, repoName);

      // Extract repo-specific issues from validate artifact
      const repoSection = this.extractRepoSection(validateArtifact, repoName);
      if (!repoSection || !this.hasValidationFailures(repoSection)) {
        return { artifact: '', cost: 0 };  // this repo is fine
      }

      const issuesBlock = repoSection.slice(0, 4000);
      const priorId = this.fixLoopAgentByRepo.get(repoName);
      if (priorId && attempt > 1 && this.agentManager.getAgent(priorId)) {
        const followUp = `Validation still failing in "${repoName}" after your last fix (attempt ${attempt}). Issues:\n\n${issuesBlock}\n\nFix the remaining errors and re-run tests.`;
        this.agentManager.sendInput(priorId, followUp);
        return this.waitForAgent(priorId);
      }

      const prompt = `The validation stage found issues in "${repoName}" that need to be fixed (attempt ${attempt}):\n\n${issuesBlock}\n\nFix ALL build errors, lint errors, and test failures in this repo. Run the build and tests again to verify. Do NOT make git commits.`;
      const agent = this.agentManager.spawn({
        name: `fixer-${repoName}-${attempt}`,
        persona: 'engineer',
        project: this.config.project,
        stage: `fix-${attempt}:${repoName}`,
        prompt,
        model: this.resolveModelForStage('validate'),
        cwd: repoPath,
        projectPrompt: this.buildRepoProjectPrompt(buildStage, repoName),
        permissionMode: 'bypassPermissions',
        disallowedTools: ['Agent'],
      });
      this.fixLoopAgentByRepo.set(repoName, agent.id);
      return this.waitForAgent(agent.id);
    });

    const results = await Promise.all(promises);
    const combinedArtifact = results.map((r) => r.artifact).filter(Boolean).join('\n\n');
    totalCost = results.reduce((sum, r) => sum + r.cost, 0);

    return { artifact: combinedArtifact, cost: totalCost };
  }

  /** Extract the section of a validate artifact related to a specific repo */
  private extractRepoSection(artifact: string, repoName: string): string {
    // Try to find a section headed with the repo name
    const regex = new RegExp(`## ${repoName}[\\s\\S]*?(?=## \\w|$)`, 'i');
    const match = artifact.match(regex);
    if (match) return match[0];

    // Fallback: check if repo name appears anywhere with error context
    if (artifact.includes(repoName)) return artifact;
    return '';
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

    for (const repo of repos) {
      try {
        // Load commands from project config (factory.yaml)
        const repoCommands = this.projectLoader.getRepoCommands(this.config.project, repo.name);
        if (repoCommands?.format) {
          this.runSilent(repoCommands.format, repo.path, repo.name);
        }
        if (repoCommands?.lint) {
          this.runSilent(repoCommands.lint, repo.path, repo.name);
        }

        // Fallback to language-based detection if no config
        if (!repoCommands?.format && !repoCommands?.lint) {
          const hasGo = this.fileExists(repo.path, 'go.mod');
          const hasTs = this.fileExists(repo.path, 'tsconfig.json');
          const hasPackageJson = this.fileExists(repo.path, 'package.json');
          const hasPython = this.fileExists(repo.path, 'pyproject.toml') || this.fileExists(repo.path, 'setup.py');

          if (hasGo) {
            this.runSilent('gofmt -w .', repo.path, repo.name);
            this.runSilent('golangci-lint run --fix ./... 2>/dev/null', repo.path, repo.name);
          }

          if (hasTs || hasPackageJson) {
            this.runSilent('npx prettier --write "**/*.{ts,tsx,js,jsx}" --ignore-unknown 2>/dev/null', repo.path, repo.name);
            this.runSilent('npx eslint --fix "**/*.{ts,tsx,js,jsx}" 2>/dev/null', repo.path, repo.name);
          }

          if (hasPython) {
            this.runSilent('black . 2>/dev/null', repo.path, repo.name);
            this.runSilent('ruff check --fix . 2>/dev/null', repo.path, repo.name);
          }
        }
      } catch (err) {
        // Guards are best-effort — don't fail the pipeline
        console.warn(`[pipeline] Post-build guard error in ${repo.name}:`, err);
      }
    }

    console.log('[pipeline] Post-build guards complete.');
  }

  private runSilent(cmd: string, cwd: string, _repoName: string): void {
    try {
      execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 });
    } catch {
      // Silently ignore — formatters/linters may not be installed
    }
  }

  private fileExists(dir: string, filename: string): boolean {
    try {
      return existsSync(join(dir, filename));
    } catch {
      return false;
    }
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
    const project = this.config.project;
    const mode = this.config.deploy;
    if (!mode) return;

    const isRemote = mode === 'remote';
    const label = isRemote ? 'remote sandbox' : 'local environment';

    // Resolve deploy command: factory.yaml > ANVIL_DEPLOY_CMD env > skip
    const factoryConfig = this.projectLoader.getConfig(project);
    const configDeployCmd = factoryConfig?.pipeline?.ship?.deploy;
    const envDeployCmd = process.env.ANVIL_DEPLOY_CMD || process.env.FF_DEPLOY_CMD;

    let cmd: string;
    if (configDeployCmd) {
      cmd = configDeployCmd;
      console.log(`[pipeline] Using deploy command from factory.yaml: ${cmd}`);
    } else if (envDeployCmd) {
      cmd = isRemote ? `${envDeployCmd} up ${project} --remote` : `${envDeployCmd} up ${project}`;
      console.log(`[pipeline] Using deploy command from ANVIL_DEPLOY_CMD: ${cmd}`);
    } else {
      console.log(`[pipeline] No deploy command configured — skipping sandbox deployment`);
      return;
    }
    console.log(`[pipeline] Deploying ${project} to ${label}...`);

    try {
      const result = execSync(cmd, {
        cwd: this.workspaceDir,
        timeout: 10 * 60 * 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();

      // Try to extract URL from output
      const urlMatch = result.match(/https?:\/\/\S+/);
      if (urlMatch) {
        console.log(`[pipeline] Deployed: ${urlMatch[0]}`);
        this.emit('artifact-written', {
          stage: 'ship',
          file: isRemote ? 'SANDBOX_URL' : 'LOCAL_URL',
          summary: `${label} deployed: ${urlMatch[0]}`,
          content: urlMatch[0],
        });
      } else {
        console.log(`[pipeline] ${label} deployed for ${project}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[pipeline] Deploy to ${label} failed (non-fatal): ${msg}`);
    }
  }

  // ── Feature branch creation ────────────────────────────────────────

  /**
   * Create a feature branch in each repo before the build stage.
   * Branch name: anvil/<feature-slug>
   */
  private createFeatureBranches(): void {
    const branchName = `anvil/${this.state.featureSlug}`;
    console.log(`[pipeline] Creating feature branch "${branchName}" in all repos...`);

    for (const repoName of this.state.repoNames) {
      const repoPath = this.repoPaths[repoName] || join(this.workspaceDir, repoName);
      try {
        // Check if branch already exists
        try {
          execSync(`git rev-parse --verify "${branchName}"`, { cwd: repoPath, stdio: 'pipe' });
          // Branch exists — check it out
          execSync(`git checkout "${branchName}"`, { cwd: repoPath, stdio: 'pipe' });
          console.log(`[pipeline] Checked out existing branch "${branchName}" in ${repoName}`);
        } catch {
          // Branch doesn't exist — create it from current HEAD
          execSync(`git checkout -b "${branchName}"`, { cwd: repoPath, stdio: 'pipe' });
          console.log(`[pipeline] Created branch "${branchName}" in ${repoName}`);
        }
      } catch (err) {
        console.warn(`[pipeline] Failed to create branch in ${repoName}:`, err);
      }
    }

    // Also create branch in workspace root if no repos
    if (this.state.repoNames.length === 0) {
      try {
        try {
          execSync(`git rev-parse --verify "${branchName}"`, { cwd: this.workspaceDir, stdio: 'pipe' });
          execSync(`git checkout "${branchName}"`, { cwd: this.workspaceDir, stdio: 'pipe' });
        } catch {
          execSync(`git checkout -b "${branchName}"`, { cwd: this.workspaceDir, stdio: 'pipe' });
        }
        console.log(`[pipeline] Created branch "${branchName}" in workspace root`);
      } catch (err) {
        console.warn(`[pipeline] Failed to create branch in workspace root:`, err);
      }
    }
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
    // Load the full persona prompt from the markdown file
    const personaPrompt = loadPersonaPromptSync(stage.persona);

    if (personaPrompt) {
      // Inject template variables
      const repoList = this.state.repoNames.length > 0
        ? this.state.repoNames.join(', ')
        : '(single-repo or monorepo)';

      // Load persistent memory for this project (P10: cap at 4KB, P11: drop placeholder)
      const projectMemory = this.memoryStore.formatForPrompt(this.config.project, 'memory');
      const userProfile = this.memoryStore.formatForPrompt(this.config.project, 'user');
      const memoryRaw = [projectMemory, userProfile].filter(Boolean).join('\n\n');
      const memoryBlock = memoryRaw.length > 4000 ? memoryRaw.slice(0, 4000) + '\n... [memory truncated]' : memoryRaw;

      // Load knowledge graph — prefer compact index + query-matched context over full blob
      let knowledgeGraph = '';
      const indexPrompt = this.kbManager?.getIndexForPrompt(this.config.project) || '';
      if (indexPrompt) {
        // Use index + pre-query for focused context
        const queryContext = this.kbManager?.getQueryContextForPrompt(this.config.project, this.config.feature) || '';
        knowledgeGraph = `${indexPrompt}\n\n---\n\n${queryContext}`;
        console.log(`[pipeline] buildProjectPrompt("${stage.name}"): KB index (${indexPrompt.length} chars) + query context (${queryContext.length} chars) = ${knowledgeGraph.length} total`);
      } else {
        // Fallback: full KB blob (no index built yet)
        knowledgeGraph = this.kbManager?.getAllGraphReports(this.config.project) || '';
        console.log(`[pipeline] buildProjectPrompt("${stage.name}"): KB fallback full blob = ${knowledgeGraph ? `${knowledgeGraph.length} chars` : 'EMPTY'}`);
      }

      // Emit explicit integration events for the output panel
      if (knowledgeGraph) {
        this.emit('project-event', {
          source: 'knowledge-base',
          message: `Knowledge Base loaded for "${this.config.project}" (${knowledgeGraph.length} chars, ${indexPrompt ? 'index + query-matched' : 'full blob'}) → injecting into ${stage.persona} agent`,
        });
      } else {
        this.emit('project-event', {
          source: 'knowledge-base',
          message: `No Knowledge Base available for "${this.config.project}" — ${stage.persona} agent will explore codebase manually`,
          level: 'warn',
        });
      }
      if (this.projectYaml && this.projectYaml.length > 10) {
        this.emit('project-event', {
          source: 'project-context',
          message: `Project config loaded for "${this.config.project}" (${this.projectYaml.slice(0, 8000).length} chars) → injecting into ${stage.persona} agent`,
        });
      }

      // Apply context budget to avoid exceeding provider token limits
      const budgeted = budgetPromptContext({
        featureDescription: `Feature: "${this.config.feature}"\nProject: ${this.config.project}\nRepositories: ${repoList}`,
        stagePrompt: personaPrompt,
        knowledgeBase: knowledgeGraph,
        priorArtifacts: '', // Prior artifacts are in the user prompt, not project prompt
        memory: memoryBlock,
        projectYaml: this.projectYaml.slice(0, 8000) || '(not available)',
        overrides: '', // Will be added after injection
        modelId: this.config.model,
      });

      if (budgeted.warning) {
        console.warn(`[pipeline] Context budget: ${budgeted.warning}`);
        this.emit('project-event', {
          source: 'context-budget',
          message: budgeted.warning,
          level: 'warn',
        });
      }

      const tokenInfo = `[Context: ~${Math.round(budgeted.totalTokens / 1000)}K / ${Math.round(budgeted.limit / 1000)}K tokens]`;
      console.log(`[pipeline] ${stage.name} prompt ${tokenInfo}`);

      // P11: drop empty-state placeholders.
      const injected = injectTemplateVars(personaPrompt, {
        project_yaml: budgeted.projectYaml,
        task: `Feature: "${this.config.feature}"\nProject: ${this.config.project}\nRepositories: ${repoList}`,
        conventions: '',
        memories: budgeted.memory,
        knowledge_graph: budgeted.knowledgeBase,
        repo_context: `Project: ${this.config.project}\nRepositories: ${repoList}\nWorkspace: ${this.workspaceDir}`,
        existing_code: budgeted.knowledgeBase ? '(see Knowledge Graph section above)' : '',
      });

      // Append pipeline-specific overrides
      const overrides: string[] = [];

      // Non-coding personas must NOT write files — output text only, pipeline persists artifacts
      if (stage.persona !== 'engineer') {
        overrides.push('CRITICAL — NO FILE WRITES: Do NOT use the Write tool, do NOT create files, do NOT run mkdir. Output your documents as plain text in your response. The pipeline will persist your output automatically. The workspace repos must contain ONLY source code changes, never markdown artifacts.');
      }

      if (knowledgeGraph) {
        overrides.push(`CRITICAL — KNOWLEDGE BASE USAGE:
A pre-computed Knowledge Base has been injected into the "Codebase Knowledge Graph" section above. It contains:
1. **Project-level synthesis** (if available): Cross-repo dependencies, shared concepts, and architecture overview for the entire "${this.config.project}" project.
2. **Per-repo analysis**: AST-extracted modules, functions, imports, call graphs, and community clusters for each repository.

**You MUST follow this traversal strategy:**
- START by reading the Project Knowledge Base section (if present) to understand how repos relate to each other.
- THEN read the per-repo sections relevant to your task for detailed module/function information.
- ONLY read specific source files when you need exact implementation details (API signatures, data model fields) not covered by the KB.
- When you use KB information, explicitly state it: e.g., "From the Knowledge Base, I can see that module X in repo Y handles Z..."
- Do NOT broadly explore files when the KB already provides the architectural map.`);
        if (stage.persona === 'analyst') {
          overrides.push('IMPORTANT — ANALYST DIRECTIVE: The Knowledge Base provides sufficient architectural context for writing requirements. Do NOT spawn sub-agents to explore the codebase. Do NOT run find/ls/tree commands. Reference specific KB findings in your requirements (e.g., "Based on KB analysis of module X..."). Only read a specific file if you need to verify a concrete implementation detail.');
        }
      }
      if (stage.persona === 'clarifier') {
        overrides.push('IMPORTANT: Format each clarifying question as a separate numbered item (1. 2. 3. etc). Each question will be shown to the user one at a time in an interactive Q&A flow. Keep each question self-contained. Do NOT combine multiple questions into one item.');
      }
      if (stage.persona === 'engineer') {
        overrides.push('IMPORTANT: Do NOT make git commits. Commits happen in the ship stage on a feature branch.');
      }
      if (stage.persona === 'tester') {
        overrides.push('IMPORTANT: Do NOT make git commits. Commits happen in the ship stage on a feature branch.');
        overrides.push('CRITICAL: You MUST fix ALL build errors, lint errors, and test failures before completing. Iterate until the codebase is clean. End your output with "VERDICT: PASS" or "VERDICT: FAIL" so the pipeline knows whether to proceed to shipping.');
      }

      const finalPrompt = injected + (overrides.length > 0 ? '\n\n' + overrides.join('\n') : '');
      this.warnIfSystemPromptOversized(`${stage.persona}/${stage.name}`, finalPrompt);
      return finalPrompt;
    }

    // Fallback if prompt file not found
    return `You are the ${stage.persona} agent in an Anvil pipeline for the "${this.config.project}" project.\n\nProject YAML:\n${this.projectYaml.slice(0, 4000)}`;
  }

  private buildRepoProjectPrompt(stage: StageDefinition, repoName: string): string {
    // Load the full persona prompt from the markdown file
    const personaPrompt = loadPersonaPromptSync(stage.persona);

    // Find repo info from project data
    const repoInfo = this.projectInfo?.repos.find((r) => r.name === repoName);
    const repoContext = repoInfo
      ? `Repository: ${repoName}\n- GitHub: ${repoInfo.github}\n- Language: ${repoInfo.language}\n- Kind: ${repoInfo.repoKind}\n- Description: ${repoInfo.description}`
      : `Repository: ${repoName}`;

    if (personaPrompt) {
      // Memories: cap to ~4KB total and drop the empty-state placeholder (P10/P11).
      const projectMemory = this.memoryStore.formatForPrompt(this.config.project, 'memory');
      const userProfile = this.memoryStore.formatForPrompt(this.config.project, 'user');
      const memoryRaw = [projectMemory, userProfile].filter(Boolean).join('\n\n');
      const memoryBlock = memoryRaw.length > 4000 ? memoryRaw.slice(0, 4000) + '\n... [memory truncated]' : memoryRaw;

      // Load KB. Tier picked by (persona, stage) — see kbTierForStage (P2).
      // Coding personas get only the focused per-repo KB to keep the system
      // prompt small and cache-stable; design-stage personas get the full
      // index + per-repo + cross-repo + query context for breadth.
      const tier = this.kbTierForStage(stage.persona, stage.name);
      let knowledgeGraph = '';
      let kbSourceLabel: 'none' | 'repo-focused' | 'index-only' | 'full-with-index' | 'full-blob' = 'none';
      if (tier !== 'none') {
        const indexPrompt = this.kbManager?.getIndexForPrompt(this.config.project) || '';
        const repoKB = this.kbManager?.getGraphReport(this.config.project, repoName) || '';
        if (tier === 'repo-focused') {
          knowledgeGraph = repoKB ? `## YOUR TARGET REPO: ${repoName}\n\n${repoKB}` : '';
          if (knowledgeGraph) kbSourceLabel = 'repo-focused';
        } else if (tier === 'index-only') {
          knowledgeGraph = indexPrompt;
          if (knowledgeGraph) kbSourceLabel = 'index-only';
        } else if (indexPrompt) {
          // tier === 'full'
          const queryContext = this.kbManager?.getQueryContextForPrompt(this.config.project, this.config.feature) || '';
          knowledgeGraph = `${indexPrompt}\n\n---\n\n## YOUR TARGET REPO: ${repoName}\n\n${repoKB || '(no repo-specific KB)'}\n\n---\n\n${queryContext}`;
          kbSourceLabel = 'full-with-index';
        } else {
          // Fallback: full blob approach when no index exists
          const fullKB = this.kbManager?.getAllGraphReports(this.config.project) || '';
          if (repoKB) {
            knowledgeGraph += `## YOUR TARGET REPO: ${repoName}\n\n${repoKB}`;
            const otherRepos = fullKB.split('\n\n---\n\n').filter((s) => !s.includes(`## ${repoName}\n`));
            if (otherRepos.length > 0) {
              knowledgeGraph += `\n\n---\n\n## OTHER REPOS (for cross-repo context)\n\n${otherRepos.join('\n\n---\n\n')}`;
            }
          } else {
            knowledgeGraph = fullKB;
          }
          if (knowledgeGraph) kbSourceLabel = 'full-blob';
        }
      }

      // Emit explicit integration events for per-repo prompt
      if (knowledgeGraph) {
        this.emit('project-event', {
          source: 'knowledge-base',
          message: `Knowledge Base loaded for repo "${repoName}" (${knowledgeGraph.length} chars, tier=${kbSourceLabel}) → injecting into ${stage.persona} agent`,
        });
      } else if (tier !== 'none') {
        this.emit('project-event', {
          source: 'knowledge-base',
          message: `No Knowledge Base available for repo "${repoName}" — ${stage.persona} agent will explore codebase manually`,
          level: 'warn',
        });
      }
      if (this.projectYaml && this.projectYaml.length > 10) {
        this.emit('project-event', {
          source: 'project-context',
          message: `Project config loaded for "${this.config.project}" → injecting into ${stage.persona}/${repoName} agent`,
        });
      }

      // Empty-placeholder strings are dropped (P11) — they're noise that the
      // model has to read every spawn. The persona prompt already documents
      // what each block contains; an empty value is self-evident.
      const injected = injectTemplateVars(personaPrompt, {
        project_yaml: this.projectYaml.slice(0, 4000),
        task: `Feature: "${this.config.feature}"\nProject: ${this.config.project}\nTarget repository: ${repoName}`,
        conventions: '',
        memories: memoryBlock,
        knowledge_graph: knowledgeGraph,
        repo_context: repoContext,
        existing_code: knowledgeGraph
          ? '(see Knowledge Graph section above)'
          : '',
      });

      // Append pipeline-specific overrides
      const overrides: string[] = [
        `You are working specifically on the "${repoName}" repository within the "${this.config.project}" project.`,
      ];

      // Non-coding personas must NOT write files — output text only, pipeline persists artifacts
      if (stage.persona !== 'engineer') {
        overrides.push('CRITICAL — NO FILE WRITES: Do NOT use the Write tool, do NOT create files, do NOT run mkdir. Output your documents as plain text in your response. The pipeline will persist your output automatically. The workspace repos must contain ONLY source code changes, never markdown artifacts.');
      }

      if (knowledgeGraph) {
        overrides.push(`CRITICAL — KNOWLEDGE BASE USAGE:
The Knowledge Base above contains your target repo "${repoName}" (labeled "YOUR TARGET REPO") as the primary section, plus the Project Knowledge Base and other repos for cross-repo context.

**You MUST follow this traversal strategy:**
- START with the Project Knowledge Base section (if present) to understand how "${repoName}" relates to other repos in "${this.config.project}".
- THEN read the "${repoName}" section in depth — it has AST-extracted modules, functions, imports, call graphs, and community clusters.
- USE the other repo sections to understand integration points, shared interfaces, and API contracts.
- ONLY read specific source files when you need exact implementation details not covered by the KB.
- When you use KB information, explicitly state it: e.g., "From the Knowledge Base, I can see that module X handles Z..."
- Do NOT broadly explore files when the KB already provides the architectural map.`);
        if (stage.persona === 'analyst') {
          overrides.push(`IMPORTANT — ANALYST DIRECTIVE: The Knowledge Base for "${repoName}" provides sufficient architectural context. Do NOT spawn sub-agents to explore the codebase. Do NOT run find/ls/tree commands. Reference specific KB findings in your requirements. Refer to other repos' KB sections for API contracts and integration points. Only read a specific file if you need to verify a concrete implementation detail.`);
        }
      }
      if (stage.persona === 'engineer' || stage.persona === 'tester') {
        overrides.push('IMPORTANT: Do NOT make git commits. Commits happen in the ship stage on a feature branch.');
      }

      const finalPrompt = injected + '\n\n' + overrides.join('\n');
      this.warnIfSystemPromptOversized(`${stage.persona}/${stage.name}:${repoName}`, finalPrompt);
      return finalPrompt;
    }

    // Fallback if prompt file not found
    return `You are the ${stage.persona} agent working on "${repoName}" in the "${this.config.project}" project.\n\n${repoContext}\n\nProject YAML:\n${this.projectYaml.slice(0, 2000)}`;
  }

  private buildClarifyExplorePrompt(): string {
    const repoList = this.state.repoNames.length > 0
      ? this.state.repoNames.join(', ')
      : '';

    // Load knowledge graph — prefer index + query context
    let kbReport = '';
    const indexPrompt = this.kbManager?.getIndexForPrompt(this.config.project) || '';
    if (indexPrompt) {
      const queryCtx = this.kbManager?.getQueryContextForPrompt(this.config.project, this.config.feature) || '';
      kbReport = `${indexPrompt}\n\n---\n\n${queryCtx}`;
    } else {
      kbReport = this.kbManager?.getAllGraphReports(this.config.project) || '';
    }
    const hasKB = kbReport.length > 100;
    console.log(`[pipeline] Clarify KB for "${this.config.project}": ${hasKB ? `${kbReport.length} chars` : 'none'} (${indexPrompt ? 'index-based' : 'full blob'})`);

    const questionFormat = `IMPORTANT: The user will answer each question one at a time in an interactive conversation. Format each question as a separate numbered item so they can be presented individually.

Format your response EXACTLY like this — each question must start on its own line with a number:
1. **[Question topic]**: Your specific question here?
2. **[Question topic]**: Your specific question here?
3. **[Question topic]**: Your specific question here?

Keep each question self-contained and clear. Do not combine multiple questions into one numbered item. End with: "Please answer these questions so I can proceed with detailed requirements."`;

    if (hasKB) {
      return `Feature: "${this.config.feature}"
Project: ${this.config.project}
Repositories: ${repoList}

## Codebase Knowledge Graph
The following is a pre-computed architectural analysis of the codebase(s). It contains:
- Module/file structure and key components
- Function signatures, class definitions, and their relationships
- Import dependencies and call graphs
- Topological communities (clusters of related code)
- Hub components (highly connected critical nodes)

USE THIS AS YOUR PRIMARY SOURCE OF UNDERSTANDING. Do NOT re-explore the entire codebase.
Only read specific files if you need to verify a detail or understand implementation specifics
that the knowledge graph doesn't cover.

### How to read the Knowledge Graph
- **Graph Statistics**: Node count, edge count, density — gives scale of the codebase
- **Communities**: Topologically clustered modules — each is a logical domain boundary
- **Hub Components (God Nodes)**: Most-connected components — critical integration points
- **Surprising Connections**: Unexpected dependencies that may indicate coupling risks

${kbReport}

---

Based on this architectural understanding, generate 3-5 specific, thoughtful clarifying questions about the feature request that will help produce better requirements.

${questionFormat}`;
    }

    // Fallback: no KB available, use original exploration approach
    return `Feature: "${this.config.feature}"${repoList ? `\n\nThis project contains these repositories: ${repoList}. Explore them to understand the architecture.` : ''}

Explore the codebase thoroughly. Understand the architecture, key files, APIs, data flows, and patterns. Then generate 3-5 specific, thoughtful clarifying questions that will help produce better requirements.

${questionFormat}`;
  }

  private buildStagePrompt(stage: StageDefinition, prevArtifact: string): string {
    const feature = `Feature: "${this.config.feature}"`;
    const prev = prevArtifact ? `\n\n## Previous stage output:\n${prevArtifact.slice(0, 12000)}` : '';
    const resumeCtx = this.config.failureContext
      ? `\n\nIMPORTANT — This is a RETRY. The previous run failed:\n${this.config.failureContext}\nFix the issues and proceed. All prior stage artifacts are included above.`
      : '';
    const repoList = this.state.repoNames.length > 0
      ? `\nRepositories: ${this.state.repoNames.join(', ')}`
      : '';

    switch (stage.name) {
      case 'requirements':
        return `${feature}${repoList}\n\nProduce high-level requirements for this feature across the entire project. Identify which repositories need changes and why. Include success criteria.${prev}${resumeCtx}`;
      case 'ship': {
        const prLabels = ['anvil'];
        const at = this.config.actionType ?? 'feature';
        if (at === 'bugfix' || at === 'fix') prLabels.push('bug');
        else if (at === 'spike' || at === 'review') prLabels.push(at);
        else prLabels.push('enhancement');
        const labelFlags = prLabels.map((l) => `--label "${l}"`).join(' ');
        const baseBranch = this.getBaseBranch();
        return `${feature}${repoList}\n\nShip the changes for each repository. The code has been validated — build, lint, and tests all pass.\n\nThe code is already on a feature branch "anvil/${this.state.featureSlug}". For each repo with changes:\n1. Run a final quick check: build and lint to confirm everything is clean\n2. If ANY errors remain, fix them before proceeding\n3. Stage and commit all changes with a clear commit message: "[anvil] ${this.config.feature}"\n4. Push the feature branch to origin\n5. Create a PR from the feature branch to "${baseBranch}" using: gh pr create --base "${baseBranch}" --head "anvil/${this.state.featureSlug}" ${labelFlags}\n\nDo NOT merge to ${baseBranch}. Only create PRs. Do NOT create a PR if the code has unfixed errors.${prev}${resumeCtx}`;
      }
      default:
        return `${feature}${repoList}${prev}${resumeCtx}`;
    }
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
    const feature = `Feature: "${this.config.feature}"`;
    const repoPath = this.repoPaths[repoName] || join(this.workspaceDir, repoName);

    const resumeCtx = this.config.failureContext
      ? `\n\nIMPORTANT — This is a RETRY. The previous run failed:\n${this.config.failureContext}\nFix the issues and proceed.`
      : '';

    // For early stages (repo-requirements, specs, tasks), use the combined prevArtifact
    const prev = prevArtifact ? `\n\n## Prior stage output:\n${prevArtifact.slice(0, 12000)}` : '';

    // High-level requirements (shared)
    const hlReqs = this.loadHighLevelRequirements();
    const hlReqsBlock = hlReqs ? `\n\n## High-Level Requirements\n${hlReqs.slice(0, 4000)}` : '';

    // For build/validate, load THIS repo's specific artifacts
    const repoArtifacts = this.loadRepoArtifacts(repoName);

    switch (stage.name) {
      case 'repo-requirements':
        return `${feature}\n\nProduce requirements specific to the "${repoName}" repository. What changes does THIS repo need for this feature? Include success criteria.${hlReqsBlock}${prev}`;

      case 'specs': {
        // Use THIS repo's requirements if available, not the combined blob
        const repoReqsBlock = repoArtifacts.requirements
          ? `\n\n## Requirements for ${repoName}\n${repoArtifacts.requirements}`
          : prev;
        return `${feature}\n\nProduce a detailed technical specification for changes in "${repoName}". Include file paths, function signatures, API changes, data model changes, and how components interact.${hlReqsBlock}${repoReqsBlock}`;
      }

      case 'tasks': {
        // Use THIS repo's spec, falling back to requirements
        const specsBlock = repoArtifacts.specs
          ? `\n\n## Technical Specification for ${repoName}\n${repoArtifacts.specs}`
          : '';
        const repoReqsFallback = !specsBlock && repoArtifacts.requirements
          ? `\n\n## Requirements for ${repoName}\n${repoArtifacts.requirements}`
          : '';
        const context = specsBlock || repoReqsFallback || prev;
        return `${feature}\n\nBreak down the spec into ordered implementation tasks for "${repoName}". Each task should include: file path, description, acceptance criteria. Order tasks so dependencies come first.${hlReqsBlock}${context}`;
      }

      case 'build': {
        // Token-efficiency strategy (P1+P4): rather than dumping requirements +
        // full specs + tasks + hlReqs and telling the engineer to "explore the
        // codebase", we (a) inject only the slice of SPECS.md referenced by
        // tasks, (b) pre-read every file in TASK Scope lines and inject them
        // as a <files> block, and (c) instruct the engineer not to read or
        // grep — Read/Grep/Glob are disabled at spawn (see runPerRepoStage).
        const sections: string[] = [feature];

        sections.push(`\n## Context`);
        sections.push(`- Repository: "${repoName}" at ${repoPath}`);
        sections.push(`- Feature branch: anvil/${this.state.featureSlug}`);

        const parsedTasks = repoArtifacts.tasks ? parseTasks(repoArtifacts.tasks) : [];
        const taskFiles: string[] = [];
        const seen = new Set<string>();
        for (const t of parsedTasks) {
          for (const f of t.files) {
            if (!seen.has(f)) { seen.add(f); taskFiles.push(f); }
          }
        }
        const specRefs = parsedTasks.map((t) => t.specRef).filter((r): r is string => !!r);

        if (repoArtifacts.tasks) {
          sections.push(`\n## Implementation Tasks for ${repoName}\n${repoArtifacts.tasks}`);
        }

        if (repoArtifacts.specs && specRefs.length > 0) {
          const slice = sliceSpecForRefs(repoArtifacts.specs, specRefs, { maxBytes: 20000 });
          if (slice.text) sections.push(`\n${slice.text}`);
        } else if (repoArtifacts.specs && !repoArtifacts.tasks) {
          // Fallback: tasks not parseable, send the spec verbatim.
          sections.push(`\n## Technical Specification for ${repoName}\n${repoArtifacts.specs}`);
        }

        if (taskFiles.length > 0) {
          const bundle = bundleFiles({ repoPath, files: taskFiles, maxBytes: 200_000 });
          if (bundle.included.length > 0) {
            sections.push(`\n## Files referenced by tasks (pre-bundled — do NOT re-read)\n${bundle.block}`);
          }
          if (bundle.skipped.length > 0) {
            const lines = bundle.skipped
              .map((s) => `- ${s.path} (${s.reason})`)
              .join('\n');
            sections.push(`\n## Task files NOT in bundle\nIf you need any of these, output \`NEED_FILE: path\` and stop. Do not guess contents.\n${lines}`);
          }
        }

        // Last-resort fallback when there are no parseable tasks or specs.
        if (!repoArtifacts.tasks && !repoArtifacts.specs && prevArtifact) {
          sections.push(`\n## Prior stage output\n${prevArtifact.slice(0, 12000)}`);
        }

        sections.push(`\n## Instructions`);
        sections.push(`Implement each task in order. Read/Grep/Glob/Agent are disabled — every file you may need is in the <files> block above.`);
        sections.push(`- Use Edit/Write to modify files; use Bash only to run tests/build.`);
        sections.push(`- Bash discipline: prefer focused test commands (single file or test name). Pipe verbose output through \`tail -50\`. Do NOT run a whole monorepo suite at once.`);
        sections.push(`- If a file you need is missing from the bundle, output \`NEED_FILE: <path>\` on its own line and stop.`);
        sections.push(`- Write production-quality code; no pseudocode or placeholders.`);
        sections.push(`- Run the build/test step to verify your changes work.`);
        sections.push(`- Do NOT make git commits — that happens in the ship stage.`);
        sections.push(`- Do NOT ask for clarification. Decide from the context above and proceed.`);

        if (resumeCtx) sections.push(resumeCtx);
        return sections.join('\n');
      }

      case 'validate': {
        const sections: string[] = [feature];

        sections.push(`\n## Context`);
        sections.push(`- You are validating the "${repoName}" repository at: ${repoPath}`);
        sections.push(`- Feature branch: anvil/${this.state.featureSlug}`);

        if (repoArtifacts.tasks) {
          sections.push(`\n## Expected Changes (Tasks)\n${repoArtifacts.tasks}`);
        }
        if (repoArtifacts.specs) {
          sections.push(`\n## Technical Specification\n${repoArtifacts.specs.slice(0, 4000)}`);
        }
        if (!repoArtifacts.tasks && !repoArtifacts.specs && prevArtifact) {
          sections.push(`\n## Prior stage output\n${prevArtifact.slice(0, 8000)}`);
        }

        sections.push(`\n## Validation Steps`);
        sections.push(`You MUST ensure the code is fully clean before this stage completes:`);
        sections.push(`1. Run the build (compile/type-check). Fix ALL errors.`);
        sections.push(`2. Run the linter. Fix ALL lint warnings and errors.`);
        sections.push(`3. Run the test suite. Fix ALL failing tests.`);
        sections.push(`4. Repeat steps 1-3 until everything passes with zero errors.`);
        sections.push(`5. Do NOT move on until build, lint, AND tests all pass.`);
        sections.push(`\nIf you cannot fix an issue after 5 attempts, document it clearly as UNRESOLVED.`);
        sections.push(`\nAt the end, output a clear verdict:`);
        sections.push(`- VERDICT: PASS — if build, lint, and tests all pass`);
        sections.push(`- VERDICT: FAIL — if any issues remain unresolved`);
        sections.push(`\nDo NOT make git commits.`);
        sections.push(`Do NOT ask for missing information. Use the codebase and context above to validate.`);

        if (resumeCtx) sections.push(resumeCtx);
        return sections.join('\n');
      }

      default:
        return `${feature}\n\nWork on "${repoName}".${prev}${resumeCtx}`;
    }
  }

  private broadcastState(): void {
    this.emit('state-change', this.state);
  }
}
