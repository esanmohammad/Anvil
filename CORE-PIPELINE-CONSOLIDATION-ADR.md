# Core-Pipeline Consolidation ADR

> Decisions for the cli pipeline runtime consolidation. Companion to `CORE-PIPELINE-CONSOLIDATION-PLAN.md`. Locks D1–D11 before any code lands.
>
> **Status:** Phase 0 complete 2026-04-30. D1–D11 ratified.

---

## D1 — One pipeline-runtime surface, owned by `@anvil/core-pipeline`

After this consolidation lands, cli has zero bespoke orchestration code beyond step adapters and prep helpers. Dashboard already consumes `@anvil/core-pipeline` exclusively (verified Phase 0). cli's legacy 1682-LOC `runPipeline` if-tree is replaced by a ~300-LOC wrapper that calls `Pipeline.run()`.

**Why:** Two pipeline runners with inconsistent feature sets is the failure mode we are eliminating. The ANVIL_USE_NEW_PIPELINE flag exists *because* of this divergence; deleting it requires unifying behind the new path.

---

## D2 — `EventBus.request/respond` for human-in-the-loop

`EventBus` gains:
```ts
request<P, R>(channel: string, payload: P, opts?: { timeoutMs?: number }): Promise<R>;
respond<R>(channel: string, requestId: string, response: R): void;
```

cli wires a stdin readline responder for clarify Q&A and approval gates; dashboard wires a WebSocket responder. Same wire (`bus.request('approval:gate', ...)` from a step), different transport.

**Why:** The legacy if-tree calls `await waitForApproval(stageIndex)` inline, which hardcodes the state-file polling transport. A bus primitive lets the *step* declare its need for an answer and the *consumer* (cli/dashboard) decide how to source it.

**Default timeout:** 30 minutes (matches legacy `waitForApproval`).

---

## D3 — `Pipeline.run({ resumeFromStep, completedSteps })`

`PipelineDeps` gains two optional fields:
- `resumeFromStep?: string` — refuses to run any registry step before this step ID.
- `completedSteps?: string[]` — populates the artifact cache from prior runs; matching steps emit `step:skipped` and are not invoked.

**Why:** Legacy supports `--resume-from-stage 3 --feature-slug my-thing` to skip stages 0–2 and load their artifacts. v2 has no equivalent today. Adding to the walker (not the cli wrapper) means dashboard gains it too.

**Skipped step emits:** new hook point `step:skipped` in `StepHookPoint`. Hooks (audit, dashboard-state, run-store) update their own state on this event.

---

## D4 — `ctx.shared` step IO

`StepContext` gains `shared: Record<string, unknown>` — a mutable shared-state record threaded through every step in a run.

cli defines a typed `CliPipelineState` interface (project, feature, featureSlug, runId, repoPaths, workspaceDir, projectYamlPath, agentRunner, memoryStore, costTracker, affectedProjects, projectArtifacts) and casts at the boundary.

**Why:** The existing v2 step adapters' `Input` shapes are unreachable: the walker threads the *prior step's output* as `ctx.input`, but most cli steps need broader cross-stage context (project name, agent runner, run dir). Solutions considered:

1. ❌ **Make every step's output a superset of the next step's input** — forces every step to carry the full pipeline state through its return value; brittle and verbose.
2. ❌ **Use the artifact store** — artifacts are write-once; pipeline-state is mutable (cost accumulates, etc.).
3. ✅ **Add `ctx.shared`** — explicit, typed, no name collisions with `ctx.input`. Minimal core-pipeline surface change.

Dashboard's existing step adapters use simple I→O chains and don't need `ctx.shared` — their input shapes already line up. Phase 3 verifies dashboard tests stay green.

---

## D5 — Cross-cutting concerns become hooks

Three new hooks attach to the bus alongside the existing audit/cost/learners/dashboard-state hooks:

| Hook | Listens for | Action |
|---|---|---|
| `attachRunStoreHook(bus, { runStore, runId })` | `pipeline:started`, `step:started`, `step:completed`, `step:failed`, `pipeline:completed`, `pipeline:failed`, `step:skipped` | Updates `RunStore` record |
| `attachFeatureStoreHook(bus, { featureDir })` | `artifact:emitted` | Writes known artifact ids (`CLARIFICATION.md`, `REQUIREMENTS.md`, etc.) to `~/.anvil/features/<project>/<slug>/` |
| `attachApprovalGateHook(bus, { getApprovalDecision })` | `request:approval:gate` | Calls injected decision function, responds via `bus.respond()` |

