/**
 * Dashboard store + service factory (Phase 3 round-11 extraction
 * from `dashboard-server.ts`).
 *
 * Constructs every store + light-weight service the dashboard needs.
 * No closures, no listeners, no async I/O at construction time — just
 * `new XxxStore(ANVIL_HOME)` boilerplate that was clogging the boot
 * scope.
 *
 * `AutoReplayQueue` is dynamic-imported in the dashboard boot
 * sequence (post-deps for env-var sniffing), so it's NOT created
 * here — the caller passes it in / wires it after `createDashboardStores`
 * returns.
 *
 * The two stores that take constructor args other than `anvilHome`
 * (`KnowledgeBaseManager` needs `projectLoader`; `PlanValidator`
 * needs `projectLoader`; `CheckpointStore` needs `blobStore`) are
 * wired in dependency order.
 */
import { ProjectLoader } from '../project-loader.js';
import { FeatureStore } from '../feature-store.js';
import { MemoryStore } from '../memory-store.js';
import { KnowledgeBaseManager } from '../knowledge-base-manager.js';
import { PlanStore } from '../plan-store.js';
import { PlanValidator } from '../plan-validator.js';
import { ReviewStore } from '../review-store.js';
import { TestSpecStore } from '../test-spec-store.js';
import { TestCaseStore } from '../test-case-store.js';
import { TestRunStore } from '../test-run-store.js';
import { TestLearningsStore } from '../test-learnings.js';
import { IncidentStore } from '../incident-store.js';
import { ReplayStore } from '../replay-store.js';
import { BoundTestsStore } from '../bound-tests.js';
import { PipelinePauseStore } from '../pipeline-pause-store.js';
import { PipelineReviewersStore } from '../pipeline-reviewers-store.js';
import { PipelineAuditLog } from '../pipeline-audit-log.js';
import { PipelineLearningsStore } from '../pipeline-learnings-store.js';
import { BlobStore, CheckpointStore } from '@esankhan3/anvil-agent-core';
import { BoundTestsAuditLog } from '../bound-tests-audit.js';
import { TestRelevanceCache } from '../test-relevance-cache.js';
import { CiTriageStore } from '../ci-triage-store.js';
import { ReviewDismissalStore } from '../review-dismissal-store.js';
import { ReviewCalibrationStore } from '../review-calibration.js';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import type { CostLedger } from '../cost-ledger.js';
export interface StoresBundleDeps {
    anvilHome: string;
    /** Caller-supplied agent manager (tests inject a `FakeAgentManager`). */
    agentManager?: AgentManager;
}
export interface DashboardStores {
    projectLoader: ProjectLoader;
    featureStore: FeatureStore;
    agentManager: AgentManager;
    memoryStore: MemoryStore;
    kbManager: KnowledgeBaseManager;
    planStore: PlanStore;
    planValidator: PlanValidator;
    reviewStore: ReviewStore;
    testSpecStore: TestSpecStore;
    testCaseStore: TestCaseStore;
    testRunStore: TestRunStore;
    testLearningsStore: TestLearningsStore;
    incidentStore: IncidentStore;
    replayStore: ReplayStore;
    boundTestsStore: BoundTestsStore;
    pauseStore: PipelinePauseStore;
    reviewersStore: PipelineReviewersStore;
    auditLog: PipelineAuditLog;
    learningsStore: PipelineLearningsStore;
    costLedger: CostLedger;
    blobStore: BlobStore;
    checkpointStore: CheckpointStore;
    approvalSecret: string;
    boundAuditLog: BoundTestsAuditLog;
    relevanceCache: TestRelevanceCache;
    ciTriageStore: CiTriageStore;
    reviewDismissalStore: ReviewDismissalStore;
    reviewCalibrationStore: ReviewCalibrationStore;
}
export declare function createDashboardStores(deps: StoresBundleDeps): DashboardStores;
//# sourceMappingURL=stores.d.ts.map