# `@anvil/core-pipeline` — Architecture

Reference for what physically lives in `packages/core-pipeline/src/`
and how the modules wire together. No future-tense roadmap content —
only what compiles today.

## 1. Layered module map

```
                ┌─────────────────────────────────────────────────────┐
                │ Consumers: cli (orchestrator-v2),                   │
                │            dashboard (pipeline-runner.ts indirect)  │
                └─────────────────────────────────────────────────────┘
                                       │
                                       ▼
        ┌────────────────────────────────────────────────────────────┐
        │ src/index.ts — public barrel                               │
        └────────────────────────────────────────────────────────────┘
              │                │                  │                │
              ▼                ▼                  ▼                ▼
   ┌──────────────────┐ ┌──────────────────┐ ┌──────────────┐ ┌─────────────────┐
   │ Pipeline walker  │ │ EventBus         │ │ StepRegistry │ │ Routing helpers │
   │ pipeline.ts      │ │ event-bus.ts +   │ │ step-        │ │ routing/        │
   │                  │ │ bus-request.ts   │ │ registry.ts  │ │  stage-perm.ts, │
   │   • per-repo     │ │                  │ │              │ │  resolve-model- │
   │     fan-out      │ │   request/       │ │  insert*,    │ │   for-stage.ts, │
   │   • subSteps     │ │   respond        │ │  replace,    │ │  ...            │
   │   • retryPolicy  │ │   primitive      │ │  remove      │ │                 │
   │   • resume-from  │ │                  │ │              │ │                 │
   └──────────────────┘ └──────────────────┘ └──────────────┘ └─────────────────┘
              │                │                  │
              └────────┬───────┴──────────────────┘
                       ▼
        ┌────────────────────────────────────────────────────────────┐
        │ Hooks (subscribers) — src/hooks/                           │
        │                                                            │
        │  audit-log         ─ priority 100                          │
        │  learners          ─ priority 50                           │
        │  cost-tracker      ─ priority 20                           │
        │  checkpoint        ─ priority 15                           │
        │  dashboard-state   ─ priority 10                           │
        │  dashboard-rollup  ─ priority 10  (FIFO after dashboard-st)│
        │  stream            ─ priority  5                           │
        │  run-store         (caller-injected RunStore shape)        │
        │  feature-store     (writes ~/.anvil/features/.../*.md)     │
        │  approval-gate     (responds to bus.request('approval'))   │
        │  pr-url / liveness-prefetch                                │
        └────────────────────────────────────────────────────────────┘
                       │
                       ▼
        ┌────────────────────────────────────────────────────────────┐
        │ Artifact store (artifacts.ts) — write-once in-memory       │
        └────────────────────────────────────────────────────────────┘
```

## 2. Type surfaces

### 2.1 `Step<I, O>` (`src/types.ts`)

```ts
interface Step<I, O> {
  id: string;
  name?: string;
  run(ctx: StepContext<I>): Promise<O>;

  subSteps?: Step<unknown, unknown>[];

  retryPolicy?: {
    attempts: number;
    backoff: 'exponential' | 'linear' | 'constant';
    baseMs: number;
    maxMs?: number;
    retryOn?: (error: unknown) => boolean;
  };

  parallelism?: 'serial' | 'per-project' | 'per-repo';
}
```

`subSteps` run sequentially before the parent's `run()`.
`retryPolicy` wraps each Step (parent or sub) independently.

### 2.2 `StepContext<I>` (`src/types.ts`)

```ts
interface StepContext<I> {
  runId: string;
  workspaceDir: string;
  repoPaths?: Record<string, string>;
  input: I;                                  // prior step's output
  shared: Record<string, unknown>;           // cross-stage mutable state (D4)
  artifacts: ReadonlyArtifactStore;
  emit: (artifactId: string, data: unknown) => void;
  bus: EventBus;
  memory?: MemoryHandles;                    // memory-core integration
  llm?: LlmHandles;                          // agent-core/router integration
  signal: AbortSignal;
}
```

