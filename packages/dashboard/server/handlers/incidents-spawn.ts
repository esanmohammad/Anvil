/**
 * Incident replay route (Phase 2.6 migration).
 *
 * Migrated:
 *   - replay-incident
 *
 * Calls `runReplayPipeline` dynamically (same as legacy), reading from
 * `unsafeStores.*` and using the bundled agent-manager handle. The
 * post-result Slack nudge stays inline since it is fire-and-forget.
 */

import { route, type Handler } from './route.js';
import * as Z from './schemas.js';

export function incidentsSpawnRoutes(): Record<string, Handler> {
  return {
    'replay-incident': route({
      input: Z.ReplayIncident,
      onParseFail: 'silent',
      handle: async (input, deps) => {
        const stores = deps.extras.unsafeStores;
        const projectLoader = deps.extras.projectLoader;
        const agentManager = deps.extras.agentManagerHandle;
        if (!stores || !projectLoader || !agentManager) return;
        const { project, incidentId, specSlug } = input;
        const model = input.model ?? 'claude-sonnet-4-6';
        try {
          const { runReplayPipeline } = await import('../replay-pipeline.js');
          const repoLocalPaths = projectLoader.getRepoLocalPaths(project);

          deps.ws.send(JSON.stringify({ type: 'replay-started', payload: { incidentId } }));

          const result = await runReplayPipeline({
            incidentStore: stores.incidentStore,
            replayStore: stores.replayStore,
            specStore: stores.testSpecStore,
            caseStore: stores.testCaseStore,
            learningsStore: stores.testLearningsStore,
            agentManager,
            project,
            incidentId,
            specSlug,
            model,
            repoLocalPaths,
            onStep: (step, state) => {
              deps.services.incidents.emit('replay.step', { incidentId, step, state } as never);
            },
          });

          if (result.boundFilePath) {
            try {
              stores.boundTestsStore.appendBound(project, {
                filePath: result.boundFilePath,
                incidentId,
                replayId: result.attempt.id,
                addedAt: new Date().toISOString(),
              });
            } catch (err) {
              console.warn('[replay] appendBound failed:', err);
            }
          }

          if (
            result.attempt.confidence === 'low'
            || result.attempt.status === 'low-confidence'
            || result.attempt.status === 'unreproducible'
          ) {
            try {
              const { notifyLowConfidenceReplay } = await import('../incident-slack-notifier.js');
              const incident = stores.incidentStore.read(project, incidentId);
              if (incident) await notifyLowConfidenceReplay(incident, result.attempt);
            } catch { /* non-fatal */ }
          }

          deps.services.incidents.emit('replay.complete', {
            result,
            incidentId,
            attempt: result.attempt,
            boundFilePath: result.boundFilePath,
          } as never);
        } catch (err) {
          deps.ws.send(JSON.stringify({
            type: 'replay-error',
            payload: { incidentId, message: err instanceof Error ? err.message : String(err) },
          }));
        }
      },
    }),
  };
}
