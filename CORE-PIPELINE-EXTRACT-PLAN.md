# Core-pipeline Extraction Plan

> Companion to [`CORE-PIPELINE-EXTRACT-ADR.md`](./CORE-PIPELINE-EXTRACT-ADR.md). Locks the decisions, persistence sites, public API migration table, and per-phase commit log.
>
> **Status:** draft 2026-04-29.
> **Depends on:** `@anvil/agent-core` (shipped), `@anvil/memory-core` (shipped — proposal queue + reflection consume pipeline events).

---

## 1. Pre-flight reality check (verified 2026-04-29)

| Check | Result |
|---|---|
| `packages/cli/src/pipeline/orchestrator.ts` exists, **2,089 LOC** | ✅ |
| 8 stages live under `cli/src/pipeline/stages/` | ✅ |
| `packages/cli/src/pipeline/state-machine.ts:143-152` has event emitter | ✅ — **`onEvent` listener never subscribed to anywhere** |
| `cli/src/memory/learners/index.ts` exports `autoLearnHook(event)` | ✅ — **never called from orchestrator** (dead code path) |
| `cli/src/pipeline/audit-log.ts` writes JSONL durably | ✅ — `~/.anvil/runs/<runId>/audit.jsonl` |
| `cli/src/pipeline/state-file.ts` writes dashboard state with 100ms debounce | ✅ |
| `cli/src/pipeline/custom-stage.ts` loads factory.yaml-defined steps | ✅ — insertion-based extension hook |
| `packages/core-pipeline/` does NOT exist yet | ✅ — greenfield package |
| `CORE-PIPELINE-EXTRACT-ADR.md` does NOT exist yet | ✅ → this file's companion |

**Coupling shape today:**
- One 2089-LOC monolith, 8-way `if-else` tree on stage index (`orchestrator.ts:948-1432`)
- Stages communicate via shared mutable `StageContext` god-object (`orchestrator.ts:870-878`)
- Auto-fix retry loop is embedded inline in the validate branch (`orchestrator.ts:1300-1348`) — not delegatable to other stages
- PR URL parsing assumes the agent's stdout shape (regex match at `orchestrator.ts:1421`)

**Total in-scope LOC** across `cli/src/pipeline/` + `cli/src/memory/learners/` + dashboard pipeline-* files: **~16,500 LOC**.

---

## 2. Why this is the architectural one

The current orchestrator violates two decoupling axioms simultaneously:

1. **Order is hard-coded** — adding/removing/reordering a stage means editing the central monolith.
2. **Cross-cutting concerns leak into the orchestrator body** — telemetry, audit, dashboard state, learners, cost tracking are all interleaved with the stage `await` calls.

The fix is well-trodden: extract stages into a typed `Step<I, O>` graph with named lifecycle hook points, route cross-cutting concerns through a subscription bus, and let the orchestrator become a 50-line graph walker. The reference impls are **Hapi.js plugin lifecycle**, **NestJS interceptors**, and **Inngest steps** — patterns Anvil already partially has (`state-machine.ts` event emitter, `custom-stage.ts` insertion hook), they just aren't wired to the hot path.

Durable execution (Inngest/Temporal-style cross-process replay) is a separate, larger lift — explicitly deferred to a follow-up plan after this one lands and we know which step boundaries actually matter (Pattern 2 in the analysis).

---

## 3. Decisions (deferred to ADR)

The full decision matrix lives in `CORE-PIPELINE-EXTRACT-ADR.md`. Headlines:

