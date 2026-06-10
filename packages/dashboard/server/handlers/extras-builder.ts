/**
 * `handlerExtras` builder (Phase 3 round-10 extraction from
 * `dashboard-server.ts`).
 *
 * `buildHandlerExtras(deps)` returns the fully-populated
 * `HandlerExtras` bag that the registry threads through every WS
 * action handler. The bag itself isn't doing anything clever — most
 * fields are 1:1 passthroughs of the boot-scope stores + services.
 * The factory just hides the field-by-field assignment + a handful
 * of structural casts behind one call so `dashboard-server.ts`
 * stops being the file that knows every handler's dependency.
 *
 * Mutable refs (`activePipelineRunner`, `activeChild`) are reached
 * through getter/setter callbacks so the boot scope keeps owning the
 * canonical `let` bindings.
 */

import type { ChildProcess } from 'node:child_process';

import type { HandlerExtras, AgentManagerHandle } from './route.js';
import type { ProjectLoader } from '../project-loader.js';
import type { PlanStore, Plan, PlanSection } from '../plan-store.js';
import type { PlanValidator } from '../plan-validator.js';
import type { IncidentStore } from '../incident-store.js';
import type { ReplayStore } from '../replay-store.js';
import type { BoundTestsStore } from '../bound-tests.js';
import type { BoundTestsAuditLog } from '../bound-tests-audit.js';
import type { AutoReplayQueue } from '../auto-replay-queue.js';
import type { ReviewStore, Persona } from '../review-store.js';
import type { ReviewCalibrationStore } from '../review-calibration.js';
import type { ReviewDismissalStore } from '../review-dismissal-store.js';
import type { TestSpecStore } from '../test-spec-store.js';
import type { TestCaseStore } from '../test-case-store.js';
import type { TestRunStore } from '../test-run-store.js';
import type { TestLearningsStore } from '../test-learnings.js';
import type { KnowledgeBaseManager } from '../knowledge-base-manager.js';
import type { MemoryStore } from '../memory-store.js';
import type { CostLedger } from '../cost-ledger.js';
import type { CostBreachHandler } from '../cost-breach-handler.js';
import type { PipelinePauseStore } from '../pipeline-pause-store.js';
import type { PipelineLearningsStore } from '../pipeline-learnings-store.js';
import type { PipelineAuditLog } from '../pipeline-audit-log.js';
import type { CiTriageStore } from '../ci-triage-store.js';
import type { FeatureStore } from '../feature-store.js';
import type { CheckpointStore, AgentManager } from '@esankhan3/anvil-agent-core';
import type { LifecycleEvent } from '@esankhan3/anvil-core-pipeline';
import type { ActiveRun } from '../broadcasts.js';
import type { PipelineRunner } from '../pipeline-runner.js';
import type { WsClient } from '../setup/ws-client.js';

export interface ExtrasBuilderDeps {
  // ── Constants ─────────────────────────────────────────────────────
  anvilHome: string;
  shareTokenTtlMs: number;
  conventionPaths: { conventionsDir: string; rulesDir: string };
  runsDir: string;
  runsIndex: string;

  // ── Stores ────────────────────────────────────────────────────────
  projectLoader: ProjectLoader;
  planStore: PlanStore;
  planValidator: PlanValidator;
  incidentStore: IncidentStore;
  replayStore: ReplayStore;
  boundTestsStore: BoundTestsStore;
  boundAuditLog: BoundTestsAuditLog;
  autoReplayQueue: AutoReplayQueue;
  reviewStore: ReviewStore;
  reviewCalibrationStore: ReviewCalibrationStore;
  reviewDismissalStore: ReviewDismissalStore;
  testSpecStore: TestSpecStore;
  testCaseStore: TestCaseStore;
  testRunStore: TestRunStore;
  testLearningsStore: TestLearningsStore;
  ciTriageStore: CiTriageStore;
  featureStore: FeatureStore;
  kbManager: KnowledgeBaseManager;
  memoryStore: MemoryStore;
  costLedger: CostLedger;
  costBreachHandler: CostBreachHandler;
  pauseStore: PipelinePauseStore;
  learningsStore: PipelineLearningsStore;
  checkpointStore: CheckpointStore;
  auditLog: PipelineAuditLog;

