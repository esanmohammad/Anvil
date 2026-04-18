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

  // Bundled prompts — navigate from dashboard/server/ to cli/src/personas/prompts/
  const bundledPaths = [
    join(__dirname, '..', '..', 'cli', 'src', 'personas', 'prompts', `${personaName}.md`),
    join(__dirname, '..', '..', '..', 'packages', 'cli', 'src', 'personas', 'prompts', `${personaName}.md`),
  ];

  for (const p of bundledPaths) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8');
      personaPromptCache.set(personaName, content);
      return content;
    }
  }

  console.warn(`[pipeline] Persona prompt not found for "${personaName}", using fallback`);
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
  { index: 0, name: 'clarify',           label: 'Understanding',        persona: 'clarifier', perRepo: false },
  { index: 1, name: 'requirements',      label: 'Planning requirements', persona: 'analyst',   perRepo: false },
  { index: 2, name: 'repo-requirements', label: 'Repo requirements',    persona: 'analyst',   perRepo: true },
  { index: 3, name: 'specs',             label: 'Writing specs',        persona: 'architect', perRepo: true },
  { index: 4, name: 'tasks',             label: 'Creating tasks',       persona: 'lead',      perRepo: true },
  { index: 5, name: 'build',             label: 'Writing code',         persona: 'engineer',  perRepo: true },
  { index: 6, name: 'validate',          label: 'Testing',              persona: 'tester',    perRepo: true },
  { index: 7, name: 'ship',              label: 'Shipping',             persona: 'engineer',  perRepo: false },
];

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
          this.state.stages[i].status = 'skipped';
          this.state.stages[i].artifact = 'Clarification skipped.';
          prevArtifact = 'Clarification skipped.';
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

          // Write artifact to feature folder
          this.writeStageArtifact(i, stage, result.artifact);

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

      const prompt = this.buildRepoStagePrompt(stage, repoName, prevArtifact);
      const projectPrompt = this.buildRepoProjectPrompt(stage, repoName);

      // Non-engineer/tester personas cannot write files — only engineers and testers modify code
      const noWriteTools = (stage.persona !== 'engineer' && stage.persona !== 'tester')
        ? ['Write', 'Edit', 'NotebookEdit', 'Bash'] : undefined;

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
        disallowedTools: noWriteTools,
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

  // ── Single-agent stage execution ───────────────────────────────────

  private async runSingleStage(
    index: number,
    stage: StageDefinition,
    prevArtifact: string,
  ): Promise<{ artifact: string; cost: number }> {
    const prompt = this.buildStagePrompt(stage, prevArtifact);
    const projectPrompt = this.buildProjectPrompt(stage);

    // Non-engineer/tester personas cannot write files
    const noWriteTools = (stage.persona !== 'engineer' && stage.persona !== 'tester')
      ? ['Write', 'Edit', 'NotebookEdit'] : undefined;

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
      disallowedTools: noWriteTools,
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
    return /VERDICT:\s*FAIL/i.test(artifact) ||
           /UNRESOLVED/i.test(artifact) ||
           /(?:build|lint|test).*(?:fail|error)/i.test(artifact);
  }

  /** Run engineer agents to fix validation issues, then return */
  private async runFixLoop(
    _validateStageIndex: number,
    validateArtifact: string,
    attempt: number,
  ): Promise<{ artifact: string; cost: number }> {
    const buildStage = STAGES.find((s) => s.name === 'build')!;
    const repos = this.state.repoNames;
    let totalCost = 0;

    if (repos.length === 0) {
      // Single-agent fix
      const prompt = `The validation stage found issues that need to be fixed (attempt ${attempt}):\n\n${validateArtifact.slice(0, 6000)}\n\nFix ALL build errors, lint errors, and test failures. Run the build and tests again to verify. Do NOT make git commits.`;
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
      });

      const result = await this.waitForAgent(agent.id);
      return result;
    }

    // Per-repo fix
    const promises = repos.map(async (repoName) => {
      const repoPath = this.repoPaths[repoName] || join(this.workspaceDir, repoName);

      // Extract repo-specific issues from validate artifact
      const repoSection = this.extractRepoSection(validateArtifact, repoName);
      if (!repoSection || !this.hasValidationFailures(repoSection)) {
        return { artifact: '', cost: 0 };  // this repo is fine
      }

      const prompt = `The validation stage found issues in "${repoName}" that need to be fixed (attempt ${attempt}):\n\n${repoSection.slice(0, 4000)}\n\nFix ALL build errors, lint errors, and test failures in this repo. Run the build and tests again to verify. Do NOT make git commits.`;
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
      });

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

      // Load persistent memory for this project
      const projectMemory = this.memoryStore.formatForPrompt(this.config.project, 'memory');
      const userProfile = this.memoryStore.formatForPrompt(this.config.project, 'user');
      const memoryBlock = [projectMemory, userProfile].filter(Boolean).join('\n\n') || '(no prior memories)';

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

      const injected = injectTemplateVars(personaPrompt, {
        project_yaml: budgeted.projectYaml || '(not available)',
        task: `Feature: "${this.config.feature}"\nProject: ${this.config.project}\nRepositories: ${repoList}`,
        conventions: '(use existing project conventions found in the codebase)',
        memories: budgeted.memory || '(no prior memories)',
        knowledge_graph: budgeted.knowledgeBase || '(no knowledge base available — run "Refresh Knowledge Base" from the dashboard)',
        repo_context: `Project: ${this.config.project}\nRepositories: ${repoList}\nWorkspace: ${this.workspaceDir}`,
        existing_code: budgeted.knowledgeBase
          ? '(see Knowledge Graph section for codebase structure — explore specific files as needed)'
          : '(explore the codebase to discover relevant code)',
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

      return injected + (overrides.length > 0 ? '\n\n' + overrides.join('\n') : '');
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
      const projectMemory = this.memoryStore.formatForPrompt(this.config.project, 'memory');
      const userProfile = this.memoryStore.formatForPrompt(this.config.project, 'user');
      const memoryBlock = [projectMemory, userProfile].filter(Boolean).join('\n\n') || '(no prior memories)';

      // Load KB — prefer index + query-matched context, with target repo prominently
      let knowledgeGraph = '';
      const indexPrompt = this.kbManager?.getIndexForPrompt(this.config.project) || '';
      if (indexPrompt) {
        const repoKB = this.kbManager?.getGraphReport(this.config.project, repoName) || '';
        const queryContext = this.kbManager?.getQueryContextForPrompt(this.config.project, this.config.feature) || '';
        knowledgeGraph = `${indexPrompt}\n\n---\n\n## YOUR TARGET REPO: ${repoName}\n\n${repoKB || '(no repo-specific KB)'}\n\n---\n\n${queryContext}`;
      } else {
        // Fallback: full blob approach
        const repoKB = this.kbManager?.getGraphReport(this.config.project, repoName) || '';
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
      }

      // Emit explicit integration events for per-repo prompt
      if (knowledgeGraph) {
        this.emit('project-event', {
          source: 'knowledge-base',
          message: `Knowledge Base loaded for repo "${repoName}" (${knowledgeGraph.length} chars, ${indexPrompt ? 'index + query-matched' : 'full blob'}) → injecting into ${stage.persona} agent`,
        });
      } else {
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

      const injected = injectTemplateVars(personaPrompt, {
        project_yaml: this.projectYaml.slice(0, 4000) || '(not available)',
        task: `Feature: "${this.config.feature}"\nProject: ${this.config.project}\nTarget repository: ${repoName}`,
        conventions: '(use existing project conventions found in the codebase)',
        memories: memoryBlock,
        knowledge_graph: knowledgeGraph || '(no knowledge base available for this repo)',
        repo_context: repoContext,
        existing_code: knowledgeGraph
          ? '(see Knowledge Graph section for codebase structure — explore specific files as needed)'
          : '(explore the codebase to discover relevant code)',
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

      return injected + '\n\n' + overrides.join('\n');
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
    const featureDir = this.featureStore.getFeatureDir(this.config.project, this.state.featureSlug);
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
        const sections: string[] = [feature];

        sections.push(`\n## Context`);
        sections.push(`- You are working in the "${repoName}" repository at: ${repoPath}`);
        sections.push(`- Feature branch: anvil/${this.state.featureSlug}`);
        sections.push(`- Planning artifacts are in: ${featureDir}/repos/${repoName}/`);
        sections.push(`- Other repos in this project: ${this.state.repoNames.filter(r => r !== repoName).join(', ') || '(none)'}`);

        // Inject all available repo-specific artifacts
        if (repoArtifacts.requirements) {
          sections.push(`\n## Requirements for ${repoName}\n${repoArtifacts.requirements}`);
        }
        if (repoArtifacts.specs) {
          sections.push(`\n## Technical Specification for ${repoName}\n${repoArtifacts.specs}`);
        }
        if (repoArtifacts.tasks) {
          sections.push(`\n## Implementation Tasks for ${repoName}\n${repoArtifacts.tasks}`);
        }

        // Always include high-level requirements as additional context
        if (hlReqs && !repoArtifacts.requirements) {
          sections.push(`\n## High-Level Feature Requirements\n${hlReqs.slice(0, 6000)}`);
        }

        // If no repo-specific artifacts at all, fall back to prevArtifact
        if (!repoArtifacts.tasks && !repoArtifacts.specs && !repoArtifacts.requirements && prevArtifact) {
          sections.push(`\n## Prior stage output\n${prevArtifact.slice(0, 12000)}`);
        }

        sections.push(`\n## Instructions`);
        sections.push(`Implement the feature for the "${repoName}" repository based on the requirements, specs, and tasks above.`);
        sections.push(`- Explore the existing codebase FIRST to understand current patterns and conventions.`);
        sections.push(`- Write real, production-quality code. Do NOT output pseudocode or placeholders.`);
        sections.push(`- If a task list is provided above, implement each task in order.`);
        sections.push(`- If no explicit task list is available, derive the implementation steps from the requirements and specs, then implement them.`);
        sections.push(`- Run the build/compile step to verify your changes work.`);
        sections.push(`- Do NOT make git commits — that happens in the ship stage.`);
        sections.push(`- Do NOT ask for clarification or say you are missing information. Use the context above and the codebase to make informed decisions and proceed.`);

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
