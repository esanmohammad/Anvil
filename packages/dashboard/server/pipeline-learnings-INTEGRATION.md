# Phase 6 — Learnings Integration Notes

Phase 6 delivers the storage + UI for the plan-approval learning loop. This
file captures the seams that a follow-up PR needs to wire into the live
dashboard server and planner persona. No behaviour is hooked up yet.

## WebSocket actions to add in `dashboard-server.ts`

- `get-plan-approval-stats` → `{ project }`
  - Handler: `store.computeStats(project)` and reply
    `{ type: 'plan-approval-stats', payload: { project, stats } }`.
- `list-plan-approval-records` → `{ project, limit?, since?, outcome? }`
  - Handler: `store.list(project, { limit, since, outcome })` and reply
    `{ type: 'plan-approval-records', payload: { project, records } }`.

Both can share a singleton `const learnings = new PipelineLearningsStore();`
instantiated alongside the other stores at top of file.

## Where to call `store.record()`

The resume-pipeline handler added in Phase 3 (`pipeline-pause-handlers.ts`) is
the single chokepoint for plan-gate decisions. Inside the resume path, after
`PipelinePauseStore.resume(...)` succeeds, capture the record:

```
const pause = pauseStore.get(runId);
learnings.record(pause.project, {
  runId,
  planVersion: pause.planVersion ?? 1,
  outcome: decisionToOutcome(decision),     // approve → 'approved', etc.
  riskTier: pause.risk?.tier,
  riskOverall: pause.risk?.overall,
  confidence: pause.risk?.confidence,
  touchedTopLevelDirs: topLevelsOf(pause.plan?.touchedFiles ?? []),
  modifications: decision.action === 'modify' ? decision.modifications : undefined,
  rejectionReason: decision.action === 'reject' ? decision.note : undefined,
  approvedBy: approver,
  decisionLatencyMs: Date.parse(resumed.resumedAt) - Date.parse(pause.pausedAt),
});
```

Also call from the timeout sweeper (`pipeline-pause-sweeper.ts`) with
`outcome: 'timed-out'` and from the replan entry point with
`outcome: 'replanned'`.

## Register `PlanApprovalStatsPanel` in the Insights page

In the Insights route (currently `packages/dashboard/src/components/...`):

```
const { stats, loading } = usePlanApprovalStats(ws, project);
// …
<PlanApprovalStatsPanel stats={stats} loading={loading} />
```

No router changes required — the Insights page file already renders sections
list-style.

## Planner calibration (future)

`pipeline-calibration.ts` is ready but unwired. To apply it, the planner
persona loader should call `buildPlannerFewShots(stats)` and append the
result to the system prompt. The risk scorer can fold
`calibrateRiskWeights(stats)` into its per-path weight lookup.
