# Review Phase R4 — Plan-Aware Reviewer Integration Notes

Two new modules ship with this phase:

- `review-plan-diff-comparator.ts` — pure diff vs plan comparator.
- `review-plan-aware.ts`          — comparison → PlanAwareFinding mapper.

Neither touches shared state. Integration happens in `review-publisher.ts`.

## Where to call `producePlanAwareFindings`

Inside the pipeline that builds a `Review`, right after persona findings are
collected and before the verdict is computed, branch on the PR metadata:

```ts
// review-publisher.ts (or wherever Reviews are assembled)
if (pr.planSlug) {
  const plan = planStore.readCurrent(pr.project, pr.planSlug);
  if (plan) {
    const comparison = comparePlanAgainstDiff(plan, diffFiles);
    const planAware  = producePlanAwareFindings(comparison);
    review.findings.push(...planAware.map(toReviewFinding));
  }
}
```

`planSlug` is populated by `feature-store.ts` from the run's `planSeed`
config; the review pipeline receives it on the PR metadata object that it
already threads through.

## Mapping `PlanAwareFinding` → `ReviewFinding`

Field alignment is deliberate — a shim is enough. Severity mapping:

| PlanAwareSeverity | ReviewFinding severity |
|-------------------|------------------------|
| `blocker`         | `blocker`              |
| `high`            | `error`                |
| `medium`          | `warn`                 |
| `low`             | `info`                 |

Set `category: 'plan-drift'`, `persona: 'architect'`, and carry
`planStepId` / `filePath` through on the existing snippet/description
fields. Filter out `kind === 'plan-ok'` before posting to GitHub — it is a
pipeline signal, not a user-facing comment.