- **P1** — New package `packages/core-pipeline/` (`@anvil/core-pipeline`). cli's `pipeline/` becomes a thin caller.
- **P2** — `Step<I, O>` is the canonical contract; `StepContext` replaces `StageContext`.
- **P3** — `StepRegistry` supports `register`, `insertBefore`, `insertAfter`, `replace`, `remove` — extension is by ID, not by index.
- **P4** — Single in-process `EventBus` (extends today's `state-machine.ts` emitter); strongly-typed events; subscribers subscribe by event name.
- **P5** — Auto-fix retry generalizes to `Step.retryPolicy` plus a `'sub-step'` concept — child steps under a parent.
- **P6** — Custom stages (factory.yaml) keep working via shim that registers them as `Step` plugins.
- **P7** — Durability stays at audit-log + state-file granularity (Pattern 1). Step-level durable replay (Pattern 2) is **out of scope** for this plan.
- **P8** — Migration is **strangler-fig** — new package shipped in parallel, stages ported one-by-one, orchestrator's if-tree shrinks until it's gone.
- **P9** — `autoLearnHook` finally gets a subscription point (subscribes to `step:completed`).
- **P10** — Pub/sub is in-process only. Cross-process events flow through the existing audit log + dashboard state file (no new broker).

---

## 4. Public API migration table

| Surface | Today | After |
|---|---|---|
| `runPipeline(config)` (orchestrator entry) | works | works (delegates to `Pipeline.run()` from core-pipeline) |
| `stateMachine.onEvent(listener)` | exists, unused | first-class `EventBus.on('step:completed', ...)` |
| `autoLearnHook(event)` | dead code | wired as default subscriber |
| `loadCustomStages(config)` | inserts into orchestrator's if-tree | shim — registers each custom stage as a `Step` |
| `StageContext` shared mutable god-object | works | replaced by `StepContext` (immutable inputs + typed outputs) |
| Per-stage runner under `stages/<name>/` | direct function call | exports `Step<I, O>` (default export) |

---

## 5. Schema shapes (TS, locked verbatim in ADR §4)

```ts
/** Canonical Step contract — one per pipeline stage. */
export interface Step<I, O> {
  /** Stable id; used for insertBefore / insertAfter / replace / remove. */
  id: string;
  /** Human label; not load-bearing. */
  name?: string;
  /** Run this step against `ctx.input`; return the result for downstream steps. */
  run(ctx: StepContext<I>): Promise<O>;
  /**
   * Optional retry policy for transient failures. Driven by Step error
   * classification — same shape as the LLM router's RetryPolicy but applied
   * at the step level (NOT inside the LLM call).
   */
  retryPolicy?: StepRetryPolicy;
  /** Optional sub-steps; runs as a sequence within this step's frame. */
  subSteps?: Step<unknown, unknown>[];
  /** Per-project parallelism hint. Default 'serial'. */
  parallelism?: 'serial' | 'per-project';
}

export interface StepContext<I> {
  /** Stable run id (matches today's `~/.anvil/runs/<runId>/`). */
  runId: string;
  /** Workspace root. */
  workspaceDir: string;
  /** Per-project paths (preserved from today's StageContext). */
  repoPaths?: Record<string, string>;
  /** Strongly-typed input — output of the previous step. */
  input: I;
  /** Pipeline-wide read-only artifacts ledger; downstream steps can read prior outputs by id. */
  artifacts: ReadonlyArtifactStore;
  /** Step can write artifacts; persisted to runDir. */
  emit: (artifactId: string, data: unknown) => void;
  /** Pub/sub bus — for cross-cutting concerns only, NOT primary flow control. */
  bus: EventBus;
  /** Memory-core integration: run-scoped queue handle. */
  memory?: MemoryHandles;
  /** LLM router integration: tag-driven dispatch. */
  llm?: LlmHandles;
  /** Aborts the run on .signal. */
  signal: AbortSignal;
}

export interface StepRetryPolicy {
  attempts: number;
  backoff: 'exponential' | 'linear' | 'constant';
  baseMs: number;
  maxMs?: number;
  retryOn?: (error: unknown) => boolean;
}

export type StepHookPoint =
  | 'pipeline:started'
  | 'pipeline:completed'
  | 'pipeline:failed'
  | 'step:started'
  | 'step:completed'
  | 'step:failed'
  | 'step:retried'
  | 'step:skipped'
  | 'sub-step:started'
  | 'sub-step:completed'
  | 'artifact:emitted';

export interface PipelineEvent<P = unknown> {
  hook: StepHookPoint;
  runId: string;
  stepId?: string;
  ts: string;            // ISO-8601
  payload?: P;
  error?: { message: string; stack?: string; cause?: unknown };
}

export interface EventBus {
  on(hook: StepHookPoint, listener: (e: PipelineEvent) => void | Promise<void>): () => void;
  emit(event: PipelineEvent): Promise<void>;  // awaits all listeners
  emitFireAndForget(event: PipelineEvent): void;  // for non-critical paths
}

export interface StepRegistry {
  register(step: Step<unknown, unknown>): void;
  insertBefore(targetId: string, step: Step<unknown, unknown>): void;
  insertAfter(targetId: string, step: Step<unknown, unknown>): void;
  replace(targetId: string, step: Step<unknown, unknown>): void;
  remove(targetId: string): void;
  /** The ordered step list. */
  steps(): readonly Step<unknown, unknown>[];
}

export interface PipelineRunResult {
  runId: string;
  status: 'success' | 'failed' | 'aborted';
  completedSteps: string[];
  failedStep?: string;
  durationMs: number;
  costUsd: number;
}
```

---

## Phase 0 — Audit + decisions (no code change)

**Effort:** 0.5d.

### 0.1 What changes

Lock the decision matrix in `CORE-PIPELINE-EXTRACT-ADR.md`. Verify pre-flight (§1). Snapshot the 8-stage current set + their I/O shapes so the migration spec is concrete. Enumerate every external caller of `runPipeline` + every subscriber of `stateMachine.onEvent` (currently zero on cli side, but dashboard may have its own).

### 0.2 Procedure

1. Create `CORE-PIPELINE-EXTRACT-ADR.md` with §1 pre-flight, §2 decisions P1–P10, §3 persistence inventory (audit-log, state-file, runDir, custom-stage YAML), §4 TS schemas, §5 external importer list (`runPipeline` callers + `state-machine` subscribers), §6 per-phase commit log scaffold.
2. Document the **eight stage I/O contracts** today — what each stage reads from `StageContext`, what artifacts it writes. This is the compatibility spec Phase 5 ports against.

### 0.3 Validation

```sh
test -f CORE-PIPELINE-EXTRACT-ADR.md
grep -c '^### P[0-9]' CORE-PIPELINE-EXTRACT-ADR.md  # ≥ 10
```

### 0.4 Acceptance

- [ ] ADR written with P1–P10 decisions, each with one-line `Why`
- [ ] Stage I/O snapshot captured (8 stages × {reads, writes})
- [ ] External caller list complete

### 0.5 Rollback

Revert the ADR commit.

---

## Phase 1 — Scaffold `@anvil/core-pipeline` package

**Effort:** 0.5d.

### 1.1 What changes

Greenfield workspace package at `packages/core-pipeline/` with the canonical types from §5 plus a stub `Pipeline` class that compiles + smoke-tests but contains no logic yet. Wire dependency from cli.

### 1.2 Procedure

1. `mkdir packages/core-pipeline/` with `package.json`, `tsconfig.json`, `src/`, `src/__tests__/`.
2. `package.json` — `@anvil/core-pipeline@0.0.1`, deps: `@anvil/agent-core`, `@anvil/memory-core`. devDep: nothing new.
3. `tsconfig.json` — composite; references agent-core + memory-core.
4. New files:
   - `src/types.ts` — paste §5 schemas verbatim
   - `src/event-bus.ts` — minimal `EventBus` impl (Node `EventEmitter` wrapper, async-aware)
   - `src/step-registry.ts` — minimal `StepRegistry` impl
   - `src/pipeline.ts` — `Pipeline` class skeleton with `run(): Promise<PipelineRunResult>` that throws `'not implemented'`
   - `src/index.ts` — barrel
   - `src/version.ts` — exports `VERSION = '0.0.1'`
5. Add cli's `package.json` to depend on `@anvil/core-pipeline`. cli imports nothing from it yet.
6. Add 4 smoke tests: import shape, type round-trips, EventBus emit/on, StepRegistry register/insertBefore/remove.

### 1.3 Validation

```sh
npm install
npm -w @anvil/core-pipeline run build
npm -w @anvil/core-pipeline test
npm -w @esankhan3/anvil-cli run build  # cli still builds
```

### 1.4 Acceptance

- [ ] `@anvil/core-pipeline` package compiles
- [ ] cli builds (no behavior change yet)
- [ ] 4 smoke tests pass
- [ ] memory-core 119/119, agent-core 81/81 still green

### 1.5 Rollback

Per-commit. Package not yet wired into orchestrator.

### 1.6 Risks

- **Workspace lockfile churn:** new package may shake `package-lock.json`. Mitigation — single `npm install` run committed atomically with the package.

---

## Phase 2 — Implement `EventBus` + wire it into existing `state-machine.ts`

**Effort:** 0.5d.

### 2.1 What changes

The cli's `pipeline/state-machine.ts:143-152` already has an event emitter shape — make it a thin adapter over `@anvil/core-pipeline/EventBus`. Today's listeners (zero, but the API exists) keep working.

### 2.2 Procedure

1. `EventBus` implementation matures: add `on`, `once`, `off`, awaiting-`emit`, fire-and-forget `emitFireAndForget`.
2. `pipeline/state-machine.ts` imports `EventBus` from `@anvil/core-pipeline`. Existing `onEvent`/`emit` methods become thin pass-throughs.
3. **No behavior change yet** — bus is created but no producer emits structured events yet (Phase 4).

### 2.3 Validation

- New tests: `EventBus.emit('step:started', payload)` reaches all listeners; async listeners are awaited; throwing listener doesn't kill the bus.
- Existing cli tests still pass (state-machine API surface preserved).

### 2.4 Acceptance

- [ ] `EventBus` API matches §5 exactly
- [ ] `state-machine.ts` adopts it without behavior regression
- [ ] cli tests still pass

### 2.5 Risks

- **Async-listener back-pressure:** awaiting all listeners in `emit` could stall the pipeline if a slow listener exists. Mitigation — `emitFireAndForget` for non-critical (telemetry, dashboard); awaited `emit` only for hooks that *must* complete before continuing.

---

## Phase 3 — Hook subscribers (audit, dashboard, learners, cost)

**Effort:** 1d.

### 3.1 What changes

The 4 cross-cutting concerns currently inlined in `orchestrator.ts` migrate to be `EventBus` subscribers. The orchestrator stays as-is (still hard-coded if-tree); the subscribers run alongside.

### 3.2 Procedure

1. New module `core-pipeline/src/hooks/`:
   - `audit-log.hook.ts` — subscribes to all `pipeline:*`, `step:*` events; writes to `~/.anvil/runs/<runId>/audit.jsonl`. Replaces today's `pipeline/audit-log.ts` body.
   - `dashboard-state.hook.ts` — subscribes to `step:started`, `step:completed`, `step:failed`; writes `~/.anvil/state.json` with 100ms debounce.
   - `cost-tracker.hook.ts` — subscribes to `artifact:emitted` (for cost artifacts); aggregates per-step cost into `PipelineRunResult.costUsd`.
   - `learners.hook.ts` — subscribes to `step:completed`; calls `autoLearnHook(event)` from cli's existing `cli/src/memory/learners/index.ts`. **This is the "wire dead code" win.**
2. New `Pipeline.run()` impl: walks registered steps in order, awaits each `Step.run()`, emits the right events at each transition.
3. cli orchestrator gets a feature flag `ANVIL_USE_NEW_PIPELINE=1`. When set, calls `Pipeline.run()`; otherwise falls back to the existing if-tree. **Defaults to off.**

### 3.3 Validation

- Smoke run with flag on, single in-tree fixture project: every event fires once; audit JSONL has `pipeline:started → step:started → step:completed → pipeline:completed`; dashboard state.json updates; learners hook fires.
- Smoke run with flag off: identical behavior to today.

### 3.4 Acceptance

- [ ] All 4 hooks implemented + tested
- [ ] Feature flag gates the new path
- [ ] Both old and new paths produce identical audit logs (modulo timestamps)
- [ ] `autoLearnHook` is finally called

### 3.5 Risks

- **Hook ordering matters:** audit must fire before learners (so learners can read the audit row id). Mitigation — `EventBus` uses a priority queue; hooks declare priority at `on` time (default 0).

---

## Phase 4 — Implement `StepRegistry` + extract first stage as `Step`

**Effort:** 1d.

### 4.1 What changes

Pick the smallest stage (`clarify`) and port it to `Step<ClarifyInput, ClarifyOutput>`. Register it in `Pipeline`. Compatibility check: with feature flag on, `clarify → requirements → ...` still works (clarify uses Step path, the rest still use the old if-tree via fallback).

### 4.2 Procedure

1. `core-pipeline/src/step-registry.ts` matured per §5: `register`, `insertBefore`, `insertAfter`, `replace`, `remove`, `steps()`.
2. `cli/src/pipeline/stages/clarify.ts` (today's runner) → `cli/src/pipeline/steps/clarify.step.ts` exporting `Step<ClarifyInput, ClarifyOutput>`. The actual logic stays — only the wrapper changes.
3. `Pipeline` walks the registered steps. When the new path's `clarify` step succeeds, output flows into a `StepContext` that the next (legacy) stage can read.
4. **Compatibility shim** in cli orchestrator: if a step is registered, run it through the new path; otherwise fall through to the legacy if-tree. This is the strangler-fig migration kernel.

### 4.3 Validation

- E2E run with flag on: `clarify` runs through new path, `requirements`–`ship` run through old. Output identical to old-path-only run.

### 4.4 Acceptance

- [ ] `Step<I, O>` API matches §5
- [ ] `clarify` runs through new path
- [ ] Compatibility shim works for unported stages
- [ ] E2E parity verified

### 4.5 Risks

- **`StageContext` god-object dependency:** stage code reads many fields from `StageContext`. The new `StepContext` is typed and narrower. Mitigation — Phase 4 ports the smallest stage first to surface unknown deps cheaply.

---

## Phase 5 — Port remaining 7 stages, one per phase-sub-step

**Effort:** 2d (split 0.25–0.5d per stage).

### 5.1 What changes

Port the remaining 7 stages: `requirements → project-requirements → specs → tasks → build → validate → ship`. Each port is a separate commit so any regression bisects cleanly.

### 5.2 Procedure

For each stage, in order:
1. Move runner from `cli/src/pipeline/stages/<name>/` to `cli/src/pipeline/steps/<name>.step.ts`.
2. Replace `StageContext` reads with typed `StepContext.input` + `StepContext.artifacts.read('<artifact-id>')`.
3. Replace direct artifact writes with `ctx.emit('<artifact-id>', data)`.
4. Register the step. Compatibility shim drops the old if-branch for this stage.
5. **`build` stage gets the special treatment** — auto-fix retry hoists to `Step.subSteps` (P5). The build's "retry on failure" becomes a sub-step boundary.
6. **`ship` stage's PR URL parser** — today regex-matches agent stdout (`orchestrator.ts:1421`). Move to `Step.run` returning `{prUrl, ...}` typed; consumers read the typed field instead of regex.

### 5.3 Validation

After each stage port:
- E2E run with flag on against fixture project: ported stages use new path, unported still use old. Output identical.
- After all 8 ported: feature flag default flips to **on**.

### 5.4 Acceptance

- [ ] All 8 stages exported as `Step<I, O>`
- [ ] Each stage commit is independently revertible
- [ ] Auto-fix retry generalized into sub-steps (P5)
- [ ] Feature flag defaults to on at end of Phase 5

### 5.5 Risks

- **Per-project parallelism (stages 2–4):** today's `parallel-runner.ts` scheduling is bespoke. Mitigation — `Step.parallelism = 'per-project'` lets `Pipeline` honor it without each step caring.
- **Approval gate behavior:** today inline in orchestrator. Move to a hook (`step:completed → check-approval-gate.hook.ts`).

---

## Phase 6 — Custom-stage compatibility (factory.yaml)

**Effort:** 0.5d.

### 6.1 What changes

`custom-stage.ts` already loads factory.yaml-defined stages. New shim turns each into a `Step<unknown, unknown>` and registers it via `insertBefore` / `insertAfter` based on the YAML's positional hint.

### 6.2 Procedure

1. New `cli/src/pipeline/custom-stage-shim.ts` — reads factory.yaml, translates each entry to a `Step` via `loadCustomStages()` (existing function).
2. The yaml grows two optional fields: `insertBefore: <step-id>` and `insertAfter: <step-id>`. If neither present, append to end (matches today's "append" default).
3. Keep today's syntax fully backwards-compatible.

### 6.3 Validation

- Fixture factory.yaml with one custom stage `insertAfter: build`, `insertBefore: validate` — runs at the right point.
- Old factory.yaml without insertBefore/insertAfter still works (appends).

### 6.4 Acceptance

- [ ] `loadCustomStages` round-trips into Step registrations
- [ ] insertBefore/insertAfter respected
- [ ] Backwards compat preserved

### 6.5 Risks

- **YAML schema drift:** users may have existing factory.yaml files. Mitigation — version detection in the loader; default to v1 (today's shape).

---

## Phase 7 — Generalize auto-fix retry as `Step.subSteps`

**Effort:** 0.5d.

### 7.1 What changes

The validate stage's auto-fix retry loop (`orchestrator.ts:1300-1348`) is generalized: any `Step` declaring `subSteps` runs them sequentially; failure of a sub-step triggers `Step.retryPolicy` at the sub-step level.

### 7.2 Procedure

1. `Pipeline` runner gains sub-step recursion: when a step has `subSteps`, run them as a nested mini-pipeline.
2. validate's "build → lint → test → fix" becomes 4 sub-steps; failure of `test` triggers retry of just `fix → test` cycle, not the whole validate stage.
3. New events: `sub-step:started`, `sub-step:completed`. Audit hook records them with `parentStepId`.

### 7.3 Validation

- Validate runs with intentionally-failing test fixture: 3 retries observed in audit, all under one parent `validate` event frame.
- Other stages without sub-steps run unchanged.

### 7.4 Acceptance

- [ ] Sub-step recursion implemented
- [ ] validate stage rewritten with sub-steps
- [ ] Audit log records sub-step lifecycle correctly
- [ ] No regression in cli auto-fix behavior

---

## Phase 8 — Delete the if-tree from `orchestrator.ts`

**Effort:** 0.5d.

### 8.1 What changes

`orchestrator.ts` shrinks from 2089 LOC to ~150. Becomes a thin wrapper: `runPipeline(config) → setupRegistry() → new Pipeline(registry, hooks).run()`.

### 8.2 Procedure

1. Delete the 8-way if-tree (`orchestrator.ts:948-1432`).
2. Delete the auto-fix retry inline (now in sub-steps).
3. Delete `StageContext` (replaced by `StepContext`).
4. Delete the dead `state-machine.onEvent` shim path (real `EventBus` is in use).
5. Audit-log + state-file modules become thin re-exports of the hook implementations.

### 8.3 Validation

- E2E full-pipeline run on fixture: identical output to pre-refactor.
- LOC delta: `cli/src/pipeline/` shrinks by ~1500 LOC; `core-pipeline/` adds ~1000 LOC. Net –500.

### 8.4 Acceptance

- [ ] orchestrator.ts ≤ 200 LOC
- [ ] All cli tests pass
- [ ] memory-core 119/119, agent-core 81/81, knowledge-core 62/62 still green
- [ ] dashboard build clean

### 8.5 Risks

- **Subtle behavior drift:** the 2089-LOC monolith has accreted edge-case handling. Mitigation — keep feature flag for one cycle so users can fall back.

---

## Phase 9 — Tests + docs + ADR finalize

**Effort:** 1d.

### 9.1 What changes

Coverage push: ≥40 tests under `packages/core-pipeline/src/__tests__/`. README + ADR finalized.

### 9.2 Procedure

1. `packages/core-pipeline/README.md` — public API quick-start, Step contract, hook points, custom-stage migration guide, env var reference.
2. ADR §6 finalized with per-phase commit log.
3. Test coverage targets:
   - Pipeline runner (10 tests): empty registry, single step, sequence, failure-mid, abort signal, parallelism per-project, sub-step recursion, hook ordering, retry policy, async hook back-pressure
   - StepRegistry (8): register / insertBefore / insertAfter / replace / remove / duplicate-id / cycle detection / ordering invariants
   - EventBus (8): emit awaits, fire-and-forget non-blocking, listener throw isolation, off, once, priority ordering, async listeners, listener removal mid-emit
   - Hooks (4): audit, dashboard-state, cost-tracker, learners — each subscribed to a fixture run, asserts side effects
   - Compatibility shim (5): custom-stage with insertBefore, insertAfter, neither (appends), v1 backwards compat, error path

### 9.3 Acceptance

- [ ] core-pipeline ≥ 40 tests passing
- [ ] All other packages still green
- [ ] README has 6 sections (architecture, quick-start, Step contract, hook points, custom stages, env vars)
- [ ] ADR §6 fully populated with commit hashes

---

## Cross-cutting validation strategy

After each phase:

1. `npm install` — lockfile + native deps compile
2. `tsc -b` from root — type-check across all packages
3. Per-package: `npm -w <name> run build && npm -w <name> test`
4. **Real-data smoke** — run cli pipeline against the existing fixture project after Phases 4 (one stage ported), 5 (all stages ported), 8 (if-tree deleted). Each smoke must produce byte-identical artifacts to pre-Phase-1 baseline.
5. **Audit log diff** — same fixture, before/after each phase: `diff <(jq -c . old.jsonl) <(jq -c . new.jsonl)` should differ only in timestamps + monotonic ids.

---

## Cross-cutting order rationale

| # | Phase | Why this order |
|---|---|---|
| 0 | Audit + decisions | Lock P1–P10 + I/O snapshot before code |
| 1 | Scaffold package | Greenfield package; doesn't touch cli yet |
| 2 | EventBus wiring | Make today's dead emitter live; zero risk |
| 3 | Hook subscribers | Wire cross-cutting concerns first; orchestrator unchanged |
| 4 | First stage as Step | Smallest stage proves the contract |
| 5 | Port remaining 7 | One commit each — clean bisect surface |
| 6 | Custom-stage compat | factory.yaml users keep working |
| 7 | Sub-step generalization | Validate's auto-fix retry rehoused |
| 8 | Delete if-tree | All ports complete; orchestrator collapse |
| 9 | Tests + docs + ADR finalize | Standard close-out |

**Total effort:** ~7d. **Total LOC delta:** +1000 in `core-pipeline/`, –1500 from `cli/src/pipeline/orchestrator.ts`, ~+800 tests. Net **–~300 LOC** with much higher cohesion.

---

## Out of scope / known follow-ups

1. **Pattern 2 — durable execution (Inngest/Temporal-style step-level replay):** out of scope for this plan. After Pattern 1 lands, evaluate whether step boundaries are stable enough to warrant durable persistence per step. If yes, write `CORE-PIPELINE-DURABILITY-PLAN.md` separately.
2. **Cross-process pub/sub:** today's pipeline is a single cli process. If/when multiple processes need to coordinate (parallel projects across machines), revisit the bus. Out of scope here.
3. **Dashboard React tabs for the new event stream:** dashboard already reads `~/.anvil/state.json`; richer event-history UI is a follow-up under the dashboard plan.
4. **Stage-level cost budgets:** `Step.budgetUsd` could enforce per-stage caps via the LLM router's spend ledger. Defer until LLM router (the other plan) lands.
5. **Replay UI:** "rerun from step N with these inputs" is a Pattern 2 feature. Out of scope here.
6. **Auto-step-graph derivation from `factory.yaml`:** today's factory.yaml is positional + flat. A DAG-shaped declaration (with explicit `dependsOn`) is a future config evolution.