  // ── Maps + active state ───────────────────────────────────────────
  activeRuns: Map<string, ActiveRun>;
  agentToRunId: Map<string, string>;
  agentManager: AgentManager;

  // ── Functions (broadcasters + helpers) ────────────────────────────
  dispatchLifecycle: (project: string, planSlug: string, event: LifecycleEvent) => Promise<unknown>;
  getLifecycleSnapshot: (project: string, planSlug: string) => Promise<unknown | null>;
  broadcastCostSnapshot: (project: string, runId?: string) => void;
  discoverAvailableModels: () => Promise<unknown>;
  getWorkspaceFromConfig: (project: string) => string | null;
  buildProjectOverview: (project: string) => Promise<unknown>;
  broadcastActiveRuns: () => void;
  broadcastRuns: () => void;
  loadRunsSync: () => unknown[];
  refreshTrackedPRs: () => Promise<void>;
  trackedPRsForBroadcast: () => unknown[];
  sendInit: (ws: WsClient) => Promise<void>;
  executeLifecycleRefine: (project: string, planSlug: string) => Promise<void>;
  defaultUser: string;

  // ── Pipeline spawn closures ───────────────────────────────────────
  startPipeline: (project: string, feature: string, options?: unknown) => void;
  spawnQuickAction: (
    action: 'run-fix' | 'run-review' | 'run-spike',
    project: string,
    feature: string,
    model?: string,
  ) => void;
  spawnPlanAgent: (project: string, feature: string, model?: string) => void;
  spawnPlanVariants: (
    project: string,
    feature: string,
    variants: unknown[],
    model?: string,
  ) => void;
  spawnPlanSectionRegen: (plan: Plan, section: PlanSection, model?: string) => void;
  startReviewRun: (
    project: string,
    prUrl: string,
    trigger: string,
    personas: Persona[],
    model?: string,
    prior?: unknown,
  ) => Promise<unknown>;
  applyReviewFix: (project: string, reviewId: string, findingId: string) => Promise<string>;

  // ── Mutable-ref accessors (boot scope owns the `let` bindings) ────
  getActivePipelineRunner: () => PipelineRunner | null;
  setActivePipelineRunner: (r: PipelineRunner | null) => void;
  getActiveChild: () => ChildProcess | null;
  cancelLegacyPipeline: () => void;
}