**Why:** Legacy interleaves these concerns into every stage's body (~10 LOC × 8 stages = 80 LOC of duplication). Hooks subscribe once.

**Approval-gate hook contract:** `getApprovalDecision: (stageIndex: number) => Promise<'approved'|'rejected'>` is injected by the caller. cli provides a state-file-poll responder (matches legacy behavior); dashboard provides a WebSocket-driven responder.

---

## D6 — No feature flags

`ANVIL_USE_NEW_PIPELINE` and `isNewPipelineEnabled()` are deleted in Phase 8. Same rule as the dashboard consolidation series and the agent-manager consolidation. Branch-parity diff (D9) replaces flag-gated rollout.

**Why:** Flag-gated rollouts split user behavior. The dashboard consolidation taught us that a single PR with a clean cutover + parity diff is safer than a long-lived flag — the flag becomes the bug surface.

---

## D7 — No new package

All consolidation lands in existing `@anvil/core-pipeline` and `@anvil/cli`. No `@anvil/pipeline-helpers` or similar. The bus primitives, walker option, and three new hooks all fit in `@anvil/core-pipeline`. The cli helpers (persona prompt, feature branches, post-build guards, feature store, approval gate, notifications) all live in `@anvil/cli/pipeline/`.

**Why:** Adding a package is a bigger commitment than the value justifies. Both layers (core-pipeline + cli) already exist with stable surfaces.

---

## D8 — `runPipeline` import path unchanged

`commands/run-feature.ts` line 4 stays as `import { runPipeline } from '../pipeline/orchestrator.js'`. Phase 8 deletes the legacy `orchestrator.ts` and renames `orchestrator-v2.ts` → `orchestrator.ts` so the import resolves to the new implementation.

`OrchestratorConfig` and `OrchestratorResult` types are re-exported from `cli/src/pipeline/index.ts`. The internals change; the surface that callers see does not.

**Why:** Avoid touching unrelated call sites. Single PR, single file rename.

---

## D9 — Branch-parity diff replaces flag-gated rollout

Before deleting legacy (Phase 8), Phase 7 runs five representative pipelines on both code paths (legacy + new) and diffs:

- `~/.anvil/runs/<runId>/audit.jsonl` — equal modulo timestamps
- `~/.anvil/state.json` — post-run snapshot equal
- `~/.anvil/features/<project>/<slug>/*.md` — equal modulo whitespace
- Cost totals — equal within 0.1%

If parity holds, delete legacy. If not, fix the divergence inside Phase 6 before merging.

**Five fixtures:**

1. `small-feature` — single-repo, no clarify, no approval, no resume
2. `multi-repo` — three repos, parallel-per-project stages
3. `resumed-from-stage-3` — load prior artifacts, skip stages 0–2
4. `approval-gated` — `approvalRequired: true`, exercise approval gate at each stage
5. `ship-with-deploy` — full pipeline through ship + sandbox deploy

**Why:** A naked cutover is too risky on a 1682-LOC delete. Parity diff is empirical proof of behavior preservation; if a divergence shows, it's localized and fixable before the legacy is gone.

---

## D10 — On-disk + WS protocol invariant

Public on-disk artifact paths and the dashboard's WebSocket protocol stay unchanged through this consolidation.

**Paths preserved:**
- `~/.anvil/runs/<runId>/audit.jsonl`
- `~/.anvil/features/<project>/<slug>/{CLARIFICATION,REQUIREMENTS,...}.md`
- `~/.anvil/state.json` (with `pendingApproval` field for approval gate)

**WS protocol preserved:** all 133 dashboard message types keep their existing payload shapes. Same invariant as the dashboard consolidation series — re-asserted here because Phase 4 changes who *writes* the state file (was: legacy orchestrator inline, now: `attachApprovalGateHook` + `attachDashboardStateHook`).

**Why:** External integrations (`anvil resume`, dashboard WS clients, third-party tools reading the audit log) treat these paths as a public contract. Changing them is a major version bump; not worth coupling to this consolidation.

---

## D11 — `OrchestratorConfig` / `OrchestratorResult` types stay

The two public types from cli's pipeline (`OrchestratorConfig`, `OrchestratorResult`) keep their shapes. New `runPipeline` accepts the same config and returns the same result.

