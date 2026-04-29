# Core-pipeline Extraction — Architecture Decision Record

> Companion to [`CORE-PIPELINE-EXTRACT-PLAN.md`](./CORE-PIPELINE-EXTRACT-PLAN.md). Locks decisions P1–P10, persistence-site inventory, public API migration table, schema shapes, and per-phase commit log.
>
> **Status:** draft — locked at Phase 0.
> **Depends on:** `@anvil/agent-core` (shipped), `@anvil/memory-core` (shipped — hooks subscribe to pipeline events to feed the proposal queue + reflection).

---

## 1. Pre-flight reality check (verified 2026-04-29)

| Check | Result |
|---|---|
| `packages/cli/src/pipeline/orchestrator.ts` exists, **1,672 LOC** (plan said 2,089 — see deviations) | ✅ |
| 8 stages live under `cli/src/pipeline/stages/` | ✅ |
| `state-machine.ts:143-152` event emitter exists | ✅ — **`onEvent` listener never subscribed to** |
| `cli/src/memory/learners/index.ts` `autoLearnHook` exists | ✅ — **never called from orchestrator** |
| `audit-log.ts` writes JSONL | ✅ — `~/.anvil/runs/<runId>/audit.jsonl` |
| `state-file.ts` debounced 100ms | ✅ — `~/.anvil/state.json` |
| `custom-stage.ts` loads factory.yaml | ✅ — insertion-based hook |
| `packages/core-pipeline/` does NOT exist | ✅ — greenfield package |
| `CORE-PIPELINE-EXTRACT-ADR.md` does NOT exist | ✅ → this file |

**Plan deviation logged:** orchestrator.ts is **1,672 LOC**, not 2,089. The plan's number predated a recent refactor that already lifted some logic into `cli/src/pipeline/stages/{build,validate,ship}/`. The ratio "monolith vs everything else" is unchanged; the extraction approach is unaffected.

---

## 2. Decisions

### P1 — Module location
**Choice:** New workspace package `packages/core-pipeline/` (`@anvil/core-pipeline`). cli's `pipeline/` becomes a thin caller.
**Why:** Mirrors memory-core's extraction shape. Lets the dashboard + future tooling import the pipeline runner without depending on cli.

### P2 — Step contract
**Choice:** `Step<I, O>` interface with `id`, `run(ctx)`, optional `retryPolicy`, optional `subSteps`, optional `parallelism`. Replaces today's positional stage definitions.
**Why:** Typed I/O kills the `StageContext` god-object. `id` enables registry-based extension.

### P3 — Step registry
**Choice:** `StepRegistry` supports `register / insertBefore / insertAfter / replace / remove`. Order is by registration sequence + insert-relative ops.
**Why:** ID-based extension lets plugins compose without knowing the full pipeline shape. Matches Hapi.js plugin lifecycle.

### P4 — Event bus
**Choice:** Single in-process `EventBus` — extends today's `state-machine.ts` emitter. Strongly-typed events under `StepHookPoint` union.
**Why:** Async-aware (awaiting `emit`); back-pressure escape hatch via `emitFireAndForget`. In-process keeps the substrate decision aligned with memory-core (no broker).

### P5 — Auto-fix retry generalization
**Choice:** `Step.retryPolicy` for transient failures + `Step.subSteps` for child-step composition. validate's auto-fix loop becomes 4 sub-steps; failure retries just the relevant sub-step.
**Why:** Today's retry is hard-coded inline in validate. Generalizing means any future stage (security scan, mutation testing, contract tests) gets retry + sub-step composition for free.

### P6 — Custom-stage backwards compat
**Choice:** factory.yaml's `custom_stages:` block keeps working unchanged. New optional fields (`insertBefore`, `insertAfter`) for positioning.
**Why:** Users with existing factory.yaml files must not break.

### P7 — Durability scope
**Choice:** Pattern 1 only — audit-log + state-file granularity. Step-level durable replay (Pattern 2) is **out of scope**.
**Why:** Pattern 2 needs stable step boundaries; build them first via Pattern 1, then evaluate durability needs.

### P8 — Migration strategy
**Choice:** Strangler-fig — package shipped in parallel, stages ported one-by-one, orchestrator's if-tree shrinks until deleted in Phase 8. Feature flag `ANVIL_USE_NEW_PIPELINE` for staged rollout.
**Why:** Per-stage commits give clean bisect surface; flag lets users fall back during rollout.

