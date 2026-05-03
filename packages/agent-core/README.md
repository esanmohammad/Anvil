# `@anvil/agent-core`

Shared LLM stack for the Anvil monorepo. Owns every LLM call surface — both the
streaming/agent shape (build/validate/ship pipeline stages) and the single-shot
analytical shape (repo profiler, service-mesh inferrer, RAG evaluator).

> **Status:** Shipped. Phases 0–10 of [`AGENT-CORE-EXTRACT-PLAN.md`](../../AGENT-CORE-EXTRACT-PLAN.md)
> are complete. See [`AGENT-CORE-ADR.md`](../../AGENT-CORE-ADR.md) §9 for the
> per-phase commit log + plan deviations.

## Why this exists

Before extraction:
- Streaming/agent runner lived in `packages/cli/src/providers/` (12 files, ~3,500 LOC).
- Subprocess machinery lived in `packages/cli/src/agent/` (9 files, ~2,000 LOC).
- Single-shot runner lived in `packages/knowledge-core/src/claude-runner.ts` (~330 LOC).
- Two parallel pricing tables, two env-var contracts, two auth-resolution paths.

After extraction:
- One package owns it all. cli + knowledge-core + (future) headless runners
  consume `@anvil/agent-core` directly.
- One env-var contract: `ANVIL_LLM_*` canonical, with backwards-compatible
  aliases (`CODE_SEARCH_LLM_*`, `ANTHROPIC_API_KEY`, `CLAUDE_BIN`, etc.).
- One central cost table backed by LiteLLM's vendored snapshot.

## Public API

### LanguageModel — new unified interface

The forward-looking shape. Supports both streaming and single-shot use via
the same interface.

```ts
import type {
  LanguageModel,
  LanguageModelInvokeOptions,
  StreamEvent,
  InvokeResult,
  ToolCall,
  ToolSchema,
} from '@anvil/agent-core';
```

Status: **interface defined, no native adapter implementations yet.** The
seven existing adapters (claude/openai/gemini/openrouter/ollama/gemini-cli/adk)
implement only the legacy `ModelAdapter` shape today. Adding native
`LanguageModel.invoke()` impls is a follow-up phase (see ADR §9 Phase 5
deviation).

### ModelAdapter — legacy interface (current adapters)

```ts
import {
  ProviderRegistry,
  type ModelAdapter,
  type ModelAdapterConfig,
  type ModelAdapterResult,
  type ProviderName,         // 'claude' | 'openai' | 'gemini' | 'openrouter'
                             // | 'ollama' | 'gemini-cli' | 'adk'
  type ProviderTier,         // 'agentic' | 'function-calling' | 'text-only'
  type ProviderCapabilities,
} from '@anvil/agent-core';

const adapter = ProviderRegistry.getInstance().get('claude');
const result = await adapter.run(config, outputStream);
```

`ProviderRegistry.getInstance()` auto-registers all 7 adapters via static ESM
imports (per Phase 4 ESM/`require` fix in ADR §9).

### Stream format helpers

```ts
import {
  emitContent,
  emitToolUse,
  emitThinking,
  emitResult,
  type StreamLine,
  type ResultMessage,
} from '@anvil/agent-core';
```

The Anvil Stream Format is a NDJSON event stream — a superset of Claude CLI's
`--output-format stream-json`. Every adapter emits this format so `StreamParser`
+ `AgentManager` work uniformly across providers.

### Single-shot runner

```ts
import {
  runLLM,        // provider-aware facade (defaults to claude)
  runClaude,     // CLI or HTTP API based on ANVIL_LLM_MODE
  runGemini,     // Gemini CLI subprocess
  isLlmAvailable,
  resetLlmConfig,
  type LLMRunOptions,
  type ClaudeResult,
} from '@anvil/agent-core';

const result = await runLLM('analyze this code', 'You are a code reviewer', {
  provider: 'claude',
  model: 'sonnet',
  timeoutMs: 60_000,
});
```

### Agent subprocess machinery

```ts
import {
  AgentManager,
  spawnAgent,
  type AgentProcess,
  type AgentEvent,
  type AgentProcessConfig,
  StreamParser,
  OutputBuffer,
  RestartPolicy,
  TimeoutGuard,
  StageValidator,
  STAGE_TIMEOUT_DEFAULTS,
  createDefaultConfig,
} from '@anvil/agent-core';
```

