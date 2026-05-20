# `@anvil-dev/dashboard` — Architecture

Reference for what physically lives in `packages/dashboard/server/` +
`packages/dashboard/src/` and how the modules wire together. No
future-tense roadmap content — only what compiles today.

## 1. Single-process layout

```
                 ┌──────────────────────────────────────────────────┐
                 │ Browser (React, Vite-built) — packages/dashboard/src │
                 │   wireToEvent(wire) → dashboardReducer(state, ev) │
                 └──────────────────────────────────────────────────┘
                                       │ WS (/ws) + HTTP (port 5173/7475)
                                       │ + socket.io (/socket.io, env-gated)
                                       ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ dashboard-server.ts (~8,350 LOC) — single-file orchestrator      │
   │   • createServer (HTTP) + WebSocketServer({path:'/ws'})          │
   │   • registers ~150 WS client actions                             │
   │   • boots subsystems: AgentManager, MemoryStore, FeatureStore,   │
   │     KnowledgeBaseManager, PipelinePauseStore, PipelineRunner,    │
   │     CostLedger, BridgedCostLedger, RunStore                      │
   │   • OTel auto-detection (probes Langfuse at localhost:3000/)     │
   │   • PR URL extraction + PR-tracker rollup                        │
   │   • approval-token HTTP handlers (/approve, /reject)             │
   │                                                                  │
   │  ┌──── Phase 2–6 typed event layer ─────────────────────────┐    │
   │  │  services/                  events/                       │    │
   │  │    RunService               types.ts (DashboardEvent ∪)   │    │
   │  │    AgentService             topics.ts (roomsForEvent)     │    │
   │  │    PipelineService          replay.ts (ring buffer)       │    │
   │  │    ReviewService            bridge.ts (legacy adapter)    │    │
   │  │    PlanService              services-bridge.ts (socket.io)│    │
   │  │    TestService              sync-emitter.ts (base class)  │    │
   │  │    BindService                                            │    │
   │  │    IncidentService     ws/                                │    │
   │  │    KbService             socket-server.ts                 │    │
   │  │    CostService             (mountSocketServer w/coexist)  │    │
   │  │    ProjectGraphService                                    │    │
   │  │    SystemService                                          │    │
   │  └───────────────────────────────────────────────────────────┘    │
   └──────────────────────────────────────────────────────────────────┘
       │                    │                    │
       ▼                    ▼                    ▼
   ┌──────────────┐   ┌──────────────────┐   ┌───────────────────┐
   │ AgentManager │   │ PipelineRunner   │   │ MemoryStore /      │
   │ (agent-core) │   │ (server/         │   │ FeatureStore /     │
   │              │   │  pipeline-       │   │ KnowledgeBaseMgr   │
   │ + costHook,  │   │  runner.ts)      │   │ (façades over      │
   │   checkpoint-│◄──┤                  │   │  memory-core /     │
   │   Hook,      │   │ steps/{...}      │   │  cli `anvil index`)│
   │   spawn      │   │                  │   │                   │
   │   override   │   │ buildRegistry,   │   │                   │
   │              │   │ runStageWith-    │   │                   │
   │              │   │ Fallback,        │   │                   │
   │              │   │ allowedTools-    │   │                   │
   │              │   │ ForCurrentStage  │   │                   │
   └──────────────┘   └──────────────────┘   └───────────────────┘
                              │
                              ▼
                  ┌──────────────────────┐
                  │ @anvil/core-pipeline │
                  │  EventBus +          │
                  │  StepRegistry +      │
                  │  Pipeline + hooks    │
                  │  + stage permissions │
                  └──────────────────────┘
```

## 1.1 Typed event flow (Phase 2–6)

```
Handler / Domain logic
  │
  │  services.runs.emit('run.active-snapshot', { runs })
  ▼
SyncEmitter.emit  ──── synchronous dispatch ────► onAny listeners
  │                                                  │
  │                                                  ▼
  │                                       attachLegacyBridge
  │                                          │
  │                                          ├──► roomsForEvent(ev) → topics
  │                                          ├──► replay.append(envelope)
  │                                          └──► toLegacyWire(ev) → broadcast()
  │                                                                    │
  │                                                                    ▼
  │                                              React frontend (raw WS today)
  │
  └──► bridgeServicesToRooms (when socket.io mounted)
        │
        ├──► replay.append(envelope)
        └──► io.to(rooms).emit(legacyType, payload) ──► socket.io clients
```

