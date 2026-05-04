# Phase 3 — CI Triage: Integration Notes

This phase adds CI log triage: ingest a log, cluster failures into
root-cause buckets, and render the result. No existing file was modified;
wiring happens in a follow-up PR.

## New WebSocket actions

Register these in `dashboard-server.ts` alongside other handlers:

| Action (WS `action`)  | Response type          | Purpose                                                   |
|-----------------------|------------------------|-----------------------------------------------------------|
| `analyze-ci-log`      | `ci-triage-report`     | `{ logText, project }` → `{ report }` (runs `clusterCiLog`) |
| `fetch-ci-log`        | `ci-triage-report`     | `{ logUrl, project }` → fetches via `gh run view --log`, then clusters |
| `save-ci-triage`      | `ci-triage-saved`      | Persists the last report in session via `CiTriageStore.record` |
| `list-ci-triage`      | `ci-triage-history`    | `{ history: IndexEntry[] }` for the sidebar history list  |

Error paths respond with `ci-triage-error` or `ci-log-fetch-error`
carrying `{ message }`.

Skeleton wiring:

```ts
import { clusterCiLog } from './ci-log-clusterer.js';
import { CiTriageStore } from './ci-triage-store.js';
import { loadProjectExtraPatterns } from './ci-patterns-loader.js'; // follow-up

const triageStore = new CiTriageStore(getAnvilHome());

case 'analyze-ci-log': {
  const extra = loadProjectExtraPatterns(msg.project);
  const report = clusterCiLog({ logText: msg.logText, extraPatterns: extra });
  ws.send(JSON.stringify({ type: 'ci-triage-report', payload: { report } }));
  return;
}
```

## Sidebar route

Add to `router.tsx`:

```tsx
<Route path="/triage" element={<TriagePanel project={project} ws={ws} />} />
```

…and append a sidebar item in `main.tsx` using the `Search` icon.

## CLI registration

In `packages/cli/src/index.ts`:

```ts
import { triageCommand } from './commands/triage.js';
program.addCommand(triageCommand);
```

## Pattern-library extension

Teams can drop `~/.anvil/projects/<slug>/ci-patterns.json` to add custom
rules. Entries are merged **ahead** of defaults (first-match-wins):

```json
[
  {
    "pattern": "known-flake",
    "severity": "low",
    "matcher": "MyFlakyTest\\.spec",
    "suggestedFix": "Known flake #FT-42 — quarantine."
  }
]
```

The CLI loads this file directly; the dashboard should invoke the same
loader during `analyze-ci-log` / `fetch-ci-log` so both surfaces stay in
sync.
