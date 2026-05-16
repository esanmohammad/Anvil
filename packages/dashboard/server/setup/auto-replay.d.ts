/**
 * Auto-replay pump (Phase 3 round-6 extraction from
 * `dashboard-server.ts`).
 *
 * Drains the auto-replay queue every 15s. Each pass dispatches up to
 * `maxConcurrent` jobs to the bug-replay pipeline. Failures are
 * retried with backoff via the queue's internal `attempts` counter;
 * jobs that exceed `maxAttempts` drop.
 *
 * Returns a `stop()` fn — push it into `stopHandlers` so the
 * dashboard's graceful shutdown clears the interval.
 */
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import type { ProjectLoader } from '../project-loader.js';
import type { IncidentStore } from '../incident-store.js';
import type { ReplayStore } from '../replay-store.js';
import type { TestSpecStore } from '../test-spec-store.js';
import type { TestCaseStore } from '../test-case-store.js';
import type { TestLearningsStore } from '../test-learnings.js';
import type { BoundTestsStore } from '../bound-tests.js';
import type { DashboardServices } from '../services/index.js';
import type { AutoReplayQueue } from '../auto-replay-queue.js';
export interface AutoReplayDeps {
    autoReplayQueue: AutoReplayQueue;
    incidentStore: IncidentStore;
    replayStore: ReplayStore;
    testSpecStore: TestSpecStore;
    testCaseStore: TestCaseStore;
    testLearningsStore: TestLearningsStore;
    boundTestsStore: BoundTestsStore;
    agentManager: AgentManager;
    projectLoader: ProjectLoader;
    services: DashboardServices;
    /** Override interval for tests; defaults to 15_000ms. */
    intervalMs?: number;
}
export interface AutoReplayHandle {
    stop: () => void;
}
export declare function startAutoReplayPump(deps: AutoReplayDeps): AutoReplayHandle;
//# sourceMappingURL=auto-replay.d.ts.map