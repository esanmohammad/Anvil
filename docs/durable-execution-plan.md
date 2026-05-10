# Durable Execution + Cross-Process Replay

**Goal:** lift Anvil's pipeline from **Pattern 1** (audit-log + state-file
granularity) to **Pattern 2** — a Temporal-class durable execution layer
where every effect is checkpointed, step bodies are deterministically
replayable, and a process crash mid-stage resumes from the last checkpoint
on the next process. Cross-process step-level replay (P7 in
`docs/CORE-PIPELINE-EXTRACT-ADR.md`) becomes **in-scope**.

**Branch:** new branch off `feat/harness-improvment` once approved.

**Scope:** core-pipeline (the workflow engine) + dashboard (the host
that drives it). The CLI inherits the same engine for free.

**Non-negotiables:**
- Backward compatible. Existing runs that use `Pipeline.run({ resumeFromStep })`
  keep working unchanged.
- No daemon, no Postgres in v1. SQLite at `~/.anvil/durable.db`.
- Single-process replay first; multi-process scheduler is a v2 follow-up
  with the same persistence layer.
- Test contract green at every commit. New replay-equivalence tests
  are mandatory for every effect.

---

## §A. Why this matters

Today, if the dashboard process dies during stage 5/9 of a 90-minute
run, the user loses everything in flight. The `state.json` says the
stage is `running`; on restart, the runner has no way to know whether
the agent finished, the artifact was written, the git commit landed,
or the PR was created. The user reruns from-stage; the agent re-spawns;
the LLM bill fires twice; and any external effect that already
happened (a PR, a deploy) is invisible to the new run.

World-class systems (Temporal, Restate, Inngest, DBOS, AWS Step
Functions) solve this with the same primitive: **every external
effect is recorded to an append-only log**, and on replay the engine
reads the log instead of re-executing the effect. Step code becomes
deterministic-modulo-effects, and resumption is exact.

This plan ports that primitive to Anvil's `Step<I, O>` graph. It is
the smallest cohesive change that turns the existing infrastructure
(`StepRegistry`, `EventBus`, `BlobStore`, `CheckpointStore`,
`audit.jsonl`, `state.json`) into a durable execution layer.

---

## §B. Reference architectures (one paragraph each)

| System | Model | Storage | Replay |
|---|---|---|---|
| **Temporal** | Workflow code is replayed; activities are checkpointed. Workflow code MUST be deterministic. SDK records every activity result + signal + timer in an event history. | gRPC service backed by Cassandra/Postgres/MySQL. | Replay re-runs workflow code from start; SDK feeds back recorded results in order so the code reaches the suspension point. |
| **Restate** | "Durable promises." Each `await` checkpoints; replay re-executes from the log. Distributed log + state machine. | Single binary; embedded RocksDB. | Same as Temporal but with a saner programming model (await directly returns from log). |
| **Inngest** | Function-as-step. Each step is a separately-invocable serverless function. Engine resolves the DAG. | Postgres (or SaaS). | Step runs once; on retry only the failed step re-runs. No "workflow replay" — coordination is in the engine, not the user code. |
| **DBOS** | Transactional execution: every step runs inside a Postgres transaction. State is the database. | Postgres. | Replay is "look at the row." Best for short workflows that mutate the same DB. |
| **AWS Step Functions** | Declarative state machine (Amazon States Language). Each transition is an explicit message. | DynamoDB. | State machine engine is the source of truth; user code is the activity body. |
| **Anvil today** | Step graph (`StepRegistry`) + audit log + state file. Step bodies are imperative TS; effects (LLM calls, writes, git, gh) fire directly. Resume = re-run step from the start. | JSONL audit log + JSON state file + per-feature artifact files. | "Resume from stage X" granularity only; no mid-step recovery. |

**Anvil's native fit:** Temporal-style. We have the registry (workflow
definition) + bus (event emission) + audit log (event history) already.
The two missing pieces are (1) effect-level checkpoints and (2) a
deterministic replay protocol that feeds them back to step code. This
plan adds both.

---

## §C. Status quo (verified, not assumed)

### What exists today

| Piece | State | Where |
|---|---|---|
| **Step graph** | Done. Steps register; walker runs them in order; `parallelism: 'per-repo'` fans out. | `core-pipeline/src/pipeline.ts`, `step-registry.ts` |
| **EventBus** | Done. Sync emit; async emit; `request/respond` for human-in-the-loop. | `core-pipeline/src/event-bus.ts` |
| **Audit log hook** | Done. Writes JSONL to `~/.anvil/runs/<runId>/audit.jsonl`. Used today as a forensic trail; not for replay. | `core-pipeline/src/hooks/audit-log.hook.ts` |
| **State-file hook** | Done. Debounced JSON snapshot at `~/.anvil/state.json`. Cross-process consumer-only — no replay semantics. | `core-pipeline/src/hooks/dashboard-state.hook.ts` |
| **Resume from-stage** | Done at stage granularity. `Pipeline.run({ resumeFromStep, completedSteps })` walks the registry and emits `step:skipped` for prior stages. | `core-pipeline/src/pipeline.ts:137` |
| **CheckpointStore** | Done — but for **agent-output-level** memoisation, not workflow durability. Keys are `(runId, stage, fingerprint)`; values are agent outputs. Sits at `~/.anvil/checkpoints/<project>/<runFamily>/<stage>/<hash>.json` + a `BlobStore` for large bodies. | `agent-core/src/checkpoint/store.ts` + `blob-store.ts` + `key.ts` |
| **Per-feature artifact files** | Done. Markdown bodies on disk: CLARIFICATION.md, REQUIREMENTS.md, etc. Read on resume to seed `prevArtifact`. | `dashboard/server/artifact-io.ts` + `feature-store.ts` |
| **Pipeline checkpoint** | Done. Per-feature `pipeline-state.json` written on every stage transition. Drives "resume this feature" UX. | `dashboard/server/pipeline-checkpoint.ts` |
| **Sentinel-based control flow** | Done. `__anvilCancel` / `__anvilFailReturn` / `__anvilRewind` thrown from inner steps; caught by `pipeline-loop.ts`. | `dashboard/server/pipeline-loop.ts` |