Key invariants:
- **Single emit path**: domain logic NEVER calls `broadcast(...)` directly; it goes through `services.<X>.emit(kind, payload)`.
- **Sync dispatch**: `SyncEmitter` runs listeners in-line during `emit()` so wire ordering matches a direct `broadcast()` call. Emittery's microtask dispatch would reorder.
- **Topic routing is exhaustive**: `roomsForEvent(ev)` uses `ts-pattern.match(...).exhaustive()` — adding a new kind without a topic map is a compile error.
- **Bridge translates back to legacy**: while the React frontend still consumes `{type,payload}`, the bridge re-emits each typed event into that shape. Phase 7+ frontend swap removes the legacy bridge entirely.

## 2. Workspace imports (verified `grep "from '@anvil"`)

`server/`:
- `@anvil/agent-core` — `AgentManager`, `AgentState`, `ProviderName`
- `@anvil/core-pipeline` — `resolveModelForStage`,
  `allowedToolsForStage`, `permissionClassesForStage`,
  `ModelResolutionError`, `UnknownStageError`
- `@anvil/memory-core` — via local `MemoryStore` façade
- No direct `@anvil/knowledge-core` imports — KB indexing is
  out-of-process via `anvil index` shell-out.

## 3. Pipeline stages (`pipeline-runner.ts:160-170`)

| Index | Name              | Label                  | Persona     | Per-repo |
|-------|-------------------|------------------------|-------------|----------|
| 0     | clarify           | Understanding          | clarifier   | no       |
| 1     | requirements      | Planning requirements  | analyst     | no       |
| 2     | repo-requirements | Repo requirements      | analyst     | yes      |
| 3     | specs             | Writing specs          | architect   | yes      |
| 4     | tasks             | Creating tasks         | lead        | yes      |
| 5     | build             | Writing code           | engineer    | yes      |
| 6     | test              | Generating tests       | test-author | yes      |
| 7     | validate          | Testing                | tester      | yes      |
| 8     | ship              | Shipping               | engineer    | no       |

The validate-fix loop runs up to 3 engineer-fix-then-revalidate
cycles before the stage hard-fails.

## 4. `pipeline-runner.ts` orchestration shell

After Phase 4, the runner delegates every concrete operation to a
helper. The shell keeps:

1. The 9-stage iterator + resume-from-stage support.
2. `runStageWithFallback<T>(stageName, attemptFn)` — chain-fallback
   on retryable `UpstreamError` (max 5 attempts; runtime-burned
   models tracked in `runtimeBurnedModels: Set<string>`).
3. `allowedToolsForCurrentStage(stageName)` — looks up
   `allowedToolsForStage` from `@anvil/core-pipeline` and threads
   the result into every spawn spec so non-Claude agentic adapters
   (Ollama / OpenRouter / OpenCode) get a properly-scoped
   `BuiltinToolExecutor`.
4. After-stage policy gate — loads `pipeline-policy.yaml` and
   pauses on `pause` outcomes via `PipelinePauseStore` +
   broadcasts `pipeline-paused` over WS.
5. Phase B/C/F resume decisions:
   - `modify-artifact` → applies an in-place artifact edit
   - `rerun-from <stage>` → seeks the iterator back to that stage
   - `iterate-with-note <text>` → re-runs current stage with
     reviewer note injected
6. Per-repo fan-out + atomicity:
   `if (failedRepos.length > 0) throw` halts the stage when ANY
   repo fails (was: only when ALL failed).
7. Stage-specific pre/post hooks: `createFeatureBranches` (build),
   `runPostBuildGuards` (validate), `pullBaseBranchForRepos`,
   `deployProject` (ship), repo-detect (requirements).
8. WS broadcast on every stage entry / exit / cost update / state
   change — vocabulary documented at the WS section below.

## 5. Step factories + helpers (`server/steps/`)

