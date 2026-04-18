// Pipeline Orchestrator — runs the full 8-stage pipeline
//
// Features ported from dashboard PipelineRunner:
//   1. Interactive clarify (one-by-one questions via readline)
//   2. Full persona prompts with template variable injection
//   3. Feature branch creation before build
//   4. Post-build guards (format + lint auto-fix)
//   5. Validate-fix loop (up to 3 retries)
//   6. Memory store integration
//   7. Resume from failed stage
//   8. No git commits during build/validate
//   9. Ship stage prompt with feature branch context

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PIPELINE_STAGES } from './types.js';
import type { AffectedProject } from './types.js';
import { PipelineStateMachine } from './state-machine.js';
import { runParallelPerProject } from './parallel-runner.js';
import type { ParallelRunResult } from './parallel-runner.js';
import { CostTracker } from './cost-tracker.js';
import { PipelineDisplay } from './display.js';
import { detectAffectedProjects } from './affected-projects.js';
import { StageProgress } from '../ui/progress.js';
import { printPipelineSummary } from '../ui/summary.js';
import type { PipelineSummaryData, StageSummary } from '../ui/summary.js';
import { AuditLog } from './audit-log.js';

import {
  runClarifyStage,
  runHighLevelRequirementsStage,
  runProjectRequirementsStage,
  runProjectSpecsStage,
  runProjectTasksStage,
} from './stages/index.js';
import type { AgentRunner, StageContext, StageOutput } from './stages/index.js';

import { runBuildStage } from './stages/build/index.js';
import type { BuildStageConfig, BuildStageResult } from './stages/build/index.js';

import {
  generateRunId,
  generateFeatureSlug,
  createEmptyRunRecord,
  RunStore,
  RunDirectory,
} from '../run/index.js';
import type { RunRecord, CostEntry } from '../run/index.js';

import { getFFDirs, getFFHome } from '../home.js';
import { loadPersonaPrompt } from '../personas/loader.js';
import type { PersonaName } from '../personas/types.js';
import { MemoryStore } from './memory-store-cli.js';
import { info, success, error as logError, warn } from '../logger.js';
import { loadKnowledgeGraph } from '../context/knowledge-graph.js';
import { injectMemories } from '../memory/injector.js';
import { createMemoryStore as createNewMemoryStore } from '../memory/index.js';
import { readLearnings } from '../commands/team.js';
import { parseBytes } from '../project/parser.js';
import type { Project } from '../project/types.js';
import {
  getContextLayerForStage,
  getTokenBudgetForLayer,
  assembleLayeredContext,
} from '../knowledge/context-assembler.js';
import {
  writeDashboardState,
  flushDashboardState,
  updatePipelineStage,
  updatePipelineCost,
  updateStageCost,
  clearActivePipeline,
  setPendingApproval,
  clearPendingApproval,
  readDashboardState,
  drainUserMessages,
} from './state-file.js';
import type { DashboardState, DashboardStageState } from './state-file.js';

// ---------------------------------------------------------------------------
// Persona / stage mapping
// ---------------------------------------------------------------------------

const STAGE_PERSONA_MAP: Record<number, PersonaName> = {
  0: 'clarifier',
  1: 'analyst',
  2: 'analyst',
  3: 'architect',
  4: 'lead',
  5: 'engineer',
  6: 'tester',
  7: 'engineer',
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  project: string;
  feature: string;
  skipClarify?: boolean;
  skipShip?: boolean;
  deploy?: 'local' | 'remote' | false;  // deploy after shipping: local or remote sandbox
  answersFile?: string;
  workingDir?: string;
  model?: string;
  models?: Record<string, string>;
  approvalRequired?: boolean;
  actionType?: 'feature' | 'bugfix' | 'fix' | 'spike' | 'review';
  /** Resume from a specific stage index (skip completed stages before this) */
  resumeFromStage?: number;
  /** Existing feature slug to load prior artifacts from */
  featureSlug?: string;
  /** What went wrong in the previous run (injected into retry prompts) */
  failureContext?: string;
}

export interface OrchestratorResult {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  totalCost: CostEntry;
  prUrls: string[];
  sandboxUrl?: string;
  failedStage?: number;
  failedError?: string;
}

export interface StageRunners {
  runClarifyStage: typeof runClarifyStage;
  runHighLevelRequirementsStage: typeof runHighLevelRequirementsStage;
  runProjectRequirementsStage: typeof runProjectRequirementsStage;
  runProjectSpecsStage: typeof runProjectSpecsStage;
  runProjectTasksStage: typeof runProjectTasksStage;
  runBuildStage: typeof runBuildStage;
}

export interface PipelineDependencies {
  agentRunner: AgentRunner;
  runStore: RunStore;
  projectLoader: {
    findProject: (name: string) => Promise<{ project: string; repos: { name: string; path?: string }[] }>;
    loadAll: () => Promise<{ project: string; repos: { name: string; path?: string }[] }[]>;
  };
  stageRunners?: StageRunners;
}

// ---------------------------------------------------------------------------
// Template variable injection
// ---------------------------------------------------------------------------

function injectTemplateVars(prompt: string, vars: Record<string, string>): string {
  let result = prompt;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Interactive clarify helpers
// ---------------------------------------------------------------------------

/**
 * Parse numbered questions from clarifier output.
 * Matches patterns like:
 *   1. **[Topic]**: Question text?
 *   2. Question text?
 *   1) Question text?
 */
function parseQuestions(output: string): string[] {
  const lines = output.split('\n');
  const questions: string[] = [];
  let current = '';

  for (const line of lines) {
    const isNewQ = /^\s*\d+[\.\)]\s+/.test(line);
    if (isNewQ) {
      if (current.trim()) questions.push(current.trim());
      current = line.replace(/^\s*\d+[\.\)]\s+/, '');
    } else if (current) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.toLowerCase().startsWith('please answer')) {
        current += '\n' + line;
      }
    }
  }
  if (current.trim()) questions.push(current.trim());

  return questions.filter((q) => q.length > 10);
}

/**
 * Prompt the user for a single line of input via readline.
 */
function askUser(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ---------------------------------------------------------------------------
// Post-build guards
// ---------------------------------------------------------------------------

function fileExistsIn(dir: string, filename: string): boolean {
  try {
    return existsSync(join(dir, filename));
  } catch {
    return false;
  }
}

function runSilent(cmd: string, cwd: string): { ok: boolean; error?: string } {
  try {
    execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 });
    return { ok: true };
  } catch (err: any) {
    const stderr = err?.stderr?.toString()?.slice(0, 200) || '';
    return { ok: false, error: stderr || err?.message?.slice(0, 200) || 'unknown error' };
  }
}

/**
 * Minimal factory.yaml repo commands reader for CLI context.
 * Returns { format?, lint? } for a given repo, or null if not found.
 */