`ctx.shared` is the escape hatch when the prior step's output type
doesn't match the next step's input type. Steps read/write
`shared.<key>` instead of forcing every output to be a superset of
every downstream input.

### 2.3 `StepHookPoint` (`src/event-bus.ts`)

| Event                 | Fires                                        |
|-----------------------|----------------------------------------------|
| `pipeline:started`    | once, before the first Step                  |
| `step:started`        | per Step entry                               |
| `sub-step:started`    | per sub-Step entry                           |
| `sub-step:completed`  | per sub-Step exit (success or fail)          |
| `step:retried`        | before each retry attempt                    |
| `step:completed`      | per Step success                             |
| `step:failed`         | per Step failure (after retry exhaustion)    |
| `step:skipped`        | per Step skip (resume-from-step + completed) |
| `artifact:emitted`    | each `ctx.emit(...)` call                    |
| `pipeline:completed`  | once, after last Step                        |
| `pipeline:failed`     | once, after first failure                    |
| `request:<channel>`   | per `bus.request(...)` call                  |
| `response:<channel>`  | per `bus.respond(...)` call                  |

**Dashboard-domain events** (ADR §4.5 — emitted by callers via
`bus.emit(...)`, not by the walker; consumed by
`attachDashboardStateRollupHook`):

| Event                  | Fires                                                          | Payload type                |
|------------------------|----------------------------------------------------------------|------------------------------|
| `stage:repo-progress`  | per per-repo status transition inside a `'per-repo'` stage    | `StageRepoProgressPayload`   |
| `stage:cost-update`    | per cumulative-USD-ledger increment                            | `StageCostUpdatePayload`     |
| `stage:fix-attempt`    | per validate→fix loop iteration (`fix` then `revalidate`)      | `StageFixAttemptPayload`     |
| `reviewer:note`        | per reviewer-supplied note armed for a stage                   | `ReviewerNotePayload`        |

Listener registration order is preserved at equal priorities
(FIFO tie-break).

## 3. `Pipeline.run()` walker (`src/pipeline.ts`)

```
Pipeline.run(opts?)
  ├─ bus.emit('pipeline:started', { runId })
  ├─ skipSet = completedSteps ∪ steps before resumeFromStep
  ├─ for each step in registry order:
  │    ├─ if step.id in skipSet → bus.emit('step:skipped', ...) ; continue
  │    ├─ bus.emit('step:started', ...)
  │    ├─ for each subStep: runWithRetry(subStep, ctx)
  │    ├─ runWithRetry(step, ctx)        ← honors retryPolicy
  │    │    ├─ if parallelism === 'per-repo': fan out across repoPaths
  │    │    │   • fail-any: any repo's reject rejects the parent
  │    │    └─ else: await step.run(ctx)
  │    ├─ thread output into next step's ctx.input
  │    └─ bus.emit('step:completed' | 'step:failed', ...)
  └─ bus.emit('pipeline:completed' | 'pipeline:failed', { runId })
```

### Resume-from-step (`{ resumeFromStep, completedSteps }`)

Refuses to run any step before `resumeFromStep`. `completedSteps`
populates the artifact cache from prior runs (loaded by the cli's
`feature-store` helper). Skipped Steps emit `step:skipped`, NOT
`step:started/completed` — hooks must handle this explicitly.

## 4. `EventBus` (`src/event-bus.ts` + `bus-request.ts`)

`InMemoryEventBus` (default impl):

- `emit(event, payload)` — awaits all listeners (back-pressure
  honored).
- `emitFireAndForget(event, payload)` — no await, errors swallowed
  with stderr warning.
- `on(event, handler, opts?)` — `priority` for ordering, `once`
  for one-shot.