**Why:** `commands/run-feature.ts:298–301` constructs an `OrchestratorConfig` and reads an `OrchestratorResult`. Changing those shapes touches command-layer code unrelated to this consolidation.

---

## Call-graph inventory (verified 2026-04-30)

### Production callers of `runPipeline`

| Site | Line | Usage |
|---|---|---|
| `cli/src/commands/run-feature.ts` | 4 | `import { runPipeline }` |
| `cli/src/commands/run-feature.ts` | 298–301 | `result = await runPipeline(config, deps)` |
| `cli/src/pipeline/index.ts` | 36 | `export { runPipeline } from './orchestrator.js'` |

After consolidation: line 4 + 36 unchanged (D8). Line 298–301 unchanged.

### Dispatch site — to be deleted

| Site | Line | Usage |
|---|---|---|
| `cli/src/pipeline/orchestrator.ts` | 729–733 | Imports `isNewPipelineEnabled`, dispatches to `runPipelineV2` if env flag is set |

After Phase 8: deleted along with the rest of `orchestrator.ts`.

### Helpers internal to legacy `orchestrator.ts` (extracted in Phase 5)

| Function | Line range | LOC | Target home |
|---|---|---|---|
| `injectTemplateVars` | 155–161 | 7 | `cli/src/pipeline/persona-prompt.ts` (private) |
| `parseQuestions` | 174–194 | 21 | `cli/src/pipeline/persona-prompt.ts` (private) |
| `askUser` | 199–207 | 9 | `cli/src/pipeline/persona-prompt.ts` (private) |
| `fileExistsIn` | 213–219 | 7 | `cli/src/pipeline/post-build-guards.ts` (private) |
| `runSilent` | 221–229 | 9 | `cli/src/pipeline/post-build-guards.ts` (private) |
| `loadRepoCommandsFromConfig` | 235–281 | 47 | `cli/src/pipeline/post-build-guards.ts` (private) |
| `loadPipelineDeployCmd` | 287–313 | 27 | `cli/src/pipeline/feature-store.ts` (private — only used by ship stage) |
| `sendPipelineNotification` | 319–333 | 15 | `cli/src/pipeline/notifications.ts` (exported) |
| `formatDuration` | 335–340 | 6 | `cli/src/pipeline/notifications.ts` (private) |
| `runPostBuildGuards` | 347–406 | 60 | `cli/src/pipeline/post-build-guards.ts` (exported) |
| `createFeatureBranches` | 412–439 | 28 | `cli/src/pipeline/feature-branches.ts` (exported) |
| `hasValidationFailures` | 445–450 | 6 | `cli/src/pipeline/post-build-guards.ts` (private) |
| `buildPersonaProjectPrompt` | 456–670 | 215 | `cli/src/pipeline/persona-prompt.ts` (exported) |
| `waitForApproval` | 673–705 | 33 | `cli/src/pipeline/approval-gate.ts` (exported as `getApprovalDecision`) |

Total extracted: **490 LOC** to ~6 standalone modules.

### Cross-cutting concerns to become core-pipeline hooks (Phase 4)

| Concern | Inline location | Target hook | New file |
|---|---|---|---|
| Run record state-machine | `orchestrator.ts:747–749, 1024, 1065, 1126, 1168, 1210, 1274, 1371, ...` (per-stage `updateStageRecord`) | `attachRunStoreHook` | `core-pipeline/src/hooks/run-store.hook.ts` |
| Feature-dir artifact persistence | `orchestrator.ts:1457–1469 (ship stage)` + per-stage feature-store writes (lines 924–940 for resume) | `attachFeatureStoreHook` | `core-pipeline/src/hooks/feature-store.hook.ts` |
| Approval gate | `orchestrator.ts:1029, 1070, 1131, 1173, 1215, 1279, 1376` (per-stage `waitForApproval` call) | `attachApprovalGateHook` | `core-pipeline/src/hooks/approval-gate.hook.ts` |
| Audit log | `orchestrator.ts:764-766, 1028, ...` (`AuditLog`) | `attachAuditLogHook` (already exists) | unchanged |
| Cost tracker | `orchestrator.ts:754, addStageCost calls` | `attachCostTrackerHook` (already exists) | unchanged |
| Dashboard state writes | `orchestrator.ts:776-794, updatePipelineStage, etc.` | `attachDashboardStateHook` (already exists) | unchanged |

