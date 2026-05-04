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
- **`server/pipeline-runner.ts`** — per-run orchestrator. Walks the
  9-stage list, fans out per-repo where applicable, runs the
  validate-fix loop, broadcasts state over WS. Delegates every spawn,
  prompt build, and shell op to a Step factory or pure helper under
  `server/steps/`.
- **`server/steps/`** — Step factories + pure helpers extracted out
  of `pipeline-runner.ts` over the Phase-4 series. See README §
  "Pipeline runner shape (Phase 4)" for the full module table.
- **`server/provider-registry.ts`** — discovery layer for the Settings
  UI. Reports each provider's display name, env var, model list,
  setup hint. Visibility toggles on env-var presence.
- **`server/provider-liveness.ts`** — `pickAliveModelFromChainSync`
  picks the first model in a tier-chain whose provider is alive,
  excluding any in `runtimeBurnedModels`.
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
- No direct `@anvil/knowledge-core` imports. KB ops shell out to
  the cli's `anvil index` via `KnowledgeBaseManager`.

## Where to look first

- Adding a new pipeline stage? `server/pipeline-runner.ts:160` (stage
  list) + `server/steps/` for the Step factory.
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
