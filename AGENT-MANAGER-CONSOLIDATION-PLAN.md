# Agent Manager Consolidation Plan

> Closeout of the dashboard consolidation series. Lifts the agent-lifecycle surface — `AgentManager`, `AgentProcess`, the per-call checkpoint cache, and the in-process session-resume machinery — into `@anvil/agent-core` so the dashboard, the cli orchestrator, and any future consumer share a single agent runtime.
>
> **Status:** draft 2026-04-30.
> **Depends on:** `@anvil/agent-core` (shipped), the seven adapters under `packages/agent-core/src/{claude,openai,gemini,gemini-cli,openrouter,ollama,adk,fallback}-adapter.ts`, and the dashboard consolidation series Phase 1–6 (already merged).

---

## 1. Pre-flight reality check (verified 2026-04-30)

| Check | Result |
|---|---|
| `packages/dashboard/server/agent-manager.ts` exists, **444 LOC** — stateful, multi-agent, sendInput-via-resume, EventEmitter, cost+checkpoint hooks | ✅ |
| `packages/dashboard/server/agent-process.ts` exists, **120 LOC** — adapter-pattern wrapper around dashboard-local adapters | ✅ |
| `packages/dashboard/server/agent-runner-wrapper.ts` exists, **189 LOC** — `runWithCheckpoint()` SIGTERM-safe gate over a `CheckpointStore` | ✅ |
| `packages/dashboard/server/checkpoint-store.ts` (**387 LOC**) + `checkpoint-blob-store.ts` (**144 LOC**) — per-call cache: dedupe agent calls by `(project, stage, persona, model, prompt-hash)` | ✅ |
| `packages/agent-core/src/agent/agent-manager.ts` exists, **125 LOC** — `runAgent(config): Promise<AgentResult>` — single-shot, timeout/restart/validate, **no** session-resume, **no** stateful multi-agent tracking | ✅ |
| `packages/agent-core/src/agent/{spawn,stream-parser,output-buffer,timeout-guard,restart-policy,stage-validator}.ts` — supporting machinery for the cli-style runner | ✅ |
| Dashboard's `AgentManager` and agent-core's `AgentManager` are **two different abstractions** with the same name | ✅ |
| Dashboard imports from `@anvil/agent-core` for adapters/router/SpendLedger | ✅ — dashboard consolidation Phase 1 |
| Dashboard imports `AgentManager` / `AgentProcess` from local files | ❌ — **zero imports** from agent-core for the lifecycle layer |
| cli uses agent-core's `runAgent()` only at `cli/src/commands/diff.ts:300` (one-off, not the orchestrator) | ✅ |
| cli's main orchestrator (per-stage agent spawns) calls adapters directly via the LLM router | ✅ |

**Coupling shape today:**
- **Two AgentManager classes with the same name.** agent-core's is single-shot (run-once-and-return-result). Dashboard's is stateful (spawn → resume → resume → kill, with concurrent multi-agent tracking).
- **Three checkpoint surfaces.** Dashboard has `agent-runner-wrapper` + `checkpoint-store` + `checkpoint-blob-store` (~720 LOC). agent-core has nothing equivalent. cli does not cache agent calls today (each stage re-runs from scratch on retry).
- **Adapter shape diverges.** Dashboard's `BaseAdapter` (EventEmitter with `content` / `activity` / `result` / `error-output` / `exit` events) is the runtime contract for the dashboard; agent-core's `LanguageModel` (async iterable of typed `StreamEvent`) is the new forward shape. The dashboard's `AgentProcess` already bridges these (was added in dashboard consolidation Phase 1).

**Total in-scope LOC** to relocate: **~1,409 LOC** in dashboard (`agent-manager.ts` 444 + `agent-process.ts` 120 + `agent-runner-wrapper.ts` 189 + `checkpoint-store.ts` 387 + `checkpoint-blob-store.ts` 144 + `checkpoint-key.ts` ~50 + `checkpoint-types.ts` ~75); collapses agent-core's existing `agent-manager.ts` (125 LOC) into a thin convenience helper over the new surface.

---

## 2. Why this isn't a one-shot rewrite

The dashboard's `AgentManager` is the **superset**. cli's `runAgent()` is a degenerate case (one spawn → wait → return). But two real differences make a naive replacement risky:

1. **Session-resume contract differs.** Dashboard's `sendInput(agentId, text)` spawns a NEW process with `resume: true` and the same `sessionId` — depends on the underlying CLI's `--resume <session>` flag. agent-core's `LanguageModel` interface declares `sessionResume: boolean` in capabilities and accepts `sessionId` in invoke options, but the *resume-by-spawning-a-new-process* pattern lives only in dashboard code today. Lifting it into agent-core means deciding whether the surface is stream-event-based (the agent-core idiom) or process-spawn-based (the dashboard idiom).

