# CLAUDE.md — `@anvil-dev/dashboard`

Guidance for Claude Code when working inside `packages/dashboard/`. The
dashboard is the WebSocket+HTTP server that drives Anvil's per-run
pipeline orchestrator, plus the React UI rendered against it. Single
process, single file orchestrator (`server/dashboard-server.ts`).

## What this package owns

- **`server/dashboard-server.ts`** (~6000 LOC) — boots HTTP+WS, handles
  ~50 WS message types, instantiates `AgentManager` /
  `MemoryStore` / `PipelineRunner` / `PipelinePauseStore`, owns the
  `prUrls` / `costLedger` / `runStore` rollups. Single-file by design
  — splitting it has been deferred until the WS event vocabulary
  (D10) is locked.
- **`server/pipeline-runner.ts`** (~600 LOC) — per-run orchestrator
  shell. Owns the `PipelineRunner` class: state, public API
  (`setReviewNote` / `applyArtifactEdit` / `requestRerunFromStage` /
  `iterateCurrentStageWithNote` / `provideInput` / `provideStageAnswer`
  / `getStageQuestions` / `setQAPolicy` / `cancel` / `getState` /
  `setAfterStageHook` / `checkpoint`), the constructor +
  workspace bootstrap, six `depsForX()` bag builders, and a thin
  `run()` body that calls `prepareRun` → `attachPipelineHooks` →
  `runPipelineLoop`. The actual stage logic lives in siblings. Q&A
  routing uses a per-(stageIndex, repoName?) `stageInputResolvers`
  Map that fires once every question for the (stage, repo) has an
  answer.
- **`server/pipeline-stages.ts`** — `runOneStage` (the per-stage
  dispatcher: resume skip, planSeed branch, dispatch to
  clarify/perRepo/single, validate→fix loop, after-stage hook,
  reviewer rerun, ship deploy) + 7 sub-functions (`runClarifyStage`,
  `runPerRepoStage`, `runBuildForRepo`, `runSingleStage`,
  `runStageWithQA`, `runTestGenStage`, `runFixLoop`) + `makeAgentSession`
  / `makeAgentRunner` factories + `resetStagesForRerun`. Each free
  function takes a `StageOpsDeps` opts bag bundling state, config,
  side-effect hooks. Control-flow exits (`continue` / `next` /
  `cancelled` / `fail-early-return` / `rewind`) flow back to
  `pipeline-loop.ts` which translates them to walker sentinels.
  `STAGES_WITH_QA = {requirements, repo-requirements, specs}` —
  hard-coded scope for Q&A; agents in those stages may ask up to
  `policy.qa.maxQuestionsPerStage` clarifying questions before
  producing the artifact.
- **`server/pipeline-loop.ts`** — `runPipelineLoop(opts)` drives
  `Pipeline.run()` from core-pipeline over an `InMemoryStepRegistry`
  built per iteration. Each Step's `runStage` callback delegates to
  `runOneStage(stageOps, …)`; the loop translates control flags to
  thrown sentinel errors (`__anvilCancel` / `__anvilFailReturn` /
  `__anvilRewind`) so reviewer rewind re-invokes `Pipeline.run`
  with `rewindTo`. Hosts the `step:skipped` listener that renders
  plan-derived artifacts back into the loop's `prevArtifact` slot.
- **`server/pipeline-hooks.ts`** — `attachPipelineHooks(deps)` wires
  the canonical core-pipeline lifecycle hooks (audit log, cost
  tracker, stream debounce, file checkpoint, dashboard-state rollup,
  liveness prefetch). Returns a `{ detach() }` thunk that flushes +
  unsubscribes everything in one call.
- **`server/runner-prep.ts`** — `resolveWorkspaceDir(project)` reads
  factory.yaml / project.yaml workspace override (env-var + default
  fallback). `prepareRun(deps)` owns run()'s pre-loop block: feature
  record creation/resume, manifest ensure + plan-seed pre-fill, prior
  artifact load, hybrid-context prefetch, KB warning/event surfacing.
- **`server/manifest-bridge.ts`** — manifest helpers for the runner:
  `populateManifestFromPlan`, `renderPlanDerivedArtifact`,
  `extractAndUpdateManifest`, `clearManifestFieldsForStages`,
  `manifestGetTouchedFiles`, plus a `PlanRiskCache` class.
- **`server/model-resolution.ts`** — `resolveModelForStage`,
  `pickModelForStage`, `allowedToolsForCurrentStage`,
  `recordResolvedStageState`, `prefetchProviderLiveness`. The
  resolution chain (factory.yaml override → registry → ANVIL_LOCAL_MODEL
  → modelTier → `config.model`) lives here.
