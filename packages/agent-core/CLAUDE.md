# CLAUDE.md — `@anvil/agent-core`

Guidance for Claude Code when working inside `packages/agent-core/`. This is
the single LLM stack consumed by `cli`, `knowledge-core`, and the dashboard.
Only document what is actually in the source tree — speculative roadmap items
belong in ADRs, not here.

## What this package owns

- Two type surfaces: `LanguageModel` (forward-looking) and `ModelAdapter`
  (legacy; what the eight adapters actually implement today). Source:
  `src/types.ts`.
- Eight `ModelAdapter` implementations: `claude`, `openai`, `gemini`,
  `openrouter`, `ollama`, `gemini-cli`, `adk`, `opencode`. One file each at
  the package root. Plus a meta-adapter `FallbackAdapter` (deprecated;
  superseded by `LlmRouter`). Six adapters drive a true agentic loop:
    - `claude` — Claude CLI subprocess; ships its own tool runtime.
    - `ollama` — multi-turn `tools:[...]` loop hitting `/api/chat`,
      pairs each call to a `BuiltinToolExecutor` (see `src/tools/`)
      that this package ships for non-Claude paths.
    - `openrouter` — OpenAI-compat SSE consumer with delta `tool_calls`
      reassembled by `index`. Reasoning-mode models (DeepSeek V4, Kimi
      K2.x, GLM thinking) require `reasoning` + `reasoning_details`
      echoed back on the next assistant turn or upstream rejects with
      "reasoning_content is missing in assistant tool call" — the SSE
      consumer captures both fields and replays them. Throws
      `UpstreamError` (with `.retryable=true` for 429 / 5xx /
      quota-pattern bodies) so callers can chain-fallback.
    - `opencode` — extends `OpenRouterAdapter` against OpenCode Go's
      OpenAI-compatible proxy at `https://opencode.ai/zen/go/v1`.
      Registry uses `opencode/<model>` ids (e.g. `opencode/kimi-k2.6`)
      to disambiguate from OpenRouter's `org/model` slug format. Strips
      the prefix before the upstream POST. Keys off `OPENCODE_API_KEY`.
      Replaces Ollama as the cheap local-tier provider when the user
      has a Go subscription — same agentic loop, zero local VRAM cost.
    - `openai` — also extends `OpenRouterAdapter` (since OpenAI's
      `/v1/chat/completions` is the canonical OpenAI-compatible API).
      Inherits the agentic loop, `UpstreamError` chain-fallback,
      per-call `AbortController`, buffered `emitContent`, and
      `reasoning_details` echo-back for o-series reasoning models.
      Overrides config knobs only: API key (`OPENAI_API_KEY`), base URL
      (`OPENAI_BASE_URL`, defaults `https://api.openai.com/v1`), drops
      OpenRouter's `HTTP-Referer`/`X-Title` attribution headers.
    - `adk` — Google Agent Development Kit (`@google/adk` ≥ 1.1.0).
      Runs the user's prompt through `LlmAgent` + `Runner` +
      `InMemorySessionService`, translating each emitted `Event` into
      Anvil Stream Format. Registry uses `adk:<model>` (e.g.
      `adk:claude-sonnet-4-6`, `adk:gemini-2.5-flash`); the prefix is
      stripped before being handed to ADK's `LLMRegistry`. Claude
      models route through a custom `AnthropicLlm` (lives in
      `adk-anthropic-llm.ts`, registered idempotently on first run);
      Gemini models route through ADK's built-in `Gemini` Llm. Keys
      off `ANTHROPIC_API_KEY` (Claude path) and `GEMINI_API_KEY` /
      `GOOGLE_GENAI_API_KEY` / `GOOGLE_API_KEY` (Gemini path —
      `GOOGLE_API_KEY` is bridged to `GEMINI_API_KEY` automatically).
      Manual smoke test: `node packages/agent-core/scripts/smoke-adk.mjs`.
- `ProviderRegistry` singleton — auto-registers all 8 adapters via static
  ESM imports (`src/registry.ts`). Wraps every adapter with
  `instrumentModelAdapter` at registration time.
- Single-shot runner: `runLLM` / `runClaude` / `runGemini` (`src/single-shot.ts`).
  Spawns a CLI subprocess or hits the HTTP API based on `ANVIL_LLM_MODE`.
- Agent lifecycle layer at `src/agent/session/`:
  - `AgentProcess` — one logical agent. EventEmitter, supports `start()` →
    `sendInput()` resume → `kill()`.
  - `AgentManager` — registry of many `AgentProcess`es; checkpoint-aware spawn.
  - `LanguageModelBridge` — adapts a `ModelAdapter` to the 5-event
    `AgentAdapter` surface that `AgentProcess` consumes.
  - `defaultAdapterFactory` — resolves a `SpawnConfig.model` via
    `ProviderRegistry` and wraps it in a `LanguageModelBridge`.
  - `runWithAgent` — single-shot helper for cli commands that don't need
    the full registry.