### What's missing for durable execution

1. **Mid-step crash recovery.** A step body that calls
   `agentManager.spawn → writeFile → gh pr create` has no record of
   which calls completed. On restart, the runner re-spawns the agent
   and double-bills the LLM.

2. **Effect-level checkpointing.** The existing `CheckpointStore`
   checkpoints whole stage outputs by content fingerprint — useful
   for re-running an identical stage cheaply, useless for "what did
   `gh pr create` return last time so I don't run it twice."

3. **Deterministic replay contract.** Step code today reads
   `Date.now()`, generates UUIDs, calls `Math.random()` — replay would
   diverge.

4. **Idempotency keys for external effects.** Git commits create
   non-deterministic SHAs; `gh pr create` is at-most-once-per-call.
   No registry of "this run already created PR #123 in repo X."

5. **Versioning.** Step code changes between runs. Today resume just
   re-runs whatever is on disk — silently wrong if a step's contract
   changed.

6. **Compensation.** No `step.compensate()` hook for rolling back a
   partial deploy.

7. **Cross-process scheduler.** Today exactly one process owns a
   run. To hop processes (failover, horizontal scale), the run state
   must live in a shared store (SQLite is enough for v1).

---

## §D. Target architecture

Single SQLite database at `~/.anvil/durable.db` with three tables:
**runs**, **events**, **effects**. The `Pipeline.run` walker reads
this DB on entry and writes to it on every step + effect. Replay is
"open the DB, walk the events, feed effect results back to step code
in order."

```
┌─────────────────────────────────────────────────────────────────┐
│                  ~/.anvil/durable.db (SQLite WAL)               │
│                                                                 │
│  runs           events             effects                      │
│  ─────          ──────             ───────                      │
│  run_id PK      run_id FK          run_id FK                    │
│  project        seq                step_id FK                   │
│  feature        kind  ──┐          effect_key (caller-named)    │
│  status         step_id │          idx     (within step)        │
│  current_step   payload │          status  (running|done|fail)  │
│  started_at     ts      │          input_hash                   │
│  updated_at             │          output_blob_ref              │
│  cursor_seq             │          error                        │
│  version                │          started_at                   │
│                         │          completed_at                 │
│                         ▼                                       │
│  ───── kinds ─────                                              │
│  step:started   step:completed   step:failed   step:skipped     │
│  effect:started effect:completed effect:failed                  │
│  signal:received  reviewer:decision  rewindTo:set               │
│                                                                 │
│  Append-only. seq is monotonically increasing per run.          │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ EventBus emits → DurableLogHook
                              │ Step bodies call ctx.effect()
                              │ Pipeline.run() reads cursor_seq
                              │ Recovery scans runs WHERE status='running'
                              ▼
            ┌───────────┐    ┌──────────────────┐
            │ Process A │    │ Process B        │
            │ owns run  │    │ takes over after │
            │ via lease │    │ A's lease times  │
            │           │    │ out (heartbeat)  │
            └───────────┘    └──────────────────┘
```

The blob store at `~/.anvil/checkpoints/_blobs/<sha[:2]>/<sha>`
already exists and stays — it backs `output_blob_ref` for any value
larger than ~64 KB.

---

## §E. The effect protocol

The single most important primitive. Every step body that reaches the
outside world MUST go through `ctx.effect`. The contract:

```ts
// core-pipeline/src/types.ts
export interface StepContext<I> {
  // ... existing fields

  /**
   * Run a side effect once per workflow execution. Result is recorded
   * in the durable log; on replay the recorded result is returned
   * without re-running `fn`.
   *
   * `name` is the effect identifier — must be unique within the step,
   * stable across replays. Multiple calls with the same name in a loop
   * use a per-step counter (`idx`) under the hood.
   *
   * `opts.idempotencyKey` lets external systems coalesce duplicate
   * requests across crash-and-replay (e.g. `gh pr create` with
   * `--header "Idempotency-Key: <key>"`).
   *
   * Throws on cancellation. On non-retryable failure, the effect is
   * recorded as `failed` and the same error is replayed.
   */
  effect<T>(name: string, fn: () => Promise<T>, opts?: EffectOptions): Promise<T>;

  /**
   * Deterministic replacements for non-deterministic primitives.
   * Each is recorded once; replays return the recorded value.
   */
  now(): Promise<number>;            // wraps Date.now()
  uuid(): Promise<string>;            // wraps crypto.randomUUID()
  random(): Promise<number>;          // wraps Math.random()
  sleep(ms: number): Promise<void>;   // durable timer

  /**
   * Wait for an external signal (reviewer decision, Q&A answer, etc.).
   * Persisted; on replay returns the received signal without blocking.
   */
  waitForSignal<T = unknown>(channel: string): Promise<T>;
}

export interface EffectOptions {
  /** Caller-supplied retry policy. Same shape as Step.retryPolicy. */
  retry?: RetryPolicy;
  /** External-system idempotency key. Hashed into input_hash. */
  idempotencyKey?: string;
  /** Soft timeout in ms — fires sentinel error to step body. */
  timeoutMs?: number;
  /** When true, result body is stored verbatim in events.payload (no blob). */
  smallResult?: boolean;
}
```

