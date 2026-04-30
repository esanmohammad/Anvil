# Core-Pipeline Consolidation Plan

> Closeout of the pipeline runtime split. Eliminates cli's 1682-LOC legacy `runPipeline` if-tree, reclaims `core-pipeline` as the single source of truth for both cli and dashboard, removes the `ANVIL_USE_NEW_PIPELINE` feature flag, and lifts the four parity gaps (interactive clarify, approval gates, resume-from-stage, parallel-per-project fan-out — though the latter is already implemented as `parallelism: 'per-repo'`) into transport-agnostic core-pipeline primitives plus cli step adapters.
>
> **Status:** draft 2026-04-30.
> **Depends on:** `@anvil/core-pipeline` (shipped), `@anvil/agent-core` (shipped), the 8 existing cli step adapters under `packages/cli/src/pipeline/steps/`, the dashboard consolidation series Phase 1–6 (already merged), the agent-manager consolidation (already merged).

---

## 1. Pre-flight reality check (verified 2026-04-30)

| Check | Result |
|---|---|
| `packages/cli/src/pipeline/orchestrator.ts` exists, **1682 LOC** — full legacy if-tree, runs the actual pipeline | ✅ |
| `packages/cli/src/pipeline/orchestrator-v2.ts` exists, **135 LOC** — thin wrapper around `Pipeline.run()` | ✅ |
| Dispatch from legacy → v2 is **gated** behind `ANVIL_USE_NEW_PIPELINE=1` (orchestrator.ts:730–733) | ✅ |
| `isNewPipelineEnabled()` reads env var; default is **false** — v2 never runs in normal usage | ✅ |
| Dashboard's `pipeline-bus-subscriber.ts` + 8 step files import from `@anvil/core-pipeline` exclusively — no legacy if-tree on the dashboard side | ✅ |
| 8 cli step adapters exist under `packages/cli/src/pipeline/steps/` — wrap legacy `runXxxStage()` functions | ✅ |
| `core-pipeline` already supports per-repo fanout via `step.parallelism: 'per-repo'` (Phase 4a — implemented) | ✅ |
| `core-pipeline` does **NOT** support resume-from-step (no `resumeFromStep` option, no completed-step skip on `Pipeline.run()`) | ❌ |
| `core-pipeline` does **NOT** have a request/response primitive on `EventBus` for human-in-the-loop steps (clarify Q&A, approval gate) | ❌ |
| Step IO chaining **breaks** for most v2 steps: each `Step<I,O>` declares an input shape requiring `{ project, feature, agentRunner, runDir, ... }`, but the walker threads the *prior step's output* as `ctx.input`. Only the first step (`clarify`) gets `initialInput`. The other 7 steps' input shapes are unreachable. | ❌ |
| Legacy orchestrator does, v2 does NOT: persona prompt builder w/ memory + KB injection (~225 LOC), feature-branch creation (~30 LOC), post-build guards (~80 LOC), resume artifact loader (~60 LOC), per-stage approval gate (`waitForApproval` polls state file) | ❌ |
| Legacy orchestrator does, v2 DOES (via shared stage runners): interactive clarify (state-file pendingApproval pattern, lives in `stages/clarify.ts` — already shared) | ✅ |
| Legacy `runPipeline` is the production hot path — `cli/src/commands/run-feature.ts:4` is the sole import | ✅ |
| v2 wrapper has **no production callers** (only the env-flag-gated dispatch from inside legacy) | ✅ |
| Dashboard's pipeline runs through `core-pipeline` already; no dashboard-side change required | ✅ |

**Coupling shape today:**
- **Two pipeline runners with inconsistent feature sets.** Legacy has all features and ships in production. v2 has the walker, the bus, the hooks, but is missing five orchestration concerns and has broken step-IO chaining for steps 2–8.
- **Feature flag papers over the gap.** `ANVIL_USE_NEW_PIPELINE` exists because v2 is non-functional for end-to-end runs; the flag defaults off so users never hit the breakage.
- **Dashboard already migrated.** All dashboard step+hook code rides on `@anvil/core-pipeline`. The asymmetry is cli-only.

