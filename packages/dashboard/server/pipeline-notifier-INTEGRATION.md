# pipeline-notifier — integration notes

Phase 5 ships the notifier, approval-token, and escalation primitives as
standalone modules. They are **not wired** into the pipeline runtime yet —
this doc is the checklist for the follow-up integration PR.

## 1. Approve on pause

Where: immediately after `pauseStore.pause(state)` inside the pause flow
(likely `pipeline-runner.ts` or its successor `pipeline-pause-store.ts`).

```ts
import { notifyPipelinePaused } from './pipeline-notifier.js';
import { createApprovalToken, getOrCreateApprovalSecret } from './pipeline-approval-tokens.js';

const secret = getOrCreateApprovalSecret(anvilHome);
const token = createApprovalToken(state.runId, 'approve', secret, 24);
const base = process.env.ANVIL_DASHBOARD_URL; // or a dedicated public base
void notifyPipelinePaused(state, base, token); // fire-and-forget
```

For `notifyCostBreach`, generate **two** tokens — one for `approve` (raise
limit) and one for `reject` (halt run) — and pass both as `raiseToken` /
`rejectToken`.

## 2. `/api/pipeline/approve` handler

Add a webhook route to `dashboard-server.ts`:

1. Parse `token` from query string.
2. Call `verifyApprovalToken(token, secret)`.
3. On null: respond 403 with a short HTML page.
4. On success: look up the pause for `runId`, apply the resume decision
   (`approve` → `pauseStore.resume(runId, {action:'approve'})`, `reject` →
   `pauseStore.cancel(runId)`), and render a confirmation page.
5. Emit a `notifyPipelineResumed` call afterwards so the Slack thread has a
   resolution message.

The route must be idempotent — a user double-clicking the button should not
error. Check pause status before mutating.

## 3. Escalation wiring

Instantiate once at server boot:

```ts
import { PipelineEscalation } from './pipeline-escalation.js';

const escalation = new PipelineEscalation({
  intervalMs: 60_000,            // sweep every minute
  escalationAfterHours: 4,        // tune per risk tier later
  listPauses: () => pauseStore.listAll(),
  onEscalate: async (runId, tier) => {
    const pause = pauseStore.get(runId);
    if (!pause) return;
    const fallbackReviewers = resolveFallbackReviewers(pause);
    const token = createApprovalToken(runId, 'approve', secret, 24);
    await notifyPipelinePaused(
      { ...pause, reviewers: fallbackReviewers },
      process.env.ANVIL_DASHBOARD_URL,
      token,
    );
  },
});
escalation.start();
```

On graceful shutdown: `escalation.stop()`.