### Step authoring example

Today (non-durable):

```ts
export const buildStep: Step<unknown, BuildOutput> = {
  id: 'build',
  async run(ctx) {
    const result = await spawnAgent({ /* ... */ });    // ❌ re-runs on crash
    await writeFile('out.md', result.output);          // ❌ re-runs on crash
    const pr = await ghPrCreate({ title: '...' });     // ❌ creates duplicate PR
    return { prUrl: pr.url };
  },
};
```

After (durable):

```ts
export const buildStep: Step<unknown, BuildOutput> = {
  id: 'build',
  version: 2,
  async run(ctx) {
    const result = await ctx.effect('spawn-build-agent', () =>
      spawnAgent({ /* ... */ }));
    await ctx.effect('write-build-md', () =>
      writeFile('out.md', result.output));
    const pr = await ctx.effect(
      'gh-pr-create',
      () => ghPrCreate({ title: '...' }),
      { idempotencyKey: `pr-${ctx.runId}-build` },
    );
    return { prUrl: pr.url };
  },
  async compensate(ctx, output) {
    if (output?.prUrl) {
      await ctx.effect('gh-pr-close', () => ghPrClose(output.prUrl));
    }
  },
};
```

### The replay invariant

**On replay, step code MUST follow the same path until it reaches a
not-yet-recorded effect.** This means:
- No `Date.now()` outside `ctx.now()`.
- No mutable globals read in step bodies (config snapshots are part of `ctx.input`).
- No silent dependency on file system state — file reads MUST be effects.
- No randomness outside `ctx.random()` / `ctx.uuid()`.

Violations are diagnosable: when replay diverges, the framework
detects "effect call N was `gh-pr-create` last time, now it's
`writeFile`" and aborts with `DeterminismViolationError` pointing at
the step + effect index. The cure is "rerun the run from the failed
stage with the new step code"; we don't try to be clever.

A linter rule (`anvil-lint/no-direct-side-effects-in-steps`) flags
direct `Date.now`/`Math.random`/file-system imports inside step
bodies. Phase D5 ships the linter; until then, code review is the
guard.

---

## §F. Replay semantics

`Pipeline.run({ runId })` becomes:

1. Open the durable DB. Acquire the run's lease (heartbeat row).
2. Read `runs.cursor_seq` and the events stream.
3. For each step in the registry order:
   - If the step's last `step:completed` event is in the log → emit
     `step:skipped` (kind: `'replay-completed'`), skip.
   - If the step's last `step:started` event is in the log without a
     `step:completed` → enter **partial replay**:
     - Spawn `step.run(ctx)` with a context whose `ctx.effect` reads
       from the durable log.
     - For each `ctx.effect(name, fn)` call:
       - Look up the next un-replayed effect for this step in the log.
       - If matching name + same input hash: return the recorded
         output (replay).
       - If matching name + different input hash: throw
         `DeterminismViolationError`.
       - If no recorded effect: run `fn()` for real, record the
         result, return it (live execution past the cursor).
     - When step body returns or throws → record `step:completed` /
       `step:failed`, advance cursor.
   - If no `step:started`: live execution.

The step body is a single async function that crosses the
"in-log/out-of-log" boundary transparently — it doesn't know whether
it's replaying or live.

### Cancellation

`signal: AbortSignal` is part of `ctx`. On cancel: abort the live
effect (best-effort), record `effect:failed` with reason
`'cancelled'`, mark the run `cancelled`. On next run, the cancelled
run isn't picked up; the user must explicitly rerun.

### Compensation (rollback)

When a run transitions to `failed` or `cancelled`, the engine walks
**backwards** through `step:completed` events and invokes
`step.compensate(ctx, output)` for each step that defines one.
Compensation effects are recorded in the same log under
`compensate:effect:*` events so a crash mid-rollback resumes the
rollback (not the forward path).

### Versioning

Each step declares `version: number` (default `1`). On replay, the
engine compares the current step's version to the last recorded
event's `step.version` field; mismatch → emit
`DeterminismViolationError` with reason `'version-mismatch'`. The
user resolves by rerunning from the affected stage (which clears
its events).

For breaking changes that warrant in-place migration (rare),
`step.migrate(oldEvents) → newEvents` would be added in v2. Out of
scope for v1.

---

## §G. Schema (SQLite, WAL mode)

