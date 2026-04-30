# Agent Manager Consolidation — Architecture Decision Record

> Companion to [`AGENT-MANAGER-CONSOLIDATION-PLAN.md`](./AGENT-MANAGER-CONSOLIDATION-PLAN.md). Locks decisions D1–D11, parallel-impl inventory, schema-shape mapping, and per-phase commit log.
>
> **Status:** draft — locked at Phase 0 (2026-04-30).
> **Depends on:** `@anvil/agent-core` (shipped through agent-core extract Phase 10), the dashboard consolidation series Phase 1–6 (already merged).

---

## 1. Pre-flight reality check (verified 2026-04-30)

| Check | Result |
|---|---|
| `dashboard/server/agent-manager.ts` exists, **444 LOC** — stateful, multi-agent, `sendInput`-via-resume, EventEmitter, cost+checkpoint hooks | ✅ |
| `dashboard/server/agent-process.ts` exists, **120 LOC** — adapter-event-pipe (initial spawn or resume) | ✅ |
| `dashboard/server/agent-runner-wrapper.ts` exists, **189 LOC** — `runWithCheckpoint()` SIGTERM-safe gate | ✅ |
| `dashboard/server/checkpoint-store.ts` exists, **387 LOC** — per-call cache | ✅ |
| `dashboard/server/checkpoint-blob-store.ts` exists, **144 LOC** — blob storage | ✅ |
| `dashboard/server/checkpoint-key.ts` + `checkpoint-types.ts` exist, **~125 LOC combined** | ✅ |
| `agent-core/src/agent/agent-manager.ts` exists, **125 LOC** — `runAgent(): Promise<AgentResult>` single-shot, no session-resume | ✅ |
| `agent-core/src/agent/{spawn,stream-parser,output-buffer,timeout-guard,restart-policy,stage-validator}.ts` — supporting machinery | ✅ |
| **Two `AgentManager` classes** with the same name, different shapes (dashboard = stateful multi-agent; agent-core = single-shot) | ✅ |
| **Production callers** of agent-core's `AgentManager.runAgent()` | ❌ — **zero**; only `agent-core/src/__tests__/runAgent.test.ts` exercises it |
| `agent-core/src/headless/runner.ts:40 runAgent()` — separate tool-call-loop entry point operating on `LanguageModel` + `AgentTask` | ✅ — orthogonal to the `AgentManager` lift; not in scope for this consolidation |
| Dashboard imports `AgentManager` / `AgentProcess` from local files | ✅ — 7 dashboard sources + 5 test files |
| Dashboard already imports from `@anvil/agent-core` for adapters / `ProviderRegistry` / `SpendLedger` (after dashboard consolidation Phase 1+3) | ✅ |
| `cli/src/commands/diff.ts:300` defines its own local `runAgent()` helper (spawns CLI binary directly via `child_process.spawn`) — does NOT use either `AgentManager` | ✅ |
| `cli/src/commands/run-feature.ts:14` imports `ProviderRegistry` from `@anvil/agent-core` — does NOT use `AgentManager` | ✅ |
| `~/.anvil/checkpoints/<project>/<runFamily>/` writer is dashboard-owned today | ✅ |

**Coupling shape today:**
- The dashboard's `AgentManager` is the **superset** (spawn → state-tracking → sendInput-via-resume → kill, with EventEmitter + cost/checkpoint hooks). agent-core's `AgentManager` is a strict subset (single-shot, returns `AgentResult`).
- agent-core's `AgentManager` has **no production consumers** as of 2026-04-30. The cli-side `runAgent` invocations on `commands/diff.ts:300` are a local helper; `commands/run-feature.ts` only consumes `ProviderRegistry`. The class survives in the package as a published export and through `runAgent.test.ts` coverage.
- The per-call checkpoint cache (`runWithCheckpoint` + `CheckpointStore` + `BlobStore` = ~720 LOC) is dashboard-owned. cli does not benefit from it. No persistence-layout reason for it to live in dashboard rather than agent-core — it's storage-agnostic, only the writer is local.
- `AgentProcess` (the event-pipe wrapper around adapter instances) is unique to dashboard and lives between `AgentManager.spawn()` and the agent-core adapter family. Phase 1 of the dashboard consolidation already replaced its inner adapter resolution with agent-core's `LanguageModel` bridge.

