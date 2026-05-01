# `@anvil/agent-core` — Architecture

Reference for what physically lives in `packages/agent-core/src/` and how the
modules wire together. No future-tense roadmap content — only what compiles
today.

## 1. Layered module map

```
                  ┌──────────────────────────────────────────────────────┐
                  │ Consumers: cli, knowledge-core, dashboard            │
                  └──────────────────────────────────────────────────────┘
                                          │
                                          ▼
        ┌────────────────────────────────────────────────────────────────┐
        │ src/index.ts — public barrel                                   │
        └────────────────────────────────────────────────────────────────┘
              │                │                  │                │
              ▼                ▼                  ▼                ▼
   ┌──────────────────┐ ┌──────────────────┐ ┌────────────┐ ┌──────────────┐
   │ Headless         │ │ Agent lifecycle  │ │ Router     │ │ Single-shot  │
   │ runAgent         │ │ AgentProcess +   │ │ LlmRouter  │ │ runLLM /     │
   │ (Inspect-AI)     │ │ AgentManager     │ │            │ │ runClaude /  │
   │ src/headless/    │ │ src/agent/       │ │ src/router │ │ runGemini    │
   └──────────────────┘ │   session/       │ │            │ │ src/single-  │
              │         └──────────────────┘ └────────────┘ │   shot.ts    │
              │                  │                  │       └──────────────┘
              │                  ▼                  │              │
              │     ┌────────────────────────┐      │              │
              │     │ LanguageModelBridge    │      │              │
              │     │ + defaultAdapterFactory│      │              │
              │     └────────────────────────┘      │              │
              │                  │                  │              │
              ▼                  ▼                  ▼              ▼
        ┌──────────────────────────────────────────────────────────────┐
        │ ProviderRegistry (singleton, src/registry.ts)                │
        │   wraps every adapter via instrumentModelAdapter at register │
        └──────────────────────────────────────────────────────────────┘
                                          │
       ┌──────────┬──────────┬───────────┼───────────┬──────────┬──────┐
       ▼          ▼          ▼           ▼           ▼          ▼      ▼
  Claude     OpenAI     Gemini    OpenRouter     Ollama   Gemini-   ADK
  Adapter    Adapter    Adapter   Adapter        Adapter  CLI       Adapter
  (claude    (openai    (gemini   (openrouter    (ollama  Adapter   (adk
  CLI)       HTTP)      HTTP)     HTTP)          local)   (CLI)     SDK)

       Cross-cutting:
         • src/telemetry/    — OTel spans + metrics + exporters
         • src/cost.ts       — LiteLLM-snapshot pricing
         • src/stream-format.ts — Anvil Stream Format helpers
         • src/checkpoint/   — content-addressed call cache
         • src/skills/       — SKILL.md loader + activator
         • src/mcp/          — MCP client (consumes other servers)
```

## 2. Two type surfaces

Both live in `src/types.ts`.

### 2.1 `LanguageModel` (forward-looking)

Vendor-agnostic streaming + single-shot interface.

```ts
interface LanguageModel {
  readonly provider: ProviderName;
  readonly capabilities: ProviderCapabilities;
  supportsModel(modelId: string): boolean;
  getModelPricing(modelId: string): [number, number] | null;
  checkAvailability(): Promise<{ available; version?; error? }>;
  invokeStream(opts: LanguageModelInvokeOptions): AsyncIterable<StreamEvent>;
  invoke(opts: LanguageModelInvokeOptions): Promise<InvokeResult>;
}
```

Status today: **interface defined, no native adapter implementation.** All
seven concrete adapters implement `ModelAdapter` only. `runAgent` and
`LlmRouter` accept a `LanguageModel` from the caller.

### 2.2 `ModelAdapter` (legacy; current adapters)

```ts
interface ModelAdapter {
  readonly provider: ProviderName;
  readonly capabilities: ProviderCapabilities;
  supportsModel(modelId: string): boolean;
  getModelPricing(modelId: string): [number, number] | null;
  checkAvailability(): Promise<{ available; version?; error? }>;
  run(config: ModelAdapterConfig, output: NodeJS.WritableStream): Promise<ModelAdapterResult>;
  kill?(): void;
}
```

`run()` writes Anvil Stream Format NDJSON to `output` and resolves with a
`ModelAdapterResult` (text + tokens + cost + cache + reasoning + tool count
+ stop reason).

### 2.3 `ProviderName`