### P9 — Auto-learner subscription
**Choice:** `autoLearnHook` becomes a default subscriber to `step:completed` events.
**Why:** Today it's dead code on the cli side. The bus is finally the place for it.

### P10 — Pub/sub scope
**Choice:** In-process only. Cross-process state still flows through the existing audit log + dashboard state file (no new broker).
**Why:** Anvil is a single-cli-process tool today. Adding a broker (Redis, NATS) violates the "no external services" axiom logged in memory-core's M1.

---

## 3. Persistence inventory

| Path | Purpose | Format | Phase |
|---|---|---|---|
| `~/.anvil/runs/<runId>/audit.jsonl` | Append-only event log (existing) | JSONL | reused (Phase 3 hook) |
| `~/.anvil/state.json` | Dashboard state snapshot (existing) | JSON, debounced | reused (Phase 3 hook) |
| `~/.anvil/runs/<runId>/artifacts/<artifactId>.json` | Step output artifacts | JSON | new in Phase 4 |
| `<workspace>/factory.yaml` | Custom stage config (existing) | YAML | reused (Phase 6) |
| In-memory only | EventBus, StepRegistry | per-process | Phase 1 |

---

## 4. Schema shapes

(Full TS in PLAN §5.) Highlights:

- `Step<I, O>` — typed I/O; replaces god-object `StageContext`
- `StepContext<I>` — explicit `runId / workspaceDir / repoPaths / input / artifacts / emit / bus / memory / llm / signal`
- `StepHookPoint` — union of 11 lifecycle events
- `PipelineEvent<P>` — bus payload
- `EventBus` — `on / emit / emitFireAndForget`
- `StepRegistry` — `register / insertBefore / insertAfter / replace / remove`

---

## 4a. Stage I/O snapshot (locked at Phase 0, the compatibility spec for Phase 5)

Each row captures what the stage **reads** from `StageContext` + prior stage outputs, and what it **writes** (returned `StageOutput.artifact*` + side effects).

| # | Stage | File | Reads | Writes |
|---|---|---|---|---|
| 0 | clarify | `stages/clarify.ts` | `ctx.{runDir,project,feature,agentRunner,projectYamlPath?,workspaceDir?,repoPaths?}` + `ClarifyOptions{skipClarify,answersFile?}` + dashboard `state.json` userMessages | `CLARIFICATION.md`; checkpoint(stage=0); `setPendingApproval(0)` + drains userMessages |
| 1 | requirements | `stages/high-level-requirements.ts` | `ctx.*` + `clarification: string` (Stage 0 artifact) | `HIGH-LEVEL-REQUIREMENTS.md`; **invariant:** must contain `## Success Criteria`; checkpoint(stage=1) |
| 2 | project-requirements | `stages/project-requirements.ts` | `ctx.*` + `highLevelReqs: string` + `project: {name, repos[]}` | `<project>-REQUIREMENTS.md`; checkpoint(stage=2, project) — **runs per project** |
| 3 | specs | `stages/project-specs.ts` | `ctx.*` + `projectRequirements: string` + `project: {name, repos[]}` | `<project>-SPEC.md`; checkpoint(stage=3, project) — **runs per project** |
| 4 | tasks | `stages/project-tasks.ts` | `ctx.*` + `projectSpec: string` + `project: {name, repos[]}` | `<project>-TASKS.md`; checkpoint(stage=4, project) — **runs per project** |
| 5 | build | `stages/build/index.ts` | `BuildStageConfig{runId,featureSlug,agentRunner,repoPaths,taskPlans[],projectPrompt}` | `BuildStageResult{branchName,repoResults[],pushResults[]}`; creates feature branches in repos; commits + pushes per task; **side-effects: git** |
| 6 | validate | `stages/validate/index.ts` | `repoPaths`, `languages`, `agentRunner`, `maxIterations` | `FixLoopResult{allPassed,iterations,repoResults[],fixHistory[],validationMd}` — **embedded auto-fix retry loop** (Phase 7 extracts as sub-steps) |
| 7 | ship | `stages/ship/index.ts` | `ShipStageConfig{project,runId,featureSlug,repoPaths,branchName,validationSummary,agentRunner,skipShip,cost?}` | `ShipStageResult{sandboxUrl?,smokeTestPassed,prInfos[],skipped}` — sandbox deploy + smoke test + PR creation |