2. **Checkpoint cache scope is broader than agent calls.** Dashboard's `runWithCheckpoint` is used not just by per-stage agent spawns but also by deterministic non-agent steps (test-spec generators, plan validators) that want crash-safe caching. The plan keeps `runWithCheckpoint` agent-agnostic so non-agent callers continue to work after the lift.

3. **cli's orchestrator does not use the per-call checkpoint cache today.** Adding it changes cli behavior on retries — cached calls now skip. This is desirable but deserves an explicit acceptance criterion (cli retry tests must still pass) rather than being a silent behavior change.

A naive "merge the two AgentManagers" would either lose dashboard's interactive surface (sendInput/kill/concurrent tracking) or force cli to adopt event-emitter ergonomics it doesn't need. The plan therefore lifts the **superset surface** and gives cli a thin convenience wrapper that preserves its existing `runAgent(): Promise<AgentResult>` ergonomics.

---

## 3. Decisions (deferred to ADR)

The full decision matrix lives in `AGENT-MANAGER-CONSOLIDATION-ADR.md` (to be created in Phase 0). Headlines:

- **D1** — One agent-lifecycle surface, owned by `@anvil/agent-core`. Dashboard and cli both consume it. No code duplicates the lifecycle state machine after this plan lands.
- **D2** — The unified surface is **`AgentSession`** (one logical agent, EventEmitter, supports `sendInput` for resume) + **`AgentSessionRegistry`** (Map of concurrent sessions, `spawn` / `get` / `kill` / `killAll`, hosts cost + checkpoint hooks). Existing `AgentManager` *names* are reclaimed by the new surface; the cli-style `runAgent(): Promise<AgentResult>` becomes a convenience helper over `AgentSessionRegistry`.
- **D3** — Per-call checkpoint cache (`runWithCheckpoint`, `CheckpointStore`, `BlobStore`, `checkpoint-key`, `CheckpointInputs/Record`) moves verbatim into `packages/agent-core/src/checkpoint/`. Public API unchanged; storage paths default to `~/.anvil/checkpoints/` (was: dashboard-local).
- **D4** — `AgentProcess` (the adapter-event-pipe wrapper) collapses into `AgentSession`'s constructor. Dashboard's `AgentProcess` file is deleted. cli does not gain `AgentProcess` usage — it never had it.
- **D5** — Session-resume contract: `AgentSession.sendInput(text)` spawns a new adapter instance with `{ resume: true, sessionId }` and re-wires events. Adapters that report `capabilities.sessionResume === false` reject `sendInput` with a typed error. Same shape as today's dashboard behavior.
- **D6** — agent-core's existing `agent-manager.ts` (single-shot `runAgent`) is **not deleted** but becomes a 30-LOC wrapper that builds an `AgentSessionRegistry`, spawns one session, awaits `'agent-done'`, and returns the `AgentResult`. Existing cli call sites stay green without a code change.
- **D7** — cli's main orchestrator migrates **once** to the new surface so cli runs benefit from the per-call checkpoint cache (free retry deduplication). Behavior change is documented; cli's test suite must remain green.
- **D8** — **No feature flags.** Each phase is a full cutover; legacy code is deleted in the same PR that lands the replacement. Same rule as the dashboard consolidation series.
- **D9** — No new shared package. All consolidation lands in existing `@anvil/agent-core`.
- **D10** — The dashboard's WebSocket message protocol stays unchanged. All 133 message types must keep their existing payload shapes through the migration. Same invariant as the dashboard consolidation series — re-asserted here because Phase 4 of this plan touches dashboard's spawn paths.
- **D11** — No new persistence layout for sessions. Checkpoint blobs continue to live under `~/.anvil/checkpoints/<project>/<runFamily>/`; the only change is who *owns* the writer (was: dashboard, now: agent-core). Existing on-disk artifacts remain readable.

---

## 4. Public API migration table

