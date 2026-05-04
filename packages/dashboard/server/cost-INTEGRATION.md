# Phase 8 — Cost Ceilings with Live Override: Integration Notes

This phase adds cost tracking and a confidence-gated breach flow. This
document describes how the new primitives plug into the rest of Anvil.
No existing files were modified — wiring happens in a follow-up PR.

## Where to call `ledger.record()`

Inside `server/agent-manager.ts`, at the point where every LLM call
completes (in both the streaming and batch code paths):

```ts
// After each completion:
ledger.record({
  runId, project, stage, agent: personaId,
  model: response.model,
  tokensIn: response.usage.input_tokens,
  tokensOut: response.usage.output_tokens,
});
```

Keep the call synchronous — `record()` uses `appendFileSync` so there is
no race with other agents writing to the same run file.

## Where to call `handler.evaluate()`

Immediately after each `ledger.record()`, pass the run's cost policy:

```ts
await breachHandler.evaluate(runId, project, policy);
```

`policy` comes from the project config: `{ limits, graceWindowSeconds,
onBreach, autoApproveBelow }`. The handler short-circuits when no limit
is breached so the happy path is ~O(entries-in-run).

## `onRejectStop` wiring (Phase 9)

`onRejectStop(runId)` is the escape hatch from a breach:

1. Locate the run's active agent processes (via `agent-manager`).
2. Send SIGTERM to each; fall back to SIGKILL after 5s.
3. Trigger Phase 9 checkpoint flush so the next `anvil resume <runId>`
   can continue from the last stable state.
4. Broadcast `run-rejected` over WS for the dashboard to update.

## New WS handlers + HTTP endpoints

Register these in `dashboard-server.ts` alongside the existing
`list-incidents`, `get-plan`, etc. handlers:

| Action (WS `action`)    | Response type (WS `type`)    | Purpose |
|-------------------------|------------------------------|---------|
| `get-cost-summary`      | `cost-summary`               | `{ summary: RunCostSummary }` for the run |
| `get-cost-breach`       | `cost-breach`                | `{ breach: BreachState \| null }` |
| `respond-cost-breach`   | `cost-breach-response`       | `{ ok: true }`; dispatches to `handler.respond()` |

HTTP fallback (for CI / scripted environments):

```
POST /api/cost/respond
Body: { project, runId, decision: 'raise'|'reject'|'extend',
        deltaUsd?, extendSeconds? }
```

This mirrors `respond-cost-breach`. The CLI prefers the WS transport
but falls back to HTTP when the dashboard's WS is unavailable.

## Dashboard UI wiring

`CostMeter` plugs into the Active Runs view (`AgentTabs` / pipeline
view) as a per-run chrome element:

- Subscribe to `cost-summary` WS broadcasts (re-emitted after each
  `record()` plus a debounced 2s tick).
- Render `<CostMeter totalUsd={summary.totalUsd} limitUsd={policy.perRun}
  projectedUsd={summary.totalUsd * 1.2} onClick={openModal} />`.
- When `get-cost-breach` returns a non-null breach, mount
  `<CostBreachModal ... />`; the modal calls back into `respond-cost-breach`.

The modal's countdown is driven entirely from `graceEndsAt`, so it stays
in sync even if the WS reconnects mid-breach.

## Sweeper lifecycle

Instantiate `CostBreachSweeper` once at boot in `dashboard-server.ts`:

```ts
const sweeper = new CostBreachSweeper(handler, { intervalMs: 5000 });
sweeper.start();
```

Only one sweeper should run per Anvil home — otherwise `onRejectStop`
may fire twice for the same expired breach.
