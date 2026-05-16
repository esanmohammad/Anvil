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
import type { HandlerExtras } from './route.js';
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
    anvilHome: string;
    shareTokenTtlMs: number;
    conventionPaths: {
        conventionsDir: string;
        rulesDir: string;
    };
    runsDir: string;
    runsIndex: string;
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
    activeRuns: Map<string, ActiveRun>;
    agentToRunId: Map<string, string>;
    agentManager: AgentManager;
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
    startPipeline: (project: string, feature: string, options?: unknown) => void;
    spawnQuickAction: (action: 'run-fix' | 'run-review' | 'run-spike', project: string, feature: string, model?: string) => void;
    spawnPlanAgent: (project: string, feature: string, model?: string) => void;
    spawnPlanVariants: (project: string, feature: string, variants: unknown[], model?: string) => void;
    spawnPlanSectionRegen: (plan: Plan, section: PlanSection, model?: string) => void;
    startReviewRun: (project: string, prUrl: string, trigger: string, personas: Persona[], model?: string, prior?: unknown) => Promise<unknown>;
    applyReviewFix: (project: string, reviewId: string, findingId: string) => Promise<string>;
    getActivePipelineRunner: () => PipelineRunner | null;
    setActivePipelineRunner: (r: PipelineRunner | null) => void;
    getActiveChild: () => ChildProcess | null;
    cancelLegacyPipeline: () => void;
}
export declare function buildHandlerExtras(deps: ExtrasBuilderDeps): HandlerExtras;
//# sourceMappingURL=extras-builder.d.ts.map