**Total in-scope LOC:**
- Delete: `cli/src/pipeline/orchestrator.ts` 1682 LOC + `isNewPipelineEnabled` (8 LOC) + the v2 wrapper `orchestrator-v2.ts` 135 LOC (replaced by inlined `runPipeline`).
- Lift into core-pipeline (~250 LOC): bus request/response primitive, `resumeFromStep` walker option, completed-step skip semantics.
- Lift into cli pipeline helpers (~600 LOC): persona prompt builder, feature-branch creation, post-build guards, resume artifact loader, dashboard-state hook (already exists in `core-pipeline/hooks/`), per-stage approval emit.
- Refactor 8 step adapters: introduce a `PipelineSharedContext` threaded through `ctx.artifacts` so each step's input shape resolves cleanly.
- Net delta after deletes + lifts: estimated **−750 to −900 LOC**.

---

## 2. Why this isn't a one-shot rewrite of the file

The legacy if-tree is **not** a thin shell — it does six concerns interleaved per stage:

1. Persona prompt construction (memory + KB injection, layered context, learnings, template variable expansion, sanity caps).
2. Stage execution (call the agent runner with the persona prompt).
3. Cost tracking + run record updates + dashboard state writes.
4. Per-stage artifact persistence to feature dir.
5. Approval gate polling (writes `pendingApproval` to state file, polls every 500ms).
6. Resume-from-stage skip + prior-artifact load.

A naive copy-paste of these into core-pipeline `Step` adapters would re-bake six cross-cutting concerns into eight steps. The plan extracts each concern into its proper home:

| Concern | New home |
|---|---|
| Persona prompt construction | cli helper `cli/src/pipeline/persona-prompt.ts`; called by step adapters |
| Stage execution | step adapter (already done) |
| Cost tracking | core-pipeline hook `attachCostTrackerHook` (already exists) |
| Run record updates | new core-pipeline hook `attachRunStoreHook` |
| Dashboard state writes | core-pipeline hook `attachDashboardStateHook` (already exists) |
| Per-stage artifact persistence | new core-pipeline hook `attachFeatureStoreHook` (subscribes to `artifact:emitted`) |
| Approval gate polling | new core-pipeline primitive `bus.request('approval', stageIndex)` + cli/dashboard responders |
| Resume-from-stage skip | new core-pipeline option `Pipeline.run({ resumeFromStep, completedSteps })` |
| Prior artifact load | new cli helper `cli/src/pipeline/feature-store.ts`; populates initial `ctx.artifacts` |

This is a one-go cutover (no flag) but requires three real additions to `core-pipeline` itself (bus request/response, resume-from-step, run-store hook). Everything else is cli-side glue.

---

## 3. Decisions (deferred to ADR)

The full decision matrix lives in `CORE-PIPELINE-CONSOLIDATION-ADR.md` (created in Phase 0). Headlines:

- **D1** — One pipeline-runtime surface, owned by `@anvil/core-pipeline`. cli + dashboard both consume it. After this plan lands, the cli has zero bespoke orchestration code beyond step adapters and prep helpers.
- **D2** — `EventBus` gains a typed `request(channel, payload)` primitive for human-in-the-loop steps. Returns a `Promise<TResponse>` resolved when a responder calls `bus.respond(channel, requestId, response)`. cli wires a stdin readline responder for clarify Q&A; dashboard wires a WS responder. Same wire, different transport.
- **D3** — `Pipeline.run()` gains `{ resumeFromStep?: string, completedSteps?: string[] }`. When `resumeFromStep` is set, the walker skips steps until the named step (inclusive resumes from there). `completedSteps` populates the artifacts cache from prior runs (loaded by the cli `feature-store` helper).
- **D4** — Step IO chaining is fixed by introducing **`ctx.shared`**: a typed shared-state record threaded through every step. Each step reads/writes `shared.<key>`; downstream steps no longer depend on the prior step's *output type* matching their *input type*. Only artifacts use the existing artifact store.
- **D5** — Cross-cutting concerns become hooks (or core-pipeline-side responders): persona prompt is a step-internal helper, run-store updates become `attachRunStoreHook`, feature-store persistence becomes `attachFeatureStoreHook`. Approval gate becomes a `bus.request('approval:gate', stageIndex)` call, with cli + dashboard hosting responders.
- **D6** — **No feature flags.** The `ANVIL_USE_NEW_PIPELINE` env flag and the `isNewPipelineEnabled()` helper are deleted in the same PR that lands the cutover. Same rule as the dashboard consolidation series and the agent-manager consolidation.
- **D7** — **No new package.** All consolidation lands in existing `@anvil/core-pipeline` and `@anvil/cli`.
- **D8** — Legacy `runPipeline` from `orchestrator.ts` deletes outright. Its only public consumer (`commands/run-feature.ts`) updates its import to the new `runPipeline` (formerly `runPipelineV2`, renamed canonical).
- **D9** — Branch-parity diff replaces flag-gated rollout. Before deleting legacy, run the same 5 representative pipelines on both code paths (legacy + new) and diff: dashboard-state writes byte-for-byte equal, audit log lines equal modulo timestamps, cost totals equal within 0.1%, generated artifacts equal modulo whitespace. If parity holds, delete legacy.
- **D10** — Public on-disk artifact paths unchanged: `~/.anvil/runs/<runId>/audit.jsonl`, `~/.anvil/features/<project>/<slug>/{CLARIFICATION,REQUIREMENTS,...}.md`, `~/.anvil/state.json`. Dashboard's WS protocol unchanged.
- **D11** — `OrchestratorConfig` and `OrchestratorResult` types stay (re-exported from `cli/src/pipeline/index.ts`). The internals change; the surface that `commands/run-feature.ts` sees does not.

