# ADR — `@esankhan3/anvil-core-pipeline` extraction

**Status:** Accepted (Phases 1-9 shipped; Phase E in flight as part of dashboard pipeline-runner deprecation).

**Authors:** dashboard / cli / core-pipeline maintainers.

**Companion docs:**
- `docs/dashboard-pipeline-deprecation-plan.md` — strangler-fig migration off `dashboard/server/pipeline-runner.ts` onto `core-pipeline`.
- `packages/core-pipeline/ARCHITECTURE.md` — module map of what physically lives in the package today.
- `packages/core-pipeline/CLAUDE.md` — guidance for editing inside the package.

This ADR is the authoritative contract for the typed `Step<I, O>` graph + `EventBus` + `StepRegistry` + lifecycle hook surface. The runtime in `packages/core-pipeline/src/` implements these contracts; reverse drift (changing the runtime without amending this doc) is explicitly out-of-band.

---

## §1. Context

The cli's monolithic `orchestrator.ts` if-tree and the dashboard's monolithic `pipeline-runner.ts` shared the same conceptual pipeline (clarify → requirements → repo-requirements → specs → tasks → build → test → validate → ship) but had two divergent implementations. Both grew their own retry, fanout, resume, and cost-tracking logic; behavior parity bugs were endemic.

Goal of the extraction: a single, typed, hookable pipeline engine that both consumers drive — cli adopts it through a separate consolidation ADR; dashboard adopts it via the deprecation plan. Vendor SDKs, transport (WS), and storage layout (`~/.anvil/`) stay outside the engine. The engine ships with a small set of hooks (audit, learners, cost, run-store, feature-store, approval-gate, stream, checkpoint, pr-url, liveness-prefetch) that subscribers attach per-run.

---

## §2. Decision

Ship `@esankhan3/anvil-core-pipeline` as a standalone package owning:

1. The `Step<I, O>` contract (id, async `run(ctx)`, optional `subSteps`, optional `retryPolicy`, optional `parallelism`, optional `skipIf`).
2. A typed `EventBus` (in-memory, FIFO at equal priorities, descending priority globally; `request`/`respond` for human-in-the-loop steps).
3. An ID-based `StepRegistry` (Hapi-style `register` / `insertBefore` / `insertAfter` / `replace` / `remove`).
4. A `Pipeline` walker that threads outputs into next-step inputs, fans out per-repo, applies `retryPolicy`, supports resume-from-step + rewind-to-step.
5. A canonical hook vocabulary (`StepHookPoint`) emitted at well-defined moments inside the walker — see §4.
6. A canonical `STAGES` array + per-stage permission tables + per-stage routing helpers.

Hooks live in-tree but are pure subscribers — they own no state the bus doesn't already own; their durable state goes in caller-injected dependencies.

Reverse deps are physically prevented by `package.json` — the engine never imports cli or dashboard.

---

## §3. Consequences

- **Consumers stay thin.** Both cli and dashboard end up as composition layers wiring a registry + hooks against `Pipeline.run()`.
- **Behavior parity becomes the contract**, not a hope. Any deviation between cli and dashboard surfaces in the hook stream, not in private state.
- **Hook authors must tolerate `step:skipped`.** Resume-from-step and `skipIf` both fire `step:skipped`; hooks that treated it as a synonym for `step:completed` had to change.
- **No durable execution.** Pattern 1 (audit log + state file) only. Cross-process step-level replay is explicitly out-of-scope (P7); see `~/.anvil/runs/<runId>/audit.jsonl` + `~/.anvil/state.json` + `~/.anvil/features/<project>/<slug>/*.md` as the durable surfaces.
- **No cross-process pub/sub.** `EventBus` is in-process only. Distant consumers read via the audit log + state file.
- **Bus event vocabulary is locked.** `StepHookPoint` additions are an ADR amendment, not a casual code change — see §4.

---

## §4. `StepHookPoint` vocabulary (locked)

`StepHookPoint` is the canonical set of event names a `PipelineEvent` may carry. Hooks subscribe by name; the walker emits them at exactly the moments described below. Adding a new value requires a §4 amendment AND a corresponding listing in `packages/core-pipeline/ARCHITECTURE.md §2.3`.

### §4.1 Pipeline-level events

| Event                | Fires                                            | Payload (typed inline at emit site)                       |
|----------------------|--------------------------------------------------|------------------------------------------------------------|
| `pipeline:started`   | Once, before the first Step runs                 | `{ runId, workspaceDir, stepIds: string[] }`               |
| `pipeline:completed` | Once, after the last Step succeeds               | `{ runId, durationMs, costUsd, completedSteps: string[] }` |
| `pipeline:failed`    | Once, after any Step's failure halts the run     | `{ runId, failedStep: string, error: { message } }`        |

### §4.2 Step-level events

| Event                | Fires                                                | Payload                                            |
|----------------------|------------------------------------------------------|-----------------------------------------------------|
| `step:started`       | Per Step entry                                       | `{ stepId, ts }`                                    |
| `step:completed`     | Per Step success                                     | `{ stepId, output?, durationMs, costUsd? }`         |
| `step:failed`        | Per Step failure (after retry exhaustion)            | `{ stepId, error: { message, stack? }, attempts }`  |
| `step:retried`       | Before each retry attempt                            | `{ stepId, attempt, baseMs, error: { message } }`   |
| `step:skipped`       | Per Step skip (resume / completedSteps / skipIf)     | `{ stepId, reason: 'completed' \| 'resume' \| 'rewind' \| 'skipIf' }` |

