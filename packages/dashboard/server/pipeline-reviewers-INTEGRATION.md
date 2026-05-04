# Phase 7 integration notes — team mode (reviewers + audit)

## Where to call `store.assign`
Right after `PipelinePauseStore.pause(...)` returns in the Phase 3 pause
handler (`pipeline-pause-handlers.ts`). The pause record already carries a
`reviewers: string[]` list — feed it, together with the project policy's
`approvalsRequired` (default: 1), into `reviewersStore.assign`:

```ts
const pause = pauseStore.pause({ ... });
const rule = resolveCodeownersForChangedFiles(repoPath, changedFiles);
const resolved = resolveGroups(rule.owners, policy.groups);
const assignment = reviewersStore.assign({
  runId: pause.runId,
  project: pause.project,
  reviewers: resolved.length > 0 ? resolved : pause.reviewers,
  approvalsRequired: policy.approvalsRequired ?? 1,
});
auditLog.record({ runId: pause.runId, project: pause.project,
  event: 'paused', actor: 'system', details: { reviewers: assignment.reviewers } });
```

## Gating the resume handler
In the existing resume handler, short-circuit if quorum is not met:

```ts
const assignment = reviewersStore.recordApproval(runId, actor, action, note);
auditLog.record({ runId, project, event: action === 'approve' ? 'approved' : 'rejected', actor, details: { note } });
if (!reviewersStore.hasQuorum(assignment)) return { status: 'pending-quorum', assignment };
// quorum met → proceed with pauseStore.resume(...)
```

## Where to instantiate the audit log
Once per server boot, alongside the existing `PipelinePauseStore` — store it
on the same `ServerContext` so handlers can share it:

```ts
const auditLog = new PipelineAuditLog(anvilHome);
const reviewersStore = new PipelineReviewersStore(anvilHome);
```

Events to record:
- `paused`      — after pause creation
- `approved`    — every approve vote (even before quorum)
- `rejected`    — every reject vote
- `modified`    — when a reviewer submits a `modify` decision with a planPatch
- `reassigned`  — on `reviewersStore.reassign(...)`
- `escalated`   — when the sweeper escalates to a secondary reviewer group
- `timed-out`   — when `PipelinePauseSweeper` marks a pause as timed-out