**Common context surface every stage shares (today's `StageContext`):**
- `runDir` — `~/.anvil/runs/<runId>/`
- `project` — project name (single project today, multi-project via parallel-runner.ts)
- `feature` — feature slug
- `agentRunner` — `AgentRunner.run({persona, projectPrompt, userPrompt, workingDir, stage, model?, provider?})`
- `projectYamlPath?`, `conventionsPath?`, `workspaceDir?`, `repoPaths?` (optional)

**Common output surface (today's `StageOutput`):** `{artifact: string, artifactName: string, tokenEstimate: number}` for stages 0-4. Build/validate/ship return richer typed objects (build & ship are already partly extracted under `stages/<name>/index.ts`).

**Cross-cutting concerns inlined in orchestrator.ts (the things hooks will absorb in Phase 3):**
- audit JSONL writes (`audit-log.ts:appendAuditEvent`)
- dashboard state debounced writes (`state-file.ts:writeDashboardState`)
- cost tracking (`cost-tracker.ts`)
- learner trigger — **never called today** (`memory/learners/autoLearnHook` is dead code on the cli side)
- approval gate polling (between every stage)

---

## 5. External callers requiring migration (audit before Phase 8)

Verified at Phase 0 via `grep -rn 'runPipeline\b\|PipelineStateMachine\|stateMachine\.\|StageContext\|autoLearnHook'`:

| Caller | File | What it does today | Migration |
|---|---|---|---|
| `runPipeline` entry | `packages/cli/src/commands/run-feature.ts:298-301` | invokes `runPipeline(...)` from cli's `anvil run` command | unchanged signature; body delegates to `Pipeline.run()` |
| `runPipeline` re-export | `packages/cli/src/pipeline/index.ts:36` | barrel export | unchanged |
| `PipelineStateMachine` re-export | `packages/cli/src/pipeline/index.ts:19` | barrel export | unchanged; emitter becomes thin adapter over `EventBus` (Phase 2) |
| `PipelineStateMachine` instantiation | `packages/cli/src/pipeline/orchestrator.ts:743` (`new`) + 12× `stateMachine.{start,advance,fail,skip,getCurrentStage}` calls | controls stage progression + emits stage events | replaced by `Pipeline.run()` walker (Phase 3) |
| `autoLearnHook` (dead code) | `packages/cli/src/memory/learners/index.ts:17` | exists; never called from orchestrator | wired as default `step:completed` subscriber (Phase 3) |
| dashboard `autoLearn` | `packages/dashboard/server/pipeline-learner.ts` (called from `dashboard-server.ts:128`) | dashboard's own learner; reads dashboard events, not pipeline events | left alone; can subscribe to bus later if dashboard moves in-process |
| dashboard state reader | `packages/dashboard/server/dashboard-server.ts` | reads `~/.anvil/state.json` | no source change — file path/format preserved |

Migration: cli.ts → `runPipeline()` keeps its public signature; internal body delegates to `Pipeline.run()`. Dashboard subscribers continue to read the state file (P10 keeps pub/sub in-process only).

---

## 6. Per-phase commit log

Plan ships in 10 phases (0 through 9). Updated incrementally as phases land.

| Phase | Status | Commit | Deviations |
|---|---|---|---|
| 0 — Audit + decisions | shipped | 65d5b25 | orchestrator.ts is 1,672 LOC (plan said 2,089); ratio unchanged. Stage I/O snapshot added as §4a. |
| 1 — Scaffold `@anvil/core-pipeline` | shipped | a7a31dc | 4 scaffold tests; sister gates green (agent-core 152/152, memory-core 119/119, cli build) |
| 2 — EventBus wiring | shipped | 33017ee | 7 EventBus tests (priority + listener-throw isolation + fire-and-forget); cli state-machine `getBus()` accessor added; legacy `onEvent` API preserved unchanged |
| 3 — Hook subscribers (audit, dashboard, learners, cost) | pending | — | — |
| 4 — First stage as `Step` | pending | — | — |
| 5 — Port remaining 7 stages | pending | — | — |
| 6 — Custom-stage compat | pending | — | — |
| 7 — Sub-step generalization (auto-fix) | pending | — | — |
| 8 — Delete if-tree | pending | — | — |
| 9 — Tests + docs + ADR finalize | pending | — | — |
