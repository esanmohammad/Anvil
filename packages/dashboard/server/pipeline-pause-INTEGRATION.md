# Pipeline Pause/Resume — Integration Notes

Phase 3 introduced the pause/resume primitives (`pipeline-pause-types.ts`,
`pipeline-pause-store.ts`, `pipeline-pause-sweeper.ts`,
`pipeline-pause-handlers.ts`). They are intentionally isolated. This doc lists
exactly what the integration step needs to wire into `pipeline-runner.ts` and
`dashboard-server.ts`.

## 1. Instantiate the store + sweeper at boot

In `dashboard-server.ts`, alongside the other stores (e.g. `incidentStore`):

```ts
import { PipelinePauseStore } from './pipeline-pause-store.js';
import { PipelinePauseSweeper } from './pipeline-pause-sweeper.js';

const pipelinePauseStore = new PipelinePauseStore(ANVIL_HOME);
const pipelinePauseSweeper = new PipelinePauseSweeper(pipelinePauseStore, {
  intervalMs: 60_000,
  onTimeout: (state) => {
    broadcast({ type: 'pipeline-paused', payload: { pause: state } });
    // Also trigger whatever auto-action the policy says (cancel/approve).
  },
});
pipelinePauseSweeper.start();
```

Pass `pipelinePauseStore` through the existing `deps` object so other
modules (WS switch, pipeline-runner) can reach it.

## 2. Wire the policy branch in `pipeline-runner.ts`

After each stage completes, call `evaluatePolicy(...)` (Phase 2). If
`decision.pause === true`:

1. `pipelinePauseStore.pause({ runId, project, stage, reason: decision.reason,
   matchedRules: decision.matchedRules, reviewers: decision.reviewers,
   timeoutHours: policy.notifications?.timeoutHours })`.
2. Broadcast `{ type: 'pipeline-paused', payload: { pause } }` over WS.
3. Wait for an external `resume()` / `cancel()` to mutate the store, then
   continue (via a promise resolved from the WS handler) or abort.

Suggested anchor: inside the per-stage loop, right after `stage-complete` is
emitted and before the next stage is scheduled.

## 3. WS actions to add in `dashboard-server.ts`

Add new `case` branches in the WS switch. Each delegates to
`pipeline-pause-handlers.ts` and sends the returned envelope:

- `list-pipeline-pauses` → `handleListPauses(store, msg)`
- `get-pipeline-pause`   → `handleGetPause(store, msg)`
- `resume-pipeline`      → `handleResumePipeline(store, msg, ws.user)` then
  broadcast `pipeline-resumed` to all subscribers.
- `cancel-pipeline-pause` → `handleCancelPause(store, msg, ws.user)` then
  broadcast `pipeline-cancelled`.

## 4. WS message types to broadcast

- `pipeline-paused` — emitted when `store.pause()` is called by the runner.
- `pipeline-resumed` — after a successful `resume()`.
- `pipeline-cancelled` — after `cancel()` or sweeper-driven `timed-out`.

Existing subscribers (dashboard UI) should merge these into run state to show
the awaiting/resumed badge.

## 5. Shutdown

Call `pipelinePauseSweeper.stop()` from the server's shutdown hook so tests
and graceful shutdowns do not leak timers.

## Do NOT

- Import pause modules from pipeline-runner until Phase 4 wiring lands.
- Persist pause state anywhere other than the store (no in-memory duplicates).
