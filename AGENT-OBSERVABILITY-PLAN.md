# Plan: Observability layer for `@anvil/agent-core` (OpenTelemetry-first)

> **Status: Proposed.** Self-contained executable plan — does not require prior conversation context. **Depends on [`AGENT-CORE-EXTRACT-PLAN.md`](./AGENT-CORE-EXTRACT-PLAN.md) being shipped** (the `LanguageModel` interface lives in `@anvil/agent-core`). Sibling: [`AGENT-HARNESS-PLAN.md`](./AGENT-HARNESS-PLAN.md) (executes after this).

---

## Goals (what "done" means)

1. Every LLM call originating from `@anvil/agent-core` emits an OpenTelemetry span with: model, provider, input/output tokens, cost USD, prompt cache read/write tokens, tool calls, durations, error status. **Both the streaming and single-shot surfaces are instrumented.**
2. **Zero hard dependency on any vendor's observability SDK.** No `@langfuse/*`, no `@helicone/*`, no `langsmith`, no `@traceloop/*` SDKs in the dependency tree. Spans are emitted via the bare `@opentelemetry/*` standard libraries; vendors plug in via the OTel HTTP/Protobuf exporter (the standard wire protocol every backend supports).
3. **Default behavior with zero config = no-op exporter** (silent). Console exporter via env. Network exporters (Langfuse, Phoenix, Honeycomb, Datadog, Jaeger, self-hosted Tempo) plug in via standard OTLP env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`).
4. Spans follow the **GenAI semantic conventions** (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, etc.) so every backend renders them correctly out of the box.
5. No prompt content (system / user messages) is captured by default — opt-in via `ANVIL_OTEL_RECORD_CONTENT=1`. Avoids leaking secrets into traces.
6. Cost annotation on every span uses the cost table from `AGENT-CORE-EXTRACT-PLAN.md` Phase 7.
7. Existing functionality unchanged: callers that don't set any OTel env var see exactly today's behavior. Callers that opt in get full traces.

---

## Cost-benefit context

### Why not Langfuse SDK directly?

The Langfuse JS SDK works and has a richer API (datasets, prompt management, evals). But adopting it means:

- Hard dep on `@langfuse/*` packages.
- Lock-in: backend swaps require code changes, not env var changes.
- Doesn't generalize: a teammate at a Datadog shop has to re-instrument.
- Replicates what OTel already does: trace + spans + attributes.

**The OTel-only seam is a one-line config change to swap backends:**

```sh
# Langfuse cloud
OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic $(echo -n pk:sk | base64)"

# Self-hosted Phoenix
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006/v1/traces

# Honeycomb
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces
OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=YOUR_KEY"

# Self-hosted Tempo / Jaeger / Datadog Agent
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318/v1/traces
```

Every modern observability backend speaks OTLP. The SDK-vendor approach picks one bet; the OTel approach inherits the entire ecosystem.

### Why not Helicone proxy?

Already analyzed — slows the hot path, single point of failure, fragments tool-call semantics across providers. Out of scope.

### Why GenAI semantic conventions?

The OpenTelemetry SIG ratified `gen_ai.*` attributes in 2024. Every backend that supports OTel and "knows about LLMs" (Langfuse, Phoenix, Honeycomb's LLM dashboards, Datadog's GenAI product) reads these attribute names. Following them = backend-agnostic by construction.

Reference: <https://opentelemetry.io/docs/specs/semconv/gen-ai/llm-spans/>.

### Net hand-edited LOC

- ~600 LOC of new code in agent-core (telemetry init, span emission, cost annotation, config wiring, tests)
- ~50 LOC of config/docs in consumers
- Zero LOC in callers — telemetry is internal to agent-core; consumers don't see it

---

## Current state assumed (snapshot at plan-execution time)

This plan assumes:

- `AGENT-CORE-EXTRACT-PLAN.md` shipped (all 10 phases).
- `@anvil/agent-core` package exists and owns the `LanguageModel` interface, all 7 adapters, the single-shot `runLLM` wrapper, and the cost table at `data/model-prices.json`.
- The `cost.ts` module exists with `getModelPricing` and `calculateCost` helpers.
- No telemetry / OTel code exists in any package. Search `grep -rn "@opentelemetry" packages/ 2>/dev/null` returns zero matches.

### Pre-flight reality check

```sh
test -d packages/agent-core || { echo "FAIL: agent-core not extracted yet; ship AGENT-CORE-EXTRACT-PLAN first"; exit 1; }
test -f packages/agent-core/src/cost.ts || { echo "FAIL: cost.ts missing; ship Phase 7 of agent-core extract first"; exit 1; }
grep -rln "@opentelemetry" packages/ 2>/dev/null | grep -v node_modules && { echo "WARN: existing OTel imports — reconcile before proceeding"; }
npm -w @anvil/agent-core test  # 71+ pass
```

---

## Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| O1 | Telemetry standard | **OpenTelemetry** only | Vendor-neutral, industry standard, supported by every backend. |
| O2 | Span attribute conventions | **OpenTelemetry GenAI semantic conventions** (`gen_ai.*`) | Every LLM-aware backend reads these natively. |
| O3 | Default exporter | **No-op** (silent) | Zero-config users see zero behavior change. |
| O4 | Configurable exporters | **Console** + **OTLP HTTP** | Bare `@opentelemetry/exporter-trace-otlp-http` covers Langfuse, Phoenix, Honeycomb, Datadog, Jaeger, Tempo, Splunk, etc. No vendor SDK in the tree. |
| O5 | Prompt content recording | **Off by default**, opt-in via `ANVIL_OTEL_RECORD_CONTENT=1` | Avoid leaking secrets / API keys / PII into traces. |
| O6 | Cost annotation | **Computed in agent-core's wrapper, attached as `gen_ai.usage.cost_usd`** | One source of truth (the cost table), works for every backend. Some backends recompute cost themselves; conflict resolution is "ours wins" because we know the actual call. |
| O7 | Cache metrics | Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`, OpenAI `cached_tokens`, Gemini `cachedContentTokenCount` → all surfaced as `gen_ai.usage.cache_read_tokens` / `gen_ai.usage.cache_write_tokens` | Provider-specific extraction, normalized name. |
| O8 | Reasoning blocks | Surfaced as a child span `gen_ai.reasoning` with attributes `gen_ai.reasoning.tokens` and (opt-in) `gen_ai.reasoning.text` | Anthropic ThinkingBlock, OpenAI Reasoning items both fit. |
| O9 | Tool calls | Each tool call gets a child span `gen_ai.tool_call` with `gen_ai.tool.name`, `gen_ai.tool.arguments_size_bytes` | Backend can render the tool-call hierarchy. |
| O10 | Prompt management | **Out of scope** — prompts stay as `.md` files in the repo | Langfuse's prompt mgmt is the lock-in piece. In-repo + git is sufficient. |
| O11 | Eval primitives | **Out of scope** — addressed in `AGENT-HARNESS-PLAN.md` (Inspect AI as external runner) | Don't reinvent. |
| O12 | Sampling | Always-on by default; configurable via standard `OTEL_TRACES_SAMPLER` env vars | Default is appropriate at typical Anvil throughput. |
| O13 | Trace ID propagation | Standard W3C Trace Context (`traceparent` header on outbound HTTP) | Already what every OTel SDK does. No code needed beyond initialization. |
| O14 | Resource attributes | `service.name=anvil-agent-core`, `service.version=$pkgVersion` | Backends use these to group spans. |

---

## Phase 0 — Audit + decisions (no code change)

**Effort:** 0.5d.

### 0.1 Audit deliverables

Produce `AGENT-OBSERVABILITY-ADR.md` at repo root. Contents:

1. The decisions table above, formalized.
2. Inventory of every place `@anvil/agent-core` makes a network call or spawns a subprocess. Each is an instrumentation site.
3. Survey of GenAI semantic conventions used by major backends (Langfuse / Phoenix / Honeycomb / Datadog) — confirm `gen_ai.*` is the right convention namespace as of plan execution.
4. Decide retention defaults (don't decide here; document who decides).

### 0.2 Acceptance

- [ ] ADR written
- [ ] Pre-flight reality check passes
- [ ] OTel package versions chosen and pinned (recommend: `@opentelemetry/api ^1.x`, `@opentelemetry/sdk-node ^0.x`, `@opentelemetry/exporter-trace-otlp-http ^0.x`)

### 0.3 Rollback

N/A — doc-only.

---

## Phase 1 — Scaffold OTel infrastructure inside `@anvil/agent-core`

**Effort:** 0.5d.

### 1.1 Add deps

Update `packages/agent-core/package.json`:

```json
{
  "dependencies": {
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/resources": "^1.30.0",
    "@opentelemetry/sdk-trace-base": "^1.30.0",
    "@opentelemetry/sdk-trace-node": "^1.30.0",
    "@opentelemetry/exporter-trace-otlp-http": "^0.57.0",
    "@opentelemetry/semantic-conventions": "^1.30.0"
  }
}
```

(Pin to versions current at execution time; the `^` ranges above are illustrative. Bump to whatever's stable on npm.)

`npm install` to materialize.

### 1.2 Create `agent-core/src/telemetry/` directory

```
src/telemetry/
├── index.ts              public exports
├── tracer.ts             tracer initialization + lazy provider
├── attributes.ts         GenAI semantic convention helpers
├── config.ts             env var resolution
└── exporters.ts          exporter factory (no-op, console, OTLP)
```

### 1.3 `telemetry/config.ts`

Reads env vars and produces a normalized config object:

```ts
export interface TelemetryConfig {
  enabled: boolean;                    // ANVIL_OTEL_ENABLED=1 OR OTEL_EXPORTER_OTLP_ENDPOINT set
  exporterMode: 'noop' | 'console' | 'otlp';
  endpoint?: string;                   // OTEL_EXPORTER_OTLP_ENDPOINT
  headers?: Record<string, string>;    // OTEL_EXPORTER_OTLP_HEADERS
  recordContent: boolean;              // ANVIL_OTEL_RECORD_CONTENT=1
  serviceName: string;                 // OTEL_SERVICE_NAME ?? 'anvil-agent-core'
  sampler?: string;                    // OTEL_TRACES_SAMPLER
}

export function loadTelemetryConfig(): TelemetryConfig { /* ... */ }
```

Resolution rules:

- If `OTEL_EXPORTER_OTLP_ENDPOINT` is set → `exporterMode = 'otlp'`, `enabled = true`.
- Else if `ANVIL_OTEL_CONSOLE=1` → `exporterMode = 'console'`, `enabled = true`.
- Else → `exporterMode = 'noop'`, `enabled = false`.
- `recordContent` defaults to `false`. Set `ANVIL_OTEL_RECORD_CONTENT=1` to opt in.

### 1.4 `telemetry/tracer.ts`

```ts
import { trace, type Tracer } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor, NoopSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { loadTelemetryConfig } from './config.js';
import { buildExporter } from './exporters.js';
import { VERSION } from '../version.js';