| Module                       | Responsibility |
|------------------------------|----------------|
| `agent-spawner.ts`           | `spawnAndWait`, `waitForAgent` — owns the `AgentManager.spawn` call shape |
| `per-repo-stage.step.ts`     | Generic per-repo Step + `runPerRepoStageForRepo` + `disallowedToolsForPersona` |
| `per-repo-build.step.ts`     | Per-task fanout for the build stage (`runBuildForOneRepo`) |
| `clarify-stage.step.ts`      | Explore + Q&A + synthesize compose (`runClarifyForProject`) |
| `clarify.step.ts`            | Q&A loop in isolation (`createClarifyStep`) |
| `feature-manifest.step.ts`   | `FEATURE-MANIFEST.json` extraction |
| `plan-risk.step.ts`          | `PLAN-RISK.json` scorer |
| `task-bundler.step.ts`       | `TASK-BUNDLES.json` generator |
| `test-gen-stage.step.ts`     | Deterministic test-spec generator (`runTestGenForProject`) |
| `fix-loop.step.ts`           | Validate-failure → engineer-fix loop (`runFixLoop`, `hasValidationFailures`) |
| `workspace-ops.ts`           | `pullBaseBranchForRepos`, `runPostBuildGuards`, `deployProject`, `createFeatureBranches` |
| `prompt-builders.ts`         | Project / repo / clarify-explore / stage / per-task system + user prompts |
| `cost-budget.hook.ts`        | Per-step cost-budget enforcement |
| `build-registry.ts`          | `buildDashboardStepRegistry` for `Pipeline.run` wiring |

Every spawn site in `pipeline-runner.ts` follows the same shape:

```ts
const result = await this.runStageWithFallback(stage.name, (model) => spawnAndWait({
  // …
  model,
  allowedTools: this.allowedToolsForCurrentStage(stage.name),
}));
```

The `model` parameter is re-resolved per attempt by
`runStageWithFallback` so the second attempt picks the next chain
entry that's NOT in `runtimeBurnedModels`.

## 6. Provider matrix (`server/provider-registry.ts`)

Discovery toggles on env-var presence. Each provider declares display
name, env-var key, model list with capability tags + tier hints, and
a setup hint string consumed by the Settings UI.

| Provider     | Env var                                | Tier     | Notes |
|--------------|----------------------------------------|----------|-------|
| Claude (CLI) | —                                      | agentic  | `claude --version` probe |
| OpenAI       | `OPENAI_API_KEY`                       | function-calling | GPT family + o-series |
| Gemini       | `GOOGLE_API_KEY` / `GEMINI_API_KEY`    | function-calling | HTTP API |
| Gemini CLI   | —                                      | agentic  | `gemini --version` probe |
| OpenRouter   | `OPENROUTER_API_KEY`                   | agentic  | `org/model` slug ids |
| Ollama       | —                                      | agentic  | probes `localhost:11434`; embeddings + reranker too |
| OpenCode Go  | `OPENCODE_API_KEY`                     | agentic  | Replaces Ollama as cheap local-tier when subscribed; `opencode/<model>` ids |

`OpenCodeAdapter` extends `OpenRouterAdapter` (same SSE protocol,
same agentic loop, same `reasoning_details` echo-back for thinking
models). It defaults to `https://opencode.ai/zen/go/v1` and
overrides via `OPENCODE_BASE_URL`.

## 7. WS protocol surface

Major message families (search `case '...'` in
`dashboard-server.ts`):

- `start-pipeline` / `cancel-pipeline-run` / `resume-pipeline-run` /
  `replay-run`
- `list-projects` / `select-project` / `list-features` /
  `select-feature`
- `memory-add` / `memory-replace` / `memory-remove` /
  `memory-list-with-meta`
- `kb-status` / `kb-refresh` / `kb-cancel` / `kb-list-projects`
- `list-pipeline-pauses` / `get-pipeline-pause` / `resume-pipeline` /
  `cancel-pipeline-pause`
- `get-pipeline-policy` / `set-pipeline-policy`
- `discover-providers` / `set-env-var` / `test-auth`
- `run-fix` / `run-spike` / `run-review`
- `list-active-runs` / `kill-agent`

`set-env-var` only accepts keys in `ALLOWED_ENV_KEYS`.
`test-auth` has a per-provider branch (e.g. `opencode` does
`GET /v1/models` with the Bearer token).

## 8. Storage layout