- **`server/runner-telemetry.ts`** — `ensureAuth` (auth gate +
  browser re-login flow), `writePerRepoTelemetry`,
  `handleOutputTruncation`, `aggregateRunTokens`, `logCacheTelemetry`.
- **`server/claude-auth.ts`** — `checkClaudeAuth` + `refreshClaudeAuth`
  shell-out helpers (Claude CLI `auth status` + `auth login`).
- **`server/pipeline-bootstrap.ts`** — `setupWorkspace`,
  `getBaseBranch`, `pullLatestMain`, `detectRepos`. Workspace + repo
  discovery flows through `BootstrapDeps`.
- **`server/artifact-io.ts`** — `loadPriorArtifacts`,
  `loadStageArtifact`, `loadRepoArtifacts`, `loadHighLevelRequirements`,
  `writeStageArtifact`, `writeRepoArtifact` over the feature store.
- **`server/prompt-context-cache.ts`** — `PromptContextCache` owns
  per-run memoised inputs to the system prompt (memory block,
  conventions, project YAML slice, KB block, manifest). Same bytes
  across every stage so the provider prompt cache fires.
- **`server/reviewer-control.ts`** — `ReviewerControl` is the pure
  state machine for reviewer pause/note/edit/rerun-from/iterate. The
  runner owns the FS / state-mutation side effects of these actions;
  this helper owns the slot tracking.
- **`server/pipeline-checkpoint.ts`** — `writePipelineCheckpoint` +
  `clearPipelineCheckpoint` over the feature store's
  `pipeline-state.json`.
- **`server/pipeline-runner-types.ts`** — type declarations +
  module-level constants (`STAGES`, `STAGE_OUTPUT_LIMITS`,
  `LOCAL_TIER_STAGES`, `PLAN_DERIVED_STAGES`, token-stat helpers,
  checkpoint reader, `AfterStageHook` contract, `StageQuestion` type
  + `questions?: StageQuestion[]` slot on `PipelineStageState` /
  `RepoAgentState`).
- **`server/pipeline-policy.ts`** — `loadPolicy(project)` always
  returns a `PipelinePolicy` (never `null`). When no
  `~/.anvil/projects/<slug>/pipeline-policy.yaml` exists, returns
  `BUILTIN_DEFAULT_POLICY` (`enabled: true`, `pauseAfter: ['plan']`,
  `autoApproveIfRisk: 'low'`, `autoApproveIfConfidence: 0.85`,
  `qa: { enabled: true, maxQuestionsPerStage: 5 }`,
  `cost: { onBreach: 'ask', perRun: 10, perProjectDaily: 30 }`).
  `applyOverlay` layers `pipeline-policy.overlay.json` (managed by
  the `/policy` page) on top of yaml/builtin. `evaluatePolicy`
  short-circuits to `{pause: false, reason: 'disabled'}` when
  `policy.enabled === false`.
- **`server/pipeline-policy-validate.ts`** — `validatePolicyPatch`
  enforces every overlay-writable field (`enabled`, `defaults.*`,
  `cost.*`, `notifications.*`, `qa.*`); `deepMergeOverlay` is the
  shallow-on-top + deep-merge-known-blocks helper used by the
  `update-pipeline-policy` WS handler.
- **`server/steps/`** — Step factories + pure helpers extracted out
  of `pipeline-runner.ts` over the Phase-4 series. See README §
  "Pipeline runner shape (Phase 4)" for the full module table.
- **`server/runners/`** — adapters that satisfy the canonical
  `AgentRunner` / `AgentSession` interfaces (from `core-pipeline`)
  over the dashboard's heavyweight `AgentManager`:
    - `agent-manager-runner.ts` — `AgentManagerRunner` is the one-shot
      runner. Wraps `spawnAndWait` + `runWithChainFallback`. Used by
      `pipeline-stages.ts` for single-stage / per-repo / per-task
      delegations (constructed via `makeAgentRunner(deps, stageName)`).
    - `agent-manager-session.ts` — `AgentManagerSession` is the
      multi-turn session. Wraps `agentManager.spawn` for `start()` and
      `agentManager.sendInput + waitForAgent` for `sendInput()`. Used
      by clarify (explore→Q&A→synthesize) and fix-loop (resume across
      attempts). Constructed via `makeAgentSession(deps)`.
- **`server/provider-registry.ts`** — discovery layer for the Settings
  UI. Reports each provider's display name, env var, model list,
  setup hint. Visibility toggles on env-var presence.