- `LlmRouter` (`src/router/`) — tag-based routing, retries, fallbacks,
  per-provider rate limiting, SQLite spend ledger, circuit breaker. Yaml
  config at `~/.anvil/llm-router.yaml`; compiled-in defaults work.
- Checkpoint cache (`src/checkpoint/`) — SHA-keyed per-call output cache
  (project / runFamily / stage / hash). Higher-order `runWithCheckpoint`
  wraps any agent call.
- Skills loader (`src/skills/`) — Anthropic-OpenAI SKILL.md format.
  `composeSkillContext` returns system-prompt + reconciled allowed-tools.
- MCP client (`src/mcp/`) — `loadMcpServers` + `McpAgentClient` +
  `McpClientPool` + `MergedToolExecutor`. Config discovery walks
  `mcp.json` / `.mcp/servers.json` / `.claude/mcp.json`. Tools surface as
  `mcp__<server>__<tool>` (Claude Code convention) and are routed to
  non-Claude agentic adapters via `MergedToolExecutor`, which wraps the
  builtins + a session-scoped `McpClientPool`. Claude path unchanged —
  claude-cli loads its own mcp.json via `--mcp-config`. Lifecycle owned
  by `AgentProcess` (not the bridge): the pool is constructed once per
  session, reused across resume turns, and torn down on `kill()`. Failures
  to connect are isolated per server (pool stores them on `failures[]`)
  so one sick MCP doesn't poison the run. Stdio servers' stderr is
  captured to `~/.anvil/mcp-logs/<server>-<runId>.log`. Streamable-HTTP
  transport is supported alongside stdio (deprecated SSE is not).
  Cancellation: every in-flight tool call has its own `AbortController`;
  `pool.cancelInFlight()` aborts them and sends `notifications/cancelled`
  on the wire. Progress notifications surface to the agent's `activity`
  stream so the dashboard's activity panel shows MCP work.
- Built-in tool executor (`src/tools/`) — `BuiltinToolExecutor`,
  `resolveSafe`, OpenAI-tool-compatible JSON Schema for the seven
  built-ins (`read_file`, `write_file`, `edit`, `bash`, `grep`, `glob`,
  `list`). Used by non-Claude agentic adapters (Ollama, OpenRouter,
  OpenCode, OpenAI, Gemini, ADK). For non-Claude paths
  `LanguageModelBridge` wraps a `BuiltinToolExecutor` + the session's
  `McpClientPool` into a `MergedToolExecutor` and threads that through
  `ModelAdapterConfig.toolExecutor`. The merged executor enforces
  per-stage `allowedTools` filtering for BOTH builtins and MCP
  (`mcp__<server>__*` glob; destructive MCP tools require exact-name
  allowance). Path-guard rejects every escape vector tested adversarially.
- Eval trajectory collector (`src/agent/session/collect-trajectory.ts`) —
  spawns an `AgentProcess` via `defaultAdapterFactory`, listens to the
  5-event surface, and resolves with an Inspect-AI-shaped
  `AgentTrajectory`. Replaces the deleted `runAgent` headless entry per
  AGENT-PROCESS-CONSOLIDATION-ADR §C1; eval consumers call
  `collectTrajectory(task, workspace)` and the production stack
  (registry → adapter factory → bridge) handles model resolution.
- Telemetry (`src/telemetry/`) — OTel spans with GenAI semantic conventions,
  metrics export, OTLP HTTP exporter. Default = no-op.
- Cost table (`src/cost.ts`) — vendored LiteLLM snapshot at
  `src/data/model-prices.json` (Apache-2.0). Refresh via
  `npm -w @anvil/agent-core run refresh-cost-table`.
- Model registry loader (`src/router/model-registry.ts`) —
  parses `~/.anvil/models.yaml` into a `ModelRegistry { models, walker }`.
  The `walker:` block is a top-level optional section that controls the
  dashboard's chain-walker behavior — `liveness_ttl_ms` (default 30000,
  ms) and `max_attempts` (default 5). Defaults are exported as
  `DEFAULT_WALKER_CONFIG`. Unknown walker keys are rejected at parse
  time so typos like `livenessTTL` get caught early. Resolution path
  for the yaml file: `ANVIL_MODELS_CONFIG` env →
  `<workspace>/.anvil/models.yaml` → `~/.anvil/models.yaml` (canonical) →
  empty.
