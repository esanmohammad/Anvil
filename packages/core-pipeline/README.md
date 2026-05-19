# @anvil/core-pipeline

**Pipelines as graphs. Stages as steps. Events for everything else.**

The orchestrator that runs every Anvil pipeline — a tiny, typed
`Step<I, O>` graph with an `EventBus`, lifecycle hooks, and a
plugin-style registry. One engine, many fronts: the CLI drives it,
the dashboard drives it, your tools can drive it too.

---

## Why a pipeline runner needs a real shape

Every "AI workflow" library starts as an if-tree. Then it grows a
retry loop. Then a resume-from-stage shim. Then a parallel block.
By the time you can read it end to end, six concerns are tangled in
one function and changing any of them breaks the others.

**core-pipeline factors them apart from day one.** A `Step<I, O>`
is just a function with typed input and output. The walker handles
ordering, retries, fan-out, and resume. An `EventBus` carries
everything that isn't a value — audit logs, cost tracking, human-
in-the-loop requests, dashboard state. Hooks subscribe; they don't
mutate. Adding a stage is `registry.insertAfter('build', myStep)`,
not a refactor.

```ts
import {
  Pipeline,
  StepRegistry,
  EventBus,
  attachAuditLogHook,
  attachCostTrackerHook,
} from '@anvil/core-pipeline';

const registry = new StepRegistry()
  .register(clarifyStep)
  .register(planStep)
  .register(buildStep, { parallelism: 'per-repo' })
  .register(testStep)
  .register(shipStep);

const bus = new EventBus();
attachAuditLogHook(bus, { runId: 'r-123' });
const cost = attachCostTrackerHook(bus);

const pipeline = new Pipeline(registry, bus);
await pipeline.run({ runId: 'r-123', workspaceDir: process.cwd() });

console.log(`spent $${cost.totals().usd}`);
```

That's the whole shape. Steps in. Events out. Resume, retry, fan-
out, audit, cost — all bolted on through the same two seams.

---

## What you get

### Typed `Step<I, O>` graph
Every step declares its input and output types. The walker threads
each step's output into the next step's `ctx.input`. No untyped
`payload` bag. No string keys for cross-stage values. Refactor with
confidence.

### Plugin-style registry
`register`, `insertBefore`, `insertAfter`, `replace`, `remove` —
the Hapi.js plugin lifecycle, applied to pipeline stages. Tooling
doesn't fork the pipeline; it composes into it.

### Lifecycle hooks, batteries included
Eight hooks ship in-tree:

| Hook | What it does |
|---|---|
| `attachAuditLogHook` | JSONL audit at `~/.anvil/runs/<id>/audit.jsonl` |
| `attachDashboardStateHook` | Debounced state snapshot at `~/.anvil/state.json` |
| `attachCostTrackerHook` | Running USD spend with a `.totals()` accessor |
| `attachLearnersHook` | Memory-core write-back on `step:completed` |
| `attachRunStoreHook` | Persists run records via injected `RunStore` |
| `attachFeatureStoreHook` | Writes artifacts to `~/.anvil/features/<project>/<slug>/` |
| `attachApprovalGateHook` | Wires `bus.request('approval:gate', ...)` to a responder |

Hooks attach by priority. Hooks own no state the bus doesn't already
own. Hooks tolerate `step:skipped` so resume-from-stage doesn't
double-fire.

### Parallelism that scales the same code
`parallelism: 'per-repo'` fans a step out across every repo in the
project. `'per-project'` and `'serial'` are the other two modes.
The walker is fail-any: one repo failing rejects the whole step,
because half-shipped is worse than not-shipped.

### Resume from any stage
The walker accepts `{ resumeFromStep, completedSteps }` and emits
`step:skipped` for everything before the resume point. Pair with
the audit log and you can replay any pipeline run from any point.

### Human-in-the-loop, first class
`EventBus.request<P, R>(channel, payload)` and `respond<R>(channel,
requestId, response)` — the bus pauses the requesting step until a
listener responds. The CLI wires it to stdin / a state file; the
dashboard wires it to a WebSocket. Same step, different responder,
same code path.

### Stage-aware tool permissions
`allowedToolsForStage(stage)` and `permissionClassesForStage(stage)`
return the tool set each pipeline stage is allowed to use. Both the
CLI and the dashboard thread the result into agent spawn specs as
`allowedTools`. The build stage gets file edits; the test stage
gets a shell; the validate stage is read-only. No accidental writes
during review.

### Stage-policy routing
`resolveModelForStage` and `resolveModelForTask` pick the right
model per stage given a `stage-policy.yaml`. Resolution order
mirrors `models.yaml` — env override, per-workspace, per-user,
bundled default — so end users have a single mental model.