- `request<P, R>(channel, payload, opts?)` — generates `requestId`,
  emits `request:<channel>`, returns a `Promise<R>` resolved when a
  responder calls `bus.respond(channel, requestId, response)`.
  Default timeout 30 min; configurable per call.
- `respond<R>(channel, requestId, response)` — emits
  `response:<channel>` and resolves the matching pending entry.

The pending-entry map is `Map<requestId, {resolve, reject, timer}>`
keyed inside the bus instance.

## 5. `StepRegistry` (`src/step-registry.ts`)

`InMemoryStepRegistry`:

```ts
register(step)                                  // appends
insertBefore(targetId, step)                    // inserts ahead
insertAfter(targetId, step)                     // inserts after
replace(targetId, step)                         // swap by id
remove(targetId)                                // delete by id
steps()                                         // current order
```

ID-based operations let plugins compose without knowing the full
pipeline shape. Mirrors Hapi.js plugin lifecycle.

## 6. Hooks (`src/hooks/`)

| Hook file                          | Listens for                                                 | Action |
|------------------------------------|-------------------------------------------------------------|--------|
| `audit-log.hook.ts`                | every event                                                 | append JSONL row to `~/.anvil/runs/<runId>/audit.jsonl` |
| `dashboard-state.hook.ts`          | `step:started/completed/failed/skipped`, `artifact:emitted` | debounced JSON snapshot at `~/.anvil/state.json` |
| `dashboard-state-rollup.hook.ts`   | `pipeline:*`, `step:*`, `stage:*`, `reviewer:note`           | mutates caller-supplied `state` and fires debounced `broadcast()` (ADR §4.5) |
| `cost-tracker.hook.ts`             | `artifact:emitted` (cost-shaped artifacts)                  | running USD spend; `.totals()` for caller |
| `learners.hook.ts`                 | `step:completed`                                            | invokes caller-injected `onLearnEvent` (memory-core write-back) |
| `run-store.hook.ts`                | `pipeline:*`, `step:*`                                      | updates injected `RunStore` (structural type `{ updateRun(rec): Promise<void> }`) |
| `feature-store.hook.ts`            | `artifact:emitted` with known artifact ids                  | writes `~/.anvil/features/<project>/<slug>/<id>.md` |
| `approval-gate.hook.ts`            | `request:approval:gate`                                     | calls injected `getApprovalDecision(stageIndex)` and `bus.respond(...)` |

All hooks expose test seams (deterministic clocks, fake fs writers,
synchronous timers).

## 7. Routing helpers (`src/routing/`)

Pure functions used by both cli step adapters and the dashboard's
pipeline runner:

| Function                       | Source file                  | Purpose |
|--------------------------------|------------------------------|---------|
| `allowedToolsForStage(stage)`  | `stage-permissions.ts`       | Returns the tool name list for a stage (e.g. clarify=read-only, build=write+exec, ship=shell+write). Threaded into `BuiltinToolExecutor.allowedTools`. |
| `permissionClassesForStage(stage)` | `stage-permissions.ts`   | Returns the abstract `ToolClass[]` (read/write/exec). Round-trips with `allowedToolsForStage` via `BuiltinToolExecutor.listSchemas()`. |
| `resolveModelForStage(stage, project)` | `resolve-model-for-stage.ts` | Picks a model id from the project's tier policy + chain. Throws `UnknownStageError` / `ModelResolutionError` so callers can surface a clear error. |
| `resolveModelForTask(task, project)` | `resolve-model-for-task.ts` | Per-task variant for the build stage's task fan-out. |
| `extractTaskEnvelopes(...)`    | `extract-task-envelopes.ts`  | Parses TASK-BUNDLES.json into typed envelopes. |
| `loadStagePolicy(workspace)`   | `load-stage-policy.ts`       | Reads + validates `stage-policy.yaml`. |

### `stage-policy.yaml` resolution order

`findStagePolicyPath` (`load-stage-policy.ts`) walks four paths and
returns the first match:

