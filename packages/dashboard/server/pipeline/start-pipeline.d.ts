/**
 * Pipeline start orchestrator (Phase 3 round-4 extraction from
 * `dashboard-server.ts`).
 *
 * `createStartPipeline(deps)` returns the `startPipeline(project, feature,
 * options)` closure used by the build-trigger handler + plan-seeded
 * lifecycle. The body is verbatim from the legacy closure (lines 1253–
 * 1924 in the pre-extraction file); closure-resident state
 * (`activePipelineRunner`, `activeChild`, `outputBuffer`, `activeRuns`,
 * `agentToRunId`) stays in dashboard-server's scope and is reached
 * through getter/setter callbacks so the legacy "register-before-spawn"
 * + "restore-spawn-on-complete" semantics are preserved.
 *
 * The factory owns no mutable state of its own; every per-run scratch
 * (pipelineRunId, pipelineActivities, the bus + hook detach handles,
 * the original-spawn ref) lives inside the returned closure.
 *
 * The cost-hook and checkpoint-hook attach to the AgentManager
 * singleton (not per-run); since they close over `info.runId` +
 * `info.project` they keep working across consecutive runs. The
 * spawn-patch is per-run and restored on terminal events.
 */
import { BlobStore, CheckpointStore } from '@esankhan3/anvil-agent-core';
import { PipelineRunner } from '../pipeline-runner.js';
import type { PipelineRunState } from '../pipeline-runner.js';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import type { ProjectLoader } from '../project-loader.js';
import type { FeatureStore } from '../feature-store.js';
import type { MemoryStore } from '../memory-store.js';
import type { KnowledgeBaseManager } from '../knowledge-base-manager.js';
import type { TestSpecStore } from '../test-spec-store.js';
import type { TestCaseStore } from '../test-case-store.js';
import type { PipelinePauseStore } from '../pipeline-pause-store.js';
import type { PipelineAuditLog } from '../pipeline-audit-log.js';
import type { CostLedger } from '../cost-ledger.js';
import type { CostBreachHandler } from '../cost-breach-handler.js';
import type { DashboardServices } from '../services/index.js';
import type { Plan } from '../plan-store.js';
import type { Persona } from '../review-store.js';
import type { ActiveRun, ActivityEntry } from '../broadcasts.js';
import type { ChildProcess } from 'node:child_process';
/** Options accepted by `startPipeline()`. Mirrors the legacy union. */
export interface StartPipelineOptions {
    skipClarify?: boolean;
    skipShip?: boolean;
    model?: string;
    models?: Record<string, string>;
    approvalRequired?: boolean;
    baseBranch?: string;
    modelTier?: 'fast' | 'balanced' | 'thorough';
    repo?: string;
    level?: string;
    deploy?: unknown;
    resumeFromStage?: number;
    featureSlug?: string;
    failureContext?: string;
    clarifySeedArtifact?: string;
    planSeed?: {
        project: string;
        slug: string;
        version: number;
        plan: Plan;
    };
    /**
     * Reuse an existing pipeline runId instead of minting a fresh one.
     * Threaded by the resume path (Replay button + auto-resume queue) so
     * `Pipeline.run()` reads the durable event log keyed by the ORIGINAL
     * runId and replays its `step:completed` + recorded effects. Without
     * this, resume minted a fresh `build-<ts>` id, so the log lookup hit
     * an empty set and effect-granularity crash-resume never engaged
     * (BUG-1 Fix A, finding 7). `createRun` is idempotent on an existing
     * runId, so re-registering the same id is store-safe.
     */
    resumeRunId?: string;
}
export interface StartPipelineDeps {
    agentManager: AgentManager;
    projectLoader: ProjectLoader;
    featureStore: FeatureStore;
    memoryStore: MemoryStore;
    kbManager: KnowledgeBaseManager;
    testSpecStore: TestSpecStore;
    testCaseStore: TestCaseStore;
    pauseStore: PipelinePauseStore;
    auditLog: PipelineAuditLog;
    costLedger: CostLedger;
    costBreachHandler: CostBreachHandler;
    blobStore: BlobStore;
    checkpointStore: CheckpointStore;
    services: DashboardServices;
    activeRuns: Map<string, ActiveRun>;
    agentToRunId: Map<string, string>;
    getActivePipelineRunner: () => PipelineRunner | null;
    setActivePipelineRunner: (runner: PipelineRunner | null) => void;
    getActiveChild: () => ChildProcess | null;
    setActiveChild: (child: ChildProcess | null) => void;
    /** Reset dashboard-server's outputBuffer `let` binding. */
    resetOutputBuffer: () => void;
    /** Append a single entry to dashboard-server's outputBuffer. */
    pushOutputEntry: (entry: ActivityEntry) => void;
    broadcastActiveRuns: () => void;
    broadcastRuns: () => void;
    broadcastCostSnapshot: (project: string, runId?: string) => void;
    persistRunRecord: (state: PipelineRunState, runId?: string) => Promise<void>;
    extractPRUrls: (content: string) => string[];
    trackPR: (prUrl: string) => Promise<void>;
    dispatchLifecycle: (project: string, slug: string, event: {
        kind: 'execute-complete';
    } | {
        kind: 'reconcile-complete';
    } | {
        kind: 'execute-failed';
        reason: string;
    }) => Promise<unknown>;
    startReviewRun: (project: string, prUrl: string, sourceStage: 'ship', personas: Persona[], model?: string) => Promise<unknown>;
    anvilHome: string;
    runsDir: string;
    stateFile: string;
    approvalSecret: string;
}
export type StartPipelineFn = (project: string, feature: string, options?: StartPipelineOptions) => void;
export declare function createStartPipeline(deps: StartPipelineDeps): StartPipelineFn;
//# sourceMappingURL=start-pipeline.d.ts.map