---

## 4. Public API migration table

| Surface | Today | After |
|---|---|---|
| `cli/src/pipeline/orchestrator.ts` (1682 LOC, legacy if-tree) | local | **deleted** |
| `cli/src/pipeline/orchestrator-v2.ts` (135 LOC, wrapper) | local | **renamed** to `orchestrator.ts`, expanded to ~300 LOC with full feature parity |
| `cli/src/pipeline/steps/index.ts` `isNewPipelineEnabled()` | env-flag check | **deleted** |
| `commands/run-feature.ts` `import { runPipeline } from '../pipeline/orchestrator.js'` | unchanged | unchanged (same import path, same name) |
| `Pipeline.run()` | `Promise<PipelineRunResult>` | `Promise<PipelineRunResult>` — accepts new `{ resumeFromStep, completedSteps }` opts |
| `EventBus.request(channel, payload)` | does not exist | new — typed Promise-returning primitive for human-in-the-loop |
| `EventBus.respond(channel, requestId, response)` | does not exist | new — companion responder method |
| `attachRunStoreHook(bus, opts)` | does not exist | new core-pipeline hook |
| `attachFeatureStoreHook(bus, opts)` | does not exist | new core-pipeline hook |
| `attachApprovalGateHook(bus, opts)` | does not exist | new core-pipeline hook (cli stdin responder + dashboard WS responder) |
| `cli/src/pipeline/persona-prompt.ts` | does not exist | new — extracted from `buildPersonaProjectPrompt()` |
| `cli/src/pipeline/feature-store.ts` | does not exist | new — extracted from resume-artifact-loading block |
| `cli/src/pipeline/post-build-guards.ts` | inline in legacy | new — extracted standalone |
| `cli/src/pipeline/feature-branches.ts` | inline in legacy | new — extracted standalone |
| Per-stage `Step<I, O>` input shapes | broken (each step expects unreachable input) | normalized to read from `ctx.shared` |
| `~/.anvil/state.json` `pendingApproval` field | written by legacy | written by `attachApprovalGateHook` (cli responder) |
| `~/.anvil/features/<project>/<slug>/*.md` | written by legacy | written by `attachFeatureStoreHook` |

---

## 5. Schema shapes

No new on-disk schemas. The plan **adds** two in-process types:

- `EventBusRequest<P, R>` — `{ requestId: string, channel: string, payload: P }` paired with `{ requestId: string, response: R }`. Lives in `core-pipeline/src/event-bus.ts`.
- `PipelineSharedState` — typed record threaded through every step's `ctx.shared`. Defined in `core-pipeline/src/types.ts` as `Record<string, unknown>` with cli providing the concrete shape `CliPipelineState` (project, feature, featureSlug, runId, repoPaths, workspaceDir, projectYamlPath, agentRunner, memoryStore, costTracker, affectedProjects, projectArtifacts).

Existing on-disk artifacts (`audit.jsonl`, `state.json`, feature-store markdowns) keep their current schema.

---

## Phase 0 — Audit + decisions (no code change)

**Effort:** 0.5d.

### 0.1 What changes
Lock D1–D11 in `CORE-PIPELINE-CONSOLIDATION-ADR.md`. Snapshot the call graph: every site in cli that calls `runPipeline()`, `runPipelineV2()`, `isNewPipelineEnabled()`, `buildPersonaProjectPrompt()`, `runPostBuildGuards()`, `createFeatureBranches()`, `waitForApproval()`. Identify the seam where `bus.request/respond` lives, where `resumeFromStep` lives, and where each cross-cutting concern moves.