```
~/.anvil/
├── adapters/                   # Provider adapter configs (factory.yaml refs)
├── checkpoints/                # PipelineRunner checkpoints (resume support)
├── features/<project>/<slug>/  # Feature artifacts (CLARIFICATION.md, …)
├── memories/v2/                # memory-core JSONL + SQLite
├── pipeline-pauses/            # PipelinePauseStore JSON files
├── projects/                   # Per-project workspace + factory.yaml
├── runs/<runId>/audit.jsonl    # Per-run audit log
└── spend/                      # SpendLedger SQLite (agent-core)
```

The dashboard's `CostLedger` (NDJSON, per-run + daily-rollup) and
`agent-core`'s `SpendLedger` (SQLite, queryable + indexed) stay
separate. `BridgedCostLedger` mirrors `record()` calls into both
(see README "Cost ledger bridge").

## 9. Concurrency-safety contract

The dashboard frequently runs N agents in parallel (per-repo backend
+ frontend during the build stage). Constraints inherited from
`@anvil/agent-core`:

1. **Adapter singletons are concurrency-safe.** Every adapter that
   the dashboard touches (`Ollama`, `OpenRouter`, `OpenCode`,
   `Claude`) keeps a `Set<AbortController>` so `kill()` fires only
   the in-flight calls. A naive instance-level `abortController`
   gets trampled by the second call — that bug was the cause of
   "Cannot read properties of null (reading 'signal')" mid-run.
2. **PR URL extraction is lossy without `tool_result` activity.**
   The bridge now emits `kind:'text'` for each `tool_result`
   (capped at 4 KB) so `extractPRUrls(content)` can scan it.
3. **Buffered stream writes.** Adapters buffer SSE deltas until '\n'
   or ~80 chars before flushing — without it the dashboard activity
   log shows one token per row.

## 10. File layout

```
packages/dashboard/
├── README.md
├── CLAUDE.md
├── ARCHITECTURE.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── server/
│   ├── dashboard-server.ts          ← entry; HTTP + WS + subsystems
│   ├── pipeline-runner.ts           ← per-run orchestrator
│   ├── steps/                       ← Step factories + helpers
│   ├── provider-registry.ts         ← Settings UI discovery
│   ├── provider-liveness.ts         ← chain-walk picker
│   ├── memory-store.ts              ← façade over memory-core
│   ├── feature-store.ts             ← feature artifacts
│   ├── knowledge-base-manager.ts    ← shells out to `anvil index`
│   ├── model-tier-resolver.ts       ← tier→model mapping
│   ├── pipeline-pause-store.ts      ← persistent paused state
│   ├── pipeline-bus-subscriber.ts   ← core-pipeline EventBus bridge
│   ├── cost-ledger.ts + cost-bridge.ts ← per-run + bridge to SpendLedger
│   ├── pipeline-audit-log.ts
│   ├── feature-manifest*.ts
│   ├── engineer-task-bundler.ts + engineer-spec-slicer.ts
│   ├── plan-risk-scorer.ts
│   ├── prompt-budget.ts
│   ├── ... (~80 .ts modules total)
│   └── __tests__/
└── src/
    ├── main.tsx                     ← React mount
    ├── router.tsx
    ├── components/
    │   ├── output/                  ← activity log, change diffs
    │   ├── history/                 ← run history + PR list
    │   ├── settings/
    │   ├── kb/
    │   └── …
    ├── context/
    ├── hooks/
    ├── lib/
    └── styles/
```

## 11. Tests

```
npm -w @anvil-dev/dashboard run test:server
```

Compiles `server/tsconfig.json` then runs `node --test` on every
`server/out/__tests__/*.test.js`. Six pre-existing failures
(project-loader.getModelForStage, applyConventionFilter ×3,
review-evidence-gate.precedent) are tracked under the
"IDE-Jest false-positive" memory note — trust the `node --test`
exit code, not the IDE markers.

## 12. Boundaries

- The dashboard does NOT import `@anvil/knowledge-core` directly.
  KB ops shell out to the cli (`KnowledgeBaseManager`) so indexing
  runs out-of-process and can't crash the WS server.
- The dashboard does NOT vendor any LLM SDK. All model work routes
  through `AgentManager` → adapter → provider.
- The dashboard's `pipeline-runner.ts` is allowed to import from
  `@anvil/core-pipeline` for stage-permission lookups
  (`allowedToolsForStage`, `permissionClassesForStage`) but does
  NOT use `Pipeline.run()` for end-to-end orchestration yet — the
  `Pipeline.run()` resume support required for that move is
  tracked in `CORE-PIPELINE-CONSOLIDATION-PLAN.md`.