```sql
-- ~/.anvil/durable.db

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  project       TEXT NOT NULL,
  feature       TEXT NOT NULL,
  feature_slug  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN
                  ('pending', 'running', 'paused', 'completed',
                   'failed', 'cancelled', 'compensating')),
  current_step  TEXT,
  cursor_seq    INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL,           -- ISO 8601
  updated_at    TEXT NOT NULL,
  lease_holder  TEXT,                    -- process id + hostname
  lease_expires TEXT,                    -- heartbeat-driven
  workflow_ver  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_project_feature ON runs(project, feature_slug);

CREATE TABLE IF NOT EXISTS events (
  run_id     TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,              -- step:started, step:completed,
                                         -- effect:started, effect:completed,
                                         -- signal:received, etc.
  step_id    TEXT,                       -- nullable for run-level events
  effect_key TEXT,                       -- nullable except for effect:*
  effect_idx INTEGER,                    -- per-step counter
  payload    TEXT NOT NULL,              -- JSON blob (small) or {ref:'<sha>'}
  ts         TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_step ON events(run_id, step_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_effect ON events(run_id, step_id, effect_key, effect_idx);

CREATE TABLE IF NOT EXISTS signals (
  run_id    TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  channel   TEXT NOT NULL,
  payload   TEXT NOT NULL,                -- JSON
  consumed  INTEGER NOT NULL DEFAULT 0,
  ts        TEXT NOT NULL,
  PRIMARY KEY (run_id, channel, ts)
);
```

**Why three tables, not one event-only:** runs has the lease + status
fields that need updating in place (heartbeats, status transitions).
Events stay strictly append-only. Signals live in their own table
because they're inserted out-of-band by the dashboard (reviewer
decisions, Q&A answers) and consumed by the workflow at its own pace
— a many-writers / one-reader queue.

**Why SQLite, not Postgres:**
- Anvil is single-machine today. SQLite WAL handles 1k writes/sec on
  consumer SSDs — comfortable headroom over our actual write rate
  (event/sec/run).
- Zero ops. The DB file lives in `~/.anvil/`, ships with the user's
  machine, no daemon to start.
- Multi-process safe. SQLite WAL allows concurrent readers + one
  writer; the lease column serializes writes to a single run.
- Postgres path stays open: the persistence interface (§J) is a thin
  abstraction over the table operations. Swapping to Postgres is a
  driver change, not a rewrite.

---

## §H. Storage growth + retention

A typical 90-minute run produces ~200 events + ~30 effects. At
~2 KB/event JSON + blob refs for big payloads, that's ~500 KB on
disk per run. 1000 runs/year per user → ~500 MB. Manageable but not
unbounded.

Retention policy:
- `runs` rows + their `events`/`effects` are kept for 90 days by
  default. Configurable via `~/.anvil/durable.config.json`.
- A `vacuum-runs` CLI command (and a daily background hook in the
  dashboard) deletes runs older than the cutoff and the orphaned
  blobs they referenced.
- Failed/cancelled runs are kept for 30 days only by default —
  shorter because debugging windows are shorter.

Blobs are reference-counted across runs (the existing `BlobStore`
keys by sha-256 — duplicates dedupe automatically). The vacuumer
walks `events.payload` for `{ref: '...'}` references and only
deletes blobs unreferenced by any live run.

---

## §I. Migration from Pattern 1

The existing audit log (`~/.anvil/runs/<runId>/audit.jsonl`) and
state file (`~/.anvil/state.json`) STAY. They become **secondary
projections** of the durable log.

Concretely:
- `attachAuditLogHook` keeps writing JSONL — for forensic / external
  consumption (grep, jq, log shippers).
- `attachDashboardStateHook` keeps writing the snapshot — for
  cross-process consumers that don't want to query SQLite.
- The new `attachDurableLogHook` is the **primary** consumer; on
  failure of the durable log, the run aborts. The other two are
  best-effort.

Existing in-flight runs at the moment we deploy this:
- Have no row in the new `runs` table → engine treats them as
  "first time seen", creates a row, but the audit log shows them as
  in-progress. **Migration runner** at startup scans
  `~/.anvil/runs/` for runs with `status: 'running'` and seeds the
  durable DB with their last known state, marking them
  `'failed'` with reason `'migration-from-pattern-1'` so the user
  can rerun.

That's the only painful migration step. New runs are durable from
the first event.

---

## §J. The persistence interface

The engine talks to one interface; SQLite is the default driver.

```ts
// core-pipeline/src/durable/store.ts

export interface DurableStore {
  // Run lifecycle
  createRun(run: NewRunRecord): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  updateRunStatus(runId: string, status: RunStatus, currentStep?: string): Promise<void>;
  acquireLease(runId: string, holder: string, ttlMs: number): Promise<boolean>;
  renewLease(runId: string, holder: string, ttlMs: number): Promise<boolean>;
  releaseLease(runId: string, holder: string): Promise<void>;
  listRunsByStatus(status: RunStatus): Promise<RunRecord[]>;

  // Events
  appendEvent(event: NewEventRecord): Promise<EventRecord>;
  readEvents(runId: string, fromSeq?: number): AsyncIterable<EventRecord>;
  readEffectEvents(runId: string, stepId: string): AsyncIterable<EffectEventPair>;
  /** Atomic batch append — used when a step body emits multiple events at once. */
  appendBatch(events: NewEventRecord[]): Promise<EventRecord[]>;

  // Signals (out-of-band writes from outside the workflow)
  enqueueSignal(runId: string, channel: string, payload: unknown): Promise<void>;
  consumeSignal(runId: string, channel: string): Promise<unknown | null>;

  // Maintenance
  vacuum(olderThanIso: string): Promise<{ runs: number; events: number; blobs: number }>;
}

export interface SQLiteDurableStore implements DurableStore { /* ... */ }
export interface PostgresDurableStore implements DurableStore { /* v2 */ }
export interface InMemoryDurableStore implements DurableStore { /* tests */ }
```

The `InMemoryDurableStore` is mandatory — every existing test that
uses the bus or the registry without persistence wiring needs an
in-memory store to keep working. ~80 LOC.