| Surface | Today | After |
|---|---|---|
| `dashboard/server/agent-manager.ts` (444 LOC, stateful) | local | **deleted** — re-export `AgentSessionRegistry` from `@anvil/agent-core` |
| `dashboard/server/agent-process.ts` (120 LOC) | local | **deleted** — superseded by `AgentSession` constructor |
| `dashboard/server/agent-runner-wrapper.ts` (`runWithCheckpoint`) | local | **moved** to `@anvil/agent-core/checkpoint/runner.ts`; dashboard re-exports for backwards compat through one minor release, then drops |
| `dashboard/server/checkpoint-store.ts` (387 LOC) | local | **moved** to `@anvil/agent-core/checkpoint/store.ts` |
| `dashboard/server/checkpoint-blob-store.ts` (144 LOC) | local | **moved** to `@anvil/agent-core/checkpoint/blob-store.ts` |
| `dashboard/server/checkpoint-key.ts` + `checkpoint-types.ts` | local | **moved** to `@anvil/agent-core/checkpoint/{key,types}.ts` |
| `agent-core/src/agent/agent-manager.ts` (125 LOC, single-shot) | local | **shrunk to ~30 LOC** thin wrapper over new `AgentSessionRegistry` |
| `agent-core/src/agent/spawn.ts` + `stream-parser.ts` + `output-buffer.ts` + `timeout-guard.ts` + `restart-policy.ts` + `stage-validator.ts` | unchanged | unchanged — supporting machinery, reused inside `AgentSession` |
| `cli/src/commands/diff.ts:300 runAgent()` | local | unchanged externally; calls now go through new wrapper |
| cli orchestrator's per-stage agent spawn | direct adapter call via LLM router | spawn through `AgentSessionRegistry`; gains free per-call checkpoint cache |
| `dashboard/server/pipeline-runner.ts` `agentManager: AgentManager` field | dashboard-local class | re-exported `AgentSessionRegistry` from agent-core |
| `dashboard/server/steps/agent-spawner.ts` `spawnAndWait` / `waitForAgent` helpers | takes `AgentManager` from dashboard | takes `AgentSessionRegistry` from agent-core (same surface) |
| `~/.anvil/checkpoints/<project>/<runFamily>/` | dashboard-owned writer | agent-core-owned writer; on-disk format unchanged (D11) |

---

## 5. Schema shapes

No new schemas. The plan **harmonizes** existing types:

- `AgentState` (dashboard) → moves into `@anvil/agent-core/agent/types.ts` as the canonical state shape.
- `AgentResult` (cli-style, agent-core today) → kept; built from `AgentState` snapshot when `runAgent()` resolves.
- `SpawnConfig` (dashboard) and `AgentProcessConfig` (agent-core, cli-style) → merged into `SessionSpec`. The two were similar already; merge resolves field-name drift (`prompt` vs `args[0]`, `cwd` vs `workingDir`).
- `CostInfo` (dashboard) → already imports from agent-core `cost.ts`; unchanged.
- `AgentManagerEvents` (dashboard) → renamed `AgentSessionRegistryEvents`; same payloads.
- `AgentProcessEvents` (dashboard) → moves to `@anvil/agent-core` as `AgentSessionEvents`.
- `CheckpointInputs` / `CheckpointRecord` (dashboard) → unchanged on-the-wire; new home is `@anvil/agent-core/checkpoint/types.ts`.

The unification table (`SpawnConfig` ↔ `AgentProcessConfig` → `SessionSpec`) is appendix B of the ADR.

---

## Phase 0 — Audit + decisions (no code change)

**Effort:** 0.5d.

### 0.1 What changes
Lock D1–D11 in `AGENT-MANAGER-CONSOLIDATION-ADR.md`. Snapshot the call graph: every site in dashboard + cli + agent-core that calls `new AgentManager()`, `runAgent()`, `runWithCheckpoint()`, `spawn()`, `sendInput()`, or directly constructs `AgentProcess`. Identify the seam where `AgentSession` lives and the seam where the checkpoint cache lives (these are independent — checkpoint cache could land first or last).

### 0.2 Acceptance
- [ ] ADR with D1–D11, each with one-line `Why`
- [ ] Call-graph inventory: file path, line number, surface called, current behavior
- [ ] `SessionSpec` field-mapping table (dashboard `SpawnConfig` ↔ agent-core `AgentProcessConfig` ↔ new `SessionSpec`)
- [ ] List of dashboard WebSocket messages that depend on `AgentManager` events (to pin D10 invariant)

### 0.3 Rollback
Revert the ADR commit.

---

## Phase 1 — agent-core surface design + types

**Effort:** 1d.

### 1.1 What changes
New types under `packages/agent-core/src/agent/`. **No runtime behavior** — only type definitions, public-API shells with `throw new Error('unimplemented')`, and the test scaffolding that locks the contract.

