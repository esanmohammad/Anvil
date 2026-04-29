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

#### Self-hosted Langfuse (Helm / docker-compose)

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=https://langfuse.your-cluster/api/public/otel/v1/traces \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64(pk:sk)>" \
anvil index ./fixture
```

A turnkey local stack lives at [`scripts/otel-stack.yaml`](./scripts/otel-stack.yaml):

```sh
docker compose -f packages/agent-core/scripts/otel-stack.yaml up -d
# open http://localhost:3000, sign up, create project, copy pk + sk
ANVIL_OTEL_CONSOLE=1 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000/api/public/otel/v1/traces \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic $(echo -n pk-lf-xxx:sk-lf-xxx | base64)" \
ANVIL_OTEL_RECORD_CONTENT=1 \
anvil index ./fixture
```

#### Self-hosted Phoenix (Arize, OSS)

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006/v1/traces \
anvil index ./fixture
```

#### Honeycomb

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces \
OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=YOUR_KEY" \
anvil index ./fixture
```

#### Datadog (LLM Observability)

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=https://trace.agent.datadoghq.com/v1/traces \
OTEL_EXPORTER_OTLP_HEADERS="DD-API-KEY=YOUR_KEY" \
anvil index ./fixture
```

#### Self-hosted Tempo / Jaeger / OTel Collector

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318/v1/traces \
anvil index ./fixture
```

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
