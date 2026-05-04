# Regression Guard Phase 3 — Metrics & Insights Panel: Integration Notes

This phase adds a pure metrics roll-up plus the `RegressionGuardPanel`
Insights widget that answers "is Regression Guard actually working?" No
existing files were modified — wiring happens in a follow-up PR.

## New WS handler

Register in `dashboard-server.ts` alongside the existing Insights actions
(`get-plan-approval-stats`, etc.):

| Action (WS `action`)        | Response type (WS `type`)   | Purpose                              |
|-----------------------------|-----------------------------|--------------------------------------|
| `get-regression-metrics`    | `regression-metrics`        | `{ project, metrics: RegressionGuardMetrics }` |

Handler sketch:

```ts
import { computeRegressionMetrics } from './regression-metrics.js';

// Inside the WS message dispatcher:
if (msg.action === 'get-regression-metrics' && typeof msg.project === 'string') {
  const auditLogFile = join(anvilHome, 'bound-tests-audit', msg.project, 'audit.log');
  const metrics = computeRegressionMetrics(msg.project, {
    incidentStore, replayStore, boundStore, auditLogFile,
  });
  ws.send(JSON.stringify({
    type: 'regression-metrics',
    payload: { project: msg.project, metrics },
  }));
}
```

`computeRegressionMetrics` is synchronous and allocation-light — running
it on every request is cheaper than maintaining a projection. No timer /
sweeper is needed.

## Dashboard UI wiring

Mount `RegressionGuardPanel` near the top of the Insights page, above the
plan-approval panel:

```tsx
import { RegressionGuardPanel } from './insights/RegressionGuardPanel.js';
import { useRegressionMetrics } from './insights/useRegressionMetrics.js';

const { metrics, loading } = useRegressionMetrics(ws, project);
return <RegressionGuardPanel metrics={metrics} loading={loading} />;
```

The hook clears stale metrics when the project changes and drops payloads
for projects the user has since switched away from.

## Catch definition

An audit entry with `event: 'verify-failed'` on a bound file is
interpreted as a "catch" — the regression guard broke on a subsequent PR,
preventing a re-introduction of the original bug. `catchesLast30d`
counts these over a rolling 30-day window; `avgCatchLatencyMs` is the
mean delta from each file's first `bound` event to its first
`verify-failed`.