### 1.2 Procedure
1. New `packages/agent-core/src/agent/session.ts` — declares `AgentSession` class skeleton, `SessionSpec`, `AgentSessionEvents`, `AgentState` (lifted from dashboard's `AgentState`).
2. New `packages/agent-core/src/agent/session-registry.ts` — declares `AgentSessionRegistry` skeleton with `spawn(spec) → AgentSession`, `get(id)`, `kill(id)`, `killAll()`, `setCostHook()`, `setCheckpointHook()`, the EventEmitter event surface.
3. New `packages/agent-core/src/agent/cost-hook.ts` + `checkpoint-hook.ts` — moved from dashboard's `AgentCostHook` / `AgentCheckpointHook` interfaces (currently inline in `agent-manager.ts:74-160`).
4. Re-export from `packages/agent-core/src/index.ts`: `AgentSession`, `AgentSessionRegistry`, `SessionSpec`, `AgentState`, `AgentSessionEvents`, `AgentCostHook`, `AgentCheckpointHook`.
5. Type-only acceptance test: `packages/agent-core/src/__tests__/agent-session-types.test.ts` — uses `tsd` or hand-rolled `expectType<>` to lock signatures (mirrors dashboard's `AgentManagerEvents` / `SpawnConfig` shapes).

### 1.3 Acceptance
- [ ] `tsc -b` passes from root
- [ ] Type test asserts `SessionSpec` is structurally compatible with both legacy `SpawnConfig` (dashboard) and `AgentProcessConfig` (cli-style) — i.e. either can be passed where `SessionSpec` is expected (after a documented field rename: `cwd` is canonical, `workingDir` is removed).
- [ ] No call sites changed yet — agent-core compiles, dashboard compiles, cli compiles
- [ ] `npm test` all green (no impl yet, just types)

### 1.4 Risks
- **`SessionSpec` field collision:** dashboard `SpawnConfig.cwd` vs agent-core `AgentProcessConfig.workingDir`. Mitigation: ADR appendix B picks `cwd`; agent-core's existing 8 internal call sites are renamed atomically in this phase (compile-time-safe).

### 1.5 Rollback
Revert the Phase 1 commit. Pure-type addition — zero runtime impact.

---

## Phase 2 — Move `AgentSession` + Registry into agent-core

**Effort:** 2d.

### 2.1 What changes
Implementation of the type skeletons from Phase 1. The dashboard's `agent-manager.ts` state machine (Map<id, {state, process}>, EventEmitter wiring, sendInput-via-resume, kill, killAll) lifts into `agent-core/src/agent/session-registry.ts`. The dashboard's `agent-process.ts` adapter-event-pipe lifts into `agent-core/src/agent/session.ts` constructor. **Dashboard still uses its local copies** — Phase 4 flips the imports.

### 2.2 Procedure
1. Port dashboard's `AgentManager.spawn()` body (`agent-manager.ts:188-253`) into `AgentSessionRegistry.spawn()`. The checkpoint-cache lookup branch (lines 210-230) stays — but the `checkpointHook` interface is the one declared in Phase 1, so the dashboard re-implements its hook against the same shape.
2. Port `AgentManager.sendInput()` (lines 257-287) into `AgentSession.sendInput()`. Behavior parity:
   - Append `> User: <text>` to the output stream
   - Set `state.status = 'running'`, clear `finishedAt`
   - Spawn a NEW adapter with `{ resume: true, sessionId, model }`
   - Wire events through to the existing session emitter
   - Replace the entry's process reference
3. Port `wireEvents()` (private method, lines ~330-410 of dashboard) into `AgentSession.wireEvents()`.
4. Port `AgentManager.kill()` / `killAll()` into the registry.
5. Port the `getAgent(id)` query and registry iteration helpers.
6. Cost hook + checkpoint hook setters: identical shapes to dashboard, use the interfaces declared in Phase 1.
7. **Adapter resolution:** dashboard's `agent-process.ts` calls `createAdapter(config)` from `dashboard/server/adapters/adapter-factory.ts`. agent-core has its own adapter family. Phase 2 wires `AgentSession` to call `agent-core`'s `legacyAdapterToLanguageModel()` bridge directly — the dashboard's local `adapter-factory.ts` becomes vestigial after Phase 4 (deleted there).
8. Test parity: every test in `dashboard/server/__tests__/agent-runner-wrapper.test.ts` (and any test that exercises `AgentManager.spawn` / `sendInput`) gets a sibling test in `agent-core/src/agent/__tests__/session-registry.test.ts` that asserts identical behavior on the lifted code.

### 2.3 Acceptance
- [ ] `AgentSessionRegistry` parity tests cover: spawn happy-path, spawn-with-cache-hit, sendInput-resume, kill mid-run, killAll, EventEmitter event order
- [ ] `AgentSession` parity tests cover: adapter event piping, kill propagation, cost accumulation, activity append
- [ ] All 7 agent-core adapter tests still pass
- [ ] `tsc -b` green; `npm test` agent-core green
- [ ] Dashboard still uses its local `AgentManager` / `AgentProcess` (Phase 4 hasn't flipped imports yet) — dashboard tests still green

### 2.4 Risks
- **Adapter-event drift between dashboard's `BaseAdapter` and agent-core's `LanguageModel`:** dashboard pipes 5 event types (`content` / `activity` / `result` / `error-output` / `exit`); agent-core's stream emits typed `StreamEvent` objects. Mitigation: `AgentSession` consumes `LanguageModel.invokeStream()` and translates events to the dashboard-compatible 5-event surface. The translation table is locked in ADR appendix C and tested against recorded fixtures from a real Claude/OpenAI/Gemini run.
- **Session-id format:** dashboard uses `generateSessionId(project, stage)`. agent-core's `LanguageModel.sessionId` is opaque. Mitigation: `AgentSession` controls session-id generation; adapters receive whatever string we pass.
- **Cost-hook timing:** dashboard fires `costHook` after every result; agent-core fires nothing today. Mitigation: `AgentSession` fires the hook at the same lifecycle point — after `'agent-done'` — preserving dashboard semantics.

### 2.5 Rollback
Revert Phase 2 commit. agent-core regains its pre-phase state; nothing in dashboard or cli has changed yet.

---

## Phase 3 — Move checkpoint cache into agent-core

**Effort:** 1.5d.

### 3.1 What changes
`runWithCheckpoint()`, `CheckpointStore`, `BlobStore`, `checkpoint-key`, and the type files move verbatim from `packages/dashboard/server/` into `packages/agent-core/src/checkpoint/`. Public API unchanged; the only behavioral difference is who owns the writer process. Dashboard re-exports from agent-core for the duration of one minor release, then drops the re-exports.

### 3.2 Procedure
1. New directory `packages/agent-core/src/checkpoint/` with `runner.ts` (was: `agent-runner-wrapper.ts`), `store.ts` (was: `checkpoint-store.ts`), `blob-store.ts` (was: `checkpoint-blob-store.ts`), `key.ts` (was: `checkpoint-key.ts`), `types.ts` (was: `checkpoint-types.ts`).
2. Re-export from `packages/agent-core/src/index.ts`: `runWithCheckpoint`, `CheckpointStore`, `BlobStore`, `WrappedAgentOpts`, `CheckpointInputs`, `CheckpointRecord`.
3. Move all 4 dashboard checkpoint test files (`checkpoint-store.test.ts`, `checkpoint-blob-store.test.ts`, `agent-runner-wrapper.test.ts`, `checkpoint-key.test.ts`) into `packages/agent-core/src/checkpoint/__tests__/`. Update import paths only.
4. Dashboard's `agent-runner-wrapper.ts` etc. become **re-exports** that import from agent-core. Net dashboard LOC delta: ~720 LOC removed, ~30 LOC re-export shims added.
5. Update dashboard's existing call sites (`pipeline-runner.ts`, `agent-manager.ts` checkpoint hook) to import from `@anvil/agent-core` instead of relative paths. Atomic, compile-time-safe.
6. `~/.anvil/checkpoints/` path stays the same — the new home is just where the writer code lives. On-disk format unchanged.

### 3.3 Acceptance
- [ ] All 4 lifted test files pass under `npm -w @anvil/agent-core test`
- [ ] Dashboard tests that consume the re-export shims still pass
- [ ] An integration test in `agent-core/src/checkpoint/__tests__/cross-package.test.ts` writes a checkpoint via agent-core, reads it via dashboard's re-export shim, asserts identical `CheckpointRecord` shape
- [ ] `tsc -b` + `npm test` all green at the root

### 3.4 Risks
- **Test path drift:** dashboard tests use relative `__fixtures__/` directories. Mitigation: copy fixtures alongside the moved tests.
- **SIGTERM/SIGINT handler scope:** `runWithCheckpoint` registers process-level signal handlers. Mitigation: the existing `__signalHook` test seam stays untouched; behavior is identical (handler registration is per-call, cleaned up in `finally`).

### 3.5 Rollback
Revert Phase 3 commit. Dashboard re-acquires the local checkpoint files; agent-core loses the new directory; on-disk artifacts under `~/.anvil/checkpoints/` continue to be readable from either side.

---

## Phase 4 — Dashboard migration

**Effort:** 1.5d.

### 4.1 What changes
Dashboard deletes its local `agent-manager.ts`, `agent-process.ts`, and the now-vestigial `adapter-factory.ts` (whose only consumer was `agent-process.ts`). All call sites in the dashboard import `AgentSessionRegistry` and `AgentSession` from `@anvil/agent-core`. The dashboard's adapter-shim files (added in dashboard consolidation Phase 1 — `agent-core-bridge.ts`) are also no longer needed and get deleted. Net dashboard LOC delta from Phase 4: **−~700 LOC**.

### 4.2 Procedure
1. Delete `packages/dashboard/server/agent-manager.ts`, `agent-process.ts`, `adapters/agent-core-bridge.ts`, `adapters/base-adapter.ts`, `adapters/adapter-factory.ts`.
2. Update `pipeline-runner.ts:407` (`private agentManager: AgentManager`) to import `AgentSessionRegistry` from agent-core. Class field rename: `agentManager` → `agentSessions` (or keep the old name as an alias — ADR D2 picks one).
3. Update `dashboard-server.ts` constructor wiring (the `new AgentManager()` site) to construct `AgentSessionRegistry`.
4. Update `steps/agent-spawner.ts` — its `AgentManager` parameter type swaps to `AgentSessionRegistry`. Same surface; no body changes.
5. Update all 6 step modules that consume `agentManager` (`per-repo-stage`, `per-repo-build`, `clarify-stage`, `fix-loop`, `test-gen-stage`, `prompt-builders`) — pure type-rename; no logic changes (these were already lifted in 4f.x to take an injectable AgentManager-shape).
6. Update `agent-runner-wrapper.test.ts` and the 5 step-tests' fake-AgentManager helpers to match the new type. The fakes already implement the same surface (`spawn` / `getAgent` / `sendInput` / `kill`); the change is purely the type they conform to.
7. Update `package.json` exports — remove the deleted files from the `files` array.
8. Re-run dashboard's full `npm -w @anvil-dev/dashboard test:server` and assert zero new failures.

### 4.3 Acceptance
- [ ] `agent-manager.ts`, `agent-process.ts`, `adapters/*` files deleted
- [ ] All dashboard tests pass (the 6 pre-existing failures from the IDE-Jest false-positive note remain — no new failures)
- [ ] **D10 invariant verified:** dashboard WebSocket transcript on a fixture pipeline run is byte-for-byte identical (modulo timestamps + costs) to a recorded baseline from `main`
- [ ] `npm -w @anvil-dev/dashboard run build` succeeds and the server starts on `:7475`
- [ ] Manual smoke: spawn one agent through the dashboard UI → assert `agent-output` / `agent-done` events arrive → assert cost is recorded in both NDJSON and SQLite (cost-bridge from dashboard consolidation Phase 3 still works)

### 4.4 Risks
- **Adapter cleanup blast radius:** deleting the adapter shim layer might surface a hidden caller. Mitigation: `tsc -b` from root catches every reference at compile time; Phase 4 lands as a single PR, easy to revert.
- **Event-name drift:** dashboard's `AgentManagerEvents` has 4 events; the new `AgentSessionRegistryEvents` should have the same 4. Mitigation: ADR D2 locks the event names; the type test from Phase 1 catches drift.
- **Cost-hook re-wiring:** dashboard's `CostBridge` calls `agentManager.setCostHook(hook)` once at startup. Mitigation: `AgentSessionRegistry` exposes the same setter; one-line change.

### 4.5 Rollback
Revert Phase 4 commit. Dashboard regains its local lifecycle layer; agent-core's new code is unaffected. The on-disk checkpoint format hasn't changed (Phase 3 already moved the writer), so no data-migration concern.

---

## Phase 5 — cli orchestrator migration

**Effort:** 2d.

### 5.1 What changes
cli's per-stage agent invocations move from direct adapter calls (via the LLM router) to `AgentSessionRegistry.spawn(...)`. cli runs gain the per-call checkpoint cache for free — repeated runs of the same prompt skip the agent call. cli's existing `runAgent()` helper at `packages/agent-core/src/agent/agent-manager.ts` shrinks to a 30-LOC wrapper that builds an `AgentSessionRegistry`, spawns one session, awaits done, returns `AgentResult`.

### 5.2 Procedure
1. Identify cli's per-stage agent spawn sites. Likely candidates: `packages/cli/src/orchestrator/run-stage.ts` (or wherever cli runs an LLM call). Document the inventory in ADR appendix D.
2. For each site, replace direct adapter call with `registry.spawn(spec)` + `await waitForSession(id)` (a new helper in `agent-core/src/agent/wait.ts`, sibling to dashboard's `agent-spawner.ts:waitForAgent`).
3. Shrink `agent-core/src/agent/agent-manager.ts` from 125 LOC to ~30 LOC: it now constructs an `AgentSessionRegistry`, calls `spawn()` once, awaits the `'agent-done'` event, returns the `AgentResult`. The `RestartPolicy` / `TimeoutGuard` / `StageValidator` machinery moves *inside* `AgentSession` so all consumers benefit.
4. Verify `cli/src/commands/diff.ts:300 runAgent()` still works (it was the only public consumer of the old shape).
5. cli's existing `RestartPolicy` (max-restarts on crash) becomes a `SessionSpec` option: `restart?: { maxAttempts: number }`. Dashboard ignores it (sets `maxAttempts: 0`). cli sets it to its current default (2).
6. cli's `TimeoutGuard` (per-stage timeout) becomes a `SessionSpec` option: `timeoutMs?: number`. Dashboard sets it from `STAGE_OUTPUT_LIMITS` (or leaves undefined for no-timeout).
7. cli's `StageValidator` (output-shape validator) stays cli-specific — it's a post-hoc check that doesn't belong in agent-core. cli wraps `runAgent()` to run the validator after the session resolves.
8. Run cli's full test suite. Assert green. Pay particular attention to tests that exercise retry behavior — they should pass without code change because retry semantics are preserved (just relocated into `AgentSession`).

### 5.3 Acceptance
- [ ] cli orchestrator spawns through `AgentSessionRegistry`
- [ ] `cli/src/commands/diff.ts:300 runAgent()` returns the same `AgentResult` shape
- [ ] cli test suite all green
- [ ] cli benchmark: a re-run of an identical command hits the checkpoint cache (~$0 cost, ~50ms latency) — documented and committed as a smoke test
- [ ] `npm test` all packages green

### 5.4 Risks
- **cli retry behavior change:** today cli's `RestartPolicy` only triggers on subprocess crash. After the move, retries also dedupe via the checkpoint cache (a clean 2nd run hits the cache). Mitigation: cli's existing retry tests cover crash-restart, not cache-skip; cache-skip is a new desired behavior. Document explicitly.
- **Validator timing:** cli's `StageValidator` runs synchronously after `runAgent()`. After the move it still runs synchronously after the wrapper resolves. No behavior change. Test in unit.
- **Per-stage timeout for dashboard:** dashboard runs without a timeout today (relies on user cancellation). If `AgentSession` defaults to a non-zero timeout, dashboard runs would suddenly fail. Mitigation: `timeoutMs` defaults to `0` (no timeout); dashboard never sets it. cli sets it explicitly per stage.

### 5.5 Rollback
Revert Phase 5 commit. cli reverts to direct adapter calls; agent-core's new surface remains for dashboard. Cache hits stop happening for cli but no regressions on the dashboard side.

---

## Phase 6 — Tests + docs + ADR finalize

**Effort:** 1d.

### 6.1 What changes
Coverage push: cross-package integration tests, dashboard README update, ADR commit-hash backfill, deletion of vestigial dashboard re-export shims (the ones added in Phase 3 for backward compat — drop them after Phase 5 lands).

### 6.2 Procedure
1. New `packages/agent-core/src/__tests__/integration/dual-consumer.test.ts` — instantiates one `AgentSessionRegistry`, spawns 2 sessions in parallel (one mimicking dashboard's interactive flow with `sendInput`, one mimicking cli's single-shot `runAgent`), asserts they don't interfere (separate state, separate cost accumulation, separate checkpoint cache slots).
2. New `packages/agent-core/src/__tests__/integration/checkpoint-cache-shared.test.ts` — dashboard writes a checkpoint via `AgentSessionRegistry.spawn(...)` with `runFamily: 'shared-test'`. cli runs `runAgent({ runFamily: 'shared-test', sameInputs })`. Assert cli hits the cache (no actual adapter call).
3. Update `packages/dashboard/README.md` § Architecture: remove the `@anvil/agent-core` row that says "Provider adapters" and replace with "Provider adapters + agent lifecycle (`AgentSession` / `AgentSessionRegistry`) + checkpoint cache".
4. Update `packages/dashboard/README.md` § Pipeline runner shape: drop the `agent-spawner.ts` row (the helpers are still local but now wrap an agent-core surface).
5. Delete dashboard's re-export shims for `agent-runner-wrapper.ts`, `checkpoint-store.ts`, `checkpoint-blob-store.ts`, `checkpoint-key.ts`, `checkpoint-types.ts` introduced in Phase 3. All consumers are updated to import from `@anvil/agent-core` directly.
6. ADR `AGENT-MANAGER-CONSOLIDATION-ADR.md` § Implementation log: backfill commit hashes for each phase. Add a § Cumulative outcome table (LOC moved, LOC deleted, tests added).
7. Tag `v<next>` after the merge.

### 6.3 Acceptance
- [ ] Dual-consumer integration test passes
- [ ] Cross-process checkpoint-cache-share test passes
- [ ] Dashboard README updated
- [ ] ADR finalized with hashes
- [ ] All re-export shims deleted; direct imports from `@anvil/agent-core` everywhere
- [ ] `npm test` all packages green
- [ ] Final LOC delta documented:
  - Dashboard: −~1,409 LOC
  - agent-core: +~1,250 LOC (AgentSession + Registry + checkpoint cache, slightly less than dashboard had because the existing `agent-manager.ts` 125 LOC + `spawn.ts` etc. fold in)
  - cli: ±~50 LOC (orchestrator import sites change; net ~0)
  - Net: −~200 LOC across the repo, plus the entire agent runtime is now one implementation

### 6.4 Risks
- **Stale re-export shims missed:** linting catches `export from '../agent-runner-wrapper'` style re-exports if their target is gone. Mitigation: explicit `tsc --noResolve` check, or a grep for `from '../checkpoint-` patterns.

---

## Cross-cutting validation strategy

Before each phase's PR merges into the release branch:

1. `npm install`
2. `tsc -b` from root
3. Per-package: `npm -w <name> run build && npm -w <name> test`
4. Dashboard server smoke: `npm -w @anvil-dev/dashboard run build && node packages/dashboard/server/dashboard-server.js` (boots on `:7475` without crash)
5. cli smoke: `npm -w @anvil-loc test` (full suite)
6. **Branch parity diff (Phase 4 only):** trigger one fixture pipeline through the dashboard on the release-branch HEAD AND on the same-base from `main`; compare the WebSocket transcript byte-for-byte (modulo timestamps + costs). Hold the merge until the diff is empty.
7. **Cache-hit smoke (Phase 5):** run `anvil-loc <some-stable-command>` twice; assert second run completes in <500ms and reports `cost: 0` (cache hit). Commit the smoke as a CI job.
8. Tag the release only after Phase 6 lands.

---

## Cross-cutting order rationale

| # | Phase | Why this order |
|---|---|---|
| 0 | Audit | Lock D1–D11 + call-graph inventory before any code |
| 1 | Surface design | Pure type addition; gates Phase 2 with a frozen contract |
| 2 | Move AgentSession + Registry | Bigger lift; depends on Phase 1's types but doesn't touch consumers yet |
| 3 | Move checkpoint cache | Independent of AgentSession runtime; can land before or after Phase 2. Doing it before Phase 4 lets dashboard's `runWithCheckpoint` callers update their import path in one PR with the AgentManager swap. |
| 4 | Dashboard migration | Single biggest cutover; consumes Phases 2 + 3. Verifies D10 invariant. |
| 5 | cli orchestrator migration | Last consumer; benefits from Phase 4's burn-in time on the release branch. |
| 6 | Tests + docs | Standard close-out; release-branch smoke + tag |

**Total effort:** ~8.5d. **Total LOC delta:** dashboard server shrinks by ~1,409 LOC; agent-core grows by ~1,250 LOC; cli changes ~50 LOC; net **−~200 LOC** across the repo, plus collapse from two AgentManager classes to one canonical surface.

---

## Out of scope / known follow-ups

1. **Pipeline-state checkpoint (`pipeline-state.json`) — different concept.** The plan lifts the *per-call* checkpoint cache. The dashboard's pipeline-state checkpoint (resume from stage N after a crash) is orthogonal — it describes which stages have completed, not which agent calls have run. That's the "≤300 LOC façade" / `Pipeline.run()` resume work tracked separately in the dashboard consolidation ADR §6 row 4f.7. **This plan does not touch it.** A future plan can lift it into core-pipeline if cli also wants pipeline-level resume.

2. **Stream-event unification.** Dashboard's `AgentSession` (post-Phase 2) translates `LanguageModel.invokeStream()` events into the dashboard's 5-event surface. A future cleanup could push the typed `StreamEvent` interface all the way through to dashboard consumers — but that breaks D10 (133 messages reference the current event shapes). Defer.

3. **cli's `StageValidator` lift.** `agent-core/src/agent/stage-validator.ts` is cli-specific (it validates stage-output shape against expected templates). It stays in agent-core but isn't called from `AgentSession` — cli wraps `runAgent()` to invoke it post-hoc. A future plan could promote it into a generic `OutputValidator` extension point on `AgentSession`. Defer.

4. **AgentSession cross-process / persistent sessions.** Today `AgentSessionRegistry` is in-process only. Dashboard restart loses all session state. A future plan could persist sessions to SQLite for cross-process resume. Out of scope.

5. **Dashboard's `restart-policy` exposure.** `RestartPolicy` (cli, max-restarts on crash) lifts into `AgentSession` in Phase 5. Dashboard runs with `maxAttempts: 0` today — explicit setting. A future plan could surface this as a per-stage policy in dashboard config. Defer.

6. **Validator-as-step.** cli's `StageValidator` (and dashboard's per-stage post-build guards) could become a generic `validate-step.ts` Step factory. Out of scope here; orthogonal to agent runtime.