function loadRepoCommandsFromConfig(project: string, repoName: string): { format?: string; lint?: string } | null {
  const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
  const paths = [
    join(anvilHome, 'projects', project, 'factory.yaml'),
    join(anvilHome, 'projects', project, 'project.yaml'),
  ];

  for (const configPath of paths) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = readFileSync(configPath, 'utf-8');
      // Find the repo block and extract commands
      const repoPattern = new RegExp(
        `^\\s{2}-\\s+name:\\s+${repoName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
        'm',
      );
      const repoMatch = repoPattern.exec(raw);
      if (!repoMatch) continue;

      const afterRepo = raw.slice(repoMatch.index! + repoMatch[0].length);
      // Find commands block within this repo (before next repo or top-level key)
      const commandsMatch = afterRepo.match(/^\s{4,6}commands:\s*$/m);
      if (!commandsMatch) continue;

      const afterCommands = afterRepo.slice(commandsMatch.index! + commandsMatch[0].length);
      const commands: { format?: string; lint?: string } = {};

      // Extract format and lint commands (indented under commands:)
      for (const line of afterCommands.split('\n')) {
        if (/^\s{0,3}\S/.test(line) || /^\s{2}-\s+name:/.test(line)) break; // next section or repo
        if (/^\s{4,6}[a-z]/.test(line) && !/^\s{6,}/.test(line.replace(/^\s{4,6}\w/, ''))) {
          const kv = line.match(/^\s{6,8}(format|lint):\s+(.+)$/);
          if (kv) {
            const val = kv[2].replace(/^["']|["']$/g, '').trim();
            if (kv[1] === 'format') commands.format = val;
            if (kv[1] === 'lint') commands.lint = val;
          }
        }
      }

      if (commands.format || commands.lint) return commands;
    } catch {
      // Best-effort config read
    }
  }
  return null;
}

/**
 * Read pipeline.ship.deploy from factory.yaml for the given project.
 * Returns the deploy command string, or null if not configured.
 */
function loadPipelineDeployCmd(project: string): string | null {
  const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
  const paths = [
    join(anvilHome, 'projects', project, 'factory.yaml'),
    join(anvilHome, 'projects', project, 'project.yaml'),
  ];

  for (const configPath of paths) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = readFileSync(configPath, 'utf-8');
      // Look for pipeline: > ship: > deploy: value
      const deployMatch = raw.match(/^\s{4}deploy:\s+(.+)$/m);
      if (deployMatch) {
        // Verify it's under pipeline: > ship: context
        const pipelineIdx = raw.search(/^pipeline:\s*$/m);
        const shipIdx = raw.search(/^\s{2}ship:\s*$/m);
        if (pipelineIdx !== -1 && shipIdx !== -1 && shipIdx > pipelineIdx && deployMatch.index! > shipIdx) {
          return deployMatch[1].replace(/^["']|["']$/g, '').trim();
        }
      }
    } catch {
      // Best-effort
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Slack pipeline notifications (non-blocking, never fails the pipeline)
// ---------------------------------------------------------------------------

async function sendPipelineNotification(
  project: string,
  event: 'pipeline-start' | 'pipeline-complete' | 'pipeline-fail',
  data: { project: string; feature: string; cost?: number; prUrls?: string[]; error?: string; duration?: string; runId?: string },
): Promise<void> {
  const webhookUrl = process.env.ANVIL_SLACK_WEBHOOK;
  if (!webhookUrl) return; // No webhook configured — skip silently

  try {
    const { sendSlackNotification } = await import('../notifications/slack.js');
    await sendSlackNotification(webhookUrl, event, data);
  } catch {
    // Never fail the pipeline because of a notification
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Run formatters and linters with auto-fix in each repo after build.
 * Reads commands from factory.yaml config first, falls back to language detection.
 * Runs silently — never fails the pipeline.
 */
function runPostBuildGuards(repoPaths: Record<string, string>, workspaceDir: string, repoNames: string[], project?: string): void {
  info('Running post-build guards (format + lint auto-fix)...');

  const repos = repoNames.length > 0
    ? repoNames.map((r) => ({ name: r, path: repoPaths[r] || join(workspaceDir, r) }))
    : [{ name: 'root', path: workspaceDir }];

  let passCount = 0;
  let failCount = 0;

  const runGuard = (cmd: string, repoName: string, repoPath: string) => {
    const result = runSilent(cmd, repoPath);
    if (result.ok) {
      passCount++;
    } else {
      failCount++;
      warn(`Post-build guard failed in ${repoName}: ${cmd} — ${result.error}`);
    }
  };

  for (const repo of repos) {
    try {
      // Load commands from project config (factory.yaml)
      const repoCommands = project ? loadRepoCommandsFromConfig(project, repo.name) : null;
      if (repoCommands?.format) {
        runGuard(repoCommands.format, repo.name, repo.path);
      }
      if (repoCommands?.lint) {
        runGuard(repoCommands.lint, repo.name, repo.path);
      }

      // Fallback to language-based detection if no config
      if (!repoCommands?.format && !repoCommands?.lint) {
        const hasGo = fileExistsIn(repo.path, 'go.mod');
        const hasTs = fileExistsIn(repo.path, 'tsconfig.json');
        const hasPackageJson = fileExistsIn(repo.path, 'package.json');
        const hasPython = fileExistsIn(repo.path, 'pyproject.toml') || fileExistsIn(repo.path, 'setup.py');

        if (hasGo) {
          runGuard('gofmt -w .', repo.name, repo.path);
          runGuard('golangci-lint run --fix ./... 2>/dev/null', repo.name, repo.path);
        }

        if (hasTs || hasPackageJson) {
          runGuard('npx prettier --write "**/*.{ts,tsx,js,jsx}" --ignore-unknown 2>/dev/null', repo.name, repo.path);
          runGuard('npx eslint --fix "**/*.{ts,tsx,js,jsx}" 2>/dev/null', repo.name, repo.path);
        }

        if (hasPython) {
          runGuard('black . 2>/dev/null', repo.name, repo.path);
          runGuard('ruff check --fix . 2>/dev/null', repo.name, repo.path);
        }
      }
    } catch (err) {
      warn(`Post-build guard error in ${repo.name}: ${err}`);
    }
  }

  info(`Post-build guards: ${passCount} passed, ${failCount} failed${failCount > 0 ? ' (non-fatal)' : ''}`);
}

// ---------------------------------------------------------------------------
// Feature branch creation
// ---------------------------------------------------------------------------

function createFeatureBranches(
  featureSlug: string,
  repoPaths: Record<string, string>,
  workspaceDir: string,
  repoNames: string[],
): void {
  const branchName = `anvil/${featureSlug}`;
  info(`Creating feature branch "${branchName}" in all repos...`);

  const targets = repoNames.length > 0
    ? repoNames.map((r) => ({ name: r, path: repoPaths[r] || join(workspaceDir, r) }))
    : [{ name: 'workspace', path: workspaceDir }];

  for (const repo of targets) {
    try {
      try {
        execFileSync('git', ['rev-parse', '--verify', branchName], { cwd: repo.path, stdio: 'pipe' });
        execFileSync('git', ['checkout', branchName], { cwd: repo.path, stdio: 'pipe' });
        info(`Checked out existing branch "${branchName}" in ${repo.name}`);
      } catch {
        execFileSync('git', ['checkout', '-b', branchName], { cwd: repo.path, stdio: 'pipe' });
        info(`Created branch "${branchName}" in ${repo.name}`);
      }
    } catch (err) {
      warn(`Failed to create branch in ${repo.name}: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Validate-fix loop helper
// ---------------------------------------------------------------------------

function hasValidationFailures(artifact: string): boolean {
  if (!artifact) return false;
  return /VERDICT:\s*FAIL/i.test(artifact) ||
         /UNRESOLVED/i.test(artifact) ||
         /(?:build|lint|test).*(?:fail|error)/i.test(artifact);
}

// ---------------------------------------------------------------------------
// Persona prompt builder
// ---------------------------------------------------------------------------

async function buildPersonaProjectPrompt(
  stageIndex: number,
  project: string,
  feature: string,
  featureSlug: string,
  projectYamlPath: string | undefined,
  workspaceDir: string,
  repoNames: string[],
  memoryStore: MemoryStore,
): Promise<string> {
  const persona = STAGE_PERSONA_MAP[stageIndex];
  if (!persona) return '';

  let personaPrompt: string;
  try {
    personaPrompt = await loadPersonaPrompt(persona);
  } catch {
    // Fallback if persona prompt file not found
    return `You are the ${persona} agent in an Anvil pipeline for the "${project}" project.`;
  }

  if (!personaPrompt) {
    return `You are the ${persona} agent in an Anvil pipeline for the "${project}" project.`;
  }

  // Load and parse project YAML — extract structured fields for layered context
  let projectYaml = '(not available)';
  let parsedProject: Project | null = null;
  if (projectYamlPath && existsSync(projectYamlPath)) {
    try {
      const rawYaml = readFileSync(projectYamlPath, 'utf-8');
      projectYaml = rawYaml.slice(0, 8000);
      parsedProject = parseBytes(rawYaml);
      info(`[project-context] Loaded project.yaml for "${project}" (${projectYaml.length} chars) → injecting into ${persona} prompt`);
    } catch { /* ignore — projectYaml stays as raw string fallback */ }
  }

  // Load memory — combine CLI memory store with new injector project
  const projectMemory = memoryStore.formatForPrompt(project, 'memory');
  const userProfile = memoryStore.formatForPrompt(project, 'user');
  let memoryBlock = [projectMemory, userProfile].filter(Boolean).join('\n\n') || '(no prior memories)';

  // Wire injectMemories() — query by stage tags and feature content
  try {
    const stageName = PIPELINE_STAGES[stageIndex]?.name ?? `stage-${stageIndex}`;
    const { text: injectedMemoryText } = injectMemories(stageName, project, {
      tags: [stageName, persona],
      searchContent: feature,
      k: 5,
    });
    if (injectedMemoryText) {
      memoryBlock = memoryBlock === '(no prior memories)'
        ? injectedMemoryText
        : memoryBlock + '\n\n' + injectedMemoryText;
      info(`[memory] Injected memories for stage "${stageName}"`);
    }
  } catch {
    // Memory injection is optional — continue without it
  }

  // Wire team learnings as conventions
  let conventionText = '(use existing project conventions found in the codebase)';
  try {
    const learnings = readLearnings().filter(l => !l.project || l.project === project);
    const conventions = learnings
      .filter(l => l.type === 'convention')
      .slice(0, 10)
      .map(l => `- ${l.text}`);
    if (conventions.length > 0) {
      conventionText = conventions.join('\n');
      info(`[team] Loaded ${conventions.length} team conventions`);
    }
  } catch {
    // Team learnings are optional — continue without them
  }

  // Layered context loading (MemPalace L0→L3 pattern)
  const layer = getContextLayerForStage(stageIndex);
  const tokenBudget = getTokenBudgetForLayer(layer);

  // Try semantic retrieval first (new project), fall back to legacy KB
  let knowledgeGraph: string | null = null;
  try {
    const { getRetriever } = await import('../knowledge/indexer.js');
    const retriever = await getRetriever(project);
    const result = await retriever.retrieve(feature, {
      maxTokens: tokenBudget,
      repoFilter: layer === 'full' ? undefined : repoNames.slice(0, 3), // narrow for non-full layers
    });
    if (result.chunks.length > 0) {
      // Extract rich fields from parsed project for L0+L1 identity
      const repoLanguages = parsedProject?.repos
        ?.map(r => r.language).filter(Boolean) as string[] | undefined;
      const systemInvariants = parsedProject?.invariants
        ?.map(inv => inv.statement) ?? [];
      const teamConventions = conventionText !== '(use existing project conventions found in the codebase)'
        ? conventionText.split('\n').map(l => l.replace(/^- /, ''))
        : [];

      knowledgeGraph = assembleLayeredContext(
        {
          project,
          feature,
          layer,
          repoNames,
          languages: [...new Set(repoLanguages ?? [])],
          domain: parsedProject?.description,
          invariants: systemInvariants,
          conventions: teamConventions,
        },
        result,
      );
      info(`[knowledge-base] Layered retrieval (${layer}): ${result.chunks.length} chunks, ${result.totalTokens} tokens`);
    }
  } catch {
    // Semantic index not available — fall back to legacy
  }

  if (!knowledgeGraph) {
    // Legacy fallback — but respect the layer budget
    const legacyKb = await loadKnowledgeGraph(project, feature);
    if (legacyKb) {
      // Truncate legacy KB to match layer budget (chars ≈ tokens * 4)
      const maxChars = tokenBudget * 4;
      if (legacyKb.length > maxChars) {
        knowledgeGraph = legacyKb.slice(0, maxChars) + '\n\n[... truncated to fit context layer budget]\n';
        info(`[knowledge-base] Legacy KB truncated from ${legacyKb.length} to ${maxChars} chars for layer "${layer}"`);
      } else {
        knowledgeGraph = legacyKb;
      }
      info(`[knowledge-base] Loaded KB for "${project}" (${knowledgeGraph.length} chars) → injecting into ${persona} prompt`);
    } else {
      warn(`[knowledge-base] No KB available for "${project}" — agent will explore codebase manually`);
    }
  }

  const repoList = repoNames.length > 0 ? repoNames.join(', ') : '(single-repo or monorepo)';

  // Enforce per-section size budgets before injection
  const MAX_KNOWLEDGE_GRAPH_CHARS = 60_000; // ~15K tokens
  const MAX_MEMORIES_CHARS = 4_000; // ~1K tokens

  let trimmedKnowledgeGraph = knowledgeGraph || '(no knowledge base available — run "ff kb refresh" or use the dashboard to build it)';
  if (trimmedKnowledgeGraph.length > MAX_KNOWLEDGE_GRAPH_CHARS) {
    warn(`[prompt-budget] Knowledge graph is ${trimmedKnowledgeGraph.length} chars — trimming to ${MAX_KNOWLEDGE_GRAPH_CHARS}`);
    trimmedKnowledgeGraph = trimmedKnowledgeGraph.slice(0, MAX_KNOWLEDGE_GRAPH_CHARS) + '\n\n[... knowledge graph truncated to fit context window ...]';
  }

  let trimmedMemories = memoryBlock;
  if (trimmedMemories.length > MAX_MEMORIES_CHARS) {
    warn(`[prompt-budget] Memories section is ${trimmedMemories.length} chars — trimming to ${MAX_MEMORIES_CHARS}`);
    trimmedMemories = trimmedMemories.slice(0, MAX_MEMORIES_CHARS) + '\n\n[... memories truncated ...]';
  }

  const injected = injectTemplateVars(personaPrompt, {
    project_yaml: projectYaml,
    task: `Feature: "${feature}"\nProject: ${project}\nRepositories: ${repoList}`,
    conventions: conventionText,
    memories: trimmedMemories,
    knowledge_graph: trimmedKnowledgeGraph,
    repo_context: `Project: ${project}\nRepositories: ${repoList}\nWorkspace: ${workspaceDir}`,
    existing_code: knowledgeGraph
      ? '(see Knowledge Graph section for codebase structure — explore specific files as needed)'
      : '(explore the codebase to discover relevant code)',
  });

  // Append pipeline-specific overrides
  const overrides: string[] = [];
  if (knowledgeGraph) {
    overrides.push(`CRITICAL — KNOWLEDGE BASE USAGE:
A pre-computed Knowledge Base has been injected into the "Codebase Knowledge Graph" section above. It contains:
1. **Project-level synthesis** (if available): Cross-repo dependencies, shared concepts, and architecture overview for the entire "${project}" project.
2. **Per-repo analysis**: AST-extracted modules, functions, imports, call graphs, and community clusters for each repository.

**You MUST follow this traversal strategy:**
- START by reading the Project Knowledge Base section (if present) to understand how repos relate to each other.
- THEN read the per-repo sections relevant to your task for detailed module/function information.
- ONLY read specific source files when you need exact implementation details (API signatures, data model fields) not covered by the KB.
- When you use KB information, explicitly state it: e.g., "From the Knowledge Base, I can see that module X in repo Y handles Z..."
- Do NOT broadly explore files when the KB already provides the architectural map.`);
    if (persona === 'analyst') {
      overrides.push('IMPORTANT — ANALYST DIRECTIVE: The Knowledge Base provides sufficient architectural context for writing requirements. Do NOT spawn sub-agents to explore the codebase. Do NOT run find/ls/tree commands. Focus on producing requirements from the clarification document, project YAML, and the Knowledge Base. Reference specific KB findings in your requirements (e.g., "Based on KB analysis of module X..."). Only read a specific file if you need to verify a concrete implementation detail.');
    }
  }
  // Non-coding personas must NOT write files — output text only, pipeline persists artifacts
  if (persona !== 'engineer') {
    overrides.push('CRITICAL — NO FILE WRITES: Do NOT use the Write tool, do NOT create files, do NOT run mkdir. Output your documents as plain text in your response. The pipeline will persist your output automatically. The workspace repos must contain ONLY source code changes, never markdown artifacts.');
  }
  if (persona === 'clarifier') {
    overrides.push('IMPORTANT: Format each clarifying question as a separate numbered item (1. 2. 3. etc). Each question will be shown to the user one at a time in an interactive Q&A flow. Keep each question self-contained. Do NOT combine multiple questions into one item.');
  }
  if (persona === 'engineer') {
    overrides.push('IMPORTANT: Do NOT make git commits. Commits happen in the ship stage on a feature branch.');
    overrides.push('IMPORTANT: Do NOT run linters (golangci-lint, eslint, ruff). Linting is handled once by post-build guards. You may run `go build`/`go vet`/`tsc --noEmit` to verify compilation, but skip lint commands to avoid redundant slow passes.');
  }
  if (persona === 'tester') {
    overrides.push('IMPORTANT: Do NOT make git commits. Commits happen in the ship stage on a feature branch.');
    overrides.push('CRITICAL: You MUST fix ALL build errors, lint errors, and test failures before completing. Iterate until the codebase is clean. End your output with "VERDICT: PASS" or "VERDICT: FAIL" so the pipeline knows whether to proceed to shipping.');
  }

  let prompt = injected + (overrides.length > 0 ? '\n\n' + overrides.join('\n') : '');

  // Enforce prompt size budget — truncate oversized prompts
  const MAX_PROMPT_CHARS = 150_000; // ~37.5K tokens, well within 200K context
  if (prompt.length > MAX_PROMPT_CHARS) {
    warn(`[prompt-budget] Project prompt is ${prompt.length} chars (${Math.ceil(prompt.length / 4)} tokens) — trimming to fit context window`);
    prompt = prompt.slice(0, MAX_PROMPT_CHARS) + '\n\n[... prompt truncated to fit context window ...]';
  }

  info(`[prompt-budget] Project prompt: ${Math.ceil(prompt.length / 4)} tokens`);
  return prompt;
}

/** Wait for approval if approvalRequired is set. Polls state file every 500ms. */
async function waitForApproval(stageIndex: number): Promise<'approved' | 'rejected'> {
  setPendingApproval(stageIndex);
  info(`Waiting for approval on stage ${stageIndex}...`);

  const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      warn(`Approval for stage ${stageIndex} timed out after 30 minutes`);
      resolve('rejected');
    }, TIMEOUT_MS);

    const interval = setInterval(() => {
      const state = readDashboardState();
      if (!state.activePipeline) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve('rejected');
        return;
      }
      if (!state.activePipeline.pendingApproval) {
        clearInterval(interval);
        clearTimeout(timeout);
        if (state.activePipeline.status === 'failed' || state.activePipeline.status === 'cancelled') {
          resolve('rejected');
        } else {
          resolve('approved');
        }
      }
    }, 500);
  });
}