### Durable execution &nbsp;<sub><i>new in 0.3.0</i></sub>
Pattern-2 durable execution at the step + effect granularity. Pass
a `DurableStore` into `Pipeline.run()` and every `step:started`,
`step:completed`, `effect:started`, `effect:completed` lands in a
SQLite event log. Replay walks the log, skips steps with a
recorded `step:completed`, and short-circuits each `ctx.effect()`
call to its recorded result — no double spawns, no re-running tools,
no re-prompting users. `ctx.effect(name, fn)`, `ctx.now()`,
`ctx.uuid()`, `ctx.random()`, `ctx.sleep(ms)`, and
`ctx.waitForSignal(channel)` cover every nondeterministic operation
a step body might reach for. Opt-in: omit `durableStore` and the
walker runs byte-identically to pre-0.3.0.

### Multi-process race arbitration &nbsp;<sub><i>new in 0.3.0</i></sub>
`LeaseManager` claims a TTL'd lease in the durable store on
`Pipeline.run()` entry, heartbeats it at `ttl/3`, and emits `'lost'`
when a peer steals it. `findOrphanedRuns(store)` scans for
`status='running'` rows with expired leases — the canonical
crash-recovery signal. `tryTakeOverLease(store, runId, newHolder,
ttlMs)` claims one. The dashboard's boot wiring auto-claims orphan
leases and replays them through `Pipeline.run({resumeFromStep,
durableStore})`. No manual intervention; no duplicated work across
processes.

### Determinism lint &nbsp;<sub><i>new in 0.3.0</i></sub>
`npm run lint:stages` walks every stage + step source file and flags
direct calls to `Date.now`, `Math.random`, `crypto.randomUUID`,
`fs.*`, `exec*`, `setTimeout`. Recommended replacement:
`ctx.now()`, `ctx.uuid()`, `ctx.effect('<name>', fn)`. Advisory
by default; set `ANVIL_LINT_STAGES_STRICT=1` in CI to block merges
on new violations.

---

## Architecture at a glance

```
   ┌──────────────────────────────────────────────────────────┐
   │  StepRegistry        plugin-style: register / insert /   │
   │                      replace / remove                    │
   └──────────────────────┬───────────────────────────────────┘
                          │
                          ▼
   ┌──────────────────────────────────────────────────────────┐
   │  Pipeline.run()                                          │
   │   walker → retries → fan-out (per-repo) → sub-steps      │
   │           ▲                                              │
   │           │ ctx.emit(id, data)                           │
   │           │                                              │
   │   ┌───────┴───────┐                                      │
   │   │ ArtifactStore │ write-once, downstream-readable      │
   │   └───────────────┘                                      │
   └──────────────────────┬───────────────────────────────────┘
                          │ events
                          ▼
   ┌──────────────────────────────────────────────────────────┐
   │  EventBus                                                │
   │   step:starting · step:completed · step:failed ·         │
   │   step:skipped · step:retrying · request:<channel>       │
   └──────────────────────┬───────────────────────────────────┘
                          │ subscribe
                          ▼
                hooks: audit · cost · run-store · feature-store ·
                       learners · approval-gate · dashboard-state
```

Every layer is one file. The walker is ~200 LOC. The bus is
async-aware (awaits listeners) so hooks can do real work without
fighting for ordering.

---

## Stages, today

The 9 declared stages cover both CLI and dashboard pipelines:

```
clarify · requirements · repo-requirements · specs · tasks ·
build · test · validate · ship
```

Each has a permission policy. Each has a routing entry. Each is
a `Step` you can swap, wrap, or insert around.

---

## Philosophy

**Two seams, not seventeen.** Steps for values. Events for
side effects. Everything else (resume, retry, parallelism, audit,
cost) plugs into one of the two.

**No durable execution. Yet.** core-pipeline is "Pattern 1" —
audit log + state file. Cross-process step replay is a future
follow-up; the contracts don't bake it in until they're stable.

**No vendor lock-in.** Hooks accept structural types. The CLI's
`RunStore` is one impl; the dashboard's could be another. The
package depends on `@anvil/agent-core` and `@anvil/memory-core` —
nothing else.

**One engine, multiple fronts.** Same Step graph runs from a
terminal, a dashboard, or anything else that wants to drive a
pipeline. No "CLI mode" vs "server mode" — just different
responders on the bus.

---

## Status

Shipped through Phase 9 of the original extraction plus the v0.3.0
durable-execution rollout (Phases D1–D6 + E0–E10 + F1–F9 + G1–G4).
The dashboard runs on it today; the CLI is migrating off its
legacy orchestrator. Public surface is stable. Recent additions:
`ctx.effect` + replay + lease arbitration + compensation walk.

---

## Part of [Anvil](../../) — the AI development pipeline.
