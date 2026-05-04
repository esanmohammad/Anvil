# `@anvil-dev/dashboard` — Architecture

Reference for what physically lives in `packages/dashboard/server/` +
`packages/dashboard/src/` and how the modules wire together. No
future-tense roadmap content — only what compiles today.

## 1. Single-process layout

```
                 ┌──────────────────────────────────────────────────┐
                 │ Browser (React, Vite-built) — packages/dashboard/src │
                 └──────────────────────────────────────────────────┘
                                       │ WS + HTTP (port 5173 / 7475)
                                       ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ dashboard-server.ts (~6000 LOC) — single-file orchestrator       │
   │   • createServer (HTTP) + WebSocketServer                        │
   │   • registers ~50 WS message handlers                            │
   │   • boots subsystems: AgentManager, MemoryStore, FeatureStore,   │
   │     KnowledgeBaseManager, PipelinePauseStore, PipelineRunner,    │
   │     CostLedger, BridgedCostLedger, RunStore                      │
   │   • OTel auto-detection (probes Langfuse at localhost:3000/)     │
   │   • PR URL extraction + PR-tracker rollup                        │
   │   • approval-token HTTP handlers (/approve, /reject)             │
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