### 0.2 Acceptance
- [ ] ADR with D1–D11, each with one-line `Why`
- [ ] Call-graph inventory: file path, line number, surface called, current behavior, target home
- [ ] `PipelineSharedState` field-mapping table (which legacy variables become which `ctx.shared.<key>`)
- [ ] Branch-parity test plan: 5 pipelines × current vs new, diffing audit + state + artifacts

### 0.3 Rollback
Revert the ADR commit.

---

## Phase 1 — core-pipeline: bus request/response primitive

**Effort:** 0.5d.

### 1.1 What changes
`EventBus` gains `request<P, R>(channel, payload, opts?: {timeoutMs?}): Promise<R>` and `respond<R>(channel, requestId, response): void`. Pure addition — no existing API changes.

### 1.2 Procedure
1. New file `core-pipeline/src/bus-request.ts` — defines `EventBusRequest`, `EventBusResponse` shapes.
2. Extend `EventBus` interface in `event-bus.ts` with the two new methods.
3. `InMemoryEventBus` implements: keeps a `Map<requestId, {resolve, reject, timer}>`; `request()` generates id, emits a `request:<channel>` event, returns the promise; `respond()` emits `response:<channel>` and resolves the corresponding pending entry.
4. Default request timeout: 30 minutes (matches legacy `waitForApproval` timeout). Configurable per-call.
5. Tests in `core-pipeline/src/__tests__/bus-request.test.ts`: happy path, timeout, parallel requests, no-responder rejection.

### 1.3 Acceptance
- [ ] `tsc -b` green
- [ ] All new tests green
- [ ] No existing core-pipeline test regresses (245+ tests)
- [ ] No call-site changes in cli or dashboard yet

### 1.4 Risks
- **Race between request emit + responder attach.** Mitigation: `bus.request()` is synchronous in registering the pending entry before emitting; responders attach via `bus.on('request:<channel>')` *before* the step that issues the request runs.

### 1.5 Rollback
Revert Phase 1 commit. Pure addition.

---

## Phase 2 — core-pipeline: `resumeFromStep` + `completedSteps` walker option

**Effort:** 0.5d.

### 2.1 What changes
`PipelineDeps` gains `resumeFromStep?: string` and `completedSteps?: string[]`. `Pipeline.run()` skips steps whose `id` appears in `completedSteps`, and (if `resumeFromStep` is set) refuses to run any step before it in registry order.

### 2.2 Procedure
1. Extend `PipelineDeps` in `core-pipeline/src/types.ts`.
2. In `Pipeline.run()`, before the step loop, compute the skip set: `completedSteps ∪ [steps before resumeFromStep]`.
3. For each skipped step, emit synthetic `step:skipped` event (new hook point — add to `StepHookPoint`).
4. Hooks (audit, dashboard-state, run-store) consume `step:skipped` to mark stages as already-done in their own state.
5. Tests in `core-pipeline/src/__tests__/resume.test.ts`: resume from middle, resume with no-op skip, resume with all completed, resume with unknown stepId rejection.

### 2.3 Acceptance
- [ ] `tsc -b` green
- [ ] Resume tests green
- [ ] Existing 245+ tests green
- [ ] Skipped step emits `step:skipped`, not `step:started`/`step:completed`

### 2.4 Risks
- **Dashboard hook compatibility.** Dashboard's `attachDashboardStateHook` listens for `step:started`/`step:completed` to update WS clients. Adding `step:skipped` requires the hook to handle it (mark as completed in WS state). Mitigation: update the hook in this phase.

### 2.5 Rollback
Revert Phase 2 commit.

---

## Phase 3 — core-pipeline: `ctx.shared` step IO

**Effort:** 1d.

### 3.1 What changes
Step contexts gain `shared: Record<string, unknown>` — a mutable, step-scoped shared-state record threaded through the run. Existing `ctx.input` (prior step output) continues to work for steps that genuinely chain. Steps that need broader context read/write `ctx.shared`.

### 3.2 Procedure
1. Extend `StepContext` in `core-pipeline/src/types.ts` with `shared: Record<string, unknown>`.
2. `Pipeline.run()` initializes `shared` from `deps.initialShared ?? {}`.
3. `buildContext()` passes the same `shared` reference to every step.
4. Tests in `core-pipeline/src/__tests__/shared-state.test.ts`: write in step A, read in step B; concurrent per-repo fanout sees same shared (steps responsible for thread safety).
5. Update existing 8 cli step adapters: each step's `Input` shape shrinks to *only* what differs per step (e.g., `clarification` for the requirements step). Cross-stage state (project, feature, agentRunner, runDir) moves to `ctx.shared`.