### Cost calculation

```ts
import {
  getModelPricing,
  getDetailedPricing,
  calculateCost,
  type DetailedPricing,
  type UsageInput,
} from '@anvil/agent-core';

getModelPricing('sonnet');           // → [3, 15] (per-1M tokens, USD)
getModelPricing('claude-opus-4-7');  // → [5, 25]
getModelPricing('gpt-4o');           // → [2.5, 10]

calculateCost('sonnet', { inputTokens: 1_000_000, outputTokens: 500_000 });
// → 10.5

getDetailedPricing('sonnet');
// → { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3,
//     cacheWritePer1M: 3.75, maxInputTokens: 1000000, maxOutputTokens: 64000 }
```

The pricing table is a vendored snapshot of [LiteLLM's
`model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
(Apache-2.0). Anvil's short canonical names (`sonnet`/`opus`/`haiku`) bridge
to specific LiteLLM keys via `MODEL_ALIASES` inside `cost.ts`.

## LLM Router

The `LlmRouter` is the single entry point for cross-provider routing,
fallbacks, retries, rate limits, spend tracking, and circuit breaking.
Lives in `src/router/`; ships as part of this package.

### Architecture

```
caller — invokeWithSpans(router, opts)
        │
        ├── span: anvil.router.invoke           ← parent span (R10)
        │
        ├── LlmRouter.invoke
        │     ├── budget pre-flight (SpendLedger)
        │     ├── for each chain step:
        │     │     ├── circuit-breaker check
        │     │     ├── span: anvil.router.attempt
        │     │     ├── runWithRetry (per-error policy)
        │     │     │     └── rateLimiter.acquire(provider, tokens)
        │     │     │     └── adapter.invoke(...)         ← gen_ai.invoke
        │     │     ├── ledger.record(...)
        │     │     └── circuit-breaker recordSuccess/Failure
        │     └── return RouteOutcome
        │
        └── span end (status OK or ERROR + recordException)
```

### Quick start

```ts
import {
  LlmRouter,
  loadRouterConfig,
  invokeWithSpans,
} from '@anvil/agent-core';

const config = loadRouterConfig();              // YAML or compiled defaults
const router = new LlmRouter({
  config,
  resolver: { resolve: (modelId) => yourLanguageModelFor(modelId) },
});
const outcome = await invokeWithSpans(router, {
  tag: 'planner',
  prompt: 'plan a refactor',
  runId: 'run-abc',
});
console.log(outcome.result?.text, outcome.totalCostUsd);
```

### YAML config (`~/.anvil/llm-router.yaml`)

Optional — the router runs on compiled-in defaults if no file is
present. Search order: `ANVIL_ROUTER_CONFIG` env → `<workspace>/.anvil/
llm-router.yaml` → `~/.anvil/llm-router.yaml` → defaults.

```yaml
routes:
  - tag: planner
    primary: claude-sonnet-4-6
    fallbacks:
      - { model: claude-haiku-4-5-20251001, on: [rate_limit, server_5xx] }
      - { model: gpt-4o,                    on: [server_5xx, timeout] }
  - tag: reviewer
    primary: claude-sonnet-4-6
    fallbacks:
      - { model: gpt-4o, on: [rate_limit, server_5xx, timeout] }

retryPolicy:
  rate_limit: { attempts: 5, backoff: exponential, baseMs: 1000, maxMs: 30000 }
  timeout:    { attempts: 3, backoff: linear,      baseMs: 500,  maxMs: 5000  }
  server_5xx: { attempts: 4, backoff: exponential, baseMs: 200,  maxMs: 5000  }
  auth:            { attempts: 0, backoff: constant, baseMs: 0 }
  content_policy:  { attempts: 0, backoff: constant, baseMs: 0 }
  invalid_request: { attempts: 0, backoff: constant, baseMs: 0 }
  unknown:         { attempts: 1, backoff: constant, baseMs: 1000 }

rateLimit:
  claude:  { rpm: 50,  tpm: 80000 }
  openai:  { rpm: 500, tpm: 30000 }

budgets:
  dailyUsd: 50.0
  perRunUsd: 5.0
  perTagUsd:
    code-gen: 1.5
  onBreach: fail            # fail | downgrade | queue

circuitBreaker:
  failureThreshold: 5
  cooldownMs: 30000
  halfOpenAttempts: 1

maxFallbackCostUsd: 1.0
onRateLimit: wait           # wait | fail | fallback
```

`${env:VAR}` is expanded inside string values against `process.env`.

### Spend ledger

Every terminal outcome (success or failure) is one row in
`~/.anvil/router/spend.sqlite` (override via `ANVIL_HOME`). Failed calls
get `cost_usd = 0` so retry-driven amplification is auditable.

```ts
import { SpendLedger } from '@anvil/agent-core';

const ledger = new SpendLedger();              // default path
console.log(ledger.totalUsd({ runId: 'run-abc' }));
console.log(ledger.groupBy('tag'));
console.log(ledger.recent(20));
```

### Error classification

The router maps every adapter exception to one of seven `ErrorClass`
values, used to look up the retry policy + decide whether a fallback
step is eligible:

| Class | When | Default retry |
|---|---|---|
| `rate_limit` | HTTP 429 | 5 attempts, exponential 1s → 30s |
| `timeout` | abort/etimedout/socket-hang-up | 3 attempts, linear 500ms |
| `server_5xx` | HTTP 5xx | 4 attempts, exponential 200ms → 5s |
| `auth` | HTTP 401/403 | 0 (terminal) |
| `content_policy` | safety-filter signals | 0 (terminal — never fallback to a different provider) |
| `invalid_request` | HTTP 400 (non-content-policy) | 0 (terminal) |
| `unknown` | anything else | 1 attempt, constant 1s |

Per-provider classifier overrides plug in via `LlmRouterDeps.errorClassifiers`.

### OTel attributes

Parent span `anvil.router.invoke`:
- `anvil.router.{tag, run_id, project, user, attempt_count,
   total_cost_usd, budget_remaining_usd}`

Child spans `anvil.router.attempt` (one per `RouteAttempt`):
- `anvil.router.{provider, model, attempt, fallback_index,
   error_class, cost_usd}`

Existing `gen_ai.invoke` spans from `instrumentModelAdapter` become
grandchildren — preserves the OTel GenAI hierarchy.

### Migration from FallbackAdapter

`FallbackAdapter` is `@deprecated` but kept functional. New callers:

```ts
// before
const adapter = new FallbackAdapter([sonnet, haiku], 2, 1000);

// after
const router = new LlmRouter({
  config: {
    routes: [{
      tag: 'planner',
      primary: 'claude-sonnet-4-6',
      fallbacks: [{ model: 'claude-haiku-4-5-20251001' }],
    }],
    retryPolicy: DEFAULT_RETRY_POLICY,
  },
  resolver: { resolve: (modelId) => /* your LanguageModel */ },
});
```

## Environment variables

`ANVIL_*` is canonical. Legacy aliases are honoured with a one-time deprecation
warning to stderr.

| Canonical | Legacy aliases | Purpose |
|---|---|---|
| `ANVIL_LLM_MODE` | `CODE_SEARCH_LLM_MODE` | `cli` / `api` / `none` |
| `ANVIL_LLM_API_KEY` | `CODE_SEARCH_LLM_API_KEY` | required for `api` mode |
| `ANVIL_LLM_PROVIDER` | `CODE_SEARCH_LLM_PROVIDER` | `anthropic` / `openai` / `custom` |
| `ANVIL_LLM_MODEL` | `CODE_SEARCH_LLM_MODEL` | model id / short name |
| `ANVIL_LLM_BASE_URL` | `CODE_SEARCH_LLM_BASE_URL` | OpenAI-compat endpoint |
| `ANVIL_CLAUDE_BIN` | `ANVIL_AGENT_CMD`, `FF_AGENT_CMD`, `CODE_SEARCH_CLAUDE_BIN`, `CLAUDE_BIN` | path to claude CLI |
| `ANVIL_GEMINI_BIN` | `GEMINI_BIN`, `GEMINI_CLI_BIN` | path to gemini CLI |
| `ANVIL_ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | direct Anthropic key |
| `ANVIL_ROUTER_CONFIG` | — | absolute path to `llm-router.yaml` (highest priority) |
| `ANVIL_HOME` | — | overrides `~/.anvil/` for both spend ledger + router config |

Resolution order in every case: `ANVIL_*` → legacy alias(es) → default.

Adapter-specific env vars (read by individual adapters, not yet aliased to
`ANVIL_*`): `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENROUTER_API_KEY`,
`OPENROUTER_BASE_URL`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OLLAMA_HOST`.

## Telemetry (OpenTelemetry)

Every LLM call routed through `@anvil/agent-core` emits an OpenTelemetry
span using the [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/llm-spans/).
**Default behaviour with zero config = no spans exported** — there is no
hard dep on any vendor SDK. Vendors plug in via the standard OTLP HTTP
exporter; backend swap is a one-line env-var change.

### Span attributes emitted

| Attribute | Source | When |
|---|---|---|
| `gen_ai.system` | adapter `provider` | always |
| `gen_ai.request.model` | invoke options / config | always |
| `gen_ai.usage.input_tokens` / `output_tokens` | provider response | always |
| `gen_ai.usage.cost_usd` | central cost table (`cost.ts`) | always; falls back to adapter's costUsd for unknown models |
| `gen_ai.usage.cost_{input,output,cache_read,cache_write}_usd` | breakdown | always (zero when component absent) |
| `gen_ai.usage.cache_read_tokens` / `cache_write_tokens` / `cache_hit_ratio` | per-provider extraction | when adapter surfaces cache data (Anthropic, OpenAI, Gemini) |
| `gen_ai.reasoning.tokens` | provider response | when reasoning tokens > 0 |
| `gen_ai.response.tool_call_count` | stream parsing | when adapter counts tool calls |
| `gen_ai.response.id` | provider session id | when present |
| `gen_ai.prompt` / `gen_ai.completion` | request/result text (truncated to 8 KB) | only with `ANVIL_OTEL_RECORD_CONTENT=1` |
| `anvil.{stage,persona,duration_ms,session.resume,transport}` | Anvil-extension | always |

Spans set `OK` status on success, `ERROR` on adapter throws (with
`recordException` populating the exception event).

### Backend recipes

#### No-op (default)

No env vars set → no spans exported, zero overhead.

#### Console (debug)

```sh
ANVIL_OTEL_CONSOLE=1 anvil index ./fixture
```

Each finished span is dumped to stderr as JSON. Useful for verifying
attributes locally before pointing at a real backend.

#### Langfuse cloud

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel/v1/traces \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic $(echo -n pk-lf-xxx:sk-lf-xxx | base64)" \
anvil index ./fixture
```

#### Self-hosted Langfuse (canonical local stack)

A turnkey docker-compose stack lives at
[`infra/observability/docker-compose.yml`](../../infra/observability/docker-compose.yml)
(Langfuse 3 + Postgres + ClickHouse + Redis + MinIO):

```sh
docker compose -f infra/observability/docker-compose.yml up -d
# open http://localhost:3000, sign up, create project, copy pk + sk
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000/api/public/otel/v1/traces \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic $(echo -n pk-lf-xxx:sk-lf-xxx | base64)" \
ANVIL_OTEL_RECORD_CONTENT=1 \
anvil index ./fixture
```

The dashboard auto-detects this stack on startup (probes
`localhost:3000/api/public/otel/v1/traces`); zero env-var config needed
in the common case.

If port 3000 collides with another local service:

```sh
LANGFUSE_PORT=3300 docker compose -f infra/observability/docker-compose.yml up -d
```

For self-hosting outside docker-compose (e.g. Helm), point the OTLP
endpoint at your Langfuse server's `/api/public/otel/v1/traces`.

#### A different OTLP backend

Langfuse is the supported backend for Anvil. The wire format is plain
OTLP HTTP, so any other GenAI-aware OTLP receiver works in principle —
just point `OTEL_EXPORTER_OTLP_ENDPOINT` at it. We don't ship recipes
for those because we don't test against them; you're on your own for
attribute-rendering nuances.

### Privacy: prompt + completion content

By default **prompts and completions are NOT included in spans**. This
prevents secrets, API keys, and customer data from leaking into trace
backends. To opt in:

```sh
ANVIL_OTEL_RECORD_CONTENT=1
```

Even with the flag set, content is truncated to 8 KB per attribute. The
flag is a property of the run, not the span — toggling it requires
restarting the process.

### Sampling

OTel's standard environment variables control sampling. To trace 10 % of
calls:

```sh
OTEL_TRACES_SAMPLER=traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

### Kill-switch

```sh
ANVIL_OTEL_DISABLED=1   # forces noop, even if OTEL_EXPORTER_OTLP_ENDPOINT is set
```

### Adding a new exporter

The configurable exporters are `noop` (default), `console`, and `otlp`
(HTTP/Protobuf via `@opentelemetry/exporter-trace-otlp-http`). To add a
gRPC or other transport, edit
[`src/telemetry/exporters.ts`](./src/telemetry/exporters.ts) — the
`buildExporter(config)` factory is the seam.

### Lock-in surface (telemetry)

- **No vendor SDK** in the dep tree (`@langfuse/*`, `@helicone/*`,
  `langsmith`, `@traceloop/*` — none).
- Only `@opentelemetry/*` packages, which are the OTel SIG's reference
  implementation.
- Backend swap is an env-var change.

## Refresh the cost table

```sh
npm -w @anvil/agent-core run refresh-cost-table
```

Re-runs `scripts/refresh-cost-table.mjs` which fetches LiteLLM's JSON and
overwrites `src/data/model-prices.json`. Commit the result. The `MODEL_ALIASES`
table in `src/cost.ts` may need a manual update if a flagship model rev was
introduced (e.g. when `claude-opus-4-7` succeeded `claude-opus-4`).

Run cadence: quarterly + when adding a new model.

## File layout

```
packages/agent-core/
├── package.json
├── tsconfig.json
├── README.md                  ← this file
├── scripts/
│   └── refresh-cost-table.mjs
└── src/
    ├── index.ts               ← public barrel
    ├── version.ts
    ├── types.ts               ← LanguageModel + ModelAdapter (legacy section)
    ├── stream-format.ts       ← NDJSON event helpers
    ├── registry.ts            ← ProviderRegistry singleton
    ├── single-shot.ts         ← runLLM / runClaude / runGemini
    ├── cost.ts                ← LiteLLM-backed pricing
    ├── claude-adapter.ts      ← 7 provider adapters
    ├── openai-adapter.ts
    ├── gemini-adapter.ts
    ├── openrouter-adapter.ts
    ├── ollama-adapter.ts
    ├── gemini-cli-adapter.ts
    ├── adk-adapter.ts
    ├── fallback-adapter.ts    ← chain-of-adapters meta-adapter
    ├── agent/
    │   ├── index.ts
    │   ├── types.ts           ← AgentEvent, AgentProcessConfig, etc.
    │   ├── agent-manager.ts
    │   ├── spawn.ts
    │   ├── output-buffer.ts
    │   ├── restart-policy.ts
    │   ├── stage-validator.ts
    │   ├── stream-parser.ts
    │   └── timeout-guard.ts
    ├── data/
    │   └── model-prices.json  ← LiteLLM snapshot (Apache-2.0, 1.4 MB)
    └── __tests__/
        └── single-shot.test.ts (9 tests)
```

## Agent harness — skills, MCP, headless `runAgent`

Three independent-but-related capabilities exported from this package, all
designed against open standards (Anthropic-OpenAI SKILL.md, Model Context
Protocol, Inspect AI external-agent contract). See
[`AGENT-HARNESS-ADR.md`](../../AGENT-HARNESS-ADR.md) at the repo root for the
locked schemas.

### Skills (Anthropic-OpenAI SKILL.md)

```ts
import { composeSkillContext } from '@anvil/agent-core';

const ctx = composeSkillContext('You are a helpful coding agent.', {
  workspaceRoot: process.cwd(),
  allowedTools: ['fs.read', 'shell.run'],
});
// ctx.systemPrompt — base + appended "## Available Skills" block
// ctx.allowedTools — caller ∩ skill-declared `allowed-tools`
// ctx.activated.skills — Skill[] selected under the 32 KB byte budget
// ctx.resolvedDir — actual directory that was read
```

Discovery search order (first hit wins, no merging):

1. `process.env.ANVIL_SKILLS_DIR` (full path)
2. `<workspaceRoot>/.claude/skills/`
3. `$HOME/.claude/skills/`

Each skill is `<dir>/<name>/SKILL.md`. Skills compose with Claude Code, Codex
CLI, and ChatGPT GPTs — same format, no vendor lock-in.

### MCP client (`@modelcontextprotocol/sdk` 1.x)

Anvil's `code-search-mcp` is the *server* side; this is the *client* side
that lets your agent connect to OTHER MCP servers configured per project.

```ts
import { loadMcpServers, McpAgentClient, buildAgentToolset } from '@anvil/agent-core';

const servers = loadMcpServers({ workspaceRoot: process.cwd() });
const clients = servers.map((c) => new McpAgentClient(c));
const builtIn = [/* your built-in ToolSchema[] */];
const { tools, mcpDispatch } = await buildAgentToolset(builtIn, clients);
// `tools` → pass to LanguageModel.invoke({ tools })
// `mcpDispatch.get('<server>/<tool>')` → route tool calls back
```

`mcp.json` discovery search order (first hit wins):

1. `process.env.ANVIL_MCP_CONFIG` (full path)
2. `<workspaceRoot>/mcp.json`
3. `<workspaceRoot>/.mcp/servers.json`
4. `<workspaceRoot>/.claude/mcp.json`
5. `$HOME/.claude/mcp.json`

`${env:VAR}` substitutions in `env`/`headers` are expanded at parse time.
Tool names are namespaced as `<server>/<tool>` so collisions across servers
become visible.

### Headless `runAgent` (Inspect-AI-compatible)

```ts
import { runAgent } from '@anvil/agent-core';