Hooks MUST handle `step:skipped` explicitly — it is NOT a synonym for `step:completed`.

### §4.3 Sub-step events

| Event                 | Fires                                       | Payload                                |
|-----------------------|---------------------------------------------|-----------------------------------------|
| `sub-step:started`    | Per sub-Step entry                          | `{ stepId, parentStepId }`              |
| `sub-step:completed`  | Per sub-Step exit (success or fail)         | `{ stepId, parentStepId, ok: boolean }` |

Sub-steps fire ONLY these two events; they do NOT also fire `step:started` / `step:completed`.

### §4.4 Artifact events

| Event              | Fires                       | Payload                              |
|--------------------|-----------------------------|---------------------------------------|
| `artifact:emitted` | Per `ctx.emit(id, data)`    | `{ stepId, artifactId, byteSize? }`   |

The hook surface deliberately does NOT include the artifact body — large artifact payloads stay in the artifact store, not the event stream. Hooks that need the body call `ctx.artifacts.read(artifactId)`.

### §4.5 Dashboard-domain events (Phase E amendment)

These four event types are added as part of the dashboard pipeline-runner deprecation. They surface state changes the dashboard's `this.state` rollup needs but that the existing 11 events don't cover. Both events flow through the same `EventBus`, so any consumer (cli, dashboard, future tooling) can subscribe.

| Event                  | Fires                                                                | Payload                                                                                            |
|------------------------|----------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| `stage:repo-progress`  | When a single repo within a `parallelism: 'per-repo'` stage transitions status (running / completed / failed). | `{ stageId, stageIndex, repoName, status: 'pending' \| 'running' \| 'completed' \| 'failed', costUsd?, error?: { message } }` |
| `stage:cost-update`    | When the run's cumulative USD ledger increments (per spawn, per fix attempt, per repo task). | `{ stageId, stageIndex, deltaUsd, totalUsd }` |
| `stage:fix-attempt`    | At the start of each iteration of the validate→fix loop (capped at `maxFixAttempts`, default 3). | `{ stageId, stageIndex, repoName?, attempt, maxAttempts, phase: 'fix' \| 'revalidate' }` |
| `reviewer:note`        | When a reviewer-supplied note is armed for a stage (after-stage hook resolution → next-stage prompt prefix). | `{ stageId, stageIndex, note: string, source: 'pause-resolution' \| 'edit-artifact' }` |

#### §4.5.1 Why these four

- **`stage:repo-progress`** — today the dashboard mutates `state.stages[i].repos[r].status` inline. Lifting this to a bus event lets cli (when it adopts the same registry) get a uniform per-repo progress stream without re-implementing the rollup, and lets the dashboard replace ~10 inline `broadcastState()` calls with one rollup-hook subscription.
- **`stage:cost-update`** — totalCost increments today are scattered across `runOneStage`, `runFixLoop`, `runPerRepoStage`, and the after-stage hook. A single event replaces the scatter; cost-tracker, dashboard-state, and run-store hooks all get the same view.
- **`stage:fix-attempt`** — the validate→fix loop is structurally a sub-pipeline and deserves its own event. Forensic queries ("how often does fix-attempt 3 still fail?") become trivial against the audit log.
- **`reviewer:note`** — pendingReviewNote / currentStageReviewNote / clearStageReviewNote is private dashboard state today. Lifting the arming moment to a bus event lets cli surface reviewer notes the same way (when its consolidation lands) and lets a future approval-board UI subscribe without poking at runner internals.

#### §4.5.2 Hook priority interactions

The `attachDashboardStateRollupHook` introduced alongside §4.5 sits at priority `10` (same slot as `attachDashboardStateHook`). Ordering vs. existing hooks at equal `step:*` events:

```
audit-log         priority 100   ← persists first
learners          priority  50
cost-tracker      priority  20
checkpoint        priority  15
dashboard-state   priority  10   ← in-process JSON snapshot
dashboard-rollup  priority  10   ← FIFO tie-break: registers after dashboard-state
stream            priority   5
```

The rollup hook at the same priority as `dashboard-state` is intentional — they read the same event stream and write to two different consumers (file vs. caller-supplied state object). FIFO tie-break preserves the dashboard's existing register order.

### §4.6 Future amendments

When a new event type is needed:

1. Open a §4 amendment in this file with the table row + payload shape + "why" paragraph.
2. Add the value to `StepHookPoint` in `packages/core-pipeline/src/types.ts` with inline JSDoc on the payload.
3. Mirror the table row in `packages/core-pipeline/ARCHITECTURE.md §2.3`.
4. Add a subscription/dispatch test in `core-pipeline/src/__tests__/event-bus.test.ts`.
5. Document priority interactions in §4.5.2's table format if a new hook listens for it.

This sequence (ADR commit → code + tests + ARCHITECTURE.md commit) is locked by `docs/dashboard-pipeline-deprecation-plan.md` execution discipline.