### 3.3 Acceptance
- [ ] `tsc -b` green
- [ ] All 8 cli step adapters compile after `Input` shape shrink
- [ ] Existing core-pipeline + cli step tests green
- [ ] Dashboard step adapters (which already use simpler I→O chains) unaffected — their `Input` shapes already line up

### 3.4 Risks
- **Hidden coupling via `ctx.shared`** — stateful sharing through a record is easy to misuse. Mitigation: cli defines a typed `CliPipelineState` interface and casts at the boundary. Dashboard steps don't use `ctx.shared` (they continue with explicit I→O chains).

### 3.5 Rollback
Revert Phase 3 commit. Step adapters revert their Input shapes.

---

## Phase 4 — core-pipeline: new hooks (run-store, feature-store, approval-gate)

**Effort:** 1d.

### 4.1 What changes
Three new hooks attach to the bus:
- `attachRunStoreHook(bus, { runStore, runId })` — listens for `pipeline:started`, `step:started`, `step:completed`, `step:failed`, `pipeline:completed`, `pipeline:failed` and updates the `RunStore` record.
- `attachFeatureStoreHook(bus, { featureDir })` — listens for `artifact:emitted` with known artifact ids (`CLARIFICATION.md`, `HIGH-LEVEL-REQUIREMENTS.md`, etc.) and writes them to `~/.anvil/features/<project>/<slug>/`.
- `attachApprovalGateHook(bus, { transport: 'cli' | 'dashboard', stateFile? })` — listens on `request:approval:gate` and:
  - In `cli` mode: reads stdin (or polls state file for dashboard-driven approvals).
  - In `dashboard` mode: writes `pendingApproval` to `~/.anvil/state.json` and waits for the user-driven clear.
  - Calls `bus.respond('approval:gate', requestId, 'approved'|'rejected')`.

### 4.2 Procedure
1. New `core-pipeline/src/hooks/run-store.hook.ts`. Imports `RunStore` *type* from cli; concrete instance is injected. Pattern matches existing `attachAuditLogHook`.
2. New `core-pipeline/src/hooks/feature-store.hook.ts`. Filesystem writes via injected `fs` for testability.
3. New `core-pipeline/src/hooks/approval-gate.hook.ts`. The cli responder uses readline; the dashboard responder uses the existing `state-file.ts` poll loop (lifted from cli into core-pipeline so dashboard can subscribe). Actually — to avoid a cli→core-pipeline backwards dep, the hook *defines* the contract and accepts an injected `getApprovalDecision: (stageIndex: number) => Promise<'approved'|'rejected'>` function; cli + dashboard each provide their own.
4. Re-export the three new hooks from `core-pipeline/src/index.ts`.
5. Tests in `core-pipeline/src/__tests__/hooks/`: each hook has unit tests with a mocked bus + injected dep.

### 4.3 Acceptance
- [ ] `tsc -b` green
- [ ] Each new hook has ≥4 unit tests (happy path, error path, idempotency, no-op when irrelevant event)
- [ ] No call sites changed yet — orchestrator still uses legacy hooks

### 4.4 Risks
- **`RunStore` type exposure into core-pipeline.** Mitigation: hook accepts a structural type `{ updateRun(record): Promise<void> }` rather than importing the cli class directly. cli passes its `RunStore` instance.

### 4.5 Rollback
Revert Phase 4 commit.

---

## Phase 5 — cli: extract cross-cutting helpers

**Effort:** 1d.

### 5.1 What changes
Extract pure helpers from the legacy if-tree into standalone modules. **No deletion yet** — legacy still calls them in-place via local function references. New v2 wrapper imports them.

### 5.2 Procedure
1. New `cli/src/pipeline/persona-prompt.ts` — extracts `buildPersonaProjectPrompt()` (orchestrator.ts:456–670, ~215 LOC) verbatim. Becomes a pure async function.
2. New `cli/src/pipeline/feature-branches.ts` — extracts `createFeatureBranches()` (orchestrator.ts:412–439, ~28 LOC).
3. New `cli/src/pipeline/post-build-guards.ts` — extracts `runPostBuildGuards()` + helpers (`fileExistsIn`, `runSilent`, `loadRepoCommandsFromConfig`) (~120 LOC).
4. New `cli/src/pipeline/feature-store.ts` — extracts the resume artifact-loading block (orchestrator.ts:903–953, ~50 LOC) as `loadPriorArtifacts(featureSlug, project, repoNames): PriorArtifacts`.
5. New `cli/src/pipeline/approval-gate.ts` — extracts `waitForApproval()` (orchestrator.ts:673–705) as `getApprovalDecision(stageIndex): Promise<'approved'|'rejected'>`. cli wires this as the responder for `approval:gate`.
6. New `cli/src/pipeline/notifications.ts` — extracts `sendPipelineNotification()` + `formatDuration()`.
7. Update orchestrator.ts to import from these modules instead of having them inline. Delete the in-place definitions. Legacy still works.
8. Tests for each new module: snapshot tests where the helper is pure; integration tests where it touches fs.