- **`server/provider-liveness.ts`** — thin re-export shim over
  `@esankhan3/anvil-agent-core`'s provider-liveness module. The
  implementation moved to agent-core so cli + dashboard share one
  module-scoped probe cache.
- **`server/memory-store.ts`** — thin façade over
  `@anvil/memory-core`'s `HybridMemoryStore`, with the dashboard's
  legacy markdown-migration path on first read/write.
- **`server/feature-store.ts`** — owns
  `~/.anvil/features/<project>/<slug>/` artifacts (CLARIFICATION.md,
  REQUIREMENTS.md, …).
- **`server/knowledge-base-manager.ts`** — wraps the cli's `anvil index`
  command so KB indexing runs out-of-process.
- **`src/`** — React + Vite frontend. Mounts on the WS server's port,
  renders run history, change diffs, activity log, KB graph, settings,
  and the dedicated `/policy` page (`src/components/policy/`:
  `PolicyPage`, `usePolicy` hook, `policy-copy.ts` string library) +
  the inline Q&A panel (`src/components/pipeline/StageQuestionsPanel`)
  that mounts in the right pane of `PipelineContainer` whenever a
  selected stage has unanswered questions. Phase-4 pipeline event
  vocabulary is rendered by `src/components/output/`.

## Build + test

```sh
npm -w @anvil-dev/dashboard run build       # tsc + Vite
npm -w @anvil-dev/dashboard run test:server # node --test on server out/
npm -w @anvil-dev/dashboard run dev         # Vite frontend on 5173
node packages/dashboard/server/dashboard-server.js   # WS+HTTP backend
```