const trajectory = await runAgent(
  {
    prompt: 'List the files in the workspace.',
    model: 'claude-sonnet-4-6',
    allowedTools: ['fs.read'],
  },
  { rootDir: process.cwd() },
  {
    model: myLanguageModel,           // required: caller injects LanguageModel
    builtInTools: [/* … */],          // optional: built-in ToolSchema[]
    builtInDispatch: async (...) => …, // optional: router for non-MCP tools
    maxToolLoopIterations: 25,        // hard cap (default 25)
    timeoutMs: 600_000,               // wall-clock cap (default 10 min)
  },
);
// trajectory: { messages, toolCalls, model, usage, costUsd,
//               finalAnswer, finishReason, error?, durationMs }
```

The trajectory format follows Inspect AI's external-agent contract: messages
+ tool calls + aggregated usage + cost + final answer. External eval
harnesses ingest it without conversion.

> **Note (2026-04-29):** No agent-core adapter implements `LanguageModel`
> natively yet — see observability ADR §3.4. Callers must inject one via
> `options.model`. The bridge from `ModelAdapter` to `LanguageModel` is
> follow-up work; tests use a `ScriptedLanguageModel` mock.

### Inspect AI smoke recipe

[Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai) (UK AISI) is the
reference external-agent eval framework. Anvil's `runAgent` returns
trajectories in the shape Inspect AI ingests as `inspect eval --solver
external`.

```sh
pip install inspect-ai

# Wrap runAgent as an Inspect AI solver in a small Python ↔ Node bridge.
# The exact wiring depends on the Inspect AI version at the time of use;
# the contract on the Anvil side is the AgentTrajectory shape exported
# from `@anvil/agent-core/headless`.

inspect eval my_task.py --solver external --model anvil/runAgent
```

`runAgent` is callable; usage is bounded by your eval framework's harness
conventions, not by anything Anvil-specific. If Inspect AI's contract
drifts in a future version, write a ~30-LOC adapter — don't refactor
`AgentTrajectory`.

## Lock-in surface

- **Vendor SDKs**: none today. Adapters use `node:child_process` (subprocess
  adapters) or hand-rolled `fetch()` (HTTP adapters). Adopting `@anthropic-ai/sdk`
  / `openai` / `@google/genai` would localize lock-in to one ~150-LOC adapter
  file per provider — replacement cost = rewrite that one file.
- **Cost table**: vendored snapshot, no runtime fetch.
- **No abstraction framework.** No Vercel AI SDK, LiteLLM-as-proxy, Mastra,
  LangChain, etc.

## License

The vendored cost table is Apache-2.0 (upstream LiteLLM). The rest of this
package is MIT, matching the Anvil monorepo.