### 5.3 Acceptance
- [ ] `tsc -b` green
- [ ] All cli tests green
- [ ] orchestrator.ts shrinks from 1682 LOC to ~1200 LOC
- [ ] Each extracted module has ≥3 tests

### 5.4 Risks
- **Module boundary cycles** — `persona-prompt.ts` imports many things (`PIPELINE_STAGES`, `loadPersonaPrompt`, `MemoryStore`, etc.). Mitigation: keep imports identical to legacy; module is a relocation, not a rewrite.

### 5.5 Rollback
Revert Phase 5 commit.

---

## Phase 6 — Replace v2 wrapper with feature-complete `runPipeline`

**Effort:** 1.5d.

### 6.1 What changes
`orchestrator-v2.ts` expands to ~300 LOC, becoming the canonical `runPipeline`. It uses the new hooks (Phase 4), shared state (Phase 3), bus request/response (Phase 1), resume opts (Phase 2), and the extracted helpers (Phase 5). The 8 step adapters update their `Input` shapes to read from `ctx.shared` (per Phase 3).

### 6.2 Procedure
1. In `orchestrator-v2.ts`:
   - Build `CliPipelineState` from config + project loader + workspace resolution (lifted from legacy lines 738–877).
   - Init bus + 7 hooks: audit, dashboard-state, cost-tracker, learners (existing) + run-store, feature-store, approval-gate (new).
   - If `config.resumeFromStage > 0`: call `loadPriorArtifacts()` and populate `initialShared.priorArtifacts`. Pass `resumeFromStep` to `Pipeline.run()`.
   - Pass `initialShared: cliPipelineState` to the pipeline.
   - Each step adapter reads `ctx.shared.project`, `ctx.shared.agentRunner`, etc. — input shapes shrink.
2. Each step adapter (`clarify.step.ts`, `high-level-requirements.step.ts`, `project-requirements.step.ts`, `project-specs.step.ts`, `project-tasks.step.ts`, `build.step.ts`, `validate.step.ts`, `ship.step.ts`):
   - Build the persona prompt via `buildPersonaProjectPrompt(ctx.shared.stageIndex, ...)`.
   - Call the underlying stage runner.
   - On stages that need approval (per `ctx.shared.approvalRequired`), issue `await ctx.bus.request('approval:gate', { stageIndex })` after the stage completes.
   - Build step also calls `createFeatureBranches()` before its main work; runs `runPostBuildGuards()` after.
3. Per-project parallel stages (project-requirements, specs, tasks): set `parallelism: 'per-repo'` on the step (or use `parallelism: 'per-project'` which we add as an alias). The walker fans out to `affectedProjects` (which is in `ctx.shared`).

### 6.3 Acceptance
- [ ] `tsc -b` green
- [ ] All cli tests green
- [ ] New `orchestrator-v2.ts` runs 5 representative pipelines end-to-end without legacy fallback
- [ ] Dashboard receives the same WS messages (audit-log + state file format unchanged — D10)
- [ ] Resume-from-stage works: kill mid-pipeline, restart with `--resume-from-stage 3`, prior artifacts populate, walker resumes at step 3

### 6.4 Risks
- **Per-project fanout semantics** — current `parallelism: 'per-repo'` fans across `deps.repoPaths` keys. The legacy fans across `affectedProjects`, which is project names (different concept). Mitigation: in cli, populate `repoPaths` with one key per affected project for stages 2–4, so the same fanout primitive works. Or add a new `parallelism: 'per-project'` mode that reads from `ctx.shared.affectedProjects`.
- **Approval-gate responder ordering** — cli must call `attachApprovalGateHook` *before* `Pipeline.run()` to register the responder. Already the standard hook-attachment pattern.

### 6.5 Rollback
Revert Phase 6 commit. Legacy still runs (flag still on for safety; flag deletion happens in Phase 8).

---

## Phase 7 — Branch-parity validation

**Effort:** 0.5d.