```
1. process.env.ANVIL_STAGE_POLICY (full path)
2. <workspaceRoot>/.anvil/stage-policy.yaml         — per-workspace
3. ${ANVIL_HOME or $HOME/.anvil}/stage-policy.yaml  — per-user (canonical)
4. Bundled default at packages/core-pipeline/src/routing/stage-policy.yaml
```

Step 3 mirrors `models.yaml`'s home-directory lookup so end users have
a single place (`~/.anvil/`) to override both routing concerns. The
override semantics are **full replacement, not merge** — if step 3
declares only some stages, the others throw `UnknownStageError` at
resolve time.

### Declared stages

The bundled default declares 14 stage entries:

| Stage                | Capability  | Complexity | Tier prefer            | Notes |
|----------------------|-------------|-----------|------------------------|-------|
| `clarify`            | reasoning   | S         | local → cheap → premium | Q&A; per-stage permission `[read]` |
| `requirements`       | reasoning   | L         | premium-only           | Top-level analysis |
| `repo-requirements`  | reasoning   | L         | premium-only           | Per-repo decomposition (was `project-requirements`) |
| `specs`              | reasoning   | L         | premium-only           | Long-context spec writing |
| `tasks`              | reasoning   | L         | premium-only           | Task envelope generation |
| `build`              | code        | M         | local → cheap → premium | Implementation; `[read,write,exec]` |
| `test`               | code        | M         | local → cheap → premium | Test-spec authoring; `[read,write]` |
| `validate`           | code        | S         | local → cheap          | Lint/test runs |
| `ship`               | code        | S         | local → cheap          | Git ops + PR descriptions |
| `fix` / `fix-loop`   | code        | M / S     | local → cheap          | Ad-hoc + auto-fix loop |
| `review`             | reasoning   | L         | premium-only           | Code review judgment |
| `research`           | reasoning   | M         | local → cheap          | Free-tier read-only investigation |
| `plan`               | reasoning   | L         | premium-only           | Feature planning |

## 8. Artifact store (`src/artifacts.ts`)

Write-once in-memory map. `ctx.emit(id, data)` writes; downstream
Steps read via `ctx.artifacts.get(id)` / `ctx.artifacts.has(id)`.
Re-emitting an id throws (catches accidental overwrite).

## 9. File layout

```
packages/core-pipeline/
├── README.md
├── CLAUDE.md
├── ARCHITECTURE.md
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                       ← public barrel
    ├── version.ts
    ├── types.ts                       ← Step<I, O>, StepContext, StepHookPoint
    ├── event-bus.ts                   ← EventBus + InMemoryEventBus
    ├── bus-request.ts                 ← request/respond primitive
    ├── step-registry.ts               ← InMemoryStepRegistry
    ├── pipeline.ts                    ← Pipeline.run walker
    ├── artifacts.ts                   ← write-once artifact store
    ├── hooks/
    │   ├── index.ts
    │   ├── audit-log.hook.ts
    │   ├── dashboard-state.hook.ts
    │   ├── cost-tracker.hook.ts
    │   ├── learners.hook.ts
    │   ├── run-store.hook.ts
    │   ├── feature-store.hook.ts
    │   └── approval-gate.hook.ts
    ├── routing/
    │   ├── stage-permissions.ts       ← allowedToolsForStage / permissionClassesForStage
    │   ├── stage-policy.yaml          ← default policy schema example
    │   ├── load-stage-policy.ts
    │   ├── resolve-model-for-stage.ts
    │   ├── resolve-model-for-task.ts
    │   ├── extract-task-envelopes.ts
    │   └── task-envelope.ts
    └── __tests__/                     ← 40+ tests
```

## 10. Runtime dependencies

From `package.json`:

- `@anvil/agent-core` — `LlmHandles` plumbing on `StepContext.llm`,
  shared `BuiltinToolExecutor` (used by `tools-stage-integration`
  test).