Closed union: `'claude' | 'openai' | 'gemini' | 'openrouter' | 'ollama' | 'gemini-cli' | 'adk'`.

### 2.4 `ProviderCapabilities`

Per-adapter declaration of `tier`, streaming, tool use, file system, shell
execution, session resume, prompt-caching mode (`auto`/`explicit`/`none`),
TTL, `maxOutputTokens` honoring, and structured-output level
(`strict`/`tool-shim`/`best-effort`/`none`).

## 3. `ProviderRegistry` (`src/registry.ts`)

Singleton. Auto-registers all 7 adapters via static ESM imports during
`getInstance()`.

```
ProviderRegistry.getInstance()
  ├─ register(new ClaudeAdapter())     ← wraps with instrumentModelAdapter
  ├─ register(new OpenAIAdapter())
  ├─ register(new GeminiAdapter())
  ├─ register(new OpenRouterAdapter())
  ├─ register(new OllamaAdapter())
  ├─ register(new GeminiCliAdapter())
  └─ register(new AdkAdapter())
```

Resolution helpers:

- `resolveFromModelId(modelId)` — heuristic: `claude-*`/`sonnet`/`opus`/`haiku`
  → claude; `gpt-*`/`o1*`/`o3*`/`o4*` → openai; `gemini-*` → gemini;
  contains `/` → openrouter; default → claude.
- `resolveForStage(stage, modelId, override?)` — enforces `tier === 'agentic'`
  for stages `build`/`validate`/`ship`. Falls back to claude with a warning.

A separate, richer resolver lives at
`src/agent/session/default-adapter-factory.ts:resolveProvider` — adds
`ollama:` prefix detection, `gemini-cli` binary probe, and the
`<family>:<size>` heuristic for local Ollama tags.

## 4. Agent lifecycle layer (`src/agent/session/`)

### 4.1 `AgentProcess` (`session.ts`)

One logical agent. EventEmitter with five typed events:

```
content       (text: string)
activity      (activity: AgentActivity)
result        ({ result, cost, sessionId })
error-output  (text: string)
exit          (code: number | null)
```

Lifecycle: `pending` → `running` → `done` | `error` | `killed`.

- `start()` — opens `anvil.agent.session` parent span, builds an
  `AdapterRequest` from its `SpawnConfig`, calls the factory, wires
  the adapter, runs adapter.start() inside the session OTel context.
- `sendInput(text)` — spawns a NEW adapter with `resume: true` and the
  same `sessionId`; same span context.
- `kill(signal?)` — best-effort `adapter.kill()`, marks state `killed`,
  ends the session span with `outcome=killed`.

State caps: 500 KB output (tail-kept), 500 activities (tail-kept),
500 ms post-exit grace, 5000 ms empty-exit threshold.

### 4.2 `AgentManager` (`session-registry.ts`)

`Map<id, { process, spec }>`. Re-emits process events with id-prefixed
manager-level events:

```
agent-output    ({ agentId, chunk })
agent-activity  ({ agentId, activity })
agent-done      ({ agent: AgentState })
agent-error     ({ agentId, error })
```

Hooks:

- `setCostHook(hook)` — fired once per `result` (fire-and-forget).
- `setCheckpointHook(hook)` — `lookup` consulted BEFORE spawn; on hit,
  the spawn is synthesized (no adapter). `record` invoked on success.

### 4.3 `LanguageModelBridge` (`language-model-bridge.ts`)

Adapts a `ModelAdapter` to the 5-event `AgentAdapter` surface
`AgentProcess` consumes. Two parallel surfaces in one class:

- `AgentAdapter` (lifecycle): `start()` / `kill()` + 5 events.
- Prompt-construction helpers: `capabilities` (with promptCache stance),
  `markCacheBreakpoint(prompt, position)`, `countTokens(text)` (heuristic
  chars/4).

Internals:
- `start()` builds a `Writable` sink that parses NDJSON line by line,
  re-emits `content`/`activity` events, and opens `gen_ai.tool.<name>`
  child spans on `tool_use` (closed on the paired `tool_result`).