### 7.1 What changes
No code change. Run 5 representative pipelines on both legacy and new code paths and diff outputs. Approve cutover if parity holds.

### 7.2 Procedure
1. Five fixtures under `cli/__fixtures__/parity/`: small-feature, multi-repo, resumed-from-stage-3, approval-gated, ship-with-deploy.
2. Helper script `scripts/parity-diff.sh` — runs `ANVIL_USE_NEW_PIPELINE=0 anvil run-feature ...` and `ANVIL_USE_NEW_PIPELINE=1 anvil run-feature ...` per fixture; diffs `~/.anvil/runs/<runId>/audit.jsonl` (modulo timestamps), `~/.anvil/state.json` (post-run snapshot), `~/.anvil/features/<project>/<slug>/*.md`.
3. Acceptance: ≤5 byte-level differences per fixture (only timestamps, runIds, and known nondeterministic values like elapsed-ms).

### 7.3 Acceptance
- [ ] All 5 fixtures pass parity diff
- [ ] Cost totals agree within 0.1%
- [ ] Approval-gated fixture: same 30-min timeout behavior

### 7.4 Risks
- **Agent runner nondeterminism** — LLM responses vary run-to-run. Mitigation: parity fixtures use a recorded-response agent runner (already present for cli tests).

### 7.5 Rollback
If parity fails, revert Phase 6 (rollback step) and reopen the failing diff as a Phase 6 follow-up.

---

## Phase 8 — Delete legacy + flag

**Effort:** 0.5d.

### 8.1 What changes
Delete `orchestrator.ts` (1682 LOC). Rename `orchestrator-v2.ts` → `orchestrator.ts`. Delete `isNewPipelineEnabled()`. Delete the `ANVIL_USE_NEW_PIPELINE` doc references.

### 8.2 Procedure
1. `git rm cli/src/pipeline/orchestrator.ts`
2. `git mv cli/src/pipeline/orchestrator-v2.ts cli/src/pipeline/orchestrator.ts`
3. Edit `cli/src/pipeline/steps/index.ts`: remove `isNewPipelineEnabled` (unused after delete).
4. Edit `cli/src/pipeline/index.ts`: re-export `runPipeline` from new orchestrator. `OrchestratorConfig` and `OrchestratorResult` types stay, re-exported.
5. Edit `cli/src/commands/run-feature.ts`: import path unchanged.
6. Grep for `ANVIL_USE_NEW_PIPELINE`, delete every reference (env handling, README, .env templates).
7. Drop the `defaultStageRunners` constant and the `StageRunners` injection point (only legacy used them) — unless cli tests still need stage-runner injection for parity. If yes: re-introduce as `runPipeline({ stageRunners })`.

### 8.3 Acceptance
- [ ] `tsc -b` green
- [ ] All cli tests green
- [ ] `grep -r ANVIL_USE_NEW_PIPELINE` returns nothing
- [ ] `wc -l cli/src/pipeline/orchestrator.ts` ≈ 300 (was 1682)
- [ ] `cli/src/commands/run-feature.ts` import unchanged

### 8.4 Risks
- **Hidden caller of legacy-only export.** Mitigation: Phase 0 call-graph inventory ensures we know every consumer before deleting.

### 8.5 Rollback
Revert Phase 8 commit. Phase 6 + 7 still in place; legacy can be re-introduced from git history if a regression surfaces post-merge.

---

## Phase 9 — Clean up dead siblings

**Effort:** 0.5d.

### 9.1 What changes
Delete cli files that only legacy used.

### 9.2 Procedure
Audit for dead-after-Phase-8:
- `cli/src/pipeline/state-machine.ts` (170 LOC) — was used by legacy; if v2 doesn't track stage state via this class, delete.
- `cli/src/pipeline/audit-log.ts` (116 LOC) — superseded by core-pipeline's `attachAuditLogHook`. Delete if no other consumer.
- `cli/src/pipeline/cost-tracker.ts` — superseded by core-pipeline's `attachCostTrackerHook`. Delete if no consumer.
- `cli/src/pipeline/parallel-runner.ts` (67 LOC) — superseded by `parallelism: 'per-repo'`. Delete if no other consumer.
- `cli/src/pipeline/display.ts` — replaced by audit-log + bus events. Delete if no consumer.
- `cli/src/pipeline/output-log.ts` — likewise.
- `cli/src/pipeline/state-file.ts` — keep only if dashboard-state hook still writes via this module; otherwise delete.
- `cli/src/pipeline/stages/*` — these are *step bodies* called by step adapters. Keep them; they're the work.

