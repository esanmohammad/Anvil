/**
 * cli pipeline orchestrator — Phase 6 of CORE-PIPELINE-CONSOLIDATION-PLAN.
 *
 * Drives lifecycle through `@anvil/core-pipeline`'s `Pipeline.run()`.
 * Per-stage logic lives in 8 step adapters under `./steps/`. Cross-
 * cutting concerns (audit, cost, run-store, feature-store, approval-
 * gate, dashboard-state, learners) attach as bus hooks. There is NO
 * legacy if-tree fallback — this is the only runtime path.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  Pipeline,
  InMemoryEventBus,
  attachAuditLogHook,
  attachCostTrackerHook,
  attachLearnersHook,
  attachApprovalGateHook,
  attachFeatureStoreHook,
  attachRunStoreHook,
  attachDashboardStateHook,
  type RunStoreLike,
} from '@anvil/core-pipeline';

import { PIPELINE_STAGES, type AffectedProject } from './types.js';
import type { AgentRunner } from './stages/index.js';
import {
  generateRunId,
  generateFeatureSlug,
  createEmptyRunRecord,
  RunStore,
  type RunRecord,
  type CostEntry,
} from '../run/index.js';
import { getFFDirs } from '../home.js';
import { MemoryStore } from './memory-store-cli.js';
import { info, success, error as logError, warn } from '../logger.js';
import { createMemoryStore as createNewMemoryStore } from '../memory/index.js';
import {
  writeDashboardState,
  flushDashboardState,
  updatePipelineStage,
} from './state-file.js';
import type { DashboardState, DashboardStageState } from './state-file.js';
import { printPipelineSummary, type StageSummary } from '../ui/summary.js';

import { buildDefaultPipelineRegistry } from './steps/index.js';
import { getApprovalDecision } from './approval-gate.js';
import { sendPipelineNotification, formatDuration } from './notifications.js';
import { loadPriorArtifacts, FEATURE_STORE_ARTIFACT_PATHS, loadPipelineDeployCmd } from './feature-store.js';
import { askUser } from './persona-prompt.js';
import type { CliPipelineState } from './cli-state.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  project: string;
  feature: string;
  skipClarify?: boolean;
  skipShip?: boolean;
  deploy?: 'local' | 'remote' | false;
  answersFile?: string;
  workingDir?: string;
  model?: string;
  models?: Record<string, string>;
  approvalRequired?: boolean;
  actionType?: 'feature' | 'bugfix' | 'fix' | 'spike' | 'review';
  resumeFromStage?: number;
  featureSlug?: string;
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

export interface PipelineDependencies {
  agentRunner: AgentRunner;
  runStore: RunStore;
  projectLoader: {
    findProject: (name: string) => Promise<{ project: string; repos: { name: string; path?: string }[] }>;
    loadAll: () => Promise<{ project: string; repos: { name: string; path?: string }[] }[]>;
  };
}

// ---------------------------------------------------------------------------
// runPipeline — main entry point
// ---------------------------------------------------------------------------

export async function runPipeline(
  config: OrchestratorConfig,
  deps?: PipelineDependencies,
): Promise<OrchestratorResult> {
  if (!deps?.agentRunner) {
    throw new Error('AgentRunner is required — pass via PipelineDependencies');
  }
  if (!deps?.projectLoader) {
    throw new Error('projectLoader is required — pass via PipelineDependencies');
  }

  // 1. IDs + paths
  const runId = generateRunId();
  const featureSlug = config.featureSlug || generateFeatureSlug(config.feature);
  const anvilDirs = getFFDirs(config.workingDir);
  const runDir = join(anvilDirs.runs, config.project, runId);
  const featureDir = join(anvilDirs.runs, '..', 'features', config.project, featureSlug);
  const auditPath = join(runDir, 'audit.jsonl');

  // 2. Stores
  const runStore = deps.runStore;
  const memoryStore = new MemoryStore();
  const record = createEmptyRunRecord(runId, config.project, config.feature, featureSlug);
  record.status = 'running';
  await runStore.createRun(record);

  // 3. Workspace + repo resolution
  const { workspaceDir, repoPaths, projectYamlPath } = await resolveWorkspace(
    config,
    anvilDirs,
    deps.projectLoader,
  );
  const repoNames = Object.keys(repoPaths);

  // 4. Initial dashboard state — all stages pending
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
      currentStage: config.resumeFromStage ?? 0,
      stages: initialStages,
      startedAt: new Date().toISOString(),
      cost: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      model: config.model,
    },
    lastUpdated: new Date().toISOString(),
  };
  writeDashboardState(dashboardState);

  // 5. Resume support — load prior artifacts
  const prior = config.resumeFromStage && config.resumeFromStage > 0 && config.featureSlug
    ? loadPriorArtifacts(config.project, config.featureSlug, repoNames)
    : undefined;
  if (prior) {
    info(`Resuming from stage ${config.resumeFromStage} — loading prior artifacts...`);
    for (let i = 0; i < (config.resumeFromStage ?? 0); i++) {
      initialStages[i].status = 'completed';
      updatePipelineStage(i, 'completed');
    }
  }

  // 6. Build CliPipelineState
  const state: CliPipelineState = {
    project: config.project,
    feature: config.feature,
    featureSlug,
    runId,
    runDir,
    startedAt: Date.now(),
    workspaceDir,
    repoPaths,
    repoNames,
    projectYamlPath,
    agentRunner: deps.agentRunner,
    projectLoader: deps.projectLoader,
    memoryStore,
    runStore,
    approvalRequired: config.approvalRequired === true,
    skipShip: config.skipShip === true,
    skipClarify: config.skipClarify === true,
    answersFile: config.answersFile,
    actionType: config.actionType ?? 'feature',
    deploy: config.deploy ?? false,
    failureContext: config.failureContext,
    resumeFromStage: config.resumeFromStage ?? 0,
    model: config.model,
    clarificationArtifact: prior?.clarification ?? '',
    highLevelReqsArtifact: prior?.highLevelRequirements ?? '',
    affectedProjects: [],
    repoReqsMap: prior?.repoRequirements ?? new Map(),
    projectSpecsMap: prior?.projectSpecs ?? new Map(),
    projectTasksMap: prior?.projectTasks ?? new Map(),
    validationArtifact: '',
    prUrls: [],
    sandboxUrl: undefined,
    stageCosts: new Map(),
  };

  // 7. Bus + hooks
  const bus = new InMemoryEventBus();
  const auditHandle = attachAuditLogHook(bus, { path: auditPath });
  const costHandle = attachCostTrackerHook(bus);
  const learnersHandle = attachLearnersHook(bus, {
    project: config.project,
    onLearnEvent: () => undefined,
  });
  attachFeatureStoreHook(bus, {
    featureDir,
    artifactPaths: FEATURE_STORE_ARTIFACT_PATHS,
  });
  attachApprovalGateHook(bus, { getApprovalDecision });

  // cli stdin responder for clarify:answers — readline-based interactive Q&A.
  // Dashboard would attach its own WS-based responder for the same channel.
  bus.onRequest<{ questions: string[] }>('clarify:answers', async (req) => {
    const { questions } = req.payload;
    info(`\nThe clarifier has ${questions.length} questions for you:\n`);
    const answers: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      info(`\n--- Question ${i + 1} of ${questions.length} ---`);
      info(questions[i]);
      info('');
      const answer = await askUser('Your answer: ');
      answers.push(answer);
      info(`Got it. ${i < questions.length - 1 ? 'Next question...' : 'All questions answered.'}`);
    }
    bus.respond('clarify:answers', req.requestId, answers);
  });
  // Dashboard state — write the simple core-pipeline snapshot to a separate path
  // so it does not clobber legacy state.json. Legacy state.json is updated
  // through the cli's own `updatePipelineStage` calls inside step adapters.
  attachDashboardStateHook(bus, { path: join(runDir, 'pipeline-state.json') });

  const cliRunStore: RunStoreLike = {
    updateStage: async ({ runId: rid, stepId, status, error }) => {
      const idx = stageIndexFromStepId(stepId);
      if (idx < 0) return;
      await updateStageRecord(runStore, rid, idx, mapStageStatus(status), undefined, error?.message);
    },
    updateRun: async ({ runId: rid, status, error }) => {
      await runStore.updateRun(rid, {
        status: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'failed',
        ...(error ? { error: error.message } : {}),
      }).catch(() => undefined);
    },
  };
  attachRunStoreHook(bus, { runStore: cliRunStore, runId });

  // 8. Slack notifications + audit start
  sendPipelineNotification(config.project, 'pipeline-start', {
    project: config.project, feature: config.feature, runId,
  }).catch(() => undefined);

  // 9. Build registry + run pipeline
  const registry = buildDefaultPipelineRegistry();

  // resumeFromStep — map stage index to step ID
  const resumeStepId = config.resumeFromStage && config.resumeFromStage > 0
    ? stepIdForStageIndex(config.resumeFromStage)
    : undefined;

  const pipeline = new Pipeline({
    registry,
    bus,
    runId,
    workspaceDir,
    initialShared: state as unknown as Record<string, unknown>,
    resumeFromStep: resumeStepId,
  });

  let pipelineErr: { message: string; stack?: string } | undefined;
  const result = await pipeline.run().catch((err) => {
    pipelineErr = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) };
    return undefined;
  });

  // 10. Wrap up — totals, deploy, notifications, summary
  const totalsFromBus = costHandle.totals();
  const totalCost: CostEntry = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: totalsFromBus.costUsd,
  };

  // Cleanup bus subscriptions
  auditHandle.unsubscribe();
  costHandle.unsubscribe();
  learnersHandle.unsubscribe();

  if (pipelineErr || (result && result.status !== 'success')) {
    const failedStage = result?.failedStep ? stageIndexFromStepId(result.failedStep) : 0;
    const errorMsg = pipelineErr?.message || result?.failedStep || 'pipeline failed';

    finalizeFailure({
      runId, config, runStore, memoryStore, totalCost,
      failedStage, errorMsg, dashboardState, initialStages,
    }).catch(() => undefined);

    return {
      runId,
      status: 'failed',
      totalCost,
      prUrls: state.prUrls,
      failedStage,
      failedError: errorMsg,
    };
  }

  // Optional sandbox deploy (after ship)
  if (state.deploy && !state.skipShip) {
    state.sandboxUrl = await runOptionalDeploy(state) ?? undefined;
  }

  // Save run record + memories
  await finalizeSuccess({
    state, totalCost, dashboardState, initialStages,
  });

  // Summary
  const stageSummaries: StageSummary[] = PIPELINE_STAGES.map((s) => {
    const cost = state.stageCosts.get(s.index);
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
    duration: Date.now() - state.startedAt,
    totalCost,
    stages: stageSummaries,
    prUrls: state.prUrls,
    sandboxUrl: state.sandboxUrl,
  });

  return {
    runId,
    status: 'completed',
    totalCost,
    prUrls: state.prUrls,
    sandboxUrl: state.sandboxUrl,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STAGE_STEP_IDS: ReadonlyArray<string> = [
  'clarify', 'requirements', 'repo-requirements', 'specs',
  'tasks', 'build', 'validate', 'ship',
];

function stepIdForStageIndex(idx: number): string | undefined {
  return STAGE_STEP_IDS[idx];
}

function stageIndexFromStepId(stepId: string): number {
  return STAGE_STEP_IDS.indexOf(stepId);
}

function mapStageStatus(s: 'running' | 'completed' | 'failed' | 'skipped'): 'completed' | 'failed' | 'skipped' {
  return s === 'running' ? 'completed' : s; // running maps as a no-op write below
}

async function updateStageRecord(
  runStore: RunStore,
  runId: string,
  stageIndex: number,
  status: 'completed' | 'failed' | 'skipped',
  cost?: CostEntry,
  errorMsg?: string,
): Promise<void> {
  await runStore.updateStage(runId, stageIndex, {
    status,
    completedAt: new Date().toISOString(),
    ...(cost ? { cost } : {}),
    ...(errorMsg ? { error: errorMsg } : {}),
  }).catch(() => undefined);
}

async function resolveWorkspace(
  config: OrchestratorConfig,
  anvilDirs: ReturnType<typeof getFFDirs>,
  projectLoader: PipelineDependencies['projectLoader'],
): Promise<{ workspaceDir: string; repoPaths: Record<string, string>; projectYamlPath: string | undefined }> {
  const wsRootEnv = process.env.ANVIL_WORKSPACE_ROOT || process.env.FF_WORKSPACE_ROOT;
  let workspaceDir: string;

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

  const primarySys = await projectLoader.findProject(config.project);
  info(`[project-context] Loaded project "${config.project}" (${primarySys.repos.length} repos: ${primarySys.repos.map((r) => r.name).join(', ')})`);
  const repoPaths: Record<string, string> = {};
  for (const repo of primarySys.repos) {
    const repoSubpath = repo.path ?? repo.name;
    const resolved = repoSubpath.startsWith('/') ? repoSubpath : join(workspaceDir, repoSubpath);
    repoPaths[repo.name] = resolved;
  }

  const projectYamlPath = configPaths.find((p) => existsSync(p));
  if (projectYamlPath) info(`[project-context] Project config found at ${projectYamlPath}`);

  // Workspace fallback to project dir if empty
  if (!existsSync(workspaceDir) || readdirSync(workspaceDir).filter((e) => !e.startsWith('.')).length === 0) {
    const projectDir = join(anvilDirs.projects, config.project);
    if (existsSync(projectDir)) {
      workspaceDir = projectDir;
      info(`Workspace empty — using project dir: ${projectDir}`);
    }
  }

  return { workspaceDir, repoPaths, projectYamlPath };
}

async function runOptionalDeploy(state: CliPipelineState): Promise<string | undefined> {
  const isRemote = state.deploy === 'remote';
  const label = isRemote ? 'remote sandbox' : 'local environment';

  const configDeployCmd = loadPipelineDeployCmd(state.project);
  const envDeployCmd = process.env.ANVIL_DEPLOY_CMD || process.env.FF_DEPLOY_CMD;

  let deployCmd: string | null = null;
  if (configDeployCmd) {
    deployCmd = configDeployCmd;
    info(`Using deploy command from factory.yaml: ${deployCmd}`);
  } else if (envDeployCmd) {
    deployCmd = isRemote ? `${envDeployCmd} up ${state.project} --remote` : `${envDeployCmd} up ${state.project}`;
    info(`Using deploy command from ANVIL_DEPLOY_CMD: ${deployCmd}`);
  }

  if (!deployCmd) {
    info('No deploy command configured — skipping sandbox deployment');
    return undefined;
  }

  info(`Deploying to ${label}...`);
  try {
    const out = execSync(deployCmd, {
      cwd: state.workspaceDir,
      timeout: 10 * 60 * 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    const urlMatch = out.match(/https?:\/\/\S+/);
    if (urlMatch) {
      success(`${label} deployed: ${urlMatch[0]}`);
      return urlMatch[0];
    }
    success(`${label} deployed`);
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`Deploy to ${label} failed (non-fatal): ${msg}`);
    return undefined;
  }
}

interface SuccessArgs {
  state: CliPipelineState;
  totalCost: CostEntry;
  dashboardState: DashboardState;
  initialStages: DashboardStageState[];
}

async function finalizeSuccess({ state, totalCost, dashboardState, initialStages }: SuccessArgs): Promise<void> {
  // Pipeline learnings
  try {
    const learning = `Pipeline completed for "${state.feature}" — cost: $${totalCost.estimatedCost.toFixed(4)}, PRs: ${state.prUrls.length > 0 ? state.prUrls.join(', ') : 'none'}`;
    state.memoryStore.add(state.project, 'memory', learning);
  } catch { /* best-effort */ }

  try {
    const store = createNewMemoryStore(state.project);
    store.add({
      id: `run-${state.runId}`,
      kind: 'approach',
      content: `Pipeline run "${state.feature}" completed. Cost: $${totalCost.estimatedCost.toFixed(4)}. PRs: ${state.prUrls.length}. Model: ${state.model || 'default'}.`,
      confidence: 70,
      tags: ['pipeline-run', 'completed'],
      source: `run:${state.runId}`,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch { /* best-effort */ }

  await state.runStore.updateRun(state.runId, {
    status: 'completed',
    totalCost,
    prUrls: state.prUrls,
    sandboxUrl: state.sandboxUrl,
  } as Partial<RunRecord>);

  // Mark pipeline as completed in legacy dashboard state
  const finalState: DashboardState = {
    activePipeline: {
      runId: state.runId,
      project: state.project,
      feature: state.feature,
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

  sendPipelineNotification(state.project, 'pipeline-complete', {
    project: state.project,
    feature: state.feature,
    cost: totalCost.estimatedCost,
    prUrls: state.prUrls,
    duration: formatDuration(Date.now() - state.startedAt),
    runId: state.runId,
  }).catch(() => undefined);
}

interface FailureArgs {
  runId: string;
  config: OrchestratorConfig;
  runStore: RunStore;
  memoryStore: MemoryStore;
  totalCost: CostEntry;
  failedStage: number;
  errorMsg: string;
  dashboardState: DashboardState;
  initialStages: DashboardStageState[];
}

async function finalizeFailure({
  runId, config, runStore, totalCost,
  failedStage, errorMsg, dashboardState, initialStages,
}: FailureArgs): Promise<void> {
  updatePipelineStage(failedStage, 'failed', errorMsg);

  const state: DashboardState = {
    activePipeline: {
      runId,
      project: config.project,
      feature: config.feature,
      status: 'failed' as const,
      currentStage: failedStage,
      stages: initialStages,
      startedAt: dashboardState.activePipeline?.startedAt ?? new Date().toISOString(),
      cost: totalCost,
    },
    lastUpdated: new Date().toISOString(),
  };
  writeDashboardState(state);
  flushDashboardState();

  logError(`Pipeline failed at stage ${failedStage}: ${errorMsg}`);

  sendPipelineNotification(config.project, 'pipeline-fail', {
    project: config.project,
    feature: config.feature,
    error: errorMsg,
    runId,
  }).catch(() => undefined);

  try {
    const store = createNewMemoryStore(config.project);
    const stageName = PIPELINE_STAGES[failedStage]?.name ?? `stage-${failedStage}`;
    store.add({
      id: `run-${runId}-fail`,
      kind: 'approach',
      content: `Pipeline run "${config.feature}" failed at stage "${stageName}": ${errorMsg.slice(0, 200)}. Cost: $${totalCost.estimatedCost.toFixed(4)}.`,
      confidence: 40,
      tags: [stageName, 'pipeline-run', 'failed'],
      source: `run:${runId}`,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch { /* best-effort */ }

  await runStore.updateRun(runId, {
    status: 'failed',
    totalCost,
  } as Partial<RunRecord>).catch(() => undefined);
}

// Re-export AffectedProject type for backward compatibility
export type { AffectedProject };