- Provider liveness probe (`src/provider-liveness.ts`) — module-scoped
  cache of provider availability + sync chain walker. Exports
  `setLivenessTtlMs`, `prefetchLiveness`, `isProviderAlive`,
  `pickAliveModelFromChainSync`, `pickAliveModelFromChain`. The TTL
  defaults to 30s (configurable via the registry's `walker.liveness_ttl_ms`).
  Probes: Ollama hits `localhost:11434/api/tags`; cloud providers are
  env-var-presence only (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
  `OPENCODE_API_KEY`, etc.). Both cli and dashboard share one cache.
- Empty-output retryable throws — the three agentic adapters (`claude`,
  `openrouter` / `opencode`, `ollama`) throw `503 retryable
  UpstreamError` when the run completes with empty final text. The
  dashboard's `runWithChainFallback` (in `core-pipeline`) catches this
  and walks the chain to the next model. Without this, claude-cli's
  silent-empty bug (exit 0, no `result` frame) silently produced 0-byte
  artifacts downstream; now the chain walker recovers automatically.
- Concurrency-safe Claude adapter — `claude-adapter.ts` keeps a
  `Set<ChildProcess>` instead of a single `child` field, so parallel
  spawns (per-repo backend + frontend, per-task build) don't trample
  each other's process handles.

Public barrel: `src/index.ts` re-exports everything.

## Build + test

```sh
npm -w @anvil/agent-core run build       # tsc -b + copy model-prices.json
npm -w @anvil/agent-core test            # node --test on dist/**/*.test.js
npm -w @anvil/agent-core run dev         # tsc -b --watch
```

Tests are colocated under `src/__tests__/` and `src/<area>/__tests__/`.
Build copies `src/data/model-prices.json` into `dist/data/` because the
cost loader resolves the JSON via `fileURLToPath(import.meta.url)`.

## Conventions

### Adapter authoring

- Every adapter implements `ModelAdapter` (not `LanguageModel`) today.
  Field names + signatures are locked in `src/types.ts` so existing
  adapters keep compiling.
- Adapters write Anvil Stream Format (NDJSON) to the `output` Writable
  passed into `run(config, output)`. Helpers live in `src/stream-format.ts`
  (`emitContent`, `emitToolUse`, `emitThinking`, `emitResult`).
- Claude CLI emits this format natively (`--output-format stream-json`);
  every other adapter uses the helpers.
- Set `capabilities.tier`. Only `tier === 'agentic'` is allowed for
  pipeline stages `build`/`validate`/`ship` — `ProviderRegistry.resolveForStage`
  enforces this and falls back to `claude` with a warning.
- **Concurrency safety: per-call `AbortController`.** Adapters are
  registered once as singletons (the registry shares one instance across
  every spawn). Storing an instance-level `abortController` gets
  trampled by concurrent calls (e.g. per-repo backend + frontend running
  in parallel). The `ollama` and `openrouter` adapters keep a
  `Set<AbortController>`; each `run()` creates its own controller, adds
  it to the set, and removes it in `finally`. `kill()` iterates the set.
- **Buffered `emitContent`.** OpenAI-compat SSE streams emit one token
  per chunk. Calling `emitContent` per delta produces one-word activity
  rows in the dashboard. The shared pattern is to buffer until '\n'
  OR ~80 chars before flushing, so the activity log reads like prose.
- **`UpstreamError` for chain-fallback.** Adapters that hit the network
  throw `UpstreamError(status, body, { provider, retryable? })` with
  `.retryable=true` when the upstream returns 429 / 502 / 503 / 504 or
  a quota-pattern body. The class lives in `src/upstream-error.ts` and
  is shared by every adapter (`openrouter` re-exports for back-compat).
  The dashboard's `runStageWithFallback` duck-types
  `name === 'UpstreamError' && retryable === true` and picks the next
  model in the chain. CLI subprocess adapters (`claude`, `gemini-cli`)
  buffer stderr and pass it to `synthesizeStatusFromCli` to map vendor
  patterns (`rate_limit_error`, `RESOURCE_EXHAUSTED`, `Credit balance
  is too low`) to a synthetic HTTP status — so quota/rate-limit failures
  trigger the same chain-fallback path as HTTP-shaped failures.
  `bodyLooksRetryable` also matches "model not found" / "not supported
  for generateContent" / `model_not_found` / "no such model" — a
  phantom id in `~/.anvil/models.yaml` (e.g. `adk:gemini-3-pro`) used
  to fail the whole stage instead of burning that one chain entry.
  Now the walker hops to the next rung; the bad id is still bad on the
  next run, but the run completes.

### Telemetry

- Spans are added at the registry seam — adapters do **not** emit spans
  themselves. `instrumentModelAdapter` wraps every registered adapter and
  starts a `gen_ai.invoke` span around `run()`.
- `AgentProcess` opens an `anvil.agent.session` parent span on `start()`
  and runs adapter calls inside its context (`AsyncLocalStorage`), so
  initial run + every resume become children of one trace.
- `LanguageModelBridge` opens `gen_ai.tool.<name>` child spans when it
  parses `tool_use` blocks out of the assistant stream and closes them
  on the matching `tool_result`.
- Default behavior with zero env config = no spans exported. Vendor
  backends plug in via standard OTLP env vars
  (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`).
- Privacy: prompts/completions are NOT recorded in spans unless
  `ANVIL_OTEL_RECORD_CONTENT=1`. Truncated to 8KB per attribute.

### Env vars

`ANVIL_*` is canonical. Legacy aliases (`CODE_SEARCH_LLM_*`,
`ANTHROPIC_API_KEY`, `CLAUDE_BIN`, `GEMINI_BIN`, `ANVIL_AGENT_CMD`,
`FF_AGENT_CMD`, etc.) are honored with a one-time stderr deprecation
warning. Resolution path lives in `single-shot.ts:readAliased`.

OpenCode adapter:
- `OPENCODE_API_KEY` — required. Subscribe at https://opencode.ai/zen.
- `OPENCODE_BASE_URL` — optional override (default
  `https://opencode.ai/zen/go/v1`). Useful for region pinning or testing
  against a local `opencode serve`.

### Cost calculation

- `getModelPricing(modelId)` returns `[inputPer1M, outputPer1M]` or
  `null`. `MODEL_ALIASES` in `cost.ts` bridges Anvil short names
  (`sonnet`/`opus`/`haiku`) to LiteLLM keys.
- The instrumentation wrapper computes a `calculateCostBreakdown` from
  the central table. If the table is silent for a model, it falls back
  to the adapter's reported `costUsd` (decision O6: agent-core is the
  source of truth, but only when it has data).

### When you change the cost table

Run `npm -w @anvil/agent-core run refresh-cost-table` (re-fetches
LiteLLM's JSON). Commit the result. Update `MODEL_ALIASES` in `cost.ts`
when a new flagship rev ships.

## Things that don't exist in this package (intentionally)

- No first-party LLM SDKs — adapters use `child_process` (CLI
  providers) or hand-rolled `fetch()` (HTTP providers). The one
  exception is `@google/adk` + `@google/genai`, listed in
  `optionalDependencies` and consumed by the `adk` adapter only.
  Adopting `@anthropic-ai/sdk` would localize lock-in to one
  ~150-LOC adapter file but isn't done yet.
- No abstraction framework — no Vercel AI SDK, LiteLLM proxy, Mastra,
  LangChain.
- No native `LanguageModel.invoke()` impl on any adapter yet — every
  adapter implements `ModelAdapter.run()` only. The bridge from
  `ModelAdapter` → `LanguageModel` is follow-up work for `LlmRouter`
  callers, who must inject their own `LanguageModel`. The eval path
  (`collectTrajectory`) does NOT need this bridge — it routes through
  `AgentProcess` + `defaultAdapterFactory` like every other spawn.
- No tier-promotion — `OllamaAdapter`, `OpenRouterAdapter`, and
  `OpenCodeAdapter` are all `tier:'agentic'` because they drive a real
  tool loop, not because they auto-upgrade any underlying model. The
  agentic capability comes from the loop in the adapter + the
  `BuiltinToolExecutor` injected by `LanguageModelBridge`.
- No deprecated `agent/agent-manager.ts` single-shot runner — it was
  deleted; the canonical surface is `agent/session/`.

## Where to look first

- Need to understand a streaming run end-to-end? Read
  `agent/session/session.ts`, then `language-model-bridge.ts`.
- Routing/retries/fallbacks? `router/router.ts` is the only file you
  need to understand the chain walk.
- Cost numbers wrong in a span? Trace through `telemetry/instrument.ts:run`
  → `cost.ts:calculateCostBreakdown`.
- Provider auto-detect? `registry.ts:resolveFromModelId` + the
  override in `agent/session/default-adapter-factory.ts:resolveProvider`
  (which adds Ollama / Gemini-CLI / OpenCode-prefix heuristics on top —
  `opencode/` is matched BEFORE the generic slash-check so OpenRouter
  doesn't claim those ids).
- Yaml config format? `router/config-loader.ts:defaultRouterConfig`
  is the compiled-in default — that's the canonical schema example.

## Architecture + flow docs

- `ARCHITECTURE.md` — module map, layering, type surface, public exports.
- `FLOW.md` — sequence diagrams for the core paths (single-shot,
  streaming agent, router invoke, collectTrajectory loop, checkpoint cache).
