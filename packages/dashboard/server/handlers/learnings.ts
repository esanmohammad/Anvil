/**
 * Learning-loop + checkpoint + regression read routes (Recipe 7 / Phase 1).
 *
 * Migrated:
 *   - get-plan-approval-stats     — learnings stats per project
 *   - list-plan-approval-records  — historical approval/rejection trail
 *   - get-checkpoint-stats        — checkpoint hit-rate snapshot
 *   - get-regression-metrics      — incident → bound-test conversion KPIs
 */

import { route, type Handler } from './route.js';
import * as Z from './schemas.js';

export function learningsRoutes(): Record<string, Handler> {
  return {
    'get-plan-approval-stats': route({
      input: Z.GetPlanApprovalStats,
      errorWireType: 'learnings-error',
      handle: (input, deps) => {
        const store = deps.extras.learningsStore;
        if (!store) return;
        return { project: input.project, stats: store.computeStats(input.project) };
      },
      wireType: 'plan-approval-stats',
    }),

    'list-plan-approval-records': route({
      input: Z.ListPlanApprovalRecords,
      errorWireType: 'learnings-error',
      handle: (input, deps) => {
        const store = deps.extras.learningsStore;
        if (!store) return;
        return {
          project: input.project,
          records: store.list(input.project, {
            limit: input.limit,
            since: input.since,
            outcome: input.outcome,
          }),
        };
      },
      wireType: 'plan-approval-records',
    }),

    'get-checkpoint-stats': route({
      input: Z.GetCheckpointStats,
      errorWireType: 'checkpoint-error',
      handle: (input, deps) => {
        const store = deps.extras.checkpointStore;
        if (!store) return;
        return {
          project: input.project,
          runFamily: input.runFamily,
          stats: store.stats(input.project, input.runFamily),
        };
      },
      wireType: 'checkpoint-stats',
    }),

    'get-regression-metrics': route({
      input: Z.GetRegressionMetrics,
      errorWireType: 'regression-metrics-error',
      handle: async (input, deps) => {
        const incidents = deps.extras.incidentStore;
        const replays = deps.extras.replayStore;
        const bound = deps.extras.boundTestsStore;
        if (!incidents || !replays || !bound) return;
        const { computeRegressionMetrics } = await import('../regression-metrics.js');
        const { join } = await import('node:path');
        const metrics = computeRegressionMetrics(input.project, {
          incidentStore: incidents as Parameters<typeof computeRegressionMetrics>[1]['incidentStore'],
          replayStore: replays as Parameters<typeof computeRegressionMetrics>[1]['replayStore'],
          boundStore: bound as Parameters<typeof computeRegressionMetrics>[1]['boundStore'],
          auditLogFile: join(deps.extras.anvilHome, 'bound-tests-audit', input.project, 'audit.log'),
        });
        return { metrics };
      },
      wireType: 'regression-metrics',
    }),
  };
}
