# review-incident-bind-check — Integration notes (Review Phase R7)

## Wiring point
Call `checkIncidentBindings(project, changedFiles, { boundStore })` inside
`review-publisher.ts` **before** persona dispatch. The returned findings must
be merged into the review's top-level `findings[]` array ahead of any
persona-authored findings, so they always surface in the PR summary and
inline comments regardless of which personas actually ran.

```ts
// in review-publisher.ts, prior to persona routing:
const guardFindings = checkIncidentBindings(pr.project, pr.changedFiles, {
  boundStore: deps.boundStore,
});
review.findings = [...guardFindings, ...review.findings];
```

## Filter bypass
These findings carry `immutable: true` and a pre-passed `evidenceChecks`
entry (`bound-registry`). The downstream pipeline MUST treat `immutable`
findings as opaque:

- Scope filter (`review-scope-matcher`) — skip when `immutable === true`.
- Evidence gate — accept findings whose own `evidenceChecks` are all
  `passed: true`; R7 ships them pre-passed.
- Convention / calibration / dismissal / de-dup passes — skip `immutable`.

This guarantees that a touched regression-guard always blocks the PR until
a reviewer explicitly overrides.

## Override path
Overrides cannot be one-click. The existing Guards override UI in the
dashboard must:
- Require a written reason of **≥ 20 characters**.
- Forward the override to `BoundTestsStore.removeBound(project, filePath,
  reason)` which already enforces non-empty reason and emits an `override`
  audit entry.
- Display the finding's `id` + `incidentId` + `replayId` so the reason can
  be audited against the original incident.

## Failure mode
If `boundStore.listBound()` throws, `checkIncidentBindings` returns `[]`
(store is already defensive). A monitoring alert on empty returns where
bound tests are known to exist should live in `bound-tests-audit` — not
here — so this module stays pure.