- `@anvil/memory-core` — `MemoryHandles` plumbing on
  `StepContext.memory`.
- `yaml` — `stage-policy.yaml` parsing.

No vendor LLM SDK. No durability backend. No broker.

## 11. Tests

`node --test` runs every compiled `*.test.js` under `dist/__tests__/`:

- `bus-request.test.ts` — happy / timeout / parallel / no-responder.
- `resume.test.ts` — middle / no-op / all-completed / unknown-id.
- `shared-state.test.ts` — write A / read B / per-repo concurrent.
- `pipeline.test.ts` — sequential, parallel, retry, sub-steps, skip.
- `tools-stage-integration.test.ts` — round-trip through
  `allowedToolsForStage` + `BuiltinToolExecutor.listSchemas`.
- `routing-stage-permissions.test.ts` — permission-class mapping.
- Hook tests under `dist/__tests__/hooks/`.

## 12. Boundaries

- `core-pipeline` does NOT depend on cli or dashboard. cli's
  `RunStore` enters via injected structural type
  (`{ updateRun(rec): Promise<void> }`); cli's `getApprovalDecision`
  enters as an injected function. Reverse deps are physically
  prevented by `package.json`.
- The walker doesn't add a mutex around `ctx.shared` for per-repo
  fan-out — Steps are responsible for their own thread safety.
- All durable state lives outside the walker:
  `~/.anvil/runs/<runId>/audit.jsonl` (append-only),
  `~/.anvil/state.json` (debounced snapshot),
  `~/.anvil/features/<project>/<slug>/*.md` (write-once artifacts).
- **v0.3.0 — Pattern-2 durable execution (`src/durable/`).** Step-level
  cross-process replay is now in-scope (P7 from the original
  extraction ADR is done). See §11 below.

## 11. Durable execution module (`src/durable/`)

```
              ┌─────────────────────────────────────────────────┐
              │ Caller: Pipeline.run({durableStore, holder})    │
              └────────────────────────┬────────────────────────┘
                                       ▼
              ┌─────────────────────────────────────────────────┐
              │ Pipeline.run() —                                │
              │   1. Read prior events                          │
              │   2. Skip 'replay-completed' steps              │
              │   3. For each remaining step:                   │
              │      a. version check vs prior 'step:started'   │
              │      b. attach EffectRuntime to ctx             │
              │      c. invoke step.run(ctx)                    │
              │      d. record step:completed                   │
              │   4. On failure: compensation walk in reverse   │
              └────────────────────────┬────────────────────────┘
                                       ▼
                  ┌────────────────────────────────────────┐
                  │ EffectRuntime (per step)               │
                  │ ctx.effect(name, fn, opts)             │
                  │ ctx.now / uuid / random / sleep        │
                  │ ctx.waitForSignal(channel)             │
                  └────────────────┬───────────────────────┘
                                   ▼
              ┌─────────────────────────────────────────────┐
              │ DurableStore (driver: SQLite or in-memory)  │
              │ ┌─────────────────────────────────────────┐ │
              │ │ runs  events  signals  meta             │ │
              │ └─────────────────────────────────────────┘ │
              │ acquireLease | renewLease | releaseLease    │
              │ appendEvent | readEvents | readEffectEvents │
              │ enqueueSignal | consumeSignal | readSignals │
              │ vacuum                                      │
              └─────────────────────────────────────────────┘
                                   ▲
                                   │
              ┌────────────────────┴───────────────────────┐
              │ LeaseManager (multi-process arbitration)   │
              │   • periodic renew at ttl/3                │
              │   • emits 'lost' on peer takeover          │
              │   • findOrphanedRuns / tryTakeOverLease    │
              └────────────────────────────────────────────┘
```

### File layout

