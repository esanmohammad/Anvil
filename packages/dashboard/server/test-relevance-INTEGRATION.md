# Test Relevance Ranker — Integration Notes (CI Triage Phase 2)

Phase 2 introduced the AST-graph-reachability ranker
(`test-relevance-ranker.ts`, `test-relevance-cache.ts`) and its UI
(`TestRelevancePanel.tsx`, `useTestRelevance.ts`) plus the
`anvil tests rank <pr-url>` CLI. These modules are standalone —
`dashboard-server.ts`, `main.tsx`, `router.tsx`, `cli/src/index.ts`, and the
knowledge-base manager are NOT modified. Wire-up steps below.

## 1. WS action: `rank-tests-for-pr`

In `dashboard-server.ts` alongside the other action handlers:

```ts
import { rankRelevantTests } from './test-relevance-ranker.js';
import { TestRelevanceCache, hashGraph } from './test-relevance-cache.js';

const relevanceCache = new TestRelevanceCache(ANVIL_HOME);

// action === 'rank-tests-for-pr'
const changed = await diffToChangedSymbols(prUrl);    // existing PR-diff helper
const graphs = await kbManager.loadGraphs(project);    // repo → GraphifyOutput
const graphHashes = Object.fromEntries(
  Object.entries(graphs).map(([r, g]) => [r, hashGraph(g)]),
);
const diffHash = sha256(diffFingerprint(changed));
let result = relevanceCache.get(project, diffHash, graphHashes);
if (!result) {
  result = rankRelevantTests({ changedSymbols: changed, repoGraphs: graphs });
  relevanceCache.put(project, {
    diffHash, repoGraphHashes: graphHashes, result,
    computedAt: new Date().toISOString(),
  });
}
ws.send(JSON.stringify({ type: 'test-relevance', payload: result }));
```

Emit `test-relevance-error` with `{ message }` on failure (parser error, KB
miss, graph not built yet).

Also add a companion handler for `run-relevant-tests` that forwards the
`tests` array to the existing test-runner (`pipeline-runner.ts` already
accepts a filtered filename list via `--tests=<file,file,...>`).

## 2. HTTP endpoint: `POST /api/tests/rank`

Same body as the WS action; returns the JSON `RelevanceResult`. The CLI
(`anvil tests rank`) prefers HTTP because CI scripts don't keep WS open.

```ts
app.post('/api/tests/rank', async (req, res) => {
  const { project, prUrl } = req.body;
  // ...same logic as the WS handler...
  res.json(result);
});
```

## 3. PR Board mount point

In `PRBoardContainer.tsx` / `PRCard.tsx`, on the row-expansion branch
(what the user currently sees when they click a PR card), render:

```tsx
import { TestRelevancePanel } from './TestRelevancePanel.js';
...
{expanded && (
  <TestRelevancePanel prUrl={pr.url} project={project} ws={ws} />
)}
```

## 4. CLI registration

In `packages/cli/src/index.ts`, next to the other `program.addCommand(...)`
calls:

```ts
import { testsRankCommand } from './commands/tests-rank.js';
program.addCommand(testsRankCommand);
```

Users can then run:

- `anvil tests rank https://github.com/acme/svc/pull/42`
- `anvil tests rank https://...pull/42 --format json`
- `anvil tests rank https://...pull/42 --format list | xargs npx jest`

## 5. Cache gc

Call `relevanceCache.gc(7 * 24 * 3600 * 1000)` in the existing weekly
housekeeping task to evict entries older than a week.
