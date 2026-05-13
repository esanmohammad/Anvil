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
- **`server/pipeline-runner.ts`** — per-run orchestrator. Drives via
  `Pipeline.run()` from `core-pipeline` over an `InMemoryStepRegistry`
  built from `STAGES` in core-pipeline; each Step's `run` calls
  `runOneStage(i)` which contains the per-stage body (resume skip,
  planSeed branch, dispatch to clarify/perRepo/single, validate-fix
  loop, after-stage hook, ship deploy). Control-flow exits
  (`continue` / `break` / early-return / reviewer rewind) translate to
  thrown sentinel errors with `__anvilCancel` / `__anvilFailReturn` /
  `__anvilRewind` markers; the outer try unwinds to the right exit.
  Reviewer rewind is handled by trimming `completedSteps` and
  re-invoking `Pipeline.run()` from the rewind target. WS broadcasts
  + `broadcastState()` + `checkpoint()` calls remain inline today;
  bus subscribers (`attachAuditLogHook`, `attachCostTrackerHook` from
  core-pipeline) are wired to the runner's `pipelineBus` for forensic
  audit + cost rollup.
- **`server/steps/`** — Step factories + pure helpers extracted out
  of `pipeline-runner.ts` over the Phase-4 series. See README §
  "Pipeline runner shape (Phase 4)" for the full module table.
- **`server/runners/`** — adapters that satisfy the canonical
  `AgentRunner` / `AgentSession` interfaces (from `core-pipeline`)
  over the dashboard's heavyweight `AgentManager`:
    - `agent-manager-runner.ts` — `AgentManagerRunner` is the one-shot
      runner. Wraps `spawnAndWait` + `runWithChainFallback`. Used by
      `runOneStage`'s single-stage / per-repo / per-task delegations.
    - `agent-manager-session.ts` — `AgentManagerSession` is the
      multi-turn session. Wraps `agentManager.spawn` for `start()` and
      `agentManager.sendInput + waitForAgent` for `sendInput()`. Used
      by clarify (explore→Q&A→synthesize) and fix-loop (resume across
      attempts).
    - `pipeline-step-registry.ts` — `buildPipelineStepRegistry(opts)`
      assembles the `InMemoryStepRegistry` driven by `Pipeline.run()`.
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
  renders run history, change diffs, activity log, KB graph,
  pipeline-policy editor, settings. Phase-4 pipeline event vocabulary
  is rendered by `src/components/output/`.

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

Every `spawnAndWait` call in `pipeline-runner.ts` MUST thread
`allowedTools: this.allowedToolsForCurrentStage(stageName)` into the
spawn spec — `LanguageModelBridge` reads this to scope the
`BuiltinToolExecutor` for non-Claude agentic adapters
(Ollama / OpenRouter / OpenCode). The five spawn sites are:
`runClarifyForProject`, generic per-repo (`runPerRepoStageForRepo`),
per-repo build (`runBuildForOneRepo`), single-stage (`spawnAndWait`),
and fix-loop (`runFixLoop`). Forgetting one is the canonical "qwen
ran but produced no diff" symptom.

### Chain-fallback on retryable upstream errors

`runStageWithFallback<T>(stageName, attemptFn)` (max attempts read from
`walker.max_attempts` in `~/.anvil/models.yaml`, default 5) wraps each
spawn site. When the inner attempt throws an `UpstreamError`-shape
(duck-typed: `name === 'UpstreamError' && retryable === true`), the
runner adds the failed model to `runtimeBurnedModels` and re-resolves
the stage's chain via `pickAliveModelFromChainSync(..., excludeModels=runtimeBurnedModels)`.
The 429/quota burst on Alibaba upstream for `qwen3.5-plus` (an
OpenCode→upstream provider quota issue, not the user's) is the
canonical case this guards.

The chain walker is reactive (post-failure burn) **plus** proactive
(pre-call liveness probe). `prefetchProviderLiveness` runs once at
pipeline start and probes every distinct provider in
`~/.anvil/models.yaml`'s `models:` array (auto-derived — no hardcoded
list). Cloud probes are env-var-presence only (`ANTHROPIC_API_KEY`,
`OPENCODE_API_KEY`, etc.); Ollama hits `localhost:11434/api/tags`;
ADK probes the union of Anthropic+Gemini keys (it dispatches to
either). Probe results cache for `walker.liveness_ttl_ms` (default
30000ms; set to 0 to disable caching). Probe + chain-walker live in
`server/provider-liveness.ts`.

### Per-repo stage atomicity

When a per-repo step fans out across N repos and any one repo fails,
the stage halts:

```ts
if (failedRepos.length > 0) throw new Error(`stage ${stage.name} failed for ${failedRepos.length} repo(s)`);
```

The earlier behavior — only halting when ALL repos failed — silently
advanced with a half-written codebase.

### Run-start visibility — register before any setup work

`startPipeline()` calls `activeRuns.set(pipelineRunId, {...})` +
`broadcastActiveRuns()` at the TOP of the function, before
`new PipelineRunner(...)`, before any hook wiring (cost ledger,
checkpoint cache, after-stage policy hook), and before
`runner.run()` is scheduled. The hook chain is synchronous JS but
still long enough that the Active Runs panel was visibly stale for a
beat after Build was clicked. A seed `kind:'project'` activity
(`"Initialising pipeline — workspace + provider liveness…"`) is
pushed into the run's activity feed and broadcast on the same tick,
so the per-stage Output panel isn't blank during the workspace +
walker prefetch gap. Do NOT move the registration back down — the
late-broadcast bug was the canonical "I clicked Build and nothing
happened" symptom.

### Stopping a build — broadcast first, kill chain after

`stop-run` flips `run.status='failed'` and emits the
`run-stopped` + `broadcastActiveRuns()` broadcasts FIRST, then calls
`runner.cancel()` and walks `agentToRunId` to kill every spawned
agent (deduped into a `Set` so a stage-tracked + map-tracked agent
isn't killed twice). Map entries are cleaned up as we go. The kill
chain (`AgentManager.kill` → `AgentProcess.kill` → `adapter.kill()`
→ per-call `AbortController`) severs in-flight HTTP requests on
Ollama/OpenRouter/OpenCode adapters and SIGTERM-s CLI subprocesses.
The UI sees the run flip immediately even though the async kill
unwind takes a few seconds for in-flight LLM calls.

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

### Project-prompt cache invariants (P1)

`buildProjectPromptHelper` / `buildRepoProjectPromptHelper` results
are cached on `pipeline-runner.ts` keyed by
`(projectId, repoName?, stageBucket)`. Mutating these prompts mid-run
breaks reproducibility — only invalidate on explicit `clearCache()`.

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

## Where to look first

- Adding a new pipeline stage? `core-pipeline/src/stages/registry.ts`
  is the canonical `STAGES` array; the per-stage body lives in
  `pipeline-runner.ts:runOneStage` (split by `stage.name`); the actual
  agent prompt + dispatch lives in `core-pipeline/src/stages/<name>.ts`.
- Pipeline orchestration end-to-end? `pipeline-runner.ts:run()` →
  builds `pipelineBus` + `buildPipelineStepRegistry` →
  `new Pipeline().run()`. Each Step's `run()` calls
  `runOneStage(i)`. Cancellation / fail-early-return / reviewer rewind
  flow through thrown sentinel errors.
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
  `failedRepos.length > 0 → throw` branch in `pipeline-runner.ts`.

## Architecture + flow docs

- `README.md` — package overview, build commands, storage layout,
  pipeline runner shape, provider matrix.
- `ARCHITECTURE.md` — module map, single-process layout, WS protocol
  surface, hot-path sequence.