export function buildHandlerExtras(deps: ExtrasBuilderDeps): HandlerExtras {
  return {
    anvilHome: deps.anvilHome,
    shareTokenTtlMs: deps.shareTokenTtlMs,
    defaultUser: deps.defaultUser,
    dispatchLifecycle: (project, planSlug, event) =>
      deps.dispatchLifecycle(project, planSlug, event as LifecycleEvent),
    projectLoader: deps.projectLoader,
    planStore: deps.planStore,
    broadcastCostSnapshot: (project, runId) => deps.broadcastCostSnapshot(project, runId ?? undefined),
    getPlanLifecycleSnapshot: (project, planSlug) => deps.getLifecycleSnapshot(project, planSlug),
    incidentStore: deps.incidentStore,
    replayStore: deps.replayStore,
    boundTestsStore: deps.boundTestsStore,
    boundAuditLog: deps.boundAuditLog,
    autoReplayQueue: deps.autoReplayQueue,
    reviewStore: deps.reviewStore,
    reviewCalibrationStore: deps.reviewCalibrationStore,
    reviewDismissalStore: deps.reviewDismissalStore,
    testSpecStore: deps.testSpecStore,
    testCaseStore: deps.testCaseStore,
    testRunStore: deps.testRunStore,
    kbManager: deps.kbManager,
    conventionPaths: deps.conventionPaths,
    memoryStore: deps.memoryStore,
    costLedger: deps.costLedger,
    costBreachHandler: deps.costBreachHandler,
    pauseStore: deps.pauseStore as unknown as HandlerExtras['pauseStore'],
    // PipelineLearningsStore.list narrows `outcome` to a `PlanOutcome`
    // enum, but the registry's `LearningsStoreShape` keeps it as plain
    // `string` (Zod already validates the literal). Cast at the boundary.
    learningsStore: deps.learningsStore as unknown as HandlerExtras['learningsStore'],
    checkpointStore: deps.checkpointStore,
    discoverAvailableModels: deps.discoverAvailableModels,
    testLearningsStore: deps.testLearningsStore,
    ciTriageStore: deps.ciTriageStore,
    getWorkspaceFromConfig: deps.getWorkspaceFromConfig,
    buildProjectOverview: deps.buildProjectOverview,
    memoryWriter: deps.memoryStore,
    broadcastActiveRuns: deps.broadcastActiveRuns,
    loadRunsSync: deps.loadRunsSync,
    featureStore: deps.featureStore,
    refreshTrackedPRs: deps.refreshTrackedPRs,
    trackedPRsForBroadcast: deps.trackedPRsForBroadcast,
    activeRuns: deps.activeRuns as unknown as HandlerExtras['activeRuns'],
    sendInit: deps.sendInit,
    killAgent: (agentId) => { try { deps.agentManager.kill(agentId); } catch { /* ok */ } },
    sendInput: (text, agentId) => {
      // Mirror the legacy three-way dispatch: pipeline runner → named
      // agent → legacy child stdin. Phase 3 collapses this into a
      // single service method.
      const runner = deps.getActivePipelineRunner();
      if (runner) {
        runner.provideInput(text);
      } else if (agentId) {
        try { deps.agentManager.sendInput(agentId, text); } catch { /* ok */ }
      } else {
        const child = deps.getActiveChild();
        if (child?.stdin) {
          child.stdin.write(text + '\n');
        } else {
          // No active pipeline runner, no named agent, no legacy child stdin —
          // the input has nowhere to go. This was previously a silent drop
          // (the canonical "I answered clarify but it stayed stuck" symptom).
          console.warn(
            '[dashboard] send-input dropped — no active pipeline runner, no agentId, no legacy child stdin',
          );
        }
      }
    },
    cancelPipeline: () => {
      const runner = deps.getActivePipelineRunner();
      if (runner) {
        runner.cancel();
        deps.setActivePipelineRunner(null);
      } else {
        deps.cancelLegacyPipeline();
      }
    },
    broadcastRuns: deps.broadcastRuns,
    auditLog: deps.auditLog,
    // Phase 2.6 — closure-dependent pipeline + spawn migrations
    pipelineActions: {
      startPipeline: (project, feature, options) =>
        deps.startPipeline(project, feature, options),
      spawnQuickAction: (action, project, feature, model) =>
        deps.spawnQuickAction(action, project, feature, model),
      spawnPlanAgent: (project, feature, model) =>
        deps.spawnPlanAgent(project, feature, model),
      spawnPlanVariants: (project, feature, variants, model) =>
        deps.spawnPlanVariants(project, feature, variants, model),
      spawnPlanSectionRegen: (plan, section, model) =>
        deps.spawnPlanSectionRegen(plan as Plan, section as PlanSection, model),
      startReviewRun: async (project, prUrl, trigger, personas, model, prior) => {
        await deps.startReviewRun(project, prUrl, trigger, personas as Persona[], model, prior);
      },
      applyReviewFix: (project, reviewId, findingId) =>
        deps.applyReviewFix(project, reviewId, findingId),
    },
    unsafeStores: {
      planStore: deps.planStore,
      reviewStore: deps.reviewStore,
      testSpecStore: deps.testSpecStore,
      testCaseStore: deps.testCaseStore,
      testRunStore: deps.testRunStore,
      testLearningsStore: deps.testLearningsStore,
      incidentStore: deps.incidentStore,
      replayStore: deps.replayStore,
      boundTestsStore: deps.boundTestsStore,
    },
    agentManagerHandle: deps.agentManager as unknown as AgentManagerHandle,
    agentToRunId: deps.agentToRunId,
    runsDir: deps.runsDir,
    runsIndex: deps.runsIndex,
    getActivePipelineRunner: deps.getActivePipelineRunner,
    planValidator: deps.planValidator,
    executeLifecycleRefine: (project, planSlug) =>
      deps.executeLifecycleRefine(project, planSlug),
    kbManagerRich: {
      getIndexForPrompt: (project) => deps.kbManager.getIndexForPrompt(project),
      getQueryContextForPrompt: (project, feature) =>
        deps.kbManager.getQueryContextForPrompt(project, feature),
      getAllGraphReports: (project) => deps.kbManager.getAllGraphReports(project),
    },
  };
}
