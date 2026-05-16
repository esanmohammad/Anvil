/**
 * Incident + bind WS routes (Recipe 7 / Phase 1).
 *
 * Migrated:
 *   - ingest-incident        (error wire-type `incident-error`)
 *   - override-bind          (override-by-replayId + Slack notify)
 *   - override-bound-test    (echo `bound-override-applied`,
 *                            error wire-type `bound-override-error`)
 *
 * NOT migrated (closure-dependent — Phase 2):
 *   - replay-incident — drives the replay pipeline, depends on
 *     `runReplayPipeline`, `boundTestsStore.appendBound`, Slack notifier.
 */

import { route, type Handler } from './route.js';
import * as Z from './schemas.js';

export function incidentRoutes(): Record<string, Handler> {
  return {
    // ── Reads ───────────────────────────────────────────────────────────
    'list-incidents': route({
      input: Z.ListIncidents,
      onParseFail: 'silent',
      errorWireType: 'incident-error',
      handle: (input, deps) => {
        const store = deps.extras.incidentStore;
        if (!store) return;
        try {
          return { incidents: store.list(input.project) };
        } catch (err) {
          throw err instanceof Error ? err : new Error(String(err));
        }
      },
      wireType: 'incidents',
    }),

    'list-replay-queue': route({
      input: Z.ListReplayQueue,
      onParseFail: 'silent',
      handle: (input, deps) => {
        const q = deps.extras.autoReplayQueue;
        if (!q) return;
        const jobs = q.snapshot();
        const filtered = input.project ? jobs.filter((j) => j.project === input.project) : jobs;
        return { jobs: filtered };
      },
      wireType: 'replay-queue',
    }),

    'get-incident': route({
      input: Z.GetIncident,
      onParseFail: 'silent',
      handle: (input, deps) => {
        const store = deps.extras.incidentStore;
        if (!store) return;
        return { incident: store.read(input.project, input.incidentId) };
      },
      wireType: 'incident',
    }),

    'get-incident-stats': route({
      input: Z.GetIncidentStats,
      onParseFail: 'silent',
      errorWireType: 'incident-error',
      handle: async (input, deps) => {
        const store = deps.extras.incidentStore;
        const replays = deps.extras.replayStore;
        const bound = deps.extras.boundTestsStore;
        if (!store || !replays || !bound) return;
        const { computeIncidentStats } = await import('../incident-stats.js');
        const incidents = store.list(input.project)
          .map((p) => store.read(input.project, p.id))
          .filter((i): i is NonNullable<typeof i> => !!i);
        const stats = computeIncidentStats(
          incidents as Parameters<typeof computeIncidentStats>[0],
          replays.list(input.project) as Parameters<typeof computeIncidentStats>[1],
          bound.listBound(input.project).length,
        );
        return { stats };
      },
      wireType: 'incident-stats',
    }),

    'list-replays': route({
      input: Z.ListReplays,
      onParseFail: 'silent',
      handle: (input, deps) => {
        const store = deps.extras.replayStore;
        if (!store) return;
        return { replays: store.list(input.project, input.incidentId) };
      },
      wireType: 'replays',
    }),

    'list-bound-tests': route({
      input: Z.ListBoundTests,
      onParseFail: 'silent',
      handle: (input, deps) => {
        const store = deps.extras.boundTestsStore;
        if (!store) return;
        return { bound: store.listBound(input.project) };
      },
      wireType: 'bound-tests',
    }),

    'list-bound-audit': route({
      input: Z.ListBoundAudit,
      errorWireType: 'bound-audit-error',
      handle: (input, deps) => {
        const log = deps.extras.boundAuditLog;
        if (!log) return;
        return { entries: log.tail(input.project, 200) };
      },
      wireType: 'bound-audit',
    }),

    // ── Mutations ───────────────────────────────────────────────────────
    'ingest-incident': route({
      input: Z.IngestIncident,
      onParseFail: 'silent',
      errorWireType: 'incident-error',
      handle: async (input, deps) => {
        const outcome = await deps.services.incidents.ingest(input);
        if ('error' in outcome) return { error: outcome.error };
        // Success — emit handled the wire fan-out.
      },
      // The service returns the original error string as the code; pass
      // it straight through to the wire `message`.
      errorMessage: (code) => code,
    }),

    'override-bind': route({
      input: Z.OverrideBind,
      onParseFail: 'silent',
      errorWireType: 'incident-error',
      handle: async (input, deps) => {
        const result = deps.services.bind.overrideByReplayId(input);
        if ('error' in result) return { error: result.error };
        // Slack notify lives outside the bind domain — handler still
        // owns it. Non-fatal; Slack outages don't break the override.
        try {
          const { notifyBindOverride } = await import('../incident-slack-notifier.js');
          const user = deps.user ?? deps.extras.defaultUser;
          await notifyBindOverride(
            {
              filePath: result.removed.filePath,
              incidentId: result.removed.incidentId,
              replayId: result.removed.replayId,
            },
            user, input.reason,
          );
        } catch { /* non-fatal */ }
      },
      errorMessage: (code) => code === 'bound-not-found' ? 'Bound test not found' : 'Override failed',
    }),

    'override-bound-test': route({
      input: Z.OverrideBoundTest,
      errorWireType: 'bound-override-error',
      handle: (input, deps) => {
        const { entry } = deps.services.bind.overrideByFilePath(input);
        deps.ws.send(JSON.stringify({ type: 'bound-override-applied', payload: { entry } }));
      },
    }),
  };
}