---

## §K. EventBus + DurableStore composition

Today: `EventBus.emit(kind, payload)` fires listeners synchronously,
`emitFireAndForget` schedules them for the microtask queue.

After: same surface, but the **DurableLogHook** is registered with
priority `1` (above audit-log's `100`) and is `awaited` on every
`step:*` and `effect:*` event. If the hook fails, the bus's `emit`
rejects — the step body sees a thrown
`DurableStoreUnavailableError`. The walker treats this as a fatal
infrastructure error: cancel the run with a clear message, do not
mark it `failed` (which would suggest user-fixable code), mark it
`'infra-error'` (a new sub-status).

The hook's contract:

```ts
export function attachDurableLogHook(
  bus: EventBus,
  store: DurableStore,
  runId: string,
): { detach(): void };
```

Subscribed events: `step:started`, `step:completed`, `step:failed`,
`step:skipped`, `effect:started`, `effect:completed`, `effect:failed`,
`signal:received`, `reviewer:decision`, `rewindTo:set`, `cancel:requested`.

Order of event vs. effect side-effect:
1. Step body calls `ctx.effect('foo', fn)`.
2. Hook records `effect:started` event (BEFORE `fn()` runs).
3. `fn()` runs → returns `result`.
4. Hook records `effect:completed` event with `result`.
5. `ctx.effect` returns `result` to step body.

If the process crashes between (2) and (4), on replay we see
`effect:started` but no completion → re-run `fn()` for real (the
effect was never observed externally to have succeeded). For
external-effect idempotency (gh PR create), step authors pass
`opts.idempotencyKey`; the engine includes it in the request so the
external system de-dupes. This is exactly Temporal's "activity
heartbeat / idempotent activity" pattern.

---

## §L. The Q&A + reviewer integration

Existing flow:
- Reviewer pause uses `pauseStore.pause()` + a polling loop in
  `setAfterStageHook` that blocks until `resumeDecision` lands.
- Q&A uses `runner.provideStageAnswer(...)` + a per-(stage, repo)
  resolver Map.

These both become **signal channels** on the durable store:

```ts
// In step body:
const decision = await ctx.waitForSignal<ReviewerDecision>('reviewer-decision');

// In dashboard, when user clicks Approve:
await durableStore.enqueueSignal(runId, 'reviewer-decision', { action: 'approve' });
```

The polling loop dies. Signal consumption is durable: on replay,
`waitForSignal` reads the recorded `signal:received` event from the
log and returns the same payload — the reviewer doesn't have to
re-decide.

This is a meaningful simplification of `dashboard-server.ts` —
`pauseStore` shrinks to just rendering state for the UI; the
authoritative gate is the durable log.

---

## §M. Observability surface

Every event in the log is a row the dashboard can render. New
**Run Timeline** view in `src/components/runs/`:

- Vertical timeline per run, one row per event.
- Filter by step, effect, kind.
- Hover = full payload (decoded blob ref if needed).
- Side-by-side compare for two runs of the same feature: line up by
  step + effect_idx, highlight diffs in input_hash and output.
- "Replay debugger": pick any event, see the durable state at that
  point, optionally re-spawn a step from there in dry-run mode (no
  external effects, pure step body re-execution).

This is a v2 deliverable and not blocking the engine work, but the
data is already in the DB on day 1 — the dashboard is just a query
front-end.

---

## §N. Phased delivery (commit by commit)

### Phase D1 — DurableStore + SQLite driver (one commit, ~600 LOC)

1. New `core-pipeline/src/durable/types.ts` (~80 LOC) — record types,
   enums, errors.
2. New `core-pipeline/src/durable/store.ts` (~30 LOC) — interface only.
3. New `core-pipeline/src/durable/sqlite-store.ts` (~250 LOC) —
   driver. Uses `better-sqlite3` (sync, fastest) wrapped in a thin
   async facade for interface compatibility.
4. New `core-pipeline/src/durable/in-memory-store.ts` (~120 LOC) —
   for tests + dev.
5. Tests: `sqlite-store.test.ts` + `in-memory-store.test.ts`
   (~120 LOC).

**Test contract:** every existing test green (no engine behaviour
changes yet); new driver tests pass.

### Phase D2 — Effect protocol + DurableLogHook (one commit, ~500 LOC)

1. Extend `StepContext` in `core-pipeline/src/types.ts` with
   `effect` / `now` / `uuid` / `random` / `sleep` / `waitForSignal`
   (~30 LOC).
2. New `core-pipeline/src/durable/effect-runtime.ts` (~200 LOC) —
   constructs a `StepContext` that wraps each call in the durable
   log read/write protocol. Owns the per-step effect counter.
3. New `core-pipeline/src/hooks/durable-log.hook.ts` (~80 LOC) —
   subscribes to `step:*` / `effect:*` events; appends to the store.
4. `core-pipeline/src/pipeline.ts`: `Pipeline.run()` opens the
   durable store, acquires a lease, walks events for replay, hands
   the effect-runtime context to each `step.run`. Backwards-compatible:
   when no `durableStore` is passed, behaviour is unchanged
   (~60 LOC + a few branches).
5. New `effect-replay.test.ts` (~80 LOC) — proves replay equivalence
   on a 3-step toy workflow.
6. New `crash-recovery.test.ts` (~80 LOC) — kills the workflow mid-step,
   reopens, asserts the partial-replay path completes correctly.

**Test contract:** every existing test green + new replay tests
pass. No production code path uses durable store yet.

### Phase D3 — Wire dashboard pipeline runner (one commit, ~700 LOC)

1. `dashboard/server/pipeline-runner.ts`: open durable store on
   construct; pass to `Pipeline.run`.
2. Convert every direct side-effect in `pipeline-stages.ts` into a
   `ctx.effect(...)` wrap — agent spawns, file writes, git commits,
   gh CLI calls. The effect names are stage-specific:
   - `requirements:spawn-agent`
   - `build:run-task-N`
   - `ship:gh-pr-create` (with idempotency key
     `<runId>:<repoName>:<branchName>`)
   - `ship:nexus-deploy` (with idempotency key
     `<runId>:<repoName>:<deployTarget>`)
   - … (full table in §O)
3. Convert reviewer pause to `ctx.waitForSignal('reviewer-decision')`;
   convert Q&A to `ctx.waitForSignal(\`stage-answer-\${stageIndex}\`)`.
4. The dashboard's existing `pauseStore` keeps running for UI
   rendering but stops being authoritative — the workflow blocks on
   the signal, not on the polling loop.
5. Migration runner at startup: scans `~/.anvil/state.json`'s
   `activePipeline` + `~/.anvil/runs/`; any `running` run that
   doesn't have a row in `runs` gets one with `status:'failed'` +
   reason `'migration-from-pattern-1'`.

**Test contract:** dashboard 543/543, core-pipeline at parity
+ new tests.

### Phase D4 — Compensation, versioning, idempotency (one commit, ~400 LOC)

1. `Step.version: number` field — default `1`. Engine records on
   `step:started`; mismatch on replay → `DeterminismViolationError`.
2. `Step.compensate(ctx, output)?` — engine invokes on backward walk
   when run transitions to `failed`/`cancelled`/`compensating`.
3. Effect retry policy enforcement — `EffectOptions.retry` consumed
   by `effect-runtime.ts`.
4. Idempotency key threading — `effect()` includes `idempotencyKey` in
   `input_hash` so replays detect "you tried to re-run with a
   different key, that's a bug."
5. Tests covering each new path (~120 LOC).

### Phase D5 — Linter rule + observability (one commit, ~350 LOC)

1. Custom ESLint rule
   `anvil-lint/no-direct-side-effects-in-steps`. Flags imports +
   calls of `Date.now`, `Math.random`, `crypto.randomUUID` (sync
   form), `fs.writeFile*`, `child_process.exec*` inside any file
   under `**/stages/**`.
2. Run Timeline UI in dashboard (~200 LOC).
3. CLI `anvil run-replay <runId>` for offline debugging (~80 LOC).

### Optional Phase D6 — Multi-process scheduler (one commit, ~600 LOC)

Today exactly one process owns a run. With the durable store + lease
column, a second process can take over after the first's heartbeat
times out. This unlocks:
- Failover (process A crashes, process B picks up)
- Horizontal scale (run queue across N workers)
- "Pause + resume on different machine" (laptop → CI server)

Architecture: heartbeat thread per run; on lease expiry detection,
candidate processes race for the lease via `INSERT OR IGNORE` /
`UPDATE WHERE lease_holder=? AND lease_expires<?`. Winner replays
from cursor.

Out of scope for v1 — defer until single-process Pattern 2 is rock
solid.

---

## §O. Effect inventory (Phase D3)

Every external touch in `pipeline-stages.ts` + `pipeline-runner.ts`.
Each becomes a `ctx.effect`. Counted: 38 sites.

| Stage | Site | Effect name | Idempotency key |
|---|---|---|---|
| clarify | spawn explorer | `clarify:spawn-explorer` | none (deterministic from input) |
| clarify | spawn synthesizer | `clarify:spawn-synthesizer` | none |
| clarify | per-question wait | `clarify:wait-q<N>` | (signal, not effect) |
| requirements | spawn agent | `requirements:spawn-agent` | none |
| requirements | wait for Q&A answers | `requirements:wait-qa` | (signal) |
| repo-requirements | per-repo spawn | `repo-requirements:spawn-<repo>` | none |
| specs | per-repo spawn | `specs:spawn-<repo>` | none |
| tasks | spawn agent | `tasks:spawn-agent` | none |
| build | per-repo branch checkout | `build:checkout-branch-<repo>` | `<runId>:<repo>:<branch>` |
| build | per-task spawn | `build:spawn-task-<repo>-<taskId>` | none |
| build | git commit | `build:commit-<repo>-<taskId>` | (commit message + tree hash) |
| validate | spawn agent | `validate:spawn-<repo>` | none |
| validate | fix-loop attempt N | `validate:fix-attempt-<repo>-<N>` | none |
| test | spawn test-gen | `test:spawn-testgen` | none |
| test | run test command | `test:exec-<repo>` | none |
| ship | gh pr create | `ship:gh-pr-create-<repo>` | `<runId>:<repo>:<branch>` |
| ship | nexus deploy | `ship:nexus-deploy` | `<runId>:<deployId>` |
| ship | post-merge hook | `ship:post-merge-<repo>` | `<runId>:<repo>` |
| pipeline | reviewer pause | `pipeline:reviewer-decision` | (signal) |
| pipeline | cost ledger record | `pipeline:cost-record-<spawnId>` | (small, fire-and-forget — could stay outside the effect log; TBD) |

The `(signal)` rows use `ctx.waitForSignal(...)` instead of
`ctx.effect(...)`. The `(small, fire-and-forget)` row is the one
case that doesn't fit the durable model cleanly — recording every
LLM token usage event in the durable log is fine (it's just data),
but recording it as a strict effect inflates the log size. Decision
in D3: keep cost-ledger writes outside the durable log (they go to
the existing `costLedger` JSONL); on replay, recompute from
`effect:completed` payloads where available.

---

## §P. Edge cases

| Case | Handling |
|---|---|
| Two effects with the same name in a loop | Engine uses `idx` (per-step counter, incremented on each `effect()` call) to disambiguate. |
| Step body throws synchronously before any effect | `step:failed` recorded; on replay step is re-run from start. |
| Step body throws after some effects completed | Recorded effects survive; on replay the same effects skip-replay until the throw point, then the body re-throws. **Important:** the user's step code MUST be deterministic about when it throws (same effects → same throw). |
| Effect fn() throws | `effect:failed` recorded with error; engine re-throws on replay (same error, same call site). |
| Cancellation mid-effect | AbortSignal aborts `fn()`; `effect:failed` recorded with reason `'cancelled'`; run marked `cancelled`. |
| Replay diverges (effect name mismatch) | `DeterminismViolationError` aborts the run. User reruns from-stage. |
| Replay diverges (effect input_hash mismatch) | Same. |
| Step version bump | `DeterminismViolationError` with reason `'version-mismatch'`. Same recovery. |
| Two processes try to acquire the same run | First `INSERT` on `lease_holder` wins; second sees lease held, backs off + waits for expiry. |
| Lease holder crashes silently | Heartbeat stops; lease_expires elapses; a peer (or the same process restarted) picks up. v1 does NOT auto-pickup — requires explicit `anvil resume <runId>` invocation. |
| Signal arrives before `waitForSignal` | Signal is recorded with `consumed: 0`; when step body waits, it consumes the row immediately. |
| Multiple signals on same channel | Queued in `signals` table by ts; consumed in arrival order. |
| Step's `compensate` itself fails | `compensate:effect:failed` recorded; rollback continues to next earlier step (warn user; the system is best-effort during rollback). |
| Disk full | SQLite write fails; engine marks run `infra-error`; user message tells them to free space + rerun. |
| User deletes `~/.anvil/durable.db` | New runs work; old runs are unrecoverable but their JSON state files at `~/.anvil/state.json` + audit logs remain (Pattern 1 fallback). |
| Effect fn returns non-JSON-serialisable value | Engine throws `EffectResultNotSerialisableError`. Caller fixes by returning a serialisable shape (or wrapping a class instance in `.toJSON()`). |
| Effect result > 64KB | Auto-stored in `BlobStore`; payload becomes `{ref: '<sha>'}`. |
| Migration runner sees pre-existing run | Marks `failed` with reason `'migration-from-pattern-1'`. User reruns from earliest stage. |

---

## §Q. Test plan

### Unit (per-driver, per-hook)

- `sqlite-store.test.ts`: lifecycle (create, read, update), lease
  acquire/renew/release, append-batch atomicity, signal queue
  ordering, vacuum.
- `in-memory-store.test.ts`: same shape; same fixtures; bit-identical
  outputs to the SQLite driver.
- `effect-runtime.test.ts`: replay equivalence, divergence detection,
  loop counter, idempotency-key flow.
- `durable-log-hook.test.ts`: hook captures every `step:*`/`effect:*`,
  payload shape matches schema, blob ref threshold, ordering with
  multiple subscribers.

### Integration (workflow-level)

- `crash-recovery.test.ts`: 3-step workflow, kill mid-step-2, re-open,
  assert step-2 resumes from last effect.
- `compensate.test.ts`: 5-step workflow with compensate hooks; force
  failure at step 4; assert reverse compensation order.
- `versioning.test.ts`: bump step version between two runs of the
  same `runId`; assert `DeterminismViolationError`.
- `signals.test.ts`: enqueue signal before waitForSignal; assert
  immediate consumption.
- `migration.test.ts`: seed `~/.anvil/state.json` with a `running`
  run; start the dashboard; assert the run gets a durable row +
  `failed` status.

### Replay-equivalence (every effect site)

For every effect added in Phase D3, an integration test:
1. Run the workflow once with all effects firing; capture log.
2. Re-run with a fresh in-memory store seeded from the captured log.
3. Assert: zero new outbound calls (mock all effects to throw on
   call); workflow completes with identical output.

### Fault injection (smoke)

- Kill SQLite via `kill -9` mid-write; assert WAL integrity on
  restart.
- Truncate the DB file; assert engine surfaces `infra-error` not a
  silent corruption.
- Concurrent processes acquire same run; assert only one wins.

### Test contract

Phase D2 → +6 tests (effect runtime + crash recovery).
Phase D3 → +38 effect-replay tests + dashboard-pipeline integration.
Phase D4 → +6 tests (compensate, version, retry, idempotency).
Phase D5 → linter unit tests + replay CLI smoke.

Total: existing 543/543 dashboard + 348/348 core-pipeline preserved
at every commit; ~70 new tests added across the phases.

---

## §R. Risks + open questions

### Risks

- **Performance.** Every effect = 1-2 SQLite writes. Measured: WAL
  mode handles ~1000 writes/sec on consumer SSDs. A 90-min run with
  ~30 effects is far under budget. **Mitigation:** ship perf tests
  that record p99 effect latency; alarm if > 10ms.
- **Determinism violations in real code.** Existing step bodies have
  decades of accumulated `Date.now()` and `crypto.randomUUID()` calls.
  Cleaning them up is the bulk of Phase D3's risk. **Mitigation:**
  the linter (Phase D5) prevents regressions; Phase D3's PR audits
  every site against the §O inventory.
- **Recoverability of stuck runs.** A run that hits a
  `DeterminismViolationError` is dead — the user MUST re-run from a
  stage. **Mitigation:** the error message tells the user exactly
  which stage to rerun from + why; the dashboard offers a
  one-click "Rerun from <stage>" affordance.
- **Q&A + reviewer signal contract change.** Phase D3 makes signals
  the authoritative gate. If the dashboard fails to enqueue a signal
  but the workflow has already entered `waitForSignal`, the workflow
  hangs forever. **Mitigation:** signal enqueue + workflow status
  update are in the same SQLite transaction; failure is surfaced to
  the dashboard with a "retry signal" button.
- **DB file corruption.** SQLite is robust but not invincible.
  **Mitigation:** WAL mode + journal_mode + a daily `PRAGMA
  integrity_check` background task; restore-from-audit-log path as
  last resort (best-effort, may lose mid-step data).

### Open questions

1. **Effect log on cancellation: keep or vacuum?** Today's intuition:
   keep for 30 days for forensics; vacuum after.
2. **Cross-feature deduplication of effects.** If the same external
   call (e.g. `gh pr create` for a unique branch name) runs across
   two features, do we share a record? **Tentative no** — runs are
   isolated; same external system can de-dupe via the idempotency
   key.
3. **Schema versioning of the durable DB.** Anvil ships schema
   migrations as the `runs.workflow_ver` field; what about the
   schema of the DB itself? Need a `meta` table with `schema_version`
   + a startup migration runner. v1 ships at v1; future migrations
   are forward-only.
4. **Effect granularity.** Should `agentManager.spawn` be one effect,
   or should each turn of a multi-turn session be its own effect?
   **Lean toward per-turn** — each turn has independent cost +
   independent failure modes. The `AgentManagerSession` API in §3
   would need a per-turn effect wrapper.
5. **Compensation idempotency.** Compensation effects are recorded
   in the same log; if the compensator crashes, replay re-runs only
   the un-recorded compensate effects. Is this the right semantic
   vs. "compensate is at-most-once"? **Tentative at-least-once with
   compensator-must-be-idempotent** — Temporal's stance.

---

## §S. LOC estimate + checklist

| Phase | New LOC | Modified LOC | Files touched |
|---|---|---|---|
| D1 — DurableStore | ~600 | 0 | 5 new |
| D2 — Effect protocol | ~500 | ~120 | 4 new + 3 modified |
| D3 — Wire dashboard | ~700 | ~400 | 5 modified |
| D4 — Compensation/versioning | ~400 | ~150 | 4 modified |
| D5 — Linter + observability | ~350 | 0 | 3 new |
| D6 (optional) — Multi-process | ~600 | ~80 | 3 modified |
| **Total v1 (D1-D5)** | **~2550** | **~670** | **15 + 12** |

### Pre-flight checklist

- [ ] Add `better-sqlite3` to `core-pipeline` dependencies (pinned).
- [ ] Confirm that `@esankhan3/anvil-agent-core`'s existing
      `BlobStore` is reusable as-is (no schema change needed).
- [ ] Audit every direct `Date.now()` / `crypto.randomUUID()` call
      in `packages/dashboard/server/pipeline-*.ts` and
      `packages/core-pipeline/src/stages/*.ts`. Initial grep finds
      ~30 sites; each becomes `ctx.now()` / `ctx.uuid()` in D3.
- [ ] Confirm the dashboard's `pauseStore` can be made non-authoritative
      without breaking the existing reviewer-modal UI (it can; the
      modal already reads from `pause-state` broadcasts which
      become projections of the durable log).
- [ ] Decide retention defaults: 90-day succeeded, 30-day failed,
      configurable via `~/.anvil/durable.config.json`.
- [ ] Plan the rollout note: "Anvil now persists every external
      effect during a run. Existing runs from before this update
      cannot be resumed; please rerun if interrupted."

### Done criteria

A run that:
1. Starts at stage 0, gets to stage 5,
2. Process killed with `kill -9`,
3. User runs `anvil resume <runId>` (or restarts the dashboard;
   the run shows as resumable),
4. Resumes at stage 5, with the same agent session, same prior
   effects all skipped,
5. Completes successfully,

…is the bar. Ship after that round-trips end-to-end on a real run
across all 9 stages.

---

## §T. Why this is the right call now

The existing Pattern 1 stack already does 80% of the work — the
event bus is in place, the audit log captures most of what we need,
the artifact store handles large bodies. What's missing is the
single primitive (`ctx.effect`) that makes the rest mechanically
sound. This plan adds that primitive, refactors ~38 effect sites to
use it, and gets durable execution + cross-process replay for the
cost of one well-scoped engine change.

The alternative (build it later) means every new stage / effect site
gets added in the non-durable style and has to be back-converted —
the migration cost only grows.

After this lands:
- Process crashes mid-stage are recoverable.
- LLM costs stop double-billing on resume.
- External effects (PRs, deploys) get exactly-once delivery.
- The event log becomes the canonical record of what a run did.
- Cross-process scheduling (D6) becomes a small follow-up.
- The dashboard's reviewer + Q&A flow simplifies (signals replace
  polling).

Ready to execute when approved.
