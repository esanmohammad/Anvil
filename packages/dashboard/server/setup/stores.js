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
import { BridgedCostLedger } from '../cost-bridge.js';
import { BlobStore, CheckpointStore, AgentManager as RealAgentManager } from '@esankhan3/anvil-agent-core';
import { getOrCreateApprovalSecret } from '../pipeline-approval-tokens.js';
import { BoundTestsAuditLog } from '../bound-tests-audit.js';
import { TestRelevanceCache } from '../test-relevance-cache.js';
import { CiTriageStore } from '../ci-triage-store.js';
import { ReviewDismissalStore } from '../review-dismissal-store.js';
import { ReviewCalibrationStore } from '../review-calibration.js';
export function createDashboardStores(deps) {
    const projectLoader = new ProjectLoader();
    const featureStore = new FeatureStore();
    // AgentManager lives in @esankhan3/anvil-agent-core (the source of truth)
    // and resolves its own adapter via ProviderRegistry. Tests pass
    // `deps.agentManager` to inject a scripted FakeAgentManager.
    const agentManager = deps.agentManager ?? new RealAgentManager();
    const memoryStore = new MemoryStore();
    const kbManager = new KnowledgeBaseManager(projectLoader);
    const planStore = new PlanStore(deps.anvilHome);
    const planValidator = new PlanValidator(projectLoader);
    const reviewStore = new ReviewStore(deps.anvilHome);
    const testSpecStore = new TestSpecStore(deps.anvilHome);
    const testCaseStore = new TestCaseStore(deps.anvilHome);
    const testRunStore = new TestRunStore(deps.anvilHome);
    const testLearningsStore = new TestLearningsStore(deps.anvilHome);
    const incidentStore = new IncidentStore(deps.anvilHome);
    const replayStore = new ReplayStore(deps.anvilHome);
    const boundTestsStore = new BoundTestsStore(deps.anvilHome);
    // ── Confidence-gated pipeline stores ─────────────────────────────
    const pauseStore = new PipelinePauseStore(deps.anvilHome);
    const reviewersStore = new PipelineReviewersStore(deps.anvilHome);
    const auditLog = new PipelineAuditLog(deps.anvilHome);
    const learningsStore = new PipelineLearningsStore(deps.anvilHome);
    // Phase 3: cost-bridge — every record() also writes a matching SpendRow
    // to agent-core's SpendLedger so cli `cost summary` reads agree with the
    // dashboard UI (storage layouts stay separate per D4).
    const costLedger = new BridgedCostLedger(deps.anvilHome);
    const blobStore = new BlobStore(deps.anvilHome);
    const checkpointStore = new CheckpointStore({ anvilHome: deps.anvilHome, blobStore });
    const approvalSecret = getOrCreateApprovalSecret(deps.anvilHome);
    // ── RG/CG/CT stores ─────────────────────────────────────────────
    const boundAuditLog = new BoundTestsAuditLog(deps.anvilHome);
    const relevanceCache = new TestRelevanceCache(deps.anvilHome);
    const ciTriageStore = new CiTriageStore(deps.anvilHome);
    const reviewDismissalStore = new ReviewDismissalStore(deps.anvilHome);
    const reviewCalibrationStore = new ReviewCalibrationStore(deps.anvilHome);
    return {
        projectLoader, featureStore, agentManager, memoryStore, kbManager,
        planStore, planValidator,
        reviewStore, testSpecStore, testCaseStore, testRunStore,
        testLearningsStore, incidentStore, replayStore, boundTestsStore,
        pauseStore, reviewersStore, auditLog, learningsStore, costLedger,
        blobStore, checkpointStore, approvalSecret,
        boundAuditLog, relevanceCache, ciTriageStore,
        reviewDismissalStore, reviewCalibrationStore,
    };
}
//# sourceMappingURL=stores.js.map