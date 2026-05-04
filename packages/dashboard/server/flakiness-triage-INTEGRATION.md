# Flakiness Triage — Integration Notes

Phase 1 ships the clusterer, fix suggester, and tab UI. The following wire-up
steps live outside this changeset and touch shared files, so they are listed
here for the reviewer to action in a follow-up PR.

## 1. WebSocket actions (dashboard-server.ts)

Add two actions to the incoming message router:

- `get-flakiness-clusters` — expects `{ project, specSlug }`. Load samples
  via the extended `TestLearningsStore` (see step 2), run `analyzeFlakiness`
  then `suggestFlakyFixes`, and reply with:
  ```json
  { "type": "flakiness-clusters", "project": "…", "specSlug": "…",
    "clusters": [...], "suggestions": [...] }
  ```
- `list-flakiness-samples` — expects `{ project, testId }`. Return raw
  `FlakyFailureSample[]` for drill-down debugging in the tab.

## 2. TestLearningsStore surface

`test-learnings.ts` already records per-test flakiness history; extend it
with a READ-ONLY method:

```ts
listFlakySamples(project: string, testId?: string): FlakyFailureSample[]
```

Do NOT reshape the existing `flakyTests` summary — add a parallel persisted
log (e.g. `flaky-samples.jsonl`) written by the runner as each retry
completes. Keep the analyzer pure.

## 3. Mount the tab in TestSpecPage

In `src/components/test/TestSpecPage.tsx`:

- Add `'flakiness'` to the `Tab` union and `tabs` list (use `Activity` icon).
- When `activeTab === 'flakiness'` render
  `<FlakinessTriageTab project={project} specSlug={spec.slug} ws={ws} />`.

That file is shared and out of scope for this phase, hence the callout here.