### 9.3 Acceptance
- [ ] Each deletion accompanied by `grep -r '<symbol>'` returning zero hits
- [ ] All cli tests green
- [ ] cli `wc -l src/pipeline` net delta vs pre-Phase-0: −800 to −1000 LOC

### 9.4 Risks
- **Test-only references** — a deleted module might be imported by a test. Mitigation: `tsc -b` catches it; delete the test if it was testing the deleted module.

### 9.5 Rollback
Revert Phase 9 commit. Phase 8 still holds; cli still works. Phase 9 is purely additional cleanup.

---

## Acceptance — overall

After Phase 9 lands:

- [ ] `cli/src/pipeline/orchestrator.ts` ≤ 350 LOC (was 1682)
- [ ] No file in cli or dashboard references `ANVIL_USE_NEW_PIPELINE`
- [ ] `commands/run-feature.ts` imports `runPipeline` from `cli/src/pipeline/orchestrator.ts` (unchanged)
- [ ] `EventBus.request()` + `respond()` documented in `core-pipeline/README.md`
- [ ] `Pipeline.run({resumeFromStep, completedSteps})` documented
- [ ] Branch-parity diff (Phase 7) recorded as the cutover acceptance gate
- [ ] All cli + dashboard + agent-core + core-pipeline tests green
- [ ] Net LOC delta (delete + lift): **−800 to −1000 LOC**

---

## Risks across the plan

| Risk | Severity | Mitigation |
|---|---|---|
| Step IO refactor (`ctx.shared`) breaks dashboard step adapters | Medium | Dashboard steps use simple I→O chains today; this plan does not touch them. Verify in Phase 3 before merging. |
| Approval-gate responder mismatch between cli + dashboard transports | Medium | Hook injects `getApprovalDecision`; each transport provides its own. Bus protocol is identical. |
| Resume-from-stage prior-artifact load drifts from legacy | Low | Phase 5 extracts the loader verbatim. Phase 7 parity diff catches drift. |
| Per-project fanout vs per-repo fanout name confusion | Low | Phase 6 picks one mode; existing `parallelism: 'per-repo'` is repurposed by populating `repoPaths` with project keys. |
| LLM nondeterminism in parity validation | Low | Recorded-response agent runner; same as today's cli tests. |
| Dashboard WS message regression | High | D10 invariant. Each phase that touches state-writes runs the dashboard test suite (636 tests); post-Phase-6, run the dashboard manually against a real cli pipeline. |

---

## Total effort + sequencing

| Phase | Effort | Cumulative | Independent? |
|---|---|---|---|
| 0 — Audit + ADR | 0.5d | 0.5d | yes |
| 1 — bus.request/respond | 0.5d | 1.0d | yes |
| 2 — resumeFromStep | 0.5d | 1.5d | yes (depends on 1 only for tests) |
| 3 — ctx.shared | 1.0d | 2.5d | yes |
| 4 — new hooks | 1.0d | 3.5d | depends on 1 |
| 5 — extract cli helpers | 1.0d | 4.5d | yes |
| 6 — feature-complete v2 | 1.5d | 6.0d | depends on 1–5 |
| 7 — parity validation | 0.5d | 6.5d | depends on 6 |
| 8 — delete legacy + flag | 0.5d | 7.0d | depends on 7 |
| 9 — clean up dead siblings | 0.5d | 7.5d | depends on 8 |

**Total: 7.5 engineer-days.**

Phases 1, 2, 3, 5 are mutually independent and can land in parallel PRs. Phase 4 depends on Phase 1. Phases 6–9 are strictly sequential.

For "one go" execution: a single long session can land Phase 0 → Phase 9 if uninterrupted, with the caveat that the parity validation (Phase 7) is the longest single wall-clock item if real LLM calls are involved (use recorded fixtures to keep it fast).

---

## Out of scope (explicitly deferred)

- Lifting cli's interactive ship-stage flow (PR review prompts, deploy confirmations) into bus.request — current ship step shells out via `pr-orchestrator.ts`, which is a separate consolidation.
- Replacing cli's `stages/*` step bodies with smaller composable steps — Phase 7 of the *original* dashboard consolidation tracked this; out of scope here.
- Migrating dashboard's pipeline-runner abstraction (already on core-pipeline; nothing to do).
- Cross-process resume (e.g., resuming a pipeline that crashed in another process). Per-call checkpoint cache (already shipped) covers re-running the same agent call deterministically; cross-process resume requires persistent shared state on the bus, which is its own design.