- The wire-format `result` frame is ignored; the bridge surfaces `result`
  from the resolved `ModelAdapterResult` (which carries `stopReason` +
  cache token counts the wire format doesn't).

### 4.4 `defaultAdapterFactory` (`default-adapter-factory.ts`)

```
defaultAdapterFactory(request: AdapterRequest): AgentAdapter
  └─ resolveProvider(request.model)               ← provider heuristic
  └─ ProviderRegistry.getInstance().get(provider) ← falls back to claude
  └─ new LanguageModelBridge(request, adapter, provider)
```

Provider heuristics layered on top of the registry's:

1. `ollama:` prefix → `ollama`
2. `gemini-*` → `gemini-cli` (if binary on PATH) else `gemini`
3. `gpt-*` / `o1*` / `o3*` / `o4*` / `chatgpt-*` → `openai`
4. contains `/` → `openrouter`
5. `<family>:<size>` and not `claude` → `ollama`
6. default → `claude`

### 4.5 `runWithAgent` (`run-with-agent.ts`)

Thin promise-shaped helper: constructs an `AgentManager` (default
factory), spawns one agent, listens for `agent-done`/`agent-error`,
honors `AbortSignal`. Used by cli commands like `diff`, `learn`,
`migrate`, `test-gen`. No checkpoint cache — wrap the call site with
`runWithCheckpoint` if you need it.

## 5. Single-shot runner (`src/single-shot.ts`)

Provider-aware facade for the analytical shape — `prompt + system → text + cost`.

```ts
runLLM(prompt, system, { provider, model, timeoutMs })
  ├─ provider === 'gemini' → runGemini(...)  ← spawns gemini CLI
  └─ default              → runClaude(...)
                              ├─ ANVIL_LLM_MODE === 'api' → runViaApi
                              └─ default                  → runViaCli
```

Mode resolution:

1. Explicit `ANVIL_LLM_MODE` (= `cli`/`api`/`none`) wins.
2. Else if API key present → `api`.
3. Else if claude binary on PATH → `cli`.
4. Else `none` (every call throws).

`api` transport supports both Anthropic's `/v1/messages` and OpenAI-compat
`/v1/chat/completions` (selected via `ANVIL_LLM_PROVIDER`). Tracks every
spawned subprocess so SIGINT/SIGTERM kills propagate.

Wrapped with `withInvokeSpan` from `telemetry/instrument.ts` — emits a
`gen_ai.invoke` span with the same GenAI attribute set as the streaming
path.

## 6. `LlmRouter` (`src/router/`)

Single entry point for cross-provider routing, retries, fallbacks, rate
limits, spend tracking, and circuit breaking.

```
LlmRouter.invoke(InvokeOpts)
  ├─ enforceBudgetPreflight    ← daily / per-run / per-tag caps
  ├─ buildChain(opts)          ← primary + RouteFallback[]
  └─ for each step in chain:
       ├─ shouldTryFallback?       ← per-error `on:` gate
       ├─ circuitBreaker.canAttempt?
       ├─ runWithRetry(            ← per-error retry policy
       │     fn = rateLimiter.acquire(provider, tokens)
       │              .then(adapter.invoke(llmOpts))
       │   )
       ├─ ledger.record(...)       ← every terminal outcome
       └─ circuitBreaker.recordSuccess|Failure
```

Subsystems:

- `errors.ts` — maps adapter exceptions to seven `ErrorClass` values
  (`rate_limit`, `timeout`, `server_5xx`, `auth`, `content_policy`,
  `invalid_request`, `unknown`). Per-provider classifier overrides.
- `retry.ts` — per-class `RetryPolicy` (attempts, backoff, baseMs, maxMs,
  jitter). `DEFAULT_RETRY_POLICY` exported.
- `rate-limiter.ts` — `TokenBucketRateLimiter`. Per-provider rpm + tpm.
  Behavior on dry: `wait` | `fail` | `fallback`.
- `circuit-breaker.ts` — per-provider state machine. Trips after N
  consecutive non-terminal failures, half-opens after cooldown, success
  closes.
- `spend-ledger.ts` — `better-sqlite3` schema at
  `~/.anvil/router/spend.sqlite` (override via `ANVIL_HOME`). One row
  per terminal outcome; failures get `cost_usd = 0`. Indexed by
  `(run_id, project, tag, provider)`.
- `config-loader.ts` — yaml at `~/.anvil/llm-router.yaml`. Search:
  `ANVIL_ROUTER_CONFIG` env → `<workspace>/.anvil/llm-router.yaml` →
  `~/.anvil/llm-router.yaml` → compiled-in `defaultRouterConfig()`.
  `${env:VAR}` expansions inside string values.
- `telemetry.ts` — `invokeWithSpans(router, opts)` parent span
  `anvil.router.invoke`; per-step `anvil.router.attempt` child spans.

Terminal classes (`auth`, `content_policy`, `invalid_request`) never
trigger fallback. `content_policy` specifically never crosses providers
— security default.

## 7. Headless `runAgent` (`src/headless/runner.ts`)

Inspect-AI-compatible external-agent contract. Caller-injected
`LanguageModel` drives a tool-call loop bounded by
`maxToolLoopIterations` (default 25) and wall-clock `timeoutMs`
(default 600 000).

```
runAgent(task, workspace, options)
  ├─ composeSkillContext(task.systemPrompt, ...)
  │   └─ resolveSkillsDir + loadSkills + activateSkills (32 KB) + render
  ├─ loadMcpServers(workspaceRoot)
  ├─ mcpClients = servers.map(s => new McpAgentClient(s))
  ├─ buildAgentToolset(builtIn, mcpClients) → { tools, mcpDispatch }
  ├─ loop until end / length / error:
  │    ├─ options.model.invoke({ model, messages, tools, ... })
  │    ├─ aggregate usage + cost
  │    ├─ if no toolCalls → finalAnswer = text; break
  │    └─ for each call:
  │         ├─ mcpDispatch.get(name) → mcpClient.callTool
  │         └─ else builtInDispatch(name, args, workspace)
  └─ finally: close all mcpClients
```

Returns `AgentTrajectory` (messages + toolCalls + usage + cost +
finalAnswer + finishReason + durationMs).

## 8. Skills (`src/skills/`)

Anthropic-OpenAI SKILL.md format. Composes with Claude Code, Codex CLI,
ChatGPT GPTs.

Discovery search order (first hit wins, no merging):

1. `process.env.ANVIL_SKILLS_DIR` (full path)
2. `<workspaceRoot>/.claude/skills/`
3. `$HOME/.claude/skills/`

Pipeline:

```
loadSkills(dir)              ← parse all <name>/SKILL.md, drop invalid
   → activateSkills(skills, maxBytes=32_768)
                             ← byte-budget cap, stable order
   → renderSkillsForPrompt(activated)
                             ← "## Available Skills" markdown block
   → applyToolPolicy(callerAllowedTools, activated.skills)
                             ← intersect with skill `allowed-tools`
```

`composeSkillContext(basePrompt, opts)` is the single entry point.

## 9. MCP client (`src/mcp/`)

Consumer side of `@modelcontextprotocol/sdk` 1.x. Connects to OTHER MCP
servers configured per project.

`mcp.json` discovery:

1. `process.env.ANVIL_MCP_CONFIG`
2. `<workspaceRoot>/mcp.json`
3. `<workspaceRoot>/.mcp/servers.json`
4. `<workspaceRoot>/.claude/mcp.json`
5. `$HOME/.claude/mcp.json`

`${env:VAR}` substitutions in `env`/`headers` resolved at parse time.
Tool names namespaced as `<server>/<tool>` so collisions become visible.

`buildAgentToolset(builtIn, clients)` returns `{ tools, mcpDispatch }`
where `mcpDispatch.get('<server>/<tool>')` routes a tool call back to
the right client.

## 10. Checkpoint cache (`src/checkpoint/`)

Per-call output cache keyed by SHA-256 over a stable fingerprint of
prompt version + tool versions + model id + input payload.

```
<anvilHome>/checkpoints/<project>/<runFamily>/<stage>/<hash>.json
<anvilHome>/checkpoints/_blobs/<sha[0:2]>/<sha>          ← BlobStore
```

Lifecycle: `pending` → `running` → `completed` | `interrupted` |
`failed`. Stages: `plan` | `implement` | `review` | `test` | `ship` |
`kb-grounding` | `mutation`.

`runWithCheckpoint(store, blobs, opts)` is the higher-order wrapper:

1. `computeKey(runFamily, inputs)` → SHA.
2. If cache hit (status=completed + blob present) → `deserialize(blob)`,
   call `onHit`, return — no agent invocation.
3. Else `store.begin(...)`, install own SIGTERM/SIGINT handlers (each
   wrapper has its own closure for clean cleanup under concurrent
   wrappers), run agent, `store.complete(...)` on success or
   `store.fail(...)` on error. `finally` removes handlers.

Stats: on-disk counts (total/completed/...) are authoritative; `hits`
is an in-memory counter that resets on process restart. `costSavedUsd`
sums hit costs.

## 11. Telemetry (`src/telemetry/`)

OpenTelemetry GenAI semantic conventions. Default behavior with zero
config = no spans exported (no allocation overhead via OTel's no-op
tracer).

Files:

- `config.ts` — reads env vars, builds `TelemetryConfig`.
  `ANVIL_OTEL_DISABLED=1` forces noop. `ANVIL_OTEL_RECORD_CONTENT=1`
  opts into prompt/completion in spans. `ANVIL_OTEL_CONSOLE=1` dumps
  spans to stderr.
- `exporters.ts` — `noop` | `console` | `otlp` (HTTP/Protobuf via
  `@opentelemetry/exporter-trace-otlp-http`). The `buildExporter(config)`
  factory is the seam for adding new exporters.
- `tracer.ts` — `getTracer()` lazy initialization.
- `metrics.ts` — `recordGenAiCall(...)` exports counter/histogram via
  OTLP metrics.
- `attributes.ts` — `GenAi` constants for all GenAI attribute names.
- `instrument.ts` — `instrumentModelAdapter(adapter)` wrapper +
  `withInvokeSpan(args, exec, applyResult)` for single-shot.

Span surface emitted:

| Span | Where | Attributes |
|---|---|---|
| `gen_ai.invoke` | every `ModelAdapter.run()` (and single-shot) | `gen_ai.system`, `gen_ai.request.model`, usage tokens, costs (input/output/cache_read/cache_write/total), `anvil.stage`, `anvil.persona`, `anvil.session.resume` |
| `gen_ai.tool.<name>` | every `tool_use` block parsed by the bridge | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.input.summary` |
| `anvil.agent.session` | `AgentProcess.start()` lifetime | `anvil.agent.id/name`, `anvil.persona`, `anvil.project`, `anvil.stage`, `anvil.session.session_id`, total tokens + total_cost_usd |
| `anvil.router.invoke` | `LlmRouter.invoke()` (via `invokeWithSpans`) | tag, run_id, project, user, attempt_count, total_cost_usd, budget_remaining_usd |
| `anvil.router.attempt` | per `RouteAttempt` | provider, model, attempt, fallback_index, error_class, cost_usd |

`gen_ai.invoke` becomes a child of both `anvil.agent.session` (when
driven via `AgentProcess`) and `anvil.router.attempt` (when driven via
the router) through `AsyncLocalStorage` propagation.

## 12. Cost calculation (`src/cost.ts`)

Pricing from a vendored snapshot of LiteLLM's
`model_prices_and_context_window.json` (Apache-2.0). Snapshot at
`src/data/model-prices.json`; build copies it into `dist/data/`.

Public API:

- `getModelPricing(modelId): [number, number] | null` — `[inputPer1M, outputPer1M]`.
- `getDetailedPricing(modelId): DetailedPricing` — adds cache pricing
  + max input/output tokens.
- `calculateCost(modelId, usage): number`.
- `calculateCostBreakdown(modelId, usage)` — per-component (input,
  output, cache_read, cache_write) breakdown used by the OTel
  instrumentation.

Bridge from Anvil's short canonical names (`sonnet`/`opus`/`haiku`) to
LiteLLM keys via `MODEL_ALIASES` inside `cost.ts`. Refresh via
`scripts/refresh-cost-table.mjs`.

## 13. Anvil Stream Format (`src/stream-format.ts`)

NDJSON event stream — superset of `claude --output-format stream-json`.
Every adapter emits this format so a single parser
(`LanguageModelBridge.handleStreamLine`) works uniformly across
providers.

Line shapes:

```
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"...","input":{...}}]}}
{"type":"assistant","message":{"content":[{"type":"thinking","text":"..."}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...","is_error":false}]}}
{"type":"result","result":"...","total_cost_usd":0.123,"usage":{...},"duration_ms":5000,"session_id":"..."}
```

Helpers: `emitContent`, `emitToolUse`, `emitThinking`, `emitResult`.

## 14. File layout

```
packages/agent-core/
├── package.json
├── tsconfig.json
├── README.md
├── CLAUDE.md           ← this directory
├── ARCHITECTURE.md
├── FLOW.md
├── scripts/
│   ├── refresh-cost-table.mjs
│   └── otel-stack.yaml
└── src/
    ├── index.ts                     ← public barrel
    ├── version.ts
    ├── types.ts                     ← LanguageModel + ModelAdapter
    ├── stream-format.ts             ← NDJSON helpers
    ├── registry.ts                  ← ProviderRegistry singleton
    ├── single-shot.ts               ← runLLM / runClaude / runGemini
    ├── cost.ts                      ← LiteLLM-backed pricing
    ├── claude-adapter.ts
    ├── openai-adapter.ts
    ├── gemini-adapter.ts
    ├── openrouter-adapter.ts
    ├── ollama-adapter.ts
    ├── gemini-cli-adapter.ts
    ├── adk-adapter.ts
    ├── fallback-adapter.ts          ← @deprecated; kept for compat
    ├── agent/
    │   ├── index.ts                 ← re-exports session/
    │   └── session/
    │       ├── index.ts             ← canonical agent-lifecycle barrel
    │       ├── types.ts             ← AgentState, SpawnConfig, events, hooks
    │       ├── adapter.ts           ← AgentAdapter, AdapterRequest, factory
    │       ├── legacy-adapter-types.ts
    │       ├── session.ts           ← AgentProcess
    │       ├── session-registry.ts  ← AgentManager
    │       ├── language-model-bridge.ts
    │       ├── default-adapter-factory.ts
    │       ├── run-with-agent.ts    ← single-shot helper
    │       └── __tests__/
    ├── router/
    │   ├── index.ts
    │   ├── types.ts
    │   ├── errors.ts
    │   ├── retry.ts
    │   ├── rate-limiter.ts
    │   ├── spend-ledger.ts          ← SQLite (better-sqlite3)
    │   ├── circuit-breaker.ts
    │   ├── router.ts                ← LlmRouter
    │   ├── config-loader.ts         ← yaml + ${env:VAR}
    │   └── telemetry.ts             ← invokeWithSpans
    ├── headless/
    │   ├── index.ts
    │   ├── types.ts                 ← AgentTrajectory (Inspect-AI shape)
    │   └── runner.ts                ← runAgent loop
    ├── skills/
    │   ├── index.ts
    │   ├── types.ts
    │   ├── parser.ts                ← SKILL.md frontmatter
    │   ├── loader.ts
    │   ├── activator.ts             ← byte-budget activation
    │   ├── render.ts
    │   ├── resolve-dir.ts
    │   ├── tool-policy.ts
    │   └── compose.ts               ← composeSkillContext
    ├── mcp/
    │   ├── index.ts
    │   ├── types.ts
    │   ├── config-loader.ts
    │   ├── client.ts                ← McpAgentClient
    │   └── tool-merger.ts           ← buildAgentToolset
    ├── checkpoint/
    │   ├── index.ts
    │   ├── types.ts
    │   ├── key.ts                   ← computeKey / fingerprint
    │   ├── blob-store.ts            ← content-addressed blobs
    │   ├── store.ts                 ← CheckpointStore (JSON files)
    │   ├── runner.ts                ← runWithCheckpoint
    │   └── __tests__/
    ├── telemetry/
    │   ├── index.ts
    │   ├── config.ts
    │   ├── attributes.ts            ← GenAi constants
    │   ├── exporters.ts             ← noop | console | otlp
    │   ├── tracer.ts
    │   ├── metrics.ts
    │   └── instrument.ts            ← instrumentModelAdapter, withInvokeSpan
    ├── data/
    │   └── model-prices.json        ← LiteLLM snapshot (Apache-2.0)
    └── __tests__/                   ← cross-cutting tests
```

## 15. Runtime dependencies

From `package.json`:

- `@opentelemetry/*` — api, sdk-trace-base, sdk-trace-node, sdk-metrics,
  exporter-trace-otlp-http, exporter-metrics-otlp-http, resources,
  semantic-conventions. Reference OTel SIG implementation only — no
  vendor-specific SDK.
- `@modelcontextprotocol/sdk` — MCP client (`src/mcp/`).
- `better-sqlite3` — synchronous SQLite for the spend ledger.
- `yaml` — `llm-router.yaml` parsing.

No vendor LLM SDK (`@anthropic-ai/sdk`, `openai`, `@google/genai`).
No `langchain`, `mastra`, Vercel AI SDK, or LiteLLM-as-proxy.

## 16. Tests

`node --test` runs every compiled `*.test.js` under:

- `dist/__tests__/` — cross-cutting (cost, telemetry, runAgent, mcp,
  router-*, single-shot, skills*, openai-adapter-output, adapter-enrichment).
- `dist/agent/session/__tests__/` — process + manager + adapter +
  run-with-agent.
- `dist/checkpoint/__tests__/` — store + runner + blob-store + key.

Build copies `src/data/model-prices.json` to `dist/data/` before tests
run; the cost loader reads it from there at module-load time.