### Step adapter input-shape audit (D4 mitigation in Phase 3)

| Step | Current Input fields | After: `ctx.shared` keys read | After: `ctx.input` shape |
|---|---|---|---|
| `clarify` | project, feature, agentRunner, runDir, projectYamlPath?, conventionsPath?, skipClarify?, answersFile? | All except clarify-specific opts | `{ skipClarify?, answersFile? }` |
| `requirements` | project, feature, agentRunner, runDir, projectYamlPath?, conventionsPath?, clarification | All except clarification | `{ clarification }` (from prior step) |
| `project-requirements` | (similar) | All except project-tasks-related | `{ highLevelRequirements }` |
| `specs` | (similar) | All | `{ requirements }` |
| `tasks` | (similar) | All | `{ specs }` |
| `build` | runId, featureSlug, agentRunner, repoPaths, taskPlans, projectPrompt | All | `{ taskPlans }` |
| `validate` | repoPaths, languages, agentRunner, maxIterations? | All | `{}` |
| `ship` | (similar) | All | `{}` |

After Phase 3, each step's `Input` shape contains only step-specific data; everything else moves to `ctx.shared`.

### Files to delete in Phase 8

| File | LOC | Reason |
|---|---|---|
| `cli/src/pipeline/orchestrator.ts` | 1682 | Replaced by `orchestrator-v2.ts` (renamed) |
| `cli/src/pipeline/steps/index.ts:isNewPipelineEnabled` | 8 | No longer needed |

### Files to audit for deletion in Phase 9

| File | LOC | Status |
|---|---|---|
| `cli/src/pipeline/state-machine.ts` | 170 | Used only by legacy orchestrator's `PipelineStateMachine` calls |
| `cli/src/pipeline/audit-log.ts` | 116 | Used only by legacy; superseded by `attachAuditLogHook` |
| `cli/src/pipeline/cost-tracker.ts` | ? | Used only by legacy; superseded by `attachCostTrackerHook` |
| `cli/src/pipeline/parallel-runner.ts` | 67 | Used only by legacy; superseded by `parallelism: 'per-repo'` |
| `cli/src/pipeline/display.ts` | ? | Used only by legacy |
| `cli/src/pipeline/output-log.ts` | ? | Used only by legacy |
| `cli/src/pipeline/state-file.ts` | 214 | Keep — dashboard-state hook still writes via this (or migrate it into the hook) |

Phase 9 verifies each deletion with `grep -r '<symbol>'` returning zero hits beyond the deleted module's own tests.

---

## Schema mapping: legacy locals → `CliPipelineState`

| Legacy local (orchestrator.ts) | Approx line | New `ctx.shared.<key>` |
|---|---|---|
| `config.project` | 102 | `project` |
| `config.feature` | 103 | `feature` |
| `config.featureSlug ?? generateFeatureSlug(...)` | 117, 737 | `featureSlug` |
| `runId` | 736 | `runId` |
| `workspaceDir` | 815–845 | `workspaceDir` |
| `repoPaths` | 849–855 | `repoPaths` |
| `repoNames` | 877 | `repoNames` |
| `projectYamlPath` | 858–865 | `projectYamlPath` |
| `agentRunner` | 798 | `agentRunner` |
| `memoryStore` | 744 | `memoryStore` |
| `costTracker` | 754 | `costTracker` |
| `runStore` | 741 | `runStore` |
| `affectedProjects` | 896, 1092 | `affectedProjects` |
| `projectReqsMap`, `projectSpecsMap`, `projectTasksMap` | 893–895 | `projectArtifacts: { reqs, specs, tasks }` |
| `clarificationArtifact`, `highLevelReqsArtifact` | 891–892 | passed via `ctx.input` (chained step output) |
| `config.approvalRequired` | 113 | `approvalRequired` |
| `config.actionType` | 113 | `actionType` |
| `config.deploy` | 107 | `deploy` |
| `config.failureContext` | 119 | `failureContext` |

---

## Phase 0 acceptance — recorded

- [x] D1–D11 ratified (this document)
- [x] Call-graph inventory complete (above table)
- [x] `CliPipelineState` field-mapping table complete (above table)
- [x] Branch-parity test plan in `CORE-PIPELINE-CONSOLIDATION-PLAN.md` §Phase 7
- [x] Baseline tsc green (0 errors)
- [x] Baseline core-pipeline tests green (47/47)

Phase 1 unblocks.