// Default stage runners — use the real implementations
const defaultStageRunners: StageRunners = {
  runClarifyStage,
  runHighLevelRequirementsStage,
  runProjectRequirementsStage,
  runProjectSpecsStage,
  runProjectTasksStage,
  runBuildStage,
};

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

export async function runPipeline(
  config: OrchestratorConfig,
  deps?: PipelineDependencies,
): Promise<OrchestratorResult> {
  // 1. Generate run ID and feature slug
  const runId = generateRunId();
  const featureSlug = config.featureSlug || generateFeatureSlug(config.feature);
  const anvilDirs = getFFDirs(config.workingDir);

  // 2. Set up RunStore (use injected or create real)
  const runStore = deps?.runStore ?? new RunStore(anvilDirs.runs);

  // 3. Set up MemoryStore
  const memoryStore = new MemoryStore();

  // 4. Create empty run record
  const record = createEmptyRunRecord(runId, config.project, config.feature, featureSlug);
  record.status = 'running';
  await runStore.createRun(record);

  // 5. Set up pipeline components
  const resumeStage = config.resumeFromStage ?? 0;
  const stateMachine = new PipelineStateMachine(resumeStage);
  const costTracker = new CostTracker();
  const display = new PipelineDisplay();

  // Start pipeline
  stateMachine.start();
  display.onStageStart(resumeStage, PIPELINE_STAGES[resumeStage].name);

  // Progress spinners + audit log
  const stageNames = PIPELINE_STAGES.map((s) => s.name);
  const progress = new StageProgress(stageNames);
  const auditLog = new AuditLog(runId);
  auditLog.pipelineStart(runId, config.project, config.feature);
  const pipelineStartTime = Date.now();

  // Send start notification (non-blocking)
  sendPipelineNotification(config.project, 'pipeline-start', {
    project: config.project,
    feature: config.feature,
    runId,
  }).catch(() => {}); // never block pipeline on notification failure

  // Write initial dashboard state — all stages pending
  const initialStages: DashboardStageState[] = PIPELINE_STAGES.map((s) => ({
    name: s.name,
    status: 'pending' as const,
  }));
  const dashboardState: DashboardState = {
    activePipeline: {
      runId,
      project: config.project,
      feature: config.feature,
      status: 'running',
      currentStage: resumeStage,
      stages: initialStages,
      startedAt: new Date().toISOString(),
      cost: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      model: config.model,
    },
    lastUpdated: new Date().toISOString(),
  };
  writeDashboardState(dashboardState);

  try {
    // 6. Agent runner (use injected or error)
    const agentRunner = deps?.agentRunner;
    if (!agentRunner) {
      throw new Error('AgentRunner is required — pass via PipelineDependencies');
    }

    // 7. Project loader
    const projectLoader = deps?.projectLoader;
    if (!projectLoader) {
      throw new Error('SystemLoader is required — pass via PipelineDependencies');
    }

    // 8. Stage runners (use injected or defaults)
    const stages = deps?.stageRunners ?? defaultStageRunners;

    // Build run dir path
    const runDirPath = join(anvilDirs.runs, config.project, runId);

    // Resolve workspace directory — prefer factory.yaml workspace field, then env var, then default
    const wsRootEnv = process.env.ANVIL_WORKSPACE_ROOT || process.env.FF_WORKSPACE_ROOT;
    let workspaceDir: string;

    // Try to read workspace from factory.yaml / project.yaml config
    let configWorkspace: string | null = null;
    const configPaths = [
      join(anvilDirs.projects, '..', 'projects', config.project, 'factory.yaml'),
      join(anvilDirs.projects, config.project, 'project.yaml'),
    ];
    for (const cp of configPaths) {
      if (existsSync(cp)) {
        try {
          const raw = readFileSync(cp, 'utf-8');
          const wsMatch = raw.match(/^workspace:\s+(.+)$/m);
          if (wsMatch) {
            configWorkspace = wsMatch[1].replace(/^["']|["']$/g, '').trim().replace(/^~/, homedir());
            break;
          }
        } catch { /* ignore */ }
      }
    }

    if (configWorkspace && existsSync(configWorkspace)) {
      workspaceDir = configWorkspace;
      info(`[project-context] Using workspace from config: ${workspaceDir}`);
    } else if (wsRootEnv) {
      workspaceDir = join(wsRootEnv, config.project);
    } else {
      workspaceDir = join(homedir(), 'workspace', config.project);
    }

    const primarySysForPaths = await projectLoader.findProject(config.project);
    info(`[project-context] Loaded project "${config.project}" (${primarySysForPaths.repos.length} repos: ${primarySysForPaths.repos.map(r => r.name).join(', ')})`);
    const repoPaths: Record<string, string> = {};
    for (const repo of primarySysForPaths.repos) {
      // Use repo.path if provided (relative to workspace), otherwise repo.name
      const repoSubpath = repo.path ?? repo.name;
      const resolved = repoSubpath.startsWith('/') ? repoSubpath : join(workspaceDir, repoSubpath);
      repoPaths[repo.name] = resolved;
    }

    // Resolve project YAML path for context (check both projects/ dirs)
    const projectYamlCandidates = [
      join(anvilDirs.projects, '..', 'projects', config.project, 'factory.yaml'),
      join(anvilDirs.projects, config.project, 'project.yaml'),
    ];
    const projectYamlPath = projectYamlCandidates.find(p => existsSync(p));
    if (projectYamlPath) {
      info(`[project-context] Project config found at ${projectYamlPath}`);
    }

    // If workspace dir is empty, fall back to project dir
    if (!existsSync(workspaceDir) || readdirSync(workspaceDir).filter((e: string) => !e.startsWith('.')).length === 0) {
      const projectDir = join(anvilDirs.projects, config.project);
      if (existsSync(projectDir)) {
        workspaceDir = projectDir;
        info(`Workspace empty — using project dir: ${projectDir}`);
      }
    }

    // Collect repo names for reuse
    const repoNames = Object.keys(repoPaths);

    // Create stage context — workingDir points at actual code, not run artifacts
    const stageCtx: StageContext = {
      runDir: runDirPath,
      project: config.project,
      feature: config.feature,
      agentRunner,
      workspaceDir,
      repoPaths,
      projectYamlPath,
    };

    // Track per-stage artifacts for chaining
    let clarificationArtifact = '';
    let highLevelReqsArtifact = '';
    const projectReqsMap = new Map<string, string>();
    const projectSpecsMap = new Map<string, string>();
    const projectTasksMap = new Map<string, string>();
    let affectedProjects: AffectedProject[] = [];
    let prUrls: string[] = [];
    let sandboxUrl: string | undefined;

    // -----------------------------------------------------------------------
    // Resume support: load prior artifacts if resuming
    // -----------------------------------------------------------------------
    if (config.resumeFromStage && config.resumeFromStage > 0) {
      info(`Resuming from stage ${config.resumeFromStage} — loading prior artifacts...`);

      // Mark prior stages as completed
      for (let i = 0; i < config.resumeFromStage; i++) {
        initialStages[i].status = 'completed' as any;
        updatePipelineStage(i, 'completed');
      }

      // Load prior artifacts from the feature store if featureSlug is set
      if (config.featureSlug) {
        try {
          const anvilHome = process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
          const featureDir = join(anvilHome, 'features', config.project, config.featureSlug);

          const readArtifact = (relativePath: string): string | null => {
            const fullPath = join(featureDir, relativePath);
            try { return readFileSync(fullPath, 'utf-8'); } catch { return null; }
          };

          // Load clarification
          const clarifyContent = readArtifact('CLARIFICATION.md');
          if (clarifyContent) clarificationArtifact = clarifyContent;

          // Load high-level requirements
          const hlrContent = readArtifact('REQUIREMENTS.md');
          if (hlrContent) highLevelReqsArtifact = hlrContent;

          // Load per-repo artifacts
          for (const repoName of repoNames) {
            const sysReq = readArtifact(`repos/${repoName}/REQUIREMENTS.md`);
            if (sysReq) projectReqsMap.set(repoName, sysReq);

            const spec = readArtifact(`repos/${repoName}/SPECS.md`);
            if (spec) projectSpecsMap.set(repoName, spec);

            const tasks = readArtifact(`repos/${repoName}/TASKS.md`);
            if (tasks) projectTasksMap.set(repoName, tasks);
          }

          info(`Loaded prior artifacts for feature "${config.featureSlug}"`);
        } catch (err) {
          warn(`Could not load prior artifacts: ${err}`);
        }
      }

      // Build failure context for injection into prompts
      if (config.failureContext) {
        info(`Previous failure context: ${config.failureContext.slice(0, 200)}...`);
      }
    }

    // -----------------------------------------------------------------------
    // Stage 0: Clarify (interactive one-by-one questions)
    // -----------------------------------------------------------------------
    if (config.resumeFromStage && config.resumeFromStage > 0) {
      // Already completed — skip
      display.onStageSkip(0, 'clarify');
    } else if (config.skipClarify) {
      display.onStageSkip(0, 'clarify');
      updatePipelineStage(0, 'skipped');
      clarificationArtifact = '# Clarification\n\nClarification skipped.\n';
      stateMachine.skip();
    } else {
      display.onStageStart(0, 'clarify');
      updatePipelineStage(0, 'running');

      // Build persona project prompt for clarifier
      const clarifyProjectPrompt = await buildPersonaProjectPrompt(
        0, config.project, config.feature, featureSlug,
        projectYamlPath, workspaceDir, repoNames, memoryStore,
      );

      // Phase A: Agent explores codebase and generates questions
      const questionsResult = await agentRunner.run({
        persona: 'clarifier',
        projectPrompt: clarifyProjectPrompt,
        userPrompt: `Feature request: "${config.feature}"\n\nExplore the codebase to understand the current architecture, then output 3-5 clarifying questions about this feature request. Number each question. Be specific — reference actual files, APIs, or patterns you found in the code.`,
        workingDir: workspaceDir,
        stage: 'clarify',
      });

      const questions = parseQuestions(questionsResult.output);
      const qaPairs: Array<{ question: string; answer: string }> = [];

      if (questions.length === 0) {
        // Fallback: treat entire output as the clarification
        clarificationArtifact = questionsResult.output;
      } else {
        // Phase B: Ask each question one at a time via readline
        info(`\nThe clarifier has ${questions.length} questions for you:\n`);

        for (let qi = 0; qi < questions.length; qi++) {
          const question = questions[qi];
          info(`\n--- Question ${qi + 1} of ${questions.length} ---`);
          info(question);
          info('');

          const answer = await askUser(`Your answer: `);
          qaPairs.push({ question, answer });

          info(`Got it. ${qi < questions.length - 1 ? 'Next question...' : 'All questions answered.'}`);
        }

        // Phase C: Resume agent with full Q&A to synthesize CLARIFICATION.md
        const qaText = qaPairs.map((qa, i) =>
          `**Q${i + 1}**: ${qa.question}\n**A${i + 1}**: ${qa.answer}`,
        ).join('\n\n');

        const synthesizeResult = await agentRunner.run({
          persona: 'clarifier',
          projectPrompt: clarifyProjectPrompt,
          userPrompt: `Feature: "${config.feature}"\n\nHere are the clarifying questions and the user's answers:\n\n${qaText}\n\nNow synthesize a CLARIFICATION.md document that combines the questions, answers, and your codebase understanding into clear context for the next stages. Output ONLY the markdown content.`,
          workingDir: workspaceDir,
          stage: 'clarify',
        });

        clarificationArtifact = synthesizeResult.output || questionsResult.output;
      }

      costTracker.addStageCost(0, questionsResult.tokenEstimate, Math.floor(questionsResult.tokenEstimate * 0.3));
      await updateStageRecord(runStore, runId, 0, 'completed', costTracker.getStageCost(0) ?? undefined);
      display.onStageComplete(0, 'clarify');
      updatePipelineStage(0, 'completed');
      updateStageCost(0, costTracker.getStageCost(0)?.estimatedCost ?? 0);
      updatePipelineCost(costTracker.getTotalCost());
      if (config.approvalRequired) {
        const decision = await waitForApproval(0);
        if (decision === 'rejected') throw new Error('Stage 0 rejected by user');
      }
      stateMachine.advance();
    }

    // -----------------------------------------------------------------------
    // Stage 1: High-Level Requirements
    // -----------------------------------------------------------------------
    if (config.resumeFromStage && config.resumeFromStage > 1) {
      display.onStageSkip(1, 'requirements');
    } else {
      display.onStageStart(1, 'requirements');
      updatePipelineStage(1, 'running');

      const hlrProjectPrompt = await buildPersonaProjectPrompt(
        1, config.project, config.feature, featureSlug,
        projectYamlPath, workspaceDir, repoNames, memoryStore,
      );

      // Inject failure context if resuming
      const failureCtx = (config.resumeFromStage === 1 && config.failureContext)
        ? `\n\nIMPORTANT — This is a RETRY. The previous run failed:\n${config.failureContext}\nFix the issues and proceed.`
        : '';

      const hlrOut = await agentRunner.run({
        persona: 'analyst',
        projectPrompt: hlrProjectPrompt,
        userPrompt: `Feature: "${config.feature}"\n\nClarification:\n${clarificationArtifact.slice(0, 8000)}\n\nProduce high-level requirements for this feature across the entire project. Identify which repositories need changes and why. Include success criteria.${failureCtx}`,
        workingDir: workspaceDir,
        stage: 'requirements',
      });

      highLevelReqsArtifact = hlrOut.output;
      costTracker.addStageCost(1, hlrOut.tokenEstimate, Math.floor(hlrOut.tokenEstimate * 0.3));
      await updateStageRecord(runStore, runId, 1, 'completed', costTracker.getStageCost(1) ?? undefined);
      display.onStageComplete(1, 'requirements');
      updatePipelineStage(1, 'completed');
      updateStageCost(1, costTracker.getStageCost(1)?.estimatedCost ?? 0);
      updatePipelineCost(costTracker.getTotalCost());
      if (config.approvalRequired) {
        const decision = await waitForApproval(1);
        if (decision === 'rejected') throw new Error('Stage 1 rejected by user');
      }
      stateMachine.advance();
    }

    // -----------------------------------------------------------------------
    // Stage 2: Project Requirements (parallel per project)
    // -----------------------------------------------------------------------
    if (config.resumeFromStage && config.resumeFromStage > 2) {
      display.onStageSkip(2, 'project-requirements');
    } else {
      display.onStageStart(2, 'project-requirements');
      updatePipelineStage(2, 'running');

      // Detect affected projects
      const allProjects = await projectLoader.loadAll();
      const projectNames = allProjects.map((s) => s.project);
      const projectRegistry = new Map(
        allProjects.map((s) => [s.project, { repos: s.repos.map((r) => r.name) }]),
      );
      affectedProjects = detectAffectedProjects(highLevelReqsArtifact, projectNames, projectRegistry);

      // If no projects detected, use the primary project
      if (affectedProjects.length === 0) {
        const primarySys = await projectLoader.findProject(config.project);
        affectedProjects = [
          {
            name: primarySys.project,
            repos: primarySys.repos.map((r) => r.name),
            reason: 'Primary project specified in config',
          },
        ];
      }

      const sysReqResults: ParallelRunResult<StageOutput> = await runParallelPerProject(
        affectedProjects,
        async (sys) => {
          return stages.runProjectRequirementsStage(stageCtx, highLevelReqsArtifact, {
            name: sys.name,
            repos: sys.repos,
          });
        },
      );

      if (sysReqResults.status === 'failed') {
        throw new Error('All project requirements stages failed');
      }

      for (const r of sysReqResults.results) {
        if (r.status === 'completed' && r.result) {
          projectReqsMap.set(r.project, r.result.artifact);
          costTracker.addStageCost(2, r.result.tokenEstimate, Math.floor(r.result.tokenEstimate * 0.3));
        }
      }
      await updateStageRecord(runStore, runId, 2, 'completed', costTracker.getStageCost(2) ?? undefined);
      display.onStageComplete(2, 'project-requirements');
      updatePipelineStage(2, 'completed');
      updateStageCost(2, costTracker.getStageCost(2)?.estimatedCost ?? 0);
      updatePipelineCost(costTracker.getTotalCost());
      if (config.approvalRequired) {
        const decision = await waitForApproval(2);
        if (decision === 'rejected') throw new Error('Stage 2 rejected by user');
      }
      stateMachine.advance();
    }

    // -----------------------------------------------------------------------
    // Stage 3: Project Specs (parallel per project)
    // -----------------------------------------------------------------------
    if (config.resumeFromStage && config.resumeFromStage > 3) {
      display.onStageSkip(3, 'specs');
    } else {
      display.onStageStart(3, 'specs');
      updatePipelineStage(3, 'running');

      const specResults: ParallelRunResult<StageOutput> = await runParallelPerProject(
        affectedProjects,
        async (sys) => {
          const sysReqs = projectReqsMap.get(sys.name) ?? '';
          return stages.runProjectSpecsStage(stageCtx, sysReqs, {
            name: sys.name,
            repos: sys.repos,
          });
        },
      );

      if (specResults.status === 'failed') {
        throw new Error('All project specs stages failed');
      }

      for (const r of specResults.results) {
        if (r.status === 'completed' && r.result) {
          projectSpecsMap.set(r.project, r.result.artifact);
          costTracker.addStageCost(3, r.result.tokenEstimate, Math.floor(r.result.tokenEstimate * 0.3));
        }
      }
      await updateStageRecord(runStore, runId, 3, 'completed', costTracker.getStageCost(3) ?? undefined);
      display.onStageComplete(3, 'specs');
      updatePipelineStage(3, 'completed');
      updateStageCost(3, costTracker.getStageCost(3)?.estimatedCost ?? 0);
      updatePipelineCost(costTracker.getTotalCost());
      if (config.approvalRequired) {
        const decision = await waitForApproval(3);
        if (decision === 'rejected') throw new Error('Stage 3 rejected by user');
      }
      stateMachine.advance();
    }

    // -----------------------------------------------------------------------
    // Stage 4: Project Tasks (parallel per project)
    // -----------------------------------------------------------------------
    if (config.resumeFromStage && config.resumeFromStage > 4) {
      display.onStageSkip(4, 'tasks');
    } else {
      display.onStageStart(4, 'tasks');
      updatePipelineStage(4, 'running');

      const taskResults: ParallelRunResult<StageOutput> = await runParallelPerProject(
        affectedProjects,
        async (sys) => {
          const sysSpec = projectSpecsMap.get(sys.name) ?? '';
          return stages.runProjectTasksStage(stageCtx, sysSpec, {
            name: sys.name,
            repos: sys.repos,
          });
        },
      );

      if (taskResults.status === 'failed') {
        throw new Error('All project tasks stages failed');
      }

      for (const r of taskResults.results) {
        if (r.status === 'completed' && r.result) {
          projectTasksMap.set(r.project, r.result.artifact);
          costTracker.addStageCost(4, r.result.tokenEstimate, Math.floor(r.result.tokenEstimate * 0.3));
        }
      }
      await updateStageRecord(runStore, runId, 4, 'completed', costTracker.getStageCost(4) ?? undefined);
      display.onStageComplete(4, 'tasks');
      updatePipelineStage(4, 'completed');
      updateStageCost(4, costTracker.getStageCost(4)?.estimatedCost ?? 0);
      updatePipelineCost(costTracker.getTotalCost());
      if (config.approvalRequired) {
        const decision = await waitForApproval(4);
        if (decision === 'rejected') throw new Error('Stage 4 rejected by user');
      }
      stateMachine.advance();
    }

    // -----------------------------------------------------------------------
    // Stage 5: Build (with feature branch creation beforehand)
    // -----------------------------------------------------------------------
    if (config.resumeFromStage && config.resumeFromStage > 5) {
      display.onStageSkip(5, 'build');
    } else {
      // Create feature branches before build
      createFeatureBranches(featureSlug, repoPaths, workspaceDir, repoNames);

      display.onStageStart(5, 'build');
      updatePipelineStage(5, 'running');

      // Build persona project prompt for engineer with no-commit override
      const buildProjectPrompt = await buildPersonaProjectPrompt(
        5, config.project, config.feature, featureSlug,
        projectYamlPath, workspaceDir, repoNames, memoryStore,
      );

      // Inject failure context if resuming from build
      const failureCtx = (config.resumeFromStage === 5 && config.failureContext)
        ? `\n\nIMPORTANT — This is a RETRY. The previous run failed:\n${config.failureContext}\nFix the issues and proceed.`
        : '';

      // Assemble task plans and repo paths from affected projects
      const buildRepoPaths: Record<string, string> = {};
      const taskPlans: BuildStageConfig['taskPlans'] = [];

      for (const sys of affectedProjects) {
        const sysData = await projectLoader.findProject(sys.name);
        for (const repo of sysData.repos) {
          if (repo.path) {
            buildRepoPaths[repo.name] = repo.path;
          }
          const tasksArtifact = projectTasksMap.get(sys.name) ?? '';
          taskPlans.push({
            project: sys.name,
            repo: repo.name,
            tasks: [{ id: 'task-1', description: tasksArtifact + failureCtx, files: [] }],
          });
        }
      }

      const buildResult: BuildStageResult = await stages.runBuildStage({
        runId,
        featureSlug,
        agentRunner,
        repoPaths: buildRepoPaths,
        taskPlans,
        projectPrompt: buildProjectPrompt + '\n\nIMPORTANT: Do NOT make git commits. Only write code. Commits happen in the ship stage.',
      });

      costTracker.addStageCost(5, 0, 0);
      await updateStageRecord(runStore, runId, 5, 'completed', costTracker.getStageCost(5) ?? undefined);
      display.onStageComplete(5, 'build');
      updatePipelineStage(5, 'completed');
      updateStageCost(5, costTracker.getStageCost(5)?.estimatedCost ?? 0);
      updatePipelineCost(costTracker.getTotalCost());
      if (config.approvalRequired) {
        const decision = await waitForApproval(5);
        if (decision === 'rejected') throw new Error('Stage 5 rejected by user');
      }
      stateMachine.advance();
    }

    // -----------------------------------------------------------------------
    // Stage 6: Validate (with post-build guards and fix loop)
    // -----------------------------------------------------------------------
    if (config.resumeFromStage && config.resumeFromStage > 6) {
      display.onStageSkip(6, 'validate');
    } else {
      // Run post-build guards silently before validate
      runPostBuildGuards(repoPaths, workspaceDir, repoNames, config.project);

      display.onStageStart(6, 'validate');
      updatePipelineStage(6, 'running');

      // Build persona project prompt for tester with no-commit override
      const validateProjectPrompt = await buildPersonaProjectPrompt(
        6, config.project, config.feature, featureSlug,
        projectYamlPath, workspaceDir, repoNames, memoryStore,
      );

      // Inject failure context if resuming from validate
      const failureCtx = (config.resumeFromStage === 6 && config.failureContext)
        ? `\n\nIMPORTANT — This is a RETRY. The previous run failed:\n${config.failureContext}\nFix the issues and proceed.`
        : '';

      // Run validate agent
      const validateResult = await agentRunner.run({
        persona: 'tester',
        projectPrompt: validateProjectPrompt,
        userPrompt: `Feature: "${config.feature}"\n\nValidate the implementation. You MUST ensure the code is fully clean:\n\n1. Run the build (compile/type-check). Fix ALL errors.\n2. Run the linter. Fix ALL lint warnings and errors.\n3. Run the test suite. Fix ALL failing tests.\n4. Repeat steps 1-3 until everything passes with zero errors.\n5. Do NOT move on until build, lint, AND tests all pass.\n\nIf you cannot fix an issue after 5 attempts, document it as UNRESOLVED.\n\nAt the end, output a clear verdict:\n- VERDICT: PASS — if build, lint, and tests all pass\n- VERDICT: FAIL — if any issues remain unresolved\n\nDo NOT make git commits.${failureCtx}`,
        workingDir: workspaceDir,
        stage: 'validate',
      });

      let validateArtifact = validateResult.output;
      costTracker.addStageCost(6, validateResult.tokenEstimate, Math.floor(validateResult.tokenEstimate * 0.3));

      // ── Validate-fix loop: up to 3 retries ──
      let fixAttempts = 0;
      const MAX_FIX_ATTEMPTS = 3;

      while (fixAttempts < MAX_FIX_ATTEMPTS && hasValidationFailures(validateArtifact)) {
        fixAttempts++;
        info(`Validation failed — fix attempt ${fixAttempts}/${MAX_FIX_ATTEMPTS}`);

        // Build engineer project prompt for fix
        const fixProjectPrompt = await buildPersonaProjectPrompt(
          5, config.project, config.feature, featureSlug,
          projectYamlPath, workspaceDir, repoNames, memoryStore,
        );

        // Run engineer agent to fix issues
        const fixResult = await agentRunner.run({
          persona: 'engineer',
          projectPrompt: fixProjectPrompt,
          userPrompt: `The validation stage found issues that need to be fixed (attempt ${fixAttempts}):\n\n${validateArtifact.slice(0, 6000)}\n\nFix ALL build errors, lint errors, and test failures listed above. You may run \`go build\`/\`go vet\`/\`tsc --noEmit\` and tests to verify compilation, but do NOT run linters — post-build guards will auto-fix formatting and the tester will re-validate. Do NOT make git commits.`,
          workingDir: workspaceDir,
          stage: `fix-${fixAttempts}`,
        });
        costTracker.addStageCost(6, fixResult.tokenEstimate, Math.floor(fixResult.tokenEstimate * 0.3));

        // Run post-build guards again
        runPostBuildGuards(repoPaths, workspaceDir, repoNames, config.project);

        // Re-run validate
        const revalidateResult = await agentRunner.run({
          persona: 'tester',
          projectPrompt: validateProjectPrompt,
          userPrompt: `Feature: "${config.feature}"\n\nRe-validate after fix attempt ${fixAttempts}. Check build, lint, and tests. Output VERDICT: PASS or VERDICT: FAIL.\nDo NOT make git commits.`,
          workingDir: workspaceDir,
          stage: `revalidate-${fixAttempts}`,
        });
        validateArtifact = revalidateResult.output;
        costTracker.addStageCost(6, revalidateResult.tokenEstimate, Math.floor(revalidateResult.tokenEstimate * 0.3));
      }

      if (hasValidationFailures(validateArtifact)) {
        warn(`Validation still failing after ${MAX_FIX_ATTEMPTS} fix attempts — proceeding anyway`);
        // Notify on persistent validation failure
        sendPipelineNotification(config.project, 'pipeline-fail', {
          project: config.project,
          feature: config.feature,
          error: `Validation failed after ${MAX_FIX_ATTEMPTS} fix attempts`,
          runId,
        }).catch(() => {});
      }

      await updateStageRecord(runStore, runId, 6, 'completed', costTracker.getStageCost(6) ?? undefined);
      display.onStageComplete(6, 'validate');
      updatePipelineStage(6, 'completed');
      updateStageCost(6, costTracker.getStageCost(6)?.estimatedCost ?? 0);
      updatePipelineCost(costTracker.getTotalCost());
      if (config.approvalRequired) {
        const decision = await waitForApproval(6);
        if (decision === 'rejected') throw new Error('Stage 6 rejected by user');
      }
      stateMachine.advance();
    }

    // -----------------------------------------------------------------------
    // Stage 7: Ship (commit, push, create PR from feature branch)
    // -----------------------------------------------------------------------
    if (config.skipShip) {
      display.onStageSkip(7, 'ship');
      updatePipelineStage(7, 'skipped');
      stateMachine.skip();
    } else {
      // Pre-check: verify gh CLI is authenticated
      try {
        execSync('gh auth status', { stdio: 'pipe', timeout: 10_000 });
      } catch {
        warn('GitHub CLI is not authenticated. PRs will not be created.');
        warn('Run "gh auth login" to authenticate, then retry with "anvil resume".');
        // Don't block — user might not want PRs
      }

      display.onStageStart(7, 'ship');
      updatePipelineStage(7, 'running');

      // Build persona project prompt for ship (engineer persona)
      const shipProjectPrompt = await buildPersonaProjectPrompt(
        7, config.project, config.feature, featureSlug,
        projectYamlPath, workspaceDir, repoNames, memoryStore,
      );

      const branchName = `anvil/${featureSlug}`;
      const repoListStr = repoNames.length > 0 ? repoNames.join(', ') : '(workspace root)';

      // Determine PR labels based on action type
      const prLabels = ['anvil'];
      const actionType = config.actionType ?? 'feature';
      if (actionType === 'bugfix' || actionType === 'fix') prLabels.push('bug');
      else if (actionType === 'spike' || actionType === 'review') prLabels.push(actionType);
      else prLabels.push('enhancement');
      const labelFlags = prLabels.map((l) => `--label "${l}"`).join(' ');

      const shipResult = await agentRunner.run({
        persona: 'engineer',
        projectPrompt: shipProjectPrompt,
        userPrompt: `Feature: "${config.feature}"\nRepositories: ${repoListStr}\n\nShip the changes. The code is already on feature branch "${branchName}". The build, lint, and tests all pass.\n\nFor each repo with changes:\n1. Run a final quick check: build and lint to confirm everything is clean\n2. If ANY errors remain, fix them before proceeding\n3. Stage and commit all changes with a clear commit message: "[anvil] ${config.feature}"\n4. Push the feature branch to origin\n5. Create a PR from "${branchName}" to main with a description of the changes. Add these label flags to the gh pr create command: ${labelFlags}\n\nDo NOT merge to main. Only create PRs. Do NOT create a PR if the code has unfixed errors.`,
        workingDir: workspaceDir,
        stage: 'ship',
      });

      costTracker.addStageCost(7, shipResult.tokenEstimate, Math.floor(shipResult.tokenEstimate * 0.3));

      // Extract any PR URLs from the ship output
      const prUrlPattern = /https:\/\/github\.com\/[^\s"')]+\/pull\/\d+/g;
      const extractedPrUrls = shipResult.output.match(prUrlPattern);
      if (extractedPrUrls) {
        prUrls = [...new Set(extractedPrUrls)];
      }

      await updateStageRecord(runStore, runId, 7, 'completed', costTracker.getStageCost(7) ?? undefined);
      display.onStageComplete(7, 'ship');
      updatePipelineStage(7, 'completed');
      updateStageCost(7, costTracker.getStageCost(7)?.estimatedCost ?? 0);
      updatePipelineCost(costTracker.getTotalCost());
      stateMachine.advance();
    }

    // -----------------------------------------------------------------------
    // Optional: Deploy to remote sandbox
    // Resolution order: factory.yaml pipeline.ship.deploy > ANVIL_DEPLOY_CMD > skip
    // -----------------------------------------------------------------------
    if (config.deploy && !config.skipShip) {
      const isRemote = config.deploy === 'remote';
      const label = isRemote ? 'remote sandbox' : 'local environment';

      // Resolve deploy command: factory.yaml > ANVIL_DEPLOY_CMD env > skip
      const configDeployCmd = loadPipelineDeployCmd(config.project);
      const envDeployCmd = process.env.ANVIL_DEPLOY_CMD || process.env.FF_DEPLOY_CMD;

      let deployCmd: string | null = null;
      if (configDeployCmd) {
        deployCmd = configDeployCmd;
        info(`Using deploy command from factory.yaml: ${deployCmd}`);
      } else if (envDeployCmd) {
        deployCmd = isRemote ? `${envDeployCmd} up ${config.project} --remote` : `${envDeployCmd} up ${config.project}`;
        info(`Using deploy command from ANVIL_DEPLOY_CMD: ${deployCmd}`);
      }

      if (deployCmd) {
        info(`Deploying to ${label}...`);
        try {
          const deployOut = execSync(deployCmd, {
            cwd: workspaceDir,
            timeout: 10 * 60 * 1000,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).toString();

          const urlMatch = deployOut.match(/https?:\/\/\S+/);
          if (urlMatch) {
            sandboxUrl = urlMatch[0];
            success(`${label} deployed: ${sandboxUrl}`);
          } else {
            success(`${label} deployed`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warn(`Deploy to ${label} failed (non-fatal): ${msg}`);
        }
      } else {
        info('No deploy command configured — skipping sandbox deployment');
      }
    }

    // -----------------------------------------------------------------------
    // Done — save learnings to memory
    // -----------------------------------------------------------------------
    const totalCost = costTracker.getTotalCost();

    // Save pipeline learnings to memory store
    try {
      const learning = `Pipeline completed for "${config.feature}" — cost: $${totalCost.estimatedCost.toFixed(4)}, PRs: ${prUrls.length > 0 ? prUrls.join(', ') : 'none'}`;
      memoryStore.add(config.project, 'memory', learning);
    } catch {
      // Best-effort memory save
    }

    // Save pipeline transcript as structured memories (MemPalace: remember past runs)
    try {
      const store = createNewMemoryStore(config.project);
      store.add({
        id: `run-${runId}`,
        kind: 'approach',
        content: `Pipeline run "${config.feature}" completed. Cost: $${totalCost.estimatedCost.toFixed(4)}. PRs: ${prUrls.length}. Model: ${config.model || 'default'}.`,
        confidence: 70,
        tags: ['pipeline-run', 'completed'],
        source: `run:${runId}`,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    } catch {
      // Best-effort transcript save
    }

    await runStore.updateRun(runId, {
      status: 'completed',
      totalCost,
      prUrls,
      sandboxUrl,
    });

    // Mark pipeline as completed in dashboard state, then flush
    {
      const finalState = {
        activePipeline: {
          runId,
          project: config.project,
          feature: config.feature,
          status: 'completed' as const,
          currentStage: PIPELINE_STAGES.length - 1,
          stages: initialStages,
          startedAt: dashboardState.activePipeline!.startedAt,
          cost: totalCost,
        },
        lastUpdated: new Date().toISOString(),
      };
      writeDashboardState(finalState);
      flushDashboardState();
    }

    // Audit log
    auditLog.pipelineComplete(runId, totalCost.estimatedCost, prUrls);

    // Send completion notification (non-blocking)
    sendPipelineNotification(config.project, 'pipeline-complete', {
      project: config.project,
      feature: config.feature,
      cost: totalCost.estimatedCost,
      prUrls,
      duration: formatDuration(Date.now() - pipelineStartTime),
      runId,
    }).catch(() => {});

    // Rich summary output
    const pipelineDuration = Date.now() - pipelineStartTime;
    const stageSummaries: StageSummary[] = PIPELINE_STAGES.map((s) => {
      const cost = costTracker.getStageCost(s.index);
      return {
        name: s.name,
        status: (initialStages[s.index]?.status === 'skipped' ? 'skipped' : 'completed') as 'completed' | 'failed' | 'skipped',
        duration: 0,
        cost: cost?.estimatedCost ?? 0,
      };
    });

    printPipelineSummary({
      feature: config.feature,
      project: config.project,
      runId,
      duration: pipelineDuration,
      totalCost,
      stages: stageSummaries,
      prUrls,
      sandboxUrl,
    });

    return {
      runId,
      status: 'completed',
      totalCost,
      prUrls,
      sandboxUrl,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const failedStage = stateMachine.getCurrentStage();

    stateMachine.fail(errorMsg);
    display.onStageFail(failedStage, PIPELINE_STAGES[failedStage]?.name ?? 'unknown', errorMsg);
    updatePipelineStage(failedStage, 'failed', errorMsg);

    // Mark pipeline as failed in dashboard state
    {
      const state = {
        activePipeline: {
          runId,
          project: config.project,
          feature: config.feature,
          status: 'failed' as const,
          currentStage: failedStage,
          stages: initialStages,
          startedAt: dashboardState.activePipeline?.startedAt ?? new Date().toISOString(),
          cost: costTracker.getTotalCost(),
        },
        lastUpdated: new Date().toISOString(),
      };
      writeDashboardState(state);
      flushDashboardState();
    }

    auditLog.pipelineFail(runId, errorMsg, PIPELINE_STAGES[failedStage]?.name ?? 'unknown');

    // Send failure notification (non-blocking)
    sendPipelineNotification(config.project, 'pipeline-fail', {
      project: config.project,
      feature: config.feature,
      error: errorMsg,
      runId,
    }).catch(() => {});

    progress.fail(failedStage, errorMsg);
    logError(`Pipeline failed at stage ${failedStage}: ${errorMsg}`);

    // Save failure transcript as memory (MemPalace: remember past runs)
    try {
      const store = createNewMemoryStore(config.project);
      const stageName = PIPELINE_STAGES[failedStage]?.name ?? `stage-${failedStage}`;
      store.add({
        id: `run-${runId}-fail`,
        kind: 'approach',
        content: `Pipeline run "${config.feature}" failed at stage "${stageName}": ${errorMsg.slice(0, 200)}. Cost: $${costTracker.getTotalCost().estimatedCost.toFixed(4)}.`,
        confidence: 40,
        tags: [stageName, 'pipeline-run', 'failed'],
        source: `run:${runId}`,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    } catch {
      // Best-effort transcript save
    }

    await runStore.updateRun(runId, {
      status: 'failed',
      totalCost: costTracker.getTotalCost(),
    }).catch(() => {});

    await updateStageRecord(runStore, runId, failedStage, 'failed').catch(() => {});

    return {
      runId,
      status: 'failed',
      totalCost: costTracker.getTotalCost(),
      prUrls: [],
      failedStage,
      failedError: errorMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function updateStageRecord(
  runStore: RunStore,
  runId: string,
  stageIndex: number,
  status: 'completed' | 'failed' | 'skipped',
  cost?: CostEntry,
): Promise<void> {
  await runStore.updateStage(runId, stageIndex, {
    status,
    completedAt: new Date().toISOString(),
    ...(cost ? { cost } : {}),
  }).catch(() => {});
}