## 13. Durable execution + policy (v0.3.0)

### Server boot wiring

```
dashboard-server.ts startup
  ▼
createDashboardStores({anvilHome})           ← every store
  ▼
mountSocketServer({coexistWithRawWs:true})
  ▼
attachLegacyBridge + attachServicesBridge
  ▼
bootDurable({startPipeline, stagesByName})    ← NEW (setup/durable.ts)
  │  runDurableMigration(store, {onTakeover})  Phase D3+F4 sweep
  │  dispatchTakenOverRuns(store, ids, …)      Phase G1 auto-resume
  │  scheduleDurableVacuum(store)              Phase F3 retention
  ▼
listenAndReturnHandle({...})                  ← serves HTTP+WS
```

### Per-run lease wiring (pipeline-runner.ts)

```
runner.run()
  ▼
durableStore = getDurableStore()              singleton, ~/.anvil/durable.db
durableHolder = durableHolderId()             `${pid}@${hostname}`
  ▼
durableStore.createRun({runId, project, feature, ...})
durableStore.acquireLease(runId, durableHolder, 60_000)
durableStore.updateRunStatus(runId, 'running', null)
durableHookHandle = attachDurableLogHook(bus, store, runId, holder)
leaseManager = new LeaseManager({store, runId, holder, ttlMs:60_000})
leaseManager.on('lost', () => this.cancel())  ← peer takeover signal
  ▼
Pipeline.run({durableStore, durableHolder, ...})
  ▼
on terminal status:
  durableStore.updateRunStatus(runId, 'completed'|'failed'|'cancelled')
  durableStore.releaseLease(runId, holder)
  leaseManager.stop()
  durableHookHandle.unsubscribe()
```

### Q&A signal wiring

```
StageQuestionsPanel.tsx
  ws.send({action:'provide-stage-answer', stageIndex, repoName?,
           questionIndex, text})
        │
        ▼
handlers/durable.ts:49 (Zod-validated)
  runner.provideStageAnswer(stageIndex, repoName, questionIndex, text)
        │
        ▼
PipelineRunner.provideStageAnswer
  questions[i].answer = text                   ← state mutation
  broadcastState()                             ← wire 'state' event
  stageInputResolvers.get(key).resolve(...)    ← in-process unblock
  durableStore.enqueueSignal(
    runId,
    stageAnswerChannel(stageIndex, repoName),  ← per-(stage,repo) channel
    answersBlock)                              ← cross-process replay
        ▲
        │
Step body in pipeline-stages.ts:
  await Promise.race([
    ctx.waitForSignal<string>(stageAnswerChannel(idx, repoName)),
    new Promise(resolve => deps.setStageInputResolver(idx, repoName, resolve)),
  ])
```

`stageAnswerChannel(stageIndex, repoName)` returns
`stage-answer-<idx>` for project-level, `stage-answer-<idx>:<repo>`
per-repo. Both halves use the helper from `pipeline-runner.ts`.

### Policy + pause flow

```
After-stage hook (start-pipeline.ts:282)
  ▼
loadPolicy(project, anvilHome)
  │  v0.3.0: returns BUILTIN_DEFAULT_POLICY when no yaml exists.
  │  Default has `enabled:false` so vanilla runs never pause.
  ▼
stageAsPipelineStage = mapStageToPolicy(stage.name)
  ▼
evaluatePolicy(policy, {stage, touchedFiles, riskTier, confidence})
  │  decision.pause → true | false
  ▼
if pause:
  pauseStore.pause({runId, project, stage, reason, reviewers, timeoutHours})
  services.pipeline.emit('pipeline.paused', {pause})
        │  ↓ legacy bridge → wire 'pipeline-paused' → socket.io emit
        ▼
Frontend (usePausedRuns hook)
   activePause = pauses.find(p.runId === urlRunId)
   <PausedBanner data={activePause} />
        │
        ▼ user clicks Review
   <PlanReviewModal />
   User chooses Approve | Reject | Modify | Iterate | Rerun
        │
        ▼
   ws.send({action:'resume-pipeline', runId,
            decision: {action, note?, editedArtifact?, rerunFromStage?}})
        │
        ▼
handlers/runs-pipeline.ts:58 (disambiguates on msg.decision)
   handleResumePipeline(pauseStore, msg, user)
        │
        ▼
After-stage hook's polling loop (setInterval, 1s)
   detects status !== 'paused-awaiting-user' → resolves
        │
        ▼
Post-resolve actions:
   action==='cancel'           → throw → run fails
   final.resumeDecision.note   → runner.setReviewNote(note)
   action==='modify-artifact'  → runner.applyArtifactEdit(stageIndex, edited)
   action==='rerun-from'       → runner.requestRerunFromStage(target)
   default                     → next stage runs
```