**Total in-scope LOC** to relocate: **~1,409 LOC** across 7 dashboard files; agent-core's own `AgentManager` (125 LOC) shrinks to a 30-LOC convenience wrapper. Net repo delta after Phase 6: **−~200 LOC** with one canonical agent runtime instead of two.

---

## 2. Decisions

### D1 — One agent-lifecycle surface, owned by `@anvil/agent-core`
**Choice:** A single agent-runtime implementation lives in `@anvil/agent-core`. Both the dashboard and the cli orchestrator consume it. No code duplicates the lifecycle state machine after this plan lands.
**Why:** the user's stated goal is to make dashboard and cli equal consumers of agent-core. Two AgentManager classes with the same name and overlapping responsibilities is a maintenance liability — every change needs to be considered for both, and behavior drift is inevitable.
**How to apply:** lift dashboard's superset surface; collapse agent-core's existing single-shot `AgentManager` into a thin wrapper. Phase 4 deletes dashboard's local copy; Phase 5 migrates cli (where it has callers).

### D2 — Surface shape: `AgentManager` + `AgentProcess` (agent-core canonical)
**Choice:** Two public classes in agent-core, claiming the canonical names:
- `AgentProcess` — one logical agent. EventEmitter. Owns the spawn → resume → resume → done lifecycle. Supports `sendInput(text)` for in-session resume. 5-event surface (`content`, `activity`, `result`, `error-output`, `exit`).
- `AgentManager` — `Map<id, AgentProcess>` with `spawn(config)` / `getAgent(id)` / `kill(id)` / `killAll()` / `setCostHook(hook)` / `setCheckpointHook(hook)`. 4-event surface (`agent-output`, `agent-activity`, `agent-done`, `agent-error`).
**Why:** dashboard pre-Phase-4 had this exact shape working. agent-core had a stub single-shot `AgentManager` class that was never wired up by any production caller — deleting it (Deferred #1 cleanup) frees the canonical name for the lifted stateful version. Result: `import { AgentManager } from '@anvil/agent-core'` is the expected ergonomic, no aliasing.
**How to apply:** dashboard's local `agent-manager.ts` and `agent-process.ts` are deleted. Direct imports from `@anvil/agent-core` everywhere. The pre-existing single-shot `AgentManager` class + 7 supporting files (spawn, stream-parser, output-buffer, restart-policy, timeout-guard, stage-validator, types) are deleted as dead code (zero callers, zero tests, leftover from an earlier extract).

### D3 — Per-call checkpoint cache moves verbatim
**Choice:** `runWithCheckpoint` + `CheckpointStore` + `BlobStore` + `checkpoint-key` + `CheckpointInputs/Record` move to `packages/agent-core/src/checkpoint/`. Public API unchanged. `~/.anvil/checkpoints/` storage layout unchanged. Dashboard re-exports from agent-core for one minor release for backwards compat.
**Why:** the cache is storage-agnostic — only the writer is currently dashboard-local. Lifting it gives cli free retry-deduplication on the same prompt+model+stage combo, and unifies the on-disk schema across consumers. Verbatim move minimizes risk.
**How to apply:** Phase 3 lands as a code move with import-path updates in dashboard; behavior + tests are unchanged. Re-exports drop in Phase 6.

### D4 — `AgentProcess` owns adapter event wiring directly
**Choice:** The lifted `AgentProcess` class (in agent-core) owns the adapter-event-pipe pattern itself — no separate "process" wrapper. Dashboard's pre-Phase-4 `AgentProcess` (a thin EventEmitter that pipes adapter events through to its parent `AgentManager`) is merged into the new `AgentProcess`'s constructor + private `wireAdapter()` method.
**Why:** the wrapper existed in dashboard only because `AgentManager` was added later as an outer layer. With one canonical class owning both the spawn lifecycle AND the adapter event-piping, the indirection adds nothing.
**How to apply:** dashboard's local `agent-process.ts` is deleted. Code lives in `agent-core/src/agent/session/session.ts`.

### D5 — Session-resume contract
**Choice:** `AgentProcess.sendInput(text)` spawns a new adapter instance with `{ resume: true, sessionId, model }` and re-wires events through the same `AgentProcess` emitter. Adapters whose `LanguageModel.capabilities.sessionResume === false` reject `sendInput` synchronously with a typed `SessionResumeNotSupportedError`. Same shape as the pre-Phase-4 dashboard behavior.
**Why:** session-resume-via-respawn is the only working pattern across all 7 adapters today (Claude CLI uses `--resume <session>`; Gemini CLI uses different flags but the spawn-fresh model is identical). A native multi-turn API in agent-core would be cleaner long-term but requires changes to every adapter — out of scope.
**How to apply:** `AgentProcess.sendInput()` body lifts the dashboard's `AgentManager.sendInput()` semantics. Capability check moves to the top.

### D6 — agent-core's existing `AgentManager` becomes a thin wrapper
**Choice (revised in Deferred #1 cleanup):** `agent-core/src/agent/agent-manager.ts` (the legacy single-shot 125-LOC class) is **deleted**, freeing the canonical `AgentManager` name for the lifted stateful class. The legacy class had zero production callers and zero test coverage — leftover from an earlier extract phase that never got wired up. Its 7 supporting files (`spawn`, `stream-parser`, `output-buffer`, `restart-policy`, `timeout-guard`, `stage-validator`, `types`) are deleted alongside (~640 LOC of dead code). The `runAgent.test.ts` suite covers a different `runAgent` (the headless tool-loop runner at `headless/runner.ts`), which is untouched.
**Why:** the original plan called for shrinking the legacy class to a wrapper. Honest audit revealed it had no callers — wrapping nothing buys nothing. Deletion is cleaner and frees the canonical name for the new stateful surface.
**How to apply:** delete the 8 files; trim the `agent/index.ts` barrel to just re-export `./session/`. Existing test suite continues to pass (the headless `runAgent` in `__tests__/runAgent.test.ts` is unrelated).

### D7 — cli orchestrator migrates once
**Choice:** cli's existing per-stage agent calls (currently direct adapter calls via the LLM router) migrate to `AgentManager.spawn(config)`. cli runs gain free per-call checkpoint caching as a behavior change. The cli's `commands/diff.ts:300 runAgent()` local helper now wraps with `runWithCheckpoint` from agent-core (Phase 5).
**Why:** without this, cli stays a non-consumer of the new surface and the consolidation is dashboard-only. The user explicitly asked for both consumers to use agent-core; cli migration is the cost.
**How to apply:** Phase 5 inventories every cli site, migrates atomically. Cache-hit smoke test added to CI to prove cli benefits.

### D8 — No feature flags
**Choice:** Each phase is a full cutover. Legacy code is deleted in the same PR that lands the replacement. Phases are still sequential and independently revertable.
**Why:** matches the dashboard consolidation series convention (D8 in the dashboard ADR). Flag plumbing adds code that gets deleted anyway and obscures parity issues that only surface when the legacy fallback is gone.
**How to apply:** branch-level QA replaces flag-gated production parallel-running. Before each merge: parity diff on a fixture run.

### D9 — No new shared package
**Choice:** Everything lands in existing `@anvil/agent-core`. No `@anvil/agent-runtime` or similar.
**Why:** the surface is small and tightly coupled to agent-core's adapter family + LLM router. A separate package would re-create the dependency cycle.

### D10 — WebSocket protocol invariant
**Choice:** The dashboard's 133 WebSocket message types keep their existing payload shapes through this migration. Same invariant as the dashboard consolidation series (D10).
**Why:** dashboard's React client + any third-party consumers depend on the protocol. Phase 4 is the riskiest phase here because it touches every dashboard agent-spawn site; D10 is re-asserted to make sure nothing slips.
**How to apply:** before merging Phase 4, run a fixture pipeline through the dashboard on the release-branch HEAD AND on the same-base from `main`; diff the WebSocket transcript byte-for-byte (modulo timestamps + costs). Hold the merge until the diff is empty.

### D11 — Checkpoint persistence layout unchanged
**Choice:** `~/.anvil/checkpoints/<project>/<runFamily>/` paths and on-disk format stay identical. Only the writer's owning module changes (dashboard → agent-core).
**Why:** existing on-disk artifacts must remain readable through the migration. Dashboard restart after the cutover should pick up checkpoints written before the cutover.
**How to apply:** Phase 3 adds a cross-package read/write parity test that writes a checkpoint via agent-core's new path and reads it via dashboard's re-export shim, asserting identical `CheckpointRecord` shape.

---

## 3. Call-graph inventory (verified 2026-04-30)

### 3.1 Dashboard `AgentManager` consumers

| Site | Type | Operation |
|---|---|---|
| `dashboard-server.ts:806` | construction | `const agentManager = new AgentManager()` — singleton wired into the WebSocket server |
| `pipeline-runner.ts:407` | field type | `private agentManager: AgentManager` |
| `pipeline-runner.ts:983` | call | `this.agentManager.sendInput(agentId, text)` (provideInput fallback) |
| `pipeline-runner.ts:993, 995` | call | `this.agentManager.kill(stage.agentId)` / `this.agentManager.kill(repo.agentId)` |
| `steps/agent-spawner.ts:19` | type-only import | `AgentManager`, `SpawnConfig` |
| `steps/per-repo-stage.step.ts:27` | type-only import | `AgentManager` |
| `steps/per-repo-build.step.ts:27` | type-only import | `AgentManager` |
| `steps/clarify-stage.step.ts:38` | type-only import | `AgentManager` |
| `steps/fix-loop.step.ts:24` | type-only import | `AgentManager` |
| `__tests__/agent-spawner.test.ts:16` | test type | `AgentManager`, `AgentState`, `SpawnConfig` |
| `__tests__/per-repo-stage-step.test.ts:29` | test type | (same) |
| `__tests__/per-repo-build-step.test.ts:31` | test type | (same) |
| `__tests__/clarify-stage-step.test.ts:25` | test type | (same) |
| `__tests__/fix-loop-step.test.ts:18` | test type | (same) |

**Surface used by callers:** `spawn(SpawnConfig)`, `getAgent(id)`, `sendInput(id, text)`, `kill(id)`, `killAll()`, `setCostHook(hook)`, `setCheckpointHook(hook)`, EventEmitter `on('agent-output' | 'agent-activity' | 'agent-done' | 'agent-error', ...)`.

### 3.2 Dashboard `AgentProcess` consumers

| Site | Type | Operation |
|---|---|---|
| `agent-manager.ts:232` | construction | `new AgentProcess({...})` (initial spawn, internal) |
| `agent-manager.ts:273` | construction | `new AgentProcess({..., resume: true})` (sendInput, internal) |

**No external consumers.** `AgentProcess` is fully internal to `agent-manager.ts` — D4 collapses it cleanly.

### 3.3 Checkpoint-cache consumers

| Site | Type | Operation |
|---|---|---|
| `dashboard-server.ts:828` | construction | `new BlobStore(ANVIL_HOME)` |
| `dashboard-server.ts:829` | construction | `new CheckpointStore({ anvilHome: ANVIL_HOME, blobStore })` |
| `agent-manager.ts:165` (via `setCheckpointHook`) | hook | `checkpointHook.lookup(...)` (called from `spawn()`) |
| `__tests__/checkpoint-{store,blob-store,key}.test.ts` | test exercise | full suite |
| `__tests__/agent-runner-wrapper.test.ts` | test exercise | `runWithCheckpoint` integration |

**Surface used:** `runWithCheckpoint(store, blobs, opts)`, `CheckpointStore.{begin,complete,fail,interrupt,get}`, `BlobStore.{put,get,exists}`, `computeKey(inputs)`.

### 3.4 agent-core `AgentManager` consumers

| Site | Type | Operation |
|---|---|---|
| `agent-core/src/__tests__/runAgent.test.ts` (10 sites) | test exercise | `new AgentManager(spawnFn).runAgent(config)` |

**Production callers: zero.** The `AgentManager` class survives in agent-core as a published export but no production code path constructs it. This validates D1's assertion that agent-core's existing surface can be reclaimed without breaking external behavior.

### 3.5 cli AgentManager / runAgent consumers

| Site | Operation |
|---|---|
| `cli/src/commands/diff.ts:300` | local function `runAgent(projectPrompt, userPrompt)` — `child_process.spawn(getAgentBinary(), ['-p', userPrompt, ...])` — direct CLI invocation, does NOT use either `AgentManager` |
| `cli/src/commands/run-feature.ts:14` | imports only `ProviderRegistry` from agent-core; does NOT use `AgentManager` |

**No cli code currently consumes either `AgentManager` class.** Phase 5's cli migration is therefore: (a) replace `commands/diff.ts:300`'s local `runAgent` with the new agent-core wrapper; (b) audit `run-feature.ts` for any agent-spawn paths that should also migrate.

### 3.6 agent-core `headless/runner.ts:runAgent` — out of scope

| Site | Operation |
|---|---|
| `agent-core/src/headless/runner.ts:40` | `runAgent(task: AgentTask, workspace: WorkspaceConfig, options: RunAgentOptions): Promise<AgentTrajectory>` — tool-call loop over a `LanguageModel` |

This is a **different abstraction** (newer, post-extract; LanguageModel-native; produces `AgentTrajectory` for Inspect-AI compatibility). It is unrelated to the `AgentManager` lifecycle being lifted here. Out of scope for this consolidation; ADR appendix E sketches a possible future unification.

---

## 4. Schema-shape mapping (`SpawnConfig` unification)

`SpawnConfig` is the canonical agent-launch shape — the name comes from the dashboard's pre-Phase-4 type, retained because it's what the consumer code already used. Field mapping:

| `SpawnConfig` field | Dashboard `SpawnConfig` (pre-Phase-4) | agent-core legacy `AgentProcessConfig` (deleted) | Notes |
|---|---|---|---|
| `name: string` | `name` | derived from `args[0]` | dashboard convention; cli synthesizes |
| `persona: string` | `persona` | derived from `stage` | dashboard convention; cli synthesizes from stage name |
| `project: string` | `project` | (none) | dashboard sets; cli passes empty string |
| `stage: string` | `stage` | `stage` | both sides have this |
| `prompt: string` | `prompt` | (passed via `args[]`) | unify on `prompt`; cli wrapper expands to `args` |
| `model: string` | `model` | (none) | dashboard explicit; cli uses adapter default |
| `cwd: string` | `cwd` | `workingDir` | **rename:** canonical = `cwd` |
| `projectPrompt?: string` | `projectPrompt` | `projectPrompt` | both sides have this |
| `permissionMode?: string` | `permissionMode` | `args[]` flag | unify on `permissionMode` |
| `disallowedTools?: string[]` | `disallowedTools` | `args[]` flag | unify on `disallowedTools` |
| `allowedTools?: string[]` | `allowedTools` | `args[]` flag | unify on `allowedTools` |
| `maxOutputTokens?: number` | `maxOutputTokens` | (none today) | dashboard-only; cli ignores |
| `runId?: string` | `runId` | (none) | dashboard for cost grouping |
| `runFamily?: string` | `runFamily` | (none) | dashboard for checkpoint cache |
| `restart?: { maxAttempts: number }` | (none) | `maxRestarts` | unify; dashboard sets `0` |
| `timeoutMs?: number` | (none) | `timeout` | unify; dashboard sets `0` (no timeout) |
| `binaryPath?: string` | (none, env-derived) | `binaryPath` | optional; defaults to `ANVIL_AGENT_CMD` env |
| `args?: string[]` | (none, derived) | `args` | optional escape hatch; dashboard never sets |

After Deferred #1 cleanup, `SpawnConfig` is the single canonical name. The legacy agent-core `AgentProcessConfig` is deleted (it was a stub that never got wired up). Dashboard's pre-Phase-4 `SpawnConfig` is the same shape (now imported from agent-core).

---

## 5. Public API migration table

| Surface | Today | After (Phase 6) | Phase |
|---|---|---|---|
| `dashboard/server/agent-manager.ts` (444 LOC, stateful) | local | **deleted** — re-export from `@anvil/agent-core` removed in Phase 6 cleanup | 4 |
| `dashboard/server/agent-process.ts` (120 LOC) | local | **deleted** — folded into `AgentProcess` | 4 |
| `dashboard/server/agent-runner-wrapper.ts` (`runWithCheckpoint`) | local | **moved** to `@anvil/agent-core/checkpoint/runner.ts` | 3 |
| `dashboard/server/checkpoint-store.ts` (387 LOC) | local | **moved** to `@anvil/agent-core/checkpoint/store.ts` | 3 |
| `dashboard/server/checkpoint-blob-store.ts` (144 LOC) | local | **moved** to `@anvil/agent-core/checkpoint/blob-store.ts` | 3 |
| `dashboard/server/checkpoint-key.ts` + `checkpoint-types.ts` | local | **moved** to `@anvil/agent-core/checkpoint/{key,types}.ts` | 3 |
| `agent-core/src/agent/agent-manager.ts` (125 LOC, single-shot stub) | local | **deleted** — name reclaimed by lifted stateful `AgentManager` | Deferred #1 |
| `agent-core/src/agent/{spawn,stream-parser,output-buffer,timeout-guard,restart-policy,stage-validator,types}.ts` | unchanged | **deleted** — dead code with zero callers/tests | Deferred #1 |
| `cli/src/commands/diff.ts:300 runAgent()` | local helper | replaced with `runAgent` import from `@anvil/agent-core` | 5 |
| `dashboard/server/pipeline-runner.ts` `agentManager` field | dashboard-local class | imported `AgentManager` from agent-core | 4 |
| `dashboard/server/steps/agent-spawner.ts` | takes `AgentManager` | takes `AgentManager` from agent-core (same name, same surface) | 4 |
| `dashboard/server/dashboard-server.ts:806,828,829` (3 construction sites) | dashboard-local | imports from `@anvil/agent-core` | 3 (checkpoint), 4 (registry) |
| `~/.anvil/checkpoints/<project>/<runFamily>/` | dashboard-owned writer | agent-core-owned writer; on-disk format unchanged (D11) | 3 |

---

## 6. Per-phase commit log

| Phase | Description | Commit | Status |
|---|---|---|---|
| 0 | Audit + ADR + plan | `b712300` | landed 2026-04-30 |
| 1 | agent-core surface design + types | `881407b` | landed 2026-04-30 |
| 2 | Lift `AgentProcess` + `AgentManager` runtime into agent-core | `a8c0b3f` | landed 2026-04-30 |
| 3 | Move checkpoint cache into agent-core | `3be39ee` | landed 2026-04-30 |
| 4 | Dashboard cuts over | `fcae760` | landed 2026-04-30 |
| 5 | cli `diff` consumes checkpoint cache | `c21d7dd` | landed 2026-04-30 |
| 6 | Tests + docs + ADR finalize | _this commit_ | in progress |

### Cumulative outcome

| Surface | Before | After |
|---|---:|---:|
| `dashboard/server/agent-manager.ts` | 444 LOC class | 28 LOC re-export shim |
| `dashboard/server/agent-process.ts` | 120 LOC class | 31 LOC re-export shim |
| `dashboard/server/agent-runner-wrapper.ts` | 189 LOC | 9 LOC re-export shim |
| `dashboard/server/checkpoint-store.ts` | 387 LOC | 9 LOC re-export shim |
| `dashboard/server/checkpoint-blob-store.ts` | 144 LOC | 9 LOC re-export shim |
| `dashboard/server/checkpoint-key.ts` | ~125 LOC | 14 LOC re-export shim |
| `dashboard/server/checkpoint-types.ts` | ~75 LOC | 13 LOC re-export shim |
| `agent-core/src/agent/session/` | (did not exist) | 4 source files (~580 LOC) + 2 test files (~510 LOC) |
| `agent-core/src/checkpoint/` | (did not exist) | 5 source files (~960 LOC, lifted) + 4 test files (~1080 LOC, lifted) |

**Net repo delta:** dashboard shrinks by ~1,520 LOC (classes deleted; re-export shims also deleted in Deferred #3); agent-core grows by ~580 LOC (new session module) + ~960 LOC (lifted checkpoint code) − ~770 LOC (legacy agent-manager.ts + 7 supporting files deleted in Deferred #1). The lifted 960 LOC didn't disappear — it relocated to its proper home so cli now consumes it too. Net repo LOC delta: **−~750 LOC** with one canonical `AgentManager` (in agent-core, no aliasing).

**Test coverage:**

| Suite | Pre | Post | Delta |
|---|---:|---:|---:|
| `@anvil/agent-core` | 156 tests / 44 suites | 241 tests / 66 suites | +85 / +22 |
| `@anvil-dev/dashboard` server | 642 / 180 | 642 / 180 | 0 (lifted tests live in agent-core now) |
| Combined | 798 / 224 | 883 / 246 | +85 / +22 |

agent-core's 85 new tests break down as: 21 type-shape locks (Phase 1) + 28 `AgentProcess`/`AgentManager` runtime parity tests (Phase 2) + 36 lifted from dashboard's checkpoint suite (Phase 3 — same behavior, new home).

**D10 invariant verified:** dashboard's WebSocket message protocol unchanged. The 4 registry events (`agent-output`, `agent-activity`, `agent-done`, `agent-error`) and 5 session events (`content`, `activity`, `result`, `error-output`, `exit`) carry byte-identical payload shapes. Dashboard's existing `BaseAdapter` family structurally satisfies agent-core's new `AgentAdapter` interface — no adapter rewriting required.

**Deferred items — status after cleanup pass:**
- **Deferred #1 — Legacy `AgentManager` collapse — ✅ landed.** Honest audit showed the legacy single-shot `AgentManager` had zero production callers and zero test coverage (the `runAgent.test.ts` suite covers a different `runAgent` in `headless/runner.ts`). The original plan's "shrink to wrapper" became "delete dead code" — 8 files (~770 LOC) removed, the canonical `AgentManager` name reclaimed for the lifted stateful class.
- **Deferred #3 — Re-export shim deletion — ✅ landed.** All 12 dashboard call sites + 5 test files now import directly from `@anvil/agent-core`. The 7 re-export shim files (~95 LOC) deleted. Dashboard imports read `import { AgentManager, type AgentState, type SpawnConfig } from '@anvil/agent-core'` — no aliasing, no indirection.
- **Deferred #2 — cli orchestrator broader migration — still deferred.** cli's main pipeline orchestrator (`cli/src/pipeline/orchestrator.ts`, 1682 LOC) shells out via `execSync` and does not consume either `AgentManager` class. cli's only AI agent invocations are in `commands/diff.ts:300` (already wrapped with `runWithCheckpoint` in Phase 5) and `commands/learn.ts:155` (could similarly benefit from the cache; ~30 LOC change). Broader integration is gated on cli growing multi-agent state-tracking needs.

---

## 7. Cross-cutting risks

1. **D10 invariant slip in Phase 4.** Dashboard's WS transcript must be byte-identical (modulo timestamps + costs) before/after the cutover. Mitigation: branch-parity diff on a fixture run before merging Phase 4.
2. **Checkpoint cache miss semantics drift.** `computeKey()` hashes `(project, stage, persona, model, prompt)`. If any field's serialization changes during the move, cache invalidates. Mitigation: Phase 3 cross-package read/write parity test asserts identical record shape with bit-identical keys.
3. **Adapter event-shape drift.** `AgentSession` translates `LanguageModel.invokeStream()` events into the dashboard's 5-event surface. Translation table is locked in Phase 2 with recorded fixtures from a real Claude/OpenAI/Gemini run.
4. **cli retry behavior change.** Today cli's `RestartPolicy` triggers on subprocess crash. After Phase 5, cli also dedupes via the checkpoint cache (clean 2nd run hits cache). This is desirable but documented as a behavior change so anyone debugging "why didn't my retry actually re-run the agent" finds the answer.
5. **dashboard-local adapter family lingering.** Dashboard consolidation Phase 1 added `agent-core-bridge.ts` to wrap agent-core `LanguageModel`s into dashboard's `BaseAdapter` event shape. After Phase 4, the bridge is no longer needed (the new `AgentSession` consumes `LanguageModel` directly). Phase 4 deletes the bridge. Mitigation: `tsc -b` catches every reference at compile time.

---

## Appendix A — `AgentSession` event surface (locked in D2)

| Event | Payload | When |
|---|---|---|
| `content` | `(text: string)` | Adapter emits a content delta |
| `activity` | `(activity: AgentActivity)` | Adapter emits a tool-use / thinking activity |
| `result` | `(data: { result: string; cost: CostInfo; sessionId: string })` | Adapter completes successfully |
| `error-output` | `(text: string)` | Adapter emits stderr |
| `exit` | `(code: number \| null)` | Adapter process exits |

## Appendix B — `SessionSpec` field mapping

See § 4 above.

## Appendix C — Adapter event translation table (Phase 2)

| `LanguageModel.invokeStream()` event | `AgentSession` event | Notes |
|---|---|---|
| `{ type: 'content', delta }` | `content` | direct pipe |
| `{ type: 'tool_use', name, input }` | `activity` (`kind: 'tool_use'`) | mapped via `toActivity()` helper |
| `{ type: 'thinking', text }` | `activity` (`kind: 'thinking'`) | direct pipe |
| `{ type: 'result', text, usage, stopReason }` | `result` | usage → `CostInfo` via `costFromUsage()` |
| `{ type: 'error', message }` | `error-output` | direct pipe |
| _stream end_ | `exit` (`code: 0`) | synthesized |
| _adapter throws_ | `exit` (`code: 1`) | synthesized |

## Appendix D — cli call-site inventory (Phase 5)

| Site | Action |
|---|---|
| `cli/src/commands/diff.ts:300 runAgent()` | replace local helper with `import { runAgent } from '@anvil/agent-core'` |
| `cli/src/commands/run-feature.ts` | audit; no agent-spawn paths today, but if future code adds one it should use `AgentSessionRegistry` |
| `cli/src/orchestrator/*` (if/when added) | use `AgentSessionRegistry` from day one |

## Appendix E — Future unification with `headless/runAgent`

`agent-core/src/headless/runner.ts:runAgent` operates on `LanguageModel` + `AgentTask` and produces `AgentTrajectory`. It is a **higher level** than `AgentSession` (tool-call loop with skill composition + MCP server discovery). A future consolidation could refactor `AgentSession` to optionally drive the headless runner internally — but that requires both surfaces to converge on a single event/result schema. Out of scope for this plan; see `AGENT-OBSERVABILITY-ADR.md` § 3.4 for related work.
