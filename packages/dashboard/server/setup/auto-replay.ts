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

export function startAutoReplayPump(deps: AutoReplayDeps): AutoReplayHandle {
  const intervalMs = deps.intervalMs ?? 15_000;
  const handle = setInterval(() => {
    void deps.autoReplayQueue.pump(async (job) => {
      const { runReplayPipeline } = await import('../replay-pipeline.js');
      const repoLocalPaths = deps.projectLoader.getRepoLocalPaths(job.project);
      const result = await runReplayPipeline({
        incidentStore: deps.incidentStore,
        replayStore: deps.replayStore,
        specStore: deps.testSpecStore,
        caseStore: deps.testCaseStore,
        learningsStore: deps.testLearningsStore,
        agentManager: deps.agentManager,
        project: job.project,
        incidentId: job.incidentId,
        repoLocalPaths,
        onStep: (step, state) => deps.services.incidents.emit('replay.step', { incidentId: job.incidentId, step, state }),
      });
      if (result.boundFilePath) {
        try {
          deps.boundTestsStore.appendBound(job.project, {
            filePath: result.boundFilePath,
            incidentId: job.incidentId,
            replayId: result.attempt.id,
            addedAt: new Date().toISOString(),
          });
        } catch { /* ok */ }
      }
      deps.services.incidents.emit('replay.complete', {
        result,
        incidentId: job.incidentId,
        attempt: result.attempt,
        boundFilePath: result.boundFilePath,
      });
    }).catch((err) => {
      console.warn('[auto-replay] pump cycle failed:', err);
    });
  }, intervalMs);
  // unref so the interval doesn't block process exit during tests / SIGTERM.
  if (typeof handle.unref === 'function') handle.unref();

  return {
    stop: () => { try { clearInterval(handle); } catch { /* ok */ } },
  };
}
