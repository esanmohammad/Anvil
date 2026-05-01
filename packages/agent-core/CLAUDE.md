# CLAUDE.md — `@anvil/agent-core`

Guidance for Claude Code when working inside `packages/agent-core/`. This is
the single LLM stack consumed by `cli`, `knowledge-core`, and the dashboard.
Only document what is actually in the source tree — speculative roadmap items
belong in ADRs, not here.

## What this package owns

- Two type surfaces: `LanguageModel` (forward-looking) and `ModelAdapter`
  (legacy; what the seven adapters actually implement today). Source:
  `src/types.ts`.
- Seven `ModelAdapter` implementations: `claude`, `openai`, `gemini`,
  `openrouter`, `ollama`, `gemini-cli`, `adk`. One file each at the package
  root. Plus a meta-adapter `FallbackAdapter` (deprecated; superseded by
  `LlmRouter`). Two adapters drive a true agentic loop:
    - `claude` — Claude CLI subprocess; ships its own tool runtime.
    - `ollama` — multi-turn `tools:[...]` loop hitting `/api/chat`,
      pairs each call to a `BuiltinToolExecutor` (see `src/tools/`)
      that this package ships for non-Claude paths.
- `ProviderRegistry` singleton — auto-registers all 7 adapters via static
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
  `buildAgentToolset`. Config discovery walks `mcp.json` /
  `.mcp/servers.json` / `.claude/mcp.json`.
- Built-in tool executor (`src/tools/`) — `BuiltinToolExecutor`,
  `resolveSafe`, OpenAI-tool-compatible JSON Schema for the seven
  built-ins (`read_file`, `write_file`, `edit`, `bash`, `grep`, `glob`,
  `list`). Used by non-Claude agentic adapters (Ollama today; future
  agentic OpenAI/Gemini paths). `LanguageModelBridge` constructs one
  per spawn for non-Claude providers and threads it through
  `ModelAdapterConfig.toolExecutor`. Path-guard rejects every escape
  vector tested adversarially.
- Headless `runAgent` (`src/headless/runner.ts`) — Inspect-AI-compatible
  external-agent contract. Returns `AgentTrajectory`. Caller injects a
  `LanguageModel`; no agent-core adapter natively implements one yet.
- Telemetry (`src/telemetry/`) — OTel spans with GenAI semantic conventions,
  metrics export, OTLP HTTP exporter. Default = no-op.
- Cost table (`src/cost.ts`) — vendored LiteLLM snapshot at
  `src/data/model-prices.json` (Apache-2.0). Refresh via
  `npm -w @anvil/agent-core run refresh-cost-table`.

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

- No vendor SDKs — adapters use `child_process` (CLI providers) or
  hand-rolled `fetch()` (HTTP providers). Adopting `@anthropic-ai/sdk`
  would localize lock-in to one ~150-LOC adapter file.
- No abstraction framework — no Vercel AI SDK, LiteLLM proxy, Mastra,
  LangChain.
- No native `LanguageModel.invoke()` impl on any adapter yet — every
  adapter implements `ModelAdapter.run()` only. The bridge from
  `ModelAdapter` → `LanguageModel` is follow-up work
  (see ADR §9 Phase 5 deviation). `runAgent` and `LlmRouter` callers
  must inject their own `LanguageModel`.
- No tier-promotion — `OllamaAdapter` is `tier:'agentic'` because it
  drives a real tool loop, not because it auto-upgrades any underlying
  model. The agentic capability comes from the loop in the adapter +
  the `BuiltinToolExecutor` injected by `LanguageModelBridge`.
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
  (which adds Ollama / Gemini-CLI heuristics on top).
- Yaml config format? `router/config-loader.ts:defaultRouterConfig`
  is the compiled-in default — that's the canonical schema example.

## Architecture + flow docs

- `ARCHITECTURE.md` — module map, layering, type surface, public exports.
- `FLOW.md` — sequence diagrams for the core paths (single-shot,
  streaming agent, router invoke, runAgent loop, checkpoint cache).
