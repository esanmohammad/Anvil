# Review dismissal filter — integration notes (R8)

This module is additive: `review-learner.ts` keeps owning general
resolution learning; `review-dismissal-store.ts` owns the per-key
dismissal counter that gates auto-filtering.

## WebSocket actions (to be wired in `dashboard-server.ts`)

- `list-review-dismissals` — request payload `{ project }`. Server responds
  with `{ type: 'review-dismissals', payload: { records: DismissalRecord[] } }`
  via `store.list(project)`.
- `reset-review-dismissal` — request payload `{ project, key }`. Server calls
  `store.reset(project, key)` and responds with
  `{ type: 'review-dismissal-reset', payload: { key, removed: boolean } }`.
- On failure, emit `{ type: 'review-dismissal-error', payload: { message } }`.

## When to call `store.record`

Inside the existing `resolve-review-finding` handler (alongside the
`recordResolution` call in `review-learner.ts`), when the incoming
`resolution` is `'dismissed'` or `'wont-fix'`:

```ts
const key = {
  personaId: finding.persona ?? 'unknown',
  claimType: finding.category,                  // or a more specific claimType
  filePattern: derivePatternFromFile(finding.file),
};
dismissalStore.record(project, key, reason);
```

Call it once per user-initiated dismissal (same guard
`prevResolution !== newResolution` that review-learner uses).

## When to call `applyDismissalFilter`

In the reviewer pipeline: **after the evidence gate, before verdict
synthesis**. Findings that pass evidence gating are handed to the
filter, then the surviving `kept` array is what the synthesiser turns
into a verdict.

```ts
const { kept, filtered } = applyDismissalFilter(
  evidenceGatedFindings,
  project,
  dismissalStore,
  { threshold: 3, demoteOnly: false },
);
// Log `filtered` for telemetry, feed `kept` to verdict synthesis.
```

Use `demoteOnly: true` during a calibration ramp-up if you want to
keep the findings visible but drop their severity by one step instead
of hiding them outright.