```
packages/core-pipeline/src/durable/
├── index.ts             Public barrel.
├── types.ts             RunStatus, RunRecord, EventRecord, SignalRecord,
│                          DeterminismViolationError, ...
├── store.ts             DurableStore interface. Every driver implements.
├── sqlite-store.ts      SQLiteDurableStore (production driver,
│                          ~/.anvil/durable.db via better-sqlite3 + WAL).
├── in-memory-store.ts   InMemoryDurableStore (tests).
├── effect-runtime.ts    EffectRuntime — implements ctx.effect / now /
│                          uuid / random / sleep / waitForSignal.
├── effect-helpers.ts    serializeAgentRunResult, contentHash,
│                          artifactIdempotencyKey.
├── lease-manager.ts     LeaseManager + tryTakeOverLease +
│                          findOrphanedRuns.
├── replay-equivalence.ts Two-pass replay test seam:
│                          seedStoreFromLog, throwingSpy, countingSpy.
└── lint.ts              Seven regex rules: no-direct-{date-now,
                            math-random, crypto-uuid, fs-write,
                            fs-read, exec, setTimeout}.
```

### Effect protocol

```
Step body:
  const x = await ctx.effect('build:spawn-task-<repo>-<id>', async () => {
    return spawnAgentAndWait(...);   // side effect
  });

EffectRuntime.effect(name, fn, opts):
  1. idx = perStepCounter++
  2. recorded = recordedEffects.find(e => e.name === name && e.idx === idx)
  3. if recorded:
       if recorded.kind === 'completed': return recorded.result
       if recorded.kind === 'failed': throw recorded.error
  4. else: NEW effect
       appendEvent({kind: 'effect:started', stepId, name, idx, ts, ...})
       try {
         result = await fn()
         appendEvent({kind: 'effect:completed', result, ...})
         return result
       } catch (err) {
         appendEvent({kind: 'effect:failed', error, retryable, ...})
         throw err
       }
```

Name + idx tuple is the determinism key. On replay, the runtime
walks `recordedEffects` in order and matches by `(name, idx)`. A
mismatch (different name at same idx, or missing) throws
`DeterminismViolationError(reason: 'effect-order-mismatch')`.

### Lease arbitration

Each `LeaseManager` instance:
- Owns a `(runId, holderId)` lease in the durable store.
- Heartbeats `renewLease(ttlMs)` at `ttl/3` cadence.
- On `renewLease` failure → emits `'lost'` event; caller cancels
  the in-flight run.
- `tryTakeOverLease(store, runId, newHolder, ttlMs)` — peer takeover
  when the current lease is expired.
- `findOrphanedRuns(store)` — at boot, scan for `status='running'`
  rows with expired leases. The dashboard's `setup/durable.ts`
  calls this and dispatches each through `auto-replay-queue`.

### Signal channel

```
Producer (any in-process or remote actor):
  durableStore.enqueueSignal(runId, channel, payload)

Consumer (step body):
  const answer = await ctx.waitForSignal<string>(channel)
    1. Check signals table for unconsumed entries
    2. If found: mark consumed, return payload
    3. If not: subscribe to in-process notifier
    4. Block until either: signal arrives, run cancels
```

Channel naming convention:
- `stage-answer-<stageIndex>` — project-level Q&A
- `stage-answer-<stageIndex>:<repoName>` — per-repo Q&A
- `reviewer-decision-<stageLabel>` — review pause decisions

### Lint rule

`scripts/lint-stages.js` (driven by `npm run lint:stages`) walks
`src/stages/` + `src/steps/` + `dashboard/server/pipeline-stages.ts`
applying `lintStepSource` to each. Violations: direct
`Date.now()`, `Math.random()`, `crypto.randomUUID()`, `fs.write*`,
`fs.read*`, `exec*`, `setTimeout`. Recommended replacement:
`ctx.now()`, `ctx.uuid()`, `ctx.effect('<name>', fn)`. Advisory
mode by default; set `ANVIL_LINT_STAGES_STRICT=1` for CI fail.