let _tracer: Tracer | null = null;

export function getTracer(): Tracer {
  if (_tracer) return _tracer;
  const config = loadTelemetryConfig();
  const provider = new NodeTracerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: config.serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: VERSION,
    }),
  });
  if (config.enabled) {
    provider.addSpanProcessor(new BatchSpanProcessor(buildExporter(config)));
  } else {
    provider.addSpanProcessor(new NoopSpanProcessor());
  }
  provider.register();
  _tracer = trace.getTracer('anvil.agent-core', VERSION);
  return _tracer;
}

/** Test seam — reset cached tracer so config reloads. */
export function resetTracer(): void { _tracer = null; }
```

### 1.5 `telemetry/exporters.ts`

```ts
import { ConsoleSpanExporter, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { TelemetryConfig } from './config.js';

export function buildExporter(config: TelemetryConfig): SpanExporter {
  switch (config.exporterMode) {
    case 'console': return new ConsoleSpanExporter();
    case 'otlp': return new OTLPTraceExporter({
      url: config.endpoint!,
      headers: config.headers,
    });
    case 'noop':
    default:
      throw new Error('buildExporter called with noop mode');
  }
}
```

### 1.6 `telemetry/attributes.ts`

GenAI semantic convention helpers — reduces typo surface in callers:

```ts
export const GenAi = {
  SYSTEM: 'gen_ai.system',
  REQUEST_MODEL: 'gen_ai.request.model',
  REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  USAGE_CACHE_READ_TOKENS: 'gen_ai.usage.cache_read_tokens',     // anvil ext
  USAGE_CACHE_WRITE_TOKENS: 'gen_ai.usage.cache_write_tokens',   // anvil ext
  USAGE_COST_USD: 'gen_ai.usage.cost_usd',                       // anvil ext
  TOOL_NAME: 'gen_ai.tool.name',
  TOOL_ARGUMENTS_SIZE: 'gen_ai.tool.arguments_size_bytes',       // anvil ext
} as const;
```

### 1.7 `telemetry/index.ts` — public exports

```ts
export { getTracer, resetTracer } from './tracer.js';
export { loadTelemetryConfig } from './config.js';
export type { TelemetryConfig } from './config.js';
export { GenAi } from './attributes.js';
```

### 1.8 Validation

```sh
npm install
npm -w @anvil/agent-core run build
# config tests
ANVIL_OTEL_CONSOLE=1 node -e "import('./packages/agent-core/dist/telemetry/index.js').then(t => { const cfg = t.loadTelemetryConfig(); console.log(cfg); })"
# expected: { enabled: true, exporterMode: 'console', ... }
```

### 1.9 Acceptance

- [ ] `agent-core/src/telemetry/` exists with 5 files
- [ ] OTel deps in `agent-core/package.json`
- [ ] `npm install` succeeds; lockfile updated
- [ ] `npm -w @anvil/agent-core run build` green
- [ ] Existing tests still 71+ pass
- [ ] Config resolves correctly across the three modes (noop / console / otlp)

### 1.10 Rollback

Single-commit revert. Removes the OTel deps and the telemetry/ dir.

### 1.11 Risks

- **OTel SDK version churn:** the SDK trace packages have been at `0.x` for a long time. Pin tightly and don't auto-bump.
- **Provider registration race:** `provider.register()` is a global singleton in OTel. If the dashboard or cli init it elsewhere, double-registration is silent and may break. Mitigation: only `getTracer()` registers; check for existing `trace.getTracerProvider()` and short-circuit.

---

## Phase 2 — Instrument `LanguageModel.invoke` and `invokeStream`

**Effort:** 1d.

### 2.1 Where to instrument

Two surfaces:

1. **Single-shot (`invoke`)** — inside `agent-core/src/single-shot.ts` (the `runLLM` wrapper). One span per call.
2. **Streaming (`invokeStream`)** — inside the per-adapter implementations OR via a wrapper that consumes the iterable. The wrapper approach keeps instrumentation centralized.

### 2.2 The wrapper approach

Add `agent-core/src/telemetry/instrument.ts`:

```ts
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { getTracer } from './tracer.js';
import { GenAi } from './attributes.js';
import type { LanguageModel, LanguageModelInvokeOptions, InvokeResult, StreamEvent } from '../types.js';
import { calculateCost } from '../cost.js';

/**
 * Wrap a LanguageModel implementation so its invoke / invokeStream methods
 * emit OTel spans. The wrapper is transparent — same input/output shape.
 */
export function instrumentLanguageModel(model: LanguageModel): LanguageModel {
  return {
    ...model,
    async invoke(opts) {
      const tracer = getTracer();
      return tracer.startActiveSpan('gen_ai.invoke', { kind: SpanKind.CLIENT }, async (span) => {
        applyRequestAttributes(span, model, opts);
        try {
          const result = await model.invoke(opts);
          applyResponseAttributes(span, model, opts, result);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          throw err;
        } finally {
          span.end();
        }
      });
    },
    invokeStream(opts) {
      const tracer = getTracer();
      const span = tracer.startSpan('gen_ai.invoke_stream', { kind: SpanKind.CLIENT });
      applyRequestAttributes(span, model, opts);
      const inner = model.invokeStream(opts);
      return wrapAsyncIterable(inner, span, model, opts);
    },
  };
}

async function* wrapAsyncIterable(
  inner: AsyncIterable<StreamEvent>,
  span: Span,
  model: LanguageModel,
  opts: LanguageModelInvokeOptions,
): AsyncIterable<StreamEvent> {
  try {
    let usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null = null;
    for await (const event of inner) {
      if (event.type === 'usage') usage = event;
      if (event.type === 'tool-call') emitToolCallSpan(event);
      if (event.type === 'reasoning-delta') emitReasoningSpan(event);
      yield event;
    }
    if (usage) {
      span.setAttributes({
        [GenAi.USAGE_INPUT_TOKENS]: usage.inputTokens,
        [GenAi.USAGE_OUTPUT_TOKENS]: usage.outputTokens,
        [GenAi.USAGE_CACHE_READ_TOKENS]: usage.cacheReadTokens ?? 0,
        [GenAi.USAGE_CACHE_WRITE_TOKENS]: usage.cacheWriteTokens ?? 0,
        [GenAi.USAGE_COST_USD]: calculateCost(opts.model, usage),
      });
    }
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
    throw err;
  } finally {
    span.end();
  }
}
```

### 2.3 Where to apply

`agent-core/src/registry.ts` — modify `ProviderRegistry.get(provider)` (or add a wrapping layer above it) to return `instrumentLanguageModel(adapter)` instead of the raw adapter.

This is the single point of integration. Every consumer that gets a model from the registry gets instrumentation for free.

Alternative: instrument inside `single-shot.ts` for the `runLLM` family + inside each adapter for `invokeStream`. More code, more places to forget. **Recommended: registry-level wrapping** so instrumentation is a property of "got a model from the registry" not "called a specific function".

### 2.4 `applyRequestAttributes` / `applyResponseAttributes`

```ts
function applyRequestAttributes(span: Span, model: LanguageModel, opts: LanguageModelInvokeOptions): void {
  const config = loadTelemetryConfig();
  span.setAttributes({
    [GenAi.SYSTEM]: model.provider,
    [GenAi.REQUEST_MODEL]: opts.model,
    [GenAi.REQUEST_MAX_TOKENS]: opts.maxTokens ?? -1,
    [GenAi.REQUEST_TEMPERATURE]: opts.temperature ?? -1,
    'gen_ai.messages.count': opts.messages.length,
    'gen_ai.tools.count': opts.tools?.length ?? 0,
  });
  if (config.recordContent) {
    span.setAttribute('gen_ai.prompt', JSON.stringify(opts.messages).slice(0, 8192));
  }
}

function applyResponseAttributes(span: Span, model: LanguageModel, opts: LanguageModelInvokeOptions, result: InvokeResult): void {
  span.setAttributes({
    [GenAi.USAGE_INPUT_TOKENS]: result.usage.inputTokens,
    [GenAi.USAGE_OUTPUT_TOKENS]: result.usage.outputTokens,
    [GenAi.USAGE_CACHE_READ_TOKENS]: result.usage.cacheReadTokens ?? 0,
    [GenAi.USAGE_CACHE_WRITE_TOKENS]: result.usage.cacheWriteTokens ?? 0,
    [GenAi.USAGE_COST_USD]: result.costUsd,
    'gen_ai.response.tool_calls': result.toolCalls.length,
    [GenAi.RESPONSE_FINISH_REASONS]: ['end'], // adapt per actual finish reason
  });
  if (loadTelemetryConfig().recordContent) {
    span.setAttribute('gen_ai.completion', result.text.slice(0, 8192));
  }
}
```

### 2.5 Tests

`agent-core/src/__tests__/telemetry.test.ts`:

- Setup: install `InMemorySpanExporter` from `@opentelemetry/sdk-trace-base` for assertions.
- Test 1: spans emit on `invoke`, with correct attributes.
- Test 2: spans emit on `invokeStream`, capture usage from the stream.
- Test 3: span set ERROR status when adapter throws.
- Test 4: with `ANVIL_OTEL_RECORD_CONTENT=1`, `gen_ai.prompt` and `gen_ai.completion` populate.
- Test 5: with neither env var set, no spans exported (noop mode).

### 2.6 Validation

```sh
npm -w @anvil/agent-core test         # new + existing tests pass
# manual verify with console exporter
ANVIL_OTEL_CONSOLE=1 anvil index <fixture> # see span dump in stderr
```

### 2.7 Acceptance

- [ ] Every `LanguageModel.invoke` call emits a span
- [ ] Every `LanguageModel.invokeStream` call emits a span (closed when iterator drains)
- [ ] Spans carry the GenAI attributes from §2.4
- [ ] Cost USD computed from cost table appears as `gen_ai.usage.cost_usd`
- [ ] `recordContent=false` (default) does NOT include prompt/completion text
- [ ] Tests for all 5 scenarios in §2.5 pass

### 2.8 Rollback

Single-commit revert. The instrumentation is purely additive at the registry level; reverting drops it.

### 2.9 Risks

- **Async iterable wrapping** can leak the underlying iterator if not closed properly. Test with early break, AbortSignal cancellation, exception mid-stream.
- **Span lifetime in async generators:** if the consumer never finishes iterating, the span stays open. Mitigation: span has a max lifetime (`OTEL_SPAN_MAX_DURATION` semantic) — or document that consumers MUST drain or break the stream.
- **Performance overhead:** OTel adds non-zero cost per call. Measure before/after on a hot path (e.g., 100 small LLM calls in a tight loop). Expected: <1 ms per call. If higher, investigate batch-span-processor batching settings.

---

## Phase 3 — Per-provider span enrichment

**Effort:** 1d.

### 3.1 Why

Different providers report different metadata in different shapes. The wrapper from Phase 2 captures the union via `usage` and `tool-call` events. But some metadata is provider-specific and needs adapter-side enrichment:

- **Anthropic:** `cache_control` markers in the request (cache write vs read), `cache_read_input_tokens` and `cache_creation_input_tokens` in the response, ThinkingBlocks (extended thinking).
- **OpenAI:** `cached_tokens` in `prompt_tokens_details`, reasoning items (o1/o3 family), function-call streams.
- **Google:** `cachedContentTokenCount`, thinking config.
- **Ollama:** local model — usually no cache, simpler metadata.

### 3.2 Procedure

For each adapter (`claude-adapter.ts`, `openai-adapter.ts`, `gemini-adapter.ts`):

1. After receiving the provider response, populate the `StreamEvent` with the cache + reasoning fields normalized to agent-core's shape.
2. Anthropic example:
   ```ts
   // Inside ClaudeAdapter.invokeStream
   yield {
     type: 'usage',
     inputTokens: response.usage.input_tokens,
     outputTokens: response.usage.output_tokens,
     cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
     cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
   };
   ```
3. OpenAI example:
   ```ts
   yield {
     type: 'usage',
     inputTokens: response.usage.prompt_tokens,
     outputTokens: response.usage.completion_tokens,
     cacheReadTokens: response.usage.prompt_tokens_details?.cached_tokens ?? 0,
     cacheWriteTokens: 0, // OpenAI does not separately bill cache writes
   };
   ```
4. Reasoning-block surfacing: emit `{ type: 'reasoning-delta', text: '<chunk>' }` events so the wrapper from Phase 2 produces a child span. This is a behavior change — verify no consumer breaks.

### 3.3 Tests

For each adapter, add a unit test that takes a captured fixture response (real provider JSON, recorded once via `nock` or `node:test/mock`) and asserts the emitted events contain the right cache/reasoning numbers.

### 3.4 Validation

```sh
npm -w @anvil/agent-core test
# real-world smoke (requires API keys in env):
ANVIL_OTEL_CONSOLE=1 ANVIL_LLM_API_KEY=$ANTHROPIC_API_KEY ANVIL_LLM_MODE=api anvil index <fixture>
# inspect stderr; cache hit/write should appear in span attributes
```

### 3.5 Acceptance

- [ ] At least one adapter (Anthropic) reports cache hit/write tokens correctly when the request uses cache_control
- [ ] Reasoning events emit as child spans (verifiable via console exporter)
- [ ] No existing test regressions

### 3.6 Risks

- **API response shape drift:** providers change response JSON keys silently. Mitigation: the adapter parses defensively (`?? 0`); telemetry is best-effort, not blocking.
- **Reasoning content privacy:** reasoning blocks contain model thinking; with `recordContent=on`, this leaks into traces. Document clearly.

---

## Phase 4 — Cost annotation + cache cost separation

**Effort:** 0.5d.

### 4.1 Cost calculation seam

`agent-core/src/cost.ts` already computes cost from usage. Phase 4 wires this into spans (already started in Phase 2). What's added here is **cache-aware cost separation**:

```ts
// in cost.ts (extends Phase 7 of agent-core extract)
export interface CostBreakdown {
  totalUsd: number;
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
}

export function calculateCostBreakdown(model: string, usage: { ... }): CostBreakdown { /* ... */ }
```

Span attributes get the breakdown:

- `gen_ai.usage.cost_usd` — total
- `gen_ai.usage.cost_input_usd`
- `gen_ai.usage.cost_output_usd`
- `gen_ai.usage.cost_cache_read_usd`
- `gen_ai.usage.cost_cache_write_usd`

Backends like Langfuse and Phoenix render breakdowns natively when these are present.

### 4.2 Cache hit-rate computation

For every call, compute `cacheHitRatio = cacheReadTokens / (inputTokens + cacheReadTokens)`. Attach as `gen_ai.usage.cache_hit_ratio`. Useful for dashboards.

### 4.3 Validation

```sh
npm -w @anvil/agent-core test
# manual: with a known prompt-cached Anthropic call, verify breakdown sums to total
```

### 4.4 Acceptance

- [ ] `calculateCostBreakdown` exposes 5 fields
- [ ] All 5 fields appear in span attributes
- [ ] Cache hit ratio attribute present on cache-using calls

### 4.5 Risks

- **Numeric precision:** sum of components may not exactly equal the total due to floating-point. Use `toFixed(6)` or accept ε tolerance.

---

## Phase 5 — Exporter recipes (docs + smoke tests)

**Effort:** 0.5d.

### 5.1 Document the env-var contract

Update `packages/agent-core/README.md` with a "Telemetry" section:

```md
## Telemetry (OpenTelemetry)

Anvil agent-core emits OpenTelemetry spans for every LLM call. By default
no spans are exported (zero overhead for users without an OTel backend).

### Backends

#### Console (debug)

ANVIL_OTEL_CONSOLE=1 anvil index ...

#### Langfuse cloud

OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic $(echo -n pk:sk | base64)" \
anvil index ...

#### Self-hosted Langfuse (Helm)

OTEL_EXPORTER_OTLP_ENDPOINT=https://langfuse.your-cluster/api/public/otel \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic ..." \
anvil index ...

#### Self-hosted Phoenix

OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006/v1/traces \
anvil index ...

#### Honeycomb / Datadog / Tempo / Jaeger

(any OTLP-HTTP-compatible backend works the same way)

### Including prompt/completion text

By default, prompts and completions are NOT recorded in spans (security).
Opt in:

ANVIL_OTEL_RECORD_CONTENT=1
```

### 5.2 Smoke test recipe

Provide a docker-compose snippet for local testing:

```yaml
# packages/agent-core/scripts/otel-stack.yaml
services:
  langfuse:
    image: langfuse/langfuse:3
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgresql://postgres:pw@postgres:5432/langfuse
      NEXTAUTH_URL: http://localhost:3000
      NEXTAUTH_SECRET: localdev-secret
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: pw
      POSTGRES_DB: langfuse
```

Run `docker compose -f packages/agent-core/scripts/otel-stack.yaml up`, then run the smoke test:

```sh
# create a project + API keys in Langfuse UI
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000/api/public/otel \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic $(echo -n pk-lf-xxx:sk-lf-xxx | base64)" \
ANVIL_OTEL_RECORD_CONTENT=1 \
anvil index <fixture>
```

Open `http://localhost:3000` and confirm spans show with cost, cache, tool-call hierarchy.

### 5.3 Acceptance

- [ ] README has telemetry section with at least 4 backend recipes
- [ ] Docker-compose smoke recipe exists and works against fresh-install Langfuse
- [ ] Smoke test produces spans with all expected attributes

### 5.4 Risks

- **Documentation drift:** as Langfuse / Phoenix / etc. evolve their endpoint URLs, the recipes go stale. Mitigation: link primary docs from each recipe.

---

## Phase 6 — Tests + dashboard server integration

**Effort:** 1d.

### 6.1 Test surface

- Phase 2 tests cover the wrapper.
- Phase 3 tests cover per-provider enrichment.
- Phase 4 tests cover cost breakdown.
- Phase 6 adds **integration tests** that exercise a full pipeline run with telemetry enabled and assert on captured spans.

### 6.2 Dashboard hook (optional)

`packages/dashboard/server/` already tracks per-run cost. Phase 6 wires the dashboard to consume the agent-core spans:

- Either: dashboard imports `agent-core/telemetry` and uses an `InMemorySpanExporter` to read spans from the same process. Cost-tracking becomes "drain spans" instead of "intercept claude-runner result".
- Or: dashboard keeps its current cost-tracking path; OTel is purely external.

**Recommendation:** keep dashboard's current path for now. OTel is for *external* observability (Langfuse / Phoenix / etc.). Internal dashboard-level tracking (per-run cost in the run record) stays in cli/dashboard land. Cleaner separation.

### 6.3 Documentation

- Add `docs/observability.md` (or extend `packages/agent-core/README.md`):
  - "What gets traced" — full attribute list
  - "What does NOT get traced" — opt-in gates for content
  - "How to add a new exporter" — instructions for community contributions
  - "How to disable" — explicit `ANVIL_OTEL_DISABLED=1` env

### 6.4 Validation

```sh
npm -w @anvil/agent-core test
npm -w @esankhan3/anvil-cli test
cd packages/dashboard && node --test server/out/__tests__/*.test.js | tail -10
```

### 6.5 Acceptance

- [ ] Integration test: pipeline run with `ANVIL_OTEL_CONSOLE=1` produces spans for each LLM call, cost reported correctly
- [ ] Dashboard tests still 430/436 (no regression)
- [ ] Docs cover the full env-var contract

### 6.6 Risks

- **Test pollution:** OTel singletons leak between tests. Use `resetTracer()` in `beforeEach`. Set `OTEL_EXPORTER_OTLP_ENDPOINT=` (empty) explicitly to force noop mode.

---

## Cross-cutting: validation strategy

After each phase:

1. `npm install` (catches dep conflicts).
2. `npm -w @anvil/agent-core run build && npm -w @anvil/agent-core test`.
3. `npm -w @esankhan3/anvil-cli run build && npm -w @esankhan3/anvil-cli test`.
4. Dashboard tests don't regress.
5. **Manual smoke** (Phases 2+): run a real `anvil index` against a fixture with `ANVIL_OTEL_CONSOLE=1` and confirm spans appear in stderr.

---

## Cross-cutting: order rationale

| # | Phase | Why this order |
|---|---|---|
| 0 | Audit | Lock the OTel-only direction explicitly. |
| 1 | Scaffold | Validate dep tree + zero-config behavior. |
| 2 | Instrument core invoke / invokeStream | The seam is the registry. Once wrapped, every call is traced. |
| 3 | Per-provider enrichment | After Phase 2's wrapper exists; adapters fill in cache + reasoning details. |
| 4 | Cost annotation + breakdown | After Phase 3 ensures all cache fields populate; cost-table + breakdown wires up. |
| 5 | Exporter recipes | Docs after the implementation is complete. |
| 6 | Tests + dashboard wiring | End-to-end verification last. |

---

## Summary table

| Phase | Effort | LOC moved | LOC written | Risk |
|---|---|---|---|---|
| 0 — Audit | 0.5d | 0 | ~80 (ADR) | low |
| 1 — Scaffold | 0.5d | 0 | ~250 | low |
| 2 — Instrument core | 1d | 0 | ~300 | medium |
| 3 — Per-provider enrichment | 1d | 0 | ~150 | medium |
| 4 — Cost annotation | 0.5d | 0 | ~80 | low |
| 5 — Exporter recipes | 0.5d | 0 | ~200 (docs) | low |
| 6 — Tests + docs | 1d | 0 | ~200 | low |
| **Total** | **~5d** | **0** | **~1,260** | — |

Plus 30% risk premium → realistic calendar **~7 days for solo eng**, or **~5–7 conversation turns** if executed phase-by-phase.

---

## Failure modes to watch

1. **OTel SDK breaking changes:** `@opentelemetry/sdk-trace-node` ships at `0.x` and has minor breaking changes between versions. Pin tightly. Don't auto-update.
2. **Tracer registration race:** if cli or dashboard ever initializes OTel separately, double-registration is silent. Mitigation: `getTracer()` checks for an existing global TracerProvider before registering.
3. **Async iterable lifetime:** spans on `invokeStream` close when the consumer drains the iterable. If a consumer breaks early or the iterable hangs, the span leaks. Mitigation: document the contract; emit a fallback `span.end()` after a timeout (configurable).
4. **Provider-specific cache extraction wrong:** reading the wrong response key silently undercounts cache savings. Mitigation: per-adapter unit tests with real-response fixtures.
5. **Cost breakdown precision:** sum of components ≠ total due to FP. Tolerate ε.
6. **Content recording leakage:** if `recordContent=on`, prompts (potentially containing API keys, customer data) hit the trace backend. Document loudly. Default is OFF.
7. **Performance overhead:** spans add per-call latency. Measure on hot paths. If a problem, downsample via `OTEL_TRACES_SAMPLER=traceidratio` with `OTEL_TRACES_SAMPLER_ARG=0.1` (10% sampling).

---

## Glossary

- **OTLP:** OpenTelemetry Protocol. The wire format every OTel backend speaks. HTTP/JSON or HTTP/Protobuf transport.
- **Span:** one operation in a trace. An LLM call = one span. A tool call = one child span. A reasoning block = one child span.
- **Trace:** a tree of spans for one logical operation (e.g., "user runs `anvil run`").
- **GenAI semantic conventions:** the OTel SIG's standard attribute names for LLM operations (`gen_ai.system`, `gen_ai.usage.input_tokens`, etc.). Non-standard attributes use the `gen_ai.usage.cost_usd` style — namespace-prefixed but not in the spec; backends still render them.
- **Exporter:** the component that ships finished spans somewhere. We use OTLP HTTP — point it at any compatible endpoint.
- **`recordContent`:** the opt-in flag that includes prompt/completion text in span attributes. Off by default for security.
- **Cache hit ratio:** `cacheReadTokens / (inputTokens + cacheReadTokens)`. The "what fraction of input was served from cache" metric.

---

## Appendix — Why not Langfuse SDK directly?

The Langfuse JS SDK is high-quality and would work. The reason to avoid it:

| Concern | Langfuse SDK | OTel-only |
|---|---|---|
| Backend swap | Code change | Env var change |
| Dep tree | `@langfuse/*` deep | Just `@opentelemetry/*` (industry standard) |
| Onboarding new contributors | Have to learn Langfuse SDK | OTel is taught everywhere |
| Future eval primitives | Tied to Langfuse | Wrap whatever (Inspect AI etc.) |
| Prompt management | Tied to Langfuse | In-repo `.md` (already what we have) |
| If Langfuse acquired/sunset | Major rip-out | Switch endpoint |

The user requirement was "no vendor lock-in." OTel-only meets that requirement; Langfuse-SDK does not. Langfuse-as-backend is fine — they accept OTLP and that's the agreed seam.
