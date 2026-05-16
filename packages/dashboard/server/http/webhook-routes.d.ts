/**
 * HTTP webhook routes (Phase 2.8 extraction).
 *
 * Lifted verbatim out of `serveStatic` in `dashboard-server.ts`:
 *   - /share/plan/:token         (signed plan share)
 *   - /share/tests/:token        (signed test-spec share)
 *   - /api/incidents/webhook/*   (sentry / incidentio / generic)
 *   - /api/pipeline/approve      (HMAC-signed approval link)
 *   - /api/contracts/list        (GET)
 *   - /api/contracts/drift       (POST)
 *   - /api/contracts/generate    (POST 501)
 *   - /api/contracts/verify      (POST 501)
 *   - /api/tests/rank            (POST)
 *   - /api/triage/analyze        (POST)
 *   - /api/kb/:project/:repo/graph.html
 *
 * `tryWebhookRoutes` returns `true` if a route handled the request (so
 * `serveStatic` should stop) or `false` to fall through to static files.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IncidentStore } from '../incident-store.js';
import type { ReplayStore } from '../replay-store.js';
import type { TestSpecStore } from '../test-spec-store.js';
import type { TestCaseStore } from '../test-case-store.js';
import type { TestLearningsStore } from '../test-learnings.js';
import type { BoundTestsStore } from '../bound-tests.js';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import type { ProjectLoader } from '../project-loader.js';
import type { DashboardServices } from '../services/index.js';
import type { PipelinePauseStore } from '../pipeline-pause-store.js';
import type { KnowledgeBaseManager } from '../knowledge-base-manager.js';
import type { CiTriageStore } from '../ci-triage-store.js';
export interface WebhookDeps {
    incidentStore: IncidentStore;
    replayStore: ReplayStore;
    testSpecStore: TestSpecStore;
    testCaseStore: TestCaseStore;
    testLearningsStore: TestLearningsStore;
    boundTestsStore: BoundTestsStore;
    agentManager: AgentManager;
    projectLoader: ProjectLoader;
    services: DashboardServices;
    enqueueReplay: (incidentId: string, project: string) => {
        queueDepth: number;
    };
    pauseStore?: PipelinePauseStore;
    approvalSecret?: string;
    kbManager?: KnowledgeBaseManager;
    ciTriageStore?: CiTriageStore;
}
export declare function tryWebhookRoutes(req: IncomingMessage, res: ServerResponse, anvilHome: string, kbManagerRef?: {
    current: KnowledgeBaseManager | null;
}, webhookDepsRef?: {
    current: WebhookDeps | null;
}): Promise<boolean>;
//# sourceMappingURL=webhook-routes.d.ts.map