### Stage name → policy taxonomy

| Pipeline stage name | Policy taxonomy |
|---|---|
| `clarify` | `plan` |
| `requirements` | `plan` |
| `repo-requirements` | `plan` |
| `specs` | `plan` |
| `tasks` | `plan` |
| `build` | `implement` |
| `test` | `test` |
| `validate` | `test` |
| `ship` | `ship` |

### RunId alignment (v0.3.0)

A run has ONE id used everywhere:

```
start-pipeline.ts:180 → pipelineRunId = 'build-<base36>'
   ↓ passed as config.runId
new PipelineRunner(..., {runId: pipelineRunId, ...})
   ↓ used as this.state.runId
durableStore.createRun({runId: pipelineRunId})
pauseStore.pause({runId: pipelineRunId})
auditLog.record({runId: pipelineRunId})
activeRuns.set(pipelineRunId, ...)
URL: /run/${pipelineRunId}
```

(Pre-v0.3.0 the runner generated its own `run-<base36>` so pauses,
durable events, and audit logs lived under a *different* id than
the activeRuns map + URL. PausedBanner could never resolve. Fixed
by threading `config.runId` through the constructor — see
`PipelineConfig.runId?: string` in `pipeline-runner-types.ts`.)

### Frontend surfaces added (v0.3.0)

| Component | Purpose | Wire actions |
|---|---|---|
| `src/components/policy/PolicyPage.tsx` | `/policy` route — master toggle, pause stages, auto-approve thresholds, Q&A budget | `get-pipeline-policy`, `update-pipeline-policy` |
| `src/components/policy/usePolicy.ts` | Hook that loads + saves overlay JSON | same |
| `src/components/policy/policy-copy.ts` | Centralised copy strings | — |
| `src/components/history/DurableTimeline.tsx` | Per-run event log under `RunDetail → Durable execution log` disclosure | `get-durable-timeline` |
| `src/components/pipeline/StageQuestionsPanel.tsx` | In-flight agent Q&A cards | `provide-stage-answer` |
| `src/components/pipeline/PausedBanner.tsx` | Orange bar at top of run view when pause is active | — (state) |
| `src/components/pipeline/PlanReviewModal.tsx` | Approve / Reject / Modify / Iterate / Rerun modal | `resume-pipeline` (with `decision`) |

### Server WS handlers added (v0.3.0)

| Action | File | Behavior |
|---|---|---|
| `get-durable-timeline` | `handlers/durable.ts` | Returns `{run, events}` from durable store |
| `provide-stage-answer` | `handlers/durable.ts` | Routes to `runner.provideStageAnswer` + enqueues durable signal |
| `resume-pipeline` (pause variant) | `handlers/runs-pipeline.ts:58` | Dispatches on `msg.decision`: pause-flow vs replay-flow |
| `cancel-pipeline-pause` | `handlers/pauses.ts:34` (pre-existing) | Forwards to `handleCancelPause` |
| `get-pipeline-policy` / `update-pipeline-policy` | `handlers/cost.ts:101,116` (pre-existing) | Loads + saves overlay JSON |
| `list-replay-queue` | `handlers/incidents.ts:37` (pre-existing) | Snapshot from auto-replay queue |

### Env knobs

| Env | Default | Effect |
|---|---|---|
| `ANVIL_DURABLE_DISABLED=1` | unset | Skip durable persistence entirely |
| `ANVIL_DURABLE_AUTO_TAKEOVER=0` | unset | Don't claim orphan leases at boot |
| `ANVIL_DURABLE_AUTO_RESUME=0` | unset | Don't dispatch resumes after takeover |
| `ANVIL_DURABLE_VACUUM_DISABLED=1` | unset | Skip retention sweep |
| `ANVIL_DURABLE_RETENTION_DAYS` | `30` | Days before terminal runs get vacuumed |