The build copies `server/` `.ts` to `server/out/` (TypeScript with
NodeNext modules). Some `.js` sit in `server/` itself (committed
artifacts for the cli to invoke via `dynamic import` without a
build step on the user's machine).

## Conventions

### Per-stage tool permissions

Every spawn call in `pipeline-stages.ts` MUST thread
`allowedTools: deps.allowedToolsForCurrentStage(stageName)` into the
spawn spec — `LanguageModelBridge` reads this to scope the
`BuiltinToolExecutor` for non-Claude agentic adapters
(Ollama / OpenRouter / OpenCode). The five spawn sites are:
`runClarifyForProject` (in `runClarifyStage`), generic per-repo
(`runPerRepoStage` body), per-repo build (`runBuildForOneRepo` via
`runBuildForRepo`), single-stage (`runSingleStage` body), and fix-loop
(`runFixLoop`). Forgetting one is the canonical "qwen ran but produced
no diff" symptom.

### Chain-fallback on retryable upstream errors

`runWithChainFallback(opts, attempt)` (canonical, in core-pipeline;
max attempts from `walker.max_attempts` in `~/.anvil/models.yaml`,
default 5) wraps the clarify + fix-loop spawn sites in
`pipeline-stages.ts`. The other per-repo / single / build spawn sites
flow through `AgentManagerRunner` which has the same fallback baked in
(see `server/runners/agent-manager-runner.ts`). When the inner attempt
throws an `UpstreamError`-shape (duck-typed:
`name === 'UpstreamError' && retryable === true`), the failing model
is added to `runtimeBurnedModels` and the stage's chain re-resolves
via `pickAliveModelFromChainSync(..., excludeModels=runtimeBurnedModels)`.
The 429/quota burst on Alibaba upstream for `qwen3.5-plus` (an
OpenCode→upstream provider quota issue, not the user's) is the
canonical case this guards.

The chain walker is reactive (post-failure burn) **plus** proactive
(pre-call liveness probe). `prefetchProviderLiveness` (in
`model-resolution.ts`) loads the walker block + probes every distinct
provider in `~/.anvil/models.yaml`'s `models:` array (auto-derived —
no hardcoded list). It's invoked once on `pipeline:started` via the
canonical `attachLivenessPrefetchHook` wired by
`attachPipelineHooks`. Cloud probes are env-var-presence only
(`ANTHROPIC_API_KEY`, `OPENCODE_API_KEY`, etc.); Ollama hits
`localhost:11434/api/tags`; ADK probes the union of Anthropic+Gemini
keys (it dispatches to either). Probe results cache for
`walker.liveness_ttl_ms` (default 30000ms; set to 0 to disable
caching). Probe + chain-walker live in `server/provider-liveness.ts`.

### Per-repo stage atomicity

When a per-repo step fans out across N repos and any one repo fails,
the stage halts (in `pipeline-stages.ts:runPerRepoStage`):

```ts
if (failedRepos.length > 0) throw new Error(`stage ${stage.name} failed for ${failedRepos.length} repo(s)`);
```

The earlier behavior — only halting when ALL repos failed — silently
advanced with a half-written codebase.

### PR URL extraction from `tool_result`

`gh pr create`'s URL appears in the agent's `tool_result` content,
not in a top-level text block. The bridge's `handleUserBlocks` emits
a `kind:'text'` activity for each `tool_result` (capped at 4 KB) so
the dashboard's `extractPRUrls(content)` scanner picks it up. The
URL lands in the active run's `prUrls: Set<string>` and surfaces in
the run-history detail view as soon as `gh pr create` returns.

### Tool-naming convention in the Changes panel

Filter uses `Set` dispatch to accept BOTH Claude-CLI PascalCase
(`Edit`, `Write`, `file_path`) AND `BuiltinToolExecutor` snake_case
(`edit`, `write_file`, `path`):

```ts
const editTools  = new Set(['Edit', 'edit']);
const writeTools = new Set(['Write', 'write_file']);
const filePath   = input.file_path ?? input.path;
```

Without this, file changes from non-Claude adapters never render.

### `ALLOWED_ENV_KEYS` (the WS env-write contract)

`set-env-var` only writes keys present in `ALLOWED_ENV_KEYS`
(`server/dashboard-server.ts`). Adding a new provider env var
requires adding it here; otherwise the Settings UI cannot persist
the value.

Currently allowed (highlights):
- `OPENCODE_API_KEY`, `OPENCODE_BASE_URL`
- `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` /
  `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`
- `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
  `OTEL_RESOURCE_ATTRIBUTES`
- `ANVIL_OTEL_CONSOLE`, `ANVIL_OTEL_DISABLED`,
  `ANVIL_OTEL_RECORD_CONTENT`, `ANVIL_ENV`

`test-auth` has a dedicated branch per provider (e.g. `opencode`
issues `GET /v1/models` with the Bearer token).

### OTel auto-detection

On startup `autoDetectTelemetry()` probes `localhost:3000` (HEAD on
`/`, ~800 ms). If alive AND the user hasn't already set
`OTEL_EXPORTER_OTLP_ENDPOINT`, the dashboard auto-wires it to
`localhost:3000/api/public/otel/v1/traces` so the local Langfuse
stack at `infra/observability/docker-compose.yml` lights up with
zero config. `ANVIL_OTEL_DISABLED=1` short-circuits the probe;
`ANVIL_OTEL_CONSOLE=1` dumps spans to stderr.

### Pipeline policy is on by default

`loadPolicy` never returns `null` — every project gets
`BUILTIN_DEFAULT_POLICY` when no yaml exists, which gates a pause
after Plan. The `setAfterStageHook` in `dashboard-server.ts` checks
`policy.enabled === false` (master switch) instead of `if (!policy)`.
Power users still keep yaml authority — the dashboard only writes to
`pipeline-policy.overlay.json`, layered on top of yaml. To disable
pauses for a project from the UI, the `/policy` page writes
`{ enabled: false }` to the overlay; reverse via the master switch.

### Stage Q&A flow

When `policy.qa.enabled !== false` AND the stage is in `STAGES_WITH_QA`
(`requirements` / `repo-requirements` / `specs`), `runSingleStage`
delegates to `runStageWithQA(deps, ...)`. That helper:
1. Spawns a multi-turn `AgentManagerSession` with the prompt prefixed
   by `STAGE_QA_PROMPT_HEADER(maxQuestions)` from core-pipeline.
2. Reads the first response. `parseStageQuestions(text, max)` looks for
   `<questions>...</questions>`; missing = agent confident, first
   response IS the artifact (return immediately).
3. If questions present: populate `state.stages[i].questions = [...]`,
   set status `'waiting'`, broadcast `stage-question` per question,
   register a per-stage resolver via
   `deps.setStageInputResolver(stageIndex, repoName, resolve)`.
4. Once every question is answered (via `provideStageAnswer` from the
   `provide-stage-answer` WS handler), the resolver fires with the
   formatted `<answers>` block. The session resumes with
   `session.sendInput(...)`; the second response is the artifact.

The `qaPolicy` snapshot is loaded once before `run()` starts via
`runner.setQAPolicy(loadPolicy(project, ANVIL_HOME).qa)`. Confident
agents skip Q&A entirely with no extra prompt-token cost (the header
is always added but the agent self-decides whether to ask).

### Project-prompt cache invariants (P1)

`buildProjectPromptHelper` / `buildRepoProjectPromptHelper` (in
`@esankhan3/anvil-core-pipeline`) read their stable inputs from the
runner's `PromptContextCache` (memory block, conventions, project
YAML slice, KB block, manifest — all memoised per run so the
provider prompt cache fires across stages). Mutating these inputs
mid-run breaks reproducibility — only invalidate on explicit
`promptCache.invalidateManifestBlock()` (called by manifest-bridge
when an extractor patches a field).

## Things that don't exist in this package (intentionally)

- No legacy if-tree orchestrator. The dashboard rides on
  `@anvil/core-pipeline` indirectly (via `pipeline-runner.ts`'s Step
  factories). The cli still has the legacy if-tree and the
  consolidation is in flight (see `CORE-PIPELINE-CONSOLIDATION-*.md`
  at the repo root).
- No feature flags. Per the dashboard-consolidation rule we don't
  gate behavior changes on flags — branch-parity diff replaces
  flag-gated rollout (see `feedback_no_feature_flags_dashboard_consolidation`
  in user memory).
- No vendor LLM SDK imports. All provider work routes through
  `@anvil/agent-core`'s `AgentManager`.
- No reimplementation of indexing / retrieval. `KnowledgeBaseManager`
  in `server/knowledge-base-manager.ts` is a thin wrapper: it
  dynamic-imports `@esankhan3/anvil-knowledge-core`'s `KnowledgeIndexer`
  + `getRetriever` for chunking, AST graph build, embeddings, LanceDB,
  and hybrid retrieval. The dashboard owns only the lifecycle layer on
  top — `origin/main` SHA resolution + detached `git worktree` so the
  user's working tree isn't touched, `getRepoStatus` / `getStatus` for
  the Project Overview UI (reads knowledge-core's `index_meta.json` for
  `lastIndexedSha` / `lastIndexedAt`), `SYSTEM_REPORT.md` deterministic
  synthesis (cheap companion to knowledge-core's LLM-driven
  `PROJECT_SUMMARY.md`), `project_index.json` compact keyword index for
  prompt injection, yaml-based transport extraction, and the in-flight
  hybrid-context cache (`prefetchHybridContext`).

## Durable execution (Phases D1–D6 + E0–E10 + F1–F9)

The dashboard is the primary consumer of `@esankhan3/anvil-core-pipeline`'s
durable execution module. Key wiring:

- **`server/durable-store-singleton.ts`** — process-wide
  `SQLiteDurableStore` opened lazily at `~/.anvil/durable.db`.
  `ANVIL_DURABLE_DISABLED=1` opts out (used by tests + by the
  `test:server` script).
- **`server/durable-migration.ts`** — boot-time scanner. Two
  responsibilities: Pattern-1 sweep (Pattern-1 in-flight runs
  marked failed) + orphan auto-takeover (Phase F4: expired-lease
  runs are now claimed via `tryTakeOverLease` so the resume
  orchestrator can replay them). Set `ANVIL_DURABLE_AUTO_TAKEOVER=0`
  to revert to mark-failed.
- **`server/durable-vacuum.ts`** — Phase F3 retention enforcement.
  Runs once at boot + daily on `setInterval`. Drops terminal runs
  older than `ANVIL_DURABLE_RETENTION_DAYS` (default 30).
  `ANVIL_DURABLE_VACUUM_DISABLED=1` to skip.
- **`server/pipeline-runner.ts`** — every `PipelineRunner.run()`:
  1. Calls `getDurableStore()` + `createRun()` + `acquireLease()`.
  2. Constructs a `LeaseManager` and starts heartbeat.
  3. Attaches `attachDurableLogHook` to the pipelineBus.
  4. Threads `durableStore` + `durableHolder` into `runPipelineLoop`.
  5. On exit: stops the lease manager, releases the lease,
     updates run status (completed/failed/cancelled).
- **`server/pipeline-loop.ts`** — passes the store + holder into
  `Pipeline.run()` via `PipelineDeps`.
- **`server/pipeline-stages.ts`** — `runOneStage` accepts an
  optional `ctx?: StepContext<string>`. When provided, all
  external touches in the stage substages flow through
  `ctx.effect(<stage>:<op>, fn, opts?)`. Effect names are
  stage-prefixed; per-repo paths embed the repo as a token
  (`build:spawn-task-<repo>-<taskId>`). Idempotency keys for
  external effects: `<runId>:<repo>:<scope>` (build/ship) or
  content-hash (artifact writes).
- **`server/dashboard-server.ts`**:
  - WS `get-durable-timeline` returns the per-event log for
    a runId — consumed by the React `DurableTimeline` panel.
  - WS `resume-pipeline` / `cancel-pipeline-pause` handlers
    enqueue `reviewer-decision-<stage>` durable signals (Phase F1).
- **`src/components/history/DurableTimeline.tsx`** — Phase F8 UI
  panel. Mounted in `RunDetail` under a `<details>` disclosure;
  filter chips for steps/effects/signals.

### Effect-name conventions (24 sites converted in E1–E10)

| Stage | Effect names |
|---|---|
| clarify | `clarify:run-for-project:<model>` |
| requirements / tasks | `<stage>:session-start`, `:session-resume`, `:spawn-agent`, `:write-artifact` |
| repo-requirements / specs | `<stage>:spawn-<repo>`, `:write-<repo>` |
| build | `build:repo-<repo>`, `:write-<repo>`, `:spawn-task-<repo>-<taskId>` |
| validate fix-loop | `validate:fix-attempt-<N>:<model>`, `:revalidate-write-<N>` |
| test | `test:spawn-testgen` |
| ship | `ship:deploy` (idempotencyKey = `<runId>:<project>:<mode>`) |
| signals | `__signal:stage-answer-<i>`, `__signal:reviewer-decision-<stage>` |
| system | `__anvil_now`, `__anvil_uuid`, `__anvil_random`, `__anvil_sleep` |

### What stays direct (NOT through ctx.effect)

- State-mutation projections (`state.stages[i].startedAt = new Date().toISOString()`).
  Replay re-writes them; that's the expected user-facing behaviour.
- Telemetry JSONL appenders (`writePerRepoTelemetry`).
- Cost ledger writes.
- State broadcasts (`deps.broadcast()`).
- runId generation in `PipelineRunner` constructor.

`npm run lint:stages` walks `pipeline-stages.ts` + core-pipeline's
stages/steps with the durable-execution linter; advisory by
default, set `ANVIL_LINT_STAGES_STRICT=1` to fail on violations.

## Where to look first

- Adding a new pipeline stage? `core-pipeline/src/stages/registry.ts`
  is the canonical `STAGES` array; the per-stage body lives in
  `pipeline-stages.ts:runOneStage` (split by `stage.name`); the actual
  agent prompt + dispatch lives in `core-pipeline/src/stages/<name>.ts`.
- Pipeline orchestration end-to-end? `pipeline-runner.ts:run()` →
  `prepareRun()` (`runner-prep.ts`) → `attachPipelineHooks()`
  (`pipeline-hooks.ts`) → `runPipelineLoop()` (`pipeline-loop.ts`) →
  `Pipeline.run()` over a per-iteration `InMemoryStepRegistry`. Each
  Step's `runStage` callback delegates to
  `runOneStage(stageOps, …)` in `pipeline-stages.ts`. Cancellation /
  fail-early-return / reviewer rewind flow through thrown sentinel
  errors caught by the loop.
- WS message vocabulary? Search for `case '<msg>'` in
  `dashboard-server.ts`.
- Settings UI doesn't show a provider? `server/provider-registry.ts`
  detects via env-var presence; the Settings panel reads
  `discover-providers`.
- PR URLs not surfacing? Verify the bridge's `handleUserBlocks`
  emits `kind:'text'` for `tool_result` (the source of truth lives
  in `@anvil/agent-core`'s `language-model-bridge.ts`).
- Activity log shows one word per row? Check that the adapter's
  `emitContent` is buffered (flush on '\n' OR ~80 chars) — the
  pattern lives in agent-core's `OpenRouterAdapter` /
  `OllamaAdapter`.
- Per-repo stage advancing despite failures? Verify the
  `failedRepos.length > 0 → throw` branch in
  `pipeline-stages.ts:runPerRepoStage`.
- Reviewer rewind not landing? Check `pipeline-loop.ts` — the
  `__anvilRewind` sentinel translates to `Pipeline.run({ rewindTo })`
  on the next iteration of the outer `while`.
- Pipeline never pauses for review? Check
  `dashboard-server.ts:setAfterStageHook` — the gate is
  `policy.enabled === false`, not `if (!policy)`. The default policy
  (`BUILTIN_DEFAULT_POLICY` in `pipeline-policy.ts`) pauses after Plan;
  a project's `pipeline-policy.overlay.json` with `{ enabled: false }`
  silences pauses without deleting the yaml.
- Q&A panel doesn't appear in the dashboard? Verify the stage is in
  `STAGES_WITH_QA` (`requirements` / `repo-requirements` / `specs`),
  `policy.qa.enabled !== false`, and the agent emitted a
  `<questions>...</questions>` block in its first response. If the
  agent is confident, no questions, the panel never mounts — that's
  correct.
- Policy save fails with no error? Check the WS server reply for
  `pipeline-policy-error`; the field-by-field validator rejects with
  a specific message (e.g. `Unknown stage: foo`).
- Durable run inspector? `src/components/history/DurableTimeline.tsx`
  in RunDetail's "Durable execution log" disclosure. CLI equivalent:
  `anvil run-replay <runId>` (read-only); resume request via
  `anvil resume-durable <runId> --take`.
- Run resumed unexpectedly on dashboard boot? Auto-takeover fired —
  `findOrphanedRuns` found a `running` row with expired lease.
  Check the boot log for "auto-takeover: claimed N orphaned run(s)".
  Disable with `ANVIL_DURABLE_AUTO_TAKEOVER=0`.
- Reviewer pause not unblocking on resume? Phase F1 race: the
  `reviewer-decision-<stage>` signal is enqueued by
  `resume-pipeline` / `cancel-pipeline-pause` WS handlers + raced
  against the pauseStore polling loop in
  `setAfterStageHook`. A crashed-process pause stays unblocked
  on resume because the durable signal survives.
- Replay re-spawns agents? Effect name mismatch. Verify the wrap in
  `pipeline-stages.ts` uses a stable, stage-prefixed name; check
  the durable timeline (RunDetail panel) for the recorded effect
  keys; rerun-from-stage in the dashboard if `DeterminismViolationError`
  surfaces.

## Browser + web tool surface (Phases H0–H10)

Three tiers of agent-callable tools that read the live web and drive
real browsers. Per-stage gating rides on top of the existing
`STAGE_TOOL_PERMISSIONS` table via `STAGE_WEB_PERMISSIONS` in
core-pipeline.

- **Tier 1 (`web.*`)** — `web_search` + `web_fetch`. Backends in
  `server/tools/web-search.ts` (Brave/Tavily/Exa/SerpAPI) and
  `server/tools/web-fetch.ts` (axios + Turndown + cheap-tier
  summarizer). Provider-agnostic: `web_fetch`'s summarizer runs
  through `resolveModelForStage('web-summarizer')`, falling back to
  `research` when the user hasn't added the new stage to
  `~/.anvil/stage-policy.yaml`.
- **Tier 2 (`browser.*`)** — Playwright child process. DOM serializer
  in `server/browser/dom-serializer.ts` walks a structured snapshot,
  assigns interactive indices, strips `<script>`/event-handlers/
  injection patterns. `BrowserSession` (`session-manager.ts`) +
  `BrowserSessionRegistry` track per-(runId, sessionId) lifecycle
  with 15-min TTLs. Playwright is an optional dep — dynamic-imported
  via `new Function('m','return import(m)')` so the build doesn't
  need it.
- **Tier 3 (`computer.*`)** — Docker-backed Xvfb + Chromium runner.
  `computer-use/computer-use-translator.ts` emits the per-provider
  native schema (Anthropic `computer_20251124`, OpenAI
  `computer_use_preview`, Gemini computer). Default-disabled; opt in
  via `pipeline-policy.overlay.json: tools.browsePixel.enabled = true`.

**Wiring path** — `dashboard-server.ts` calls
`setWebToolBackends(createWebToolBridge({ summarizerInvoker, ... }))`
once at boot. The agent-core bridge composes a `WebToolExecutor` next
to the FS `BuiltinToolExecutor` whenever a stage's allowedTools
include any `web_*` / `browser_*` / `computer_use` name.

**Durable replay** — every web/browser/computer effect records via
`ctx.effect()` (Phase H3+H7). Effect names follow §J of the plan:
`web:search:<hash>`, `web:fetch:<urlHash>`, `browser:navigate:<urlHash>`,
`browser:click:<idx>`, `computer:action:<actionHash>`. The
`getCurrentStepContext()` slot in agent-core is set by
`pipeline-stages.ts:runOneStage` so deeply-nested agent loops get
durable wrapping for free.

**Defenses (§H, on by default)** — Haiku-class summarizer pre-filter,
allow/block-list domain enforcement, DOM injection-pattern stripping
(`[INST]`, `<system>`, "ignore prior instructions"), per-session
rate limits (1/sec click; 6/min screenshot), no-progress detector
(3 identical observations triggers `[__anvilBrowseStalled]`), confirm
gate on `browser_evaluate` / `browser_attach_context` / all
`computer_use` actions, 15-min session TTL.

**UI** — `DurableTimeline` (history pane) gains `web` / `browser` /
`computer` filter chips and per-tool summary rendering;
`ToolCostPanel` aggregates spend by namespace.

**User guide** — `docs/browser-web-tools-guide.md`. Plan reference:
`docs/browser-web-tools-plan.md` + `docs/browser-web-tools-survey.md`.

## Sandbox isolation surface (Phases S0–S13)

Phase S0–S12 isolated the `build` / `test` / `validate` / `ship` /
`fix` / `fix-loop` stages. Read-only stages stay on host. Phase S12
flipped the per-stage default mode from `'none'` → `'container'`.

- **`server/sandbox/docker-runner.ts`** — `DockerSandboxRunner` +
  `DockerSandboxHandle`. Drives the host's `docker` CLI via
  `child_process` (no `dockerode` dep). Each `acquire()` starts a
  long-lived container with the host workdir bind-mounted at
  `/workspace`; `exec()` calls `docker exec`; `close()` calls
  `docker rm -f`. The CLI driver makes the runner work without
  installing extra npm packages on the user's machine.
- **`server/sandbox/firecracker-runner.ts`** — Mode 2 microVM via
  `firecracker-containerd`'s `ctr` CLI. Off by default. Linux + KVM
  only. `isAvailable()` probes `/dev/kvm` + `ctr version`.
- **`server/sandbox/gvisor-runner.ts`** — extends `DockerSandboxRunner`
  with `--runtime=runsc` injected into `docker run`. Off by default.
  Linux + `runsc` only.
- **`server/sandbox/overlay-fs.ts`** — pure FS module: walks an
  upper-layer directory and applies the diff to the host workdir.
  Conflict policy: `host-wins` (default) writes
  `<file>.anvil-conflict`; `sandbox-wins` overwrites.
  `captureBaselineMtimes()` records pre-sandbox state for conflict
  detection.
- **`server/sandbox/network-policy.ts`** — `resolveNetworkPolicy()`
  layers (project blockList > stage allowList > project allowList >
  package-manager allow-list > default deny). `dockerRunNetworkArgs()`
  picks the cheapest enforcement: `--network none` for default-deny
  + empty allowList; `--network anvil-sandbox --dns ...` for richer
  policy. `dnsmasqConfigBody()` + `iptablesRulesForPolicy()` render
  the in-namespace network setup.
- **`server/sandbox/resource-limits.ts`** — `dockerRunLimitArgs()`
  emits `--memory` / `--memory-swap` / `--cpus` / `--pids-limit` /
  `--storage-opt size=`. `detectLimitKill()` classifies exit codes +
  stderr patterns into `killedByLimit: oom | pid | disk | timeout`.
- **`server/sandbox/cache-mounts.ts`** — read-only host cache mounts
  for npm / yarn / pnpm / pip / cargo / Go. Per-stage opt-in to
  read-write so `npm install` populates the host cache.
- **`server/sandbox/pool.ts`** — `SandboxPool` wraps any
  `SandboxRunner` with a per-(project, image, fsMode, limits) warm
  cache. Idle TTL eviction (5 min default), maxIdle (4) + maxTotal
  (16) caps, FIFO waiters with timeout.

**Durable replay** — every sandbox boundary crossing records via
`ctx.effect()`. Effect names follow §I.1 of the plan:
`sandbox:acquire:<runId>:<stage>`, `sandbox:exec:<idx>:<commandHash>`,
`sandbox:write:<idx>:<pathHash>`, etc. The state-hash Merkle digest
(`hashWorkdir` in core-pipeline) bounds replay determinism — if the
workdir's content drifts, replay throws
`SandboxDeterminismViolationError` instead of silently returning a
stale result.

**UI** — `DurableTimeline` gains a `sandbox` filter chip and per-row
summaries (`$ <command>`, `runtime=<name>`, etc.). `ToolCostPanel`
adds a sandbox stream with rough wall-time-amortized estimates;
payload `costUsd` overrides when present (matches the H10-followup
pattern). `SandboxPanel.tsx` renders the live runtime stats from
the new `sandbox-stats` WS push.

**CLI** — `anvil sandbox-runtime shell|prune|stats` for diagnostics;
`anvil doctor --pull-sandbox` pre-warms the image. The existing
`anvil sandbox` command (Nexus deploy sandbox) is unchanged — that's
a different concept.

**User guide** — `docs/sandbox-isolation-guide.md`. Plan reference:
`docs/sandbox-isolation-plan.md`.

## Architecture + flow docs

- `README.md` — package overview, build commands, storage layout,
  pipeline runner shape, provider matrix.
- `ARCHITECTURE.md` — module map, single-process layout, WS protocol
  surface, hot-path sequence.
