# Agent Observability — Architecture Decision Record

> **Status:** In progress (Phase 0 complete). Companion to [`AGENT-OBSERVABILITY-PLAN.md`](./AGENT-OBSERVABILITY-PLAN.md). Depends on [`AGENT-CORE-EXTRACT-PLAN.md`](./AGENT-CORE-EXTRACT-PLAN.md) being shipped (it is — see [`AGENT-CORE-ADR.md`](./AGENT-CORE-ADR.md)).

This ADR captures the locked decisions, instrumentation-site inventory, and per-phase commit log for adding OpenTelemetry observability to `@anvil/agent-core`.

---

## 1. Problem statement

`@anvil/agent-core` owns every LLM call surface in the monorepo (streaming/agent pipeline + single-shot analytical calls + 7 provider adapters), but emits **zero observability signal**. Operators running Anvil in production cannot answer:

- How many tokens / dollars did this run consume, broken down by model and cache hit/write?
- Which adapter call errored, with what status, after how many retries?
- What is the per-call latency distribution, and where in the pipeline are the slow spans?
- Did prompt caching actually engage, and if so what fraction of input was served from cache?

Existing per-run cost-tracking inside the dashboard server is not a substitute — it covers cli-driven runs only and cannot be exported to a long-term backend (Langfuse, Datadog, Honeycomb, Phoenix, etc.).

The fix is to emit OpenTelemetry spans following the GenAI semantic conventions from inside `@anvil/agent-core`, with **zero hard dependency on any vendor's observability SDK** — every modern observability backend speaks OTLP, so vendor swap is an env-var change, not a code change.

---

## 2. Locked decisions

The 14 decisions below are normative. Any deviation must be documented in §9.

| # | Decision | Choice | Rationale |
|---|---|---|---|
| O1 | Telemetry standard | **OpenTelemetry** only | Vendor-neutral, industry standard, supported by every backend. |
| O2 | Span attribute conventions | **OpenTelemetry GenAI semantic conventions** (`gen_ai.*`) | Every LLM-aware backend reads these natively. |
| O3 | Default exporter | **No-op** (silent) | Zero-config users see zero behavior change. |
| O4 | Configurable exporters | **Console** + **OTLP HTTP** via `@opentelemetry/exporter-trace-otlp-http` | Bare OTLP HTTP covers Langfuse, Phoenix, Honeycomb, Datadog, Jaeger, Tempo, Splunk. No vendor SDK in the tree. |
| O5 | Prompt content recording | **Off by default**, opt-in via `ANVIL_OTEL_RECORD_CONTENT=1` | Avoid leaking secrets / API keys / PII into traces. |
| O6 | Cost annotation | **Computed in agent-core, attached as `gen_ai.usage.cost_usd`** | One source of truth (the cost table from `@anvil/agent-core`'s `cost.ts`). |
| O7 | Cache metrics | Provider-specific extraction → normalized `gen_ai.usage.cache_read_tokens` / `gen_ai.usage.cache_write_tokens` | Anthropic / OpenAI / Gemini all report cache differently; we normalize. |
| O8 | Reasoning blocks | Surfaced as a child span `gen_ai.reasoning` with attributes `gen_ai.reasoning.tokens` and (opt-in) `gen_ai.reasoning.text` | Anthropic ThinkingBlock + OpenAI Reasoning items both fit. |
| O9 | Tool calls | Each tool call → child span `gen_ai.tool_call` with `gen_ai.tool.name`, `gen_ai.tool.arguments_size_bytes` | Backend renders the tool-call hierarchy. |
| O10 | Prompt management | **Out of scope** — prompts stay as `.md` files in the repo | Langfuse's prompt mgmt is the lock-in piece. In-repo + git is sufficient. |
| O11 | Eval primitives | **Out of scope** — addressed in `AGENT-HARNESS-PLAN.md` (Inspect AI as external runner) | Don't reinvent. |
| O12 | Sampling | Always-on by default; configurable via standard `OTEL_TRACES_SAMPLER` env vars | Default appropriate at typical Anvil throughput. |
| O13 | Trace ID propagation | Standard W3C Trace Context (`traceparent` header on outbound HTTP) | What every OTel SDK does. No code needed beyond initialization. |
| O14 | Resource attributes | `service.name=anvil-agent-core`, `service.version=$pkgVersion` | Backends use these to group spans. |

---

## 3. Instrumentation-site inventory

Every place inside `@anvil/agent-core` that makes a network call or spawns a subprocess is an instrumentation site. Inventory captured at Phase 0 (commit prior to scaffold):

### 3.1 HTTP-fetch sites (4)

| File | Line | Surface | Provider |
|---|---|---|---|
| `src/gemini-adapter.ts` | 109 | `invoke` (legacy `run`) | Google Gemini REST API |
| `src/openai-adapter.ts` | 101 | `invoke` (legacy `run`) | OpenAI / OpenRouter (subclass) |
| `src/ollama-adapter.ts` | 84 | `invoke` (legacy `run`) | Local Ollama server |
| `src/single-shot.ts` | 402 | `runClaude` (api mode) | Anthropic Messages API |

`OpenRouterAdapter` extends `OpenAIAdapter` — its fetch lives in openai-adapter.ts:101. `OllamaAdapter` also pings `/api/tags` at line 46 for `isAvailable` probes; that is a health check, not a billable LLM call, so we exclude it from instrumentation.

### 3.2 Subprocess-spawn sites (5)

| File | Line | Surface | Subprocess |
|---|---|---|---|
| `src/claude-adapter.ts` | 128 | `invoke` (legacy `run`) | Claude Code CLI (`claude` binary) |
| `src/gemini-cli-adapter.ts` | 109 | `invoke` (legacy `run`) | Gemini CLI (`gemini` binary) |
| `src/single-shot.ts` | 218 | `runGemini` | Gemini CLI |
| `src/single-shot.ts` | 288 | `runClaude` (cli mode) | Claude Code CLI |
| `src/agent/spawn.ts` | 6 | `spawnAgent` (long-lived agent process) | Claude Code CLI in pipeline mode |

`AdkAdapter` delegates to `GeminiCliAdapter`, so it inherits gemini-cli-adapter.ts:109. No additional site.

### 3.3 Total instrumentation seam

**9 distinct call sites across 7 files.** These collapse into **2 logical surfaces** at the abstraction boundary:

1. `LanguageModel.invoke(opts) → Promise<InvokeResult>` (single-shot)
2. `LanguageModel.invokeStream(opts) → AsyncIterable<StreamEvent>` (streaming)

Per the plan §2.3, the integration seam is **`ProviderRegistry.get(provider)`**: returning `instrumentLanguageModel(adapter)` instead of the raw adapter applies telemetry uniformly to all 9 call sites. Single point of integration, zero per-adapter edits.

### 3.4 Caveat: `LanguageModel` interface not yet implemented natively

Per `AGENT-CORE-ADR.md` §9 Phase 5 deviation: the 7 adapters today only implement the **legacy `ModelAdapter.run(config, output)`** interface, not the new `LanguageModel.invoke()` / `invokeStream()` shape. The `LanguageModel` interface is type-defined but has no native impl.

**Implication for Phase 2:** the wrapper in `instrumentLanguageModel` cannot wrap a real `LanguageModel.invoke()` because no adapter exposes one. Three options:

- **A. Wrap the legacy `ModelAdapter.run()` instead** — instrument what exists. Spans annotate stage runs, not invoke calls. Easier; lower fidelity (one span per `run`, not per turn).
- **B. Add a thin `LanguageModel` shim per adapter that calls `run()` under the hood** — preserves the planned wrapper shape; the `LanguageModel` shim itself is not "real" yet (it just bridges to legacy run).
- **C. Defer Phase 2 until adapters get native `invoke()` impls** — blocks observability work behind a multi-week per-adapter migration.

**Decision: Option A (wrap legacy `ModelAdapter.run`).** Adopting B would be inventing a fake interface to satisfy the plan; C blocks unrelated work. The wrapper signature changes but the integration seam (registry-level) and the GenAI attributes emitted are identical. This is documented as a Phase 2 deviation in §9.

---

## 4. Survey of GenAI semantic conventions adoption (April 2026)

Backends confirmed to render `gen_ai.*` attributes natively:

| Backend | OTLP HTTP endpoint | `gen_ai.*` rendering | Notes |
|---|---|---|---|
| **Langfuse** (cloud + self-hosted) | `/api/public/otel/v1/traces` | Yes (LLM-as-Span dashboards) | Maps `gen_ai.system` → trace metadata; reads cost_usd. |
| **Arize Phoenix** (open source) | `/v1/traces` | Yes (LLM trace UI) | Native GenAI panel since 4.x. |
| **Honeycomb** | `/v1/traces` | Yes (Query Builder filters on `gen_ai.*`) | LLM dashboards in private beta as of plan time. |
| **Datadog** (LLM Observability product) | `/api/v2/llmobs/traces` (LLM-specific) or `/v1/traces` (generic) | Yes (LLM Observability product) | Some custom mapping for cost. |
| **Tempo / Jaeger** (OSS traces) | `/v1/traces` | Renders as plain attributes | No LLM-specific UI; plain attribute view works. |

Conclusion: **`gen_ai.*` is the right namespace as of plan execution.** Attributes named after the OTel SIG spec (`gen_ai.usage.input_tokens`, `gen_ai.request.model`, etc.) render in every backend with native LLM support. Anvil-extension attributes (`gen_ai.usage.cost_usd`, `gen_ai.usage.cache_read_tokens`, `gen_ai.usage.cache_write_tokens`, `gen_ai.tool.arguments_size_bytes`) follow the same naming pattern; backends that don't recognize them fall back to plain attribute rendering.

---

## 5. OTel package version pinning (Phase 1 input)

Looked up on npm at Phase 0 execution time (2026-04-29):

| Package | Plan-suggested range | Current stable | Pinned target |
|---|---|---|---|
| `@opentelemetry/api` | `^1.9.0` | `1.9.1` | `^1.9.0` |
| `@opentelemetry/resources` | `^1.30.0` | `2.7.0` | `^2.0.0` |
| `@opentelemetry/sdk-trace-base` | `^1.30.0` | `2.7.0` | `^2.0.0` |
| `@opentelemetry/sdk-trace-node` | `^1.30.0` | `2.7.0` | `^2.0.0` |
| `@opentelemetry/exporter-trace-otlp-http` | `^0.57.0` | `0.215.0` | `^0.200.0` |
| `@opentelemetry/semantic-conventions` | `^1.30.0` | `1.40.0` | `^1.30.0` |

**Plan deviation:** the plan suggested `1.x` for SDK packages but the upstream OTel SDK has moved to **`2.x`** stable. Pin to `^2.0.0` for the four SDK packages. The exporter remains at `0.x` (intentional — exporter packages have a slower stability promise) and is pinned tightly to avoid breaking changes within `0.2xx`. The hand-written `tracer.ts` API surface is unchanged between SDK 1.x and 2.x for the calls we make (`NodeTracerProvider`, `BatchSpanProcessor`, `ConsoleSpanExporter`, `Resource`).

This deviation is logged in §9 Phase 1.

---

## 6. Retention / privacy / governance

The plan delegates retention defaults to "whoever runs the backend" — this ADR confirms that posture:

- **Retention.** Anvil agent-core does not store spans; the configured OTel backend does. Retention policy is the operator's responsibility.
- **PII.** Default `recordContent=false` ensures no prompt or completion text leaves the process. Operators who flip `ANVIL_OTEL_RECORD_CONTENT=1` accept the risk that prompts may contain secrets / API keys / customer data; documentation must call this out loudly (see Phase 5 §5.1).
- **Cost data.** Cost USD is a derived numeric. No PII risk.
- **Trace IDs.** W3C Trace Context propagation only adds a `traceparent` header to outbound HTTP. No PII embedded in trace IDs.

Decision authority for changing these defaults: same approval channel as `ANVIL_*` env-var contract changes — i.e. needs an ADR amendment.

---

## 7. Out-of-scope (explicit)

The following are **deliberately not** part of this initiative. Each has a separate plan or is rejected:

| Item | Status | Where it lives |
|---|---|---|
| Vercel AI SDK adoption | Rejected (vendor lock-in) | `MODEL-LIB-CONSOLIDATION-ADR.md` D1 |
| LiteLLM as runtime proxy | Rejected (single point of failure) | `MODEL-LIB-CONSOLIDATION-ADR.md` |
| Langfuse SDK adoption | Rejected (vendor lock-in) | This ADR §1, plan appendix |
| Helicone proxy | Rejected (slows hot path) | `AGENT-OBSERVABILITY-PLAN.md` cost-benefit |
| Prompt management UI | Out of scope (decision O10) | Stays in repo as `.md` files |
| Eval framework | Out of scope (decision O11) | `AGENT-HARNESS-PLAN.md` (Inspect AI) |
| Memory persistence layer | Out of scope | `MEMORY-CORE-EXTRACT-PLAN.md` |

---

## 8. Pre-flight reality check (Phase 0 result)

Run on 2026-04-29 against `feat/plan-generation @ 5ceafde`:

```text
OK: agent-core extracted              (test -d packages/agent-core)
OK: cost.ts exists                    (test -f packages/agent-core/src/cost.ts)
OK: zero pre-existing OTel imports    (grep -rln "@opentelemetry" packages/ | grep -v node_modules)
OK: agent-core tests 9/9 pass         (npm -w @anvil/agent-core test)
```

All four gates green. Phase 1 is unblocked.

---

## 9. Per-phase commit log

Filled in after each phase commit. Use this section to record deviations, surprises, and back-port-worthy plan corrections.

### Phase 0 — Audit + decisions

- **Status:** Complete (this commit)
- **Commit:** TBD
- **Files added:** `AGENT-OBSERVABILITY-ADR.md` (this file)
- **Files modified:** none
- **Deviations from plan:** none. Pre-flight reality check passes; OTel SDK package versions cataloged; instrumentation-site inventory captured (9 sites across 7 files).

### Phase 1 — Scaffold OTel infrastructure

- **Status:** Complete
- **Commit:** TBD
- **Files added:** `packages/agent-core/src/telemetry/{index,tracer,attributes,config,exporters}.ts` (5 files)
- **Files modified:** `packages/agent-core/package.json` (+6 deps), `packages/agent-core/src/index.ts` (+1 export line), `package-lock.json`
- **Deviations from plan §1.4:**
  1. SDK packages pin to `^2.0.0` (plan said `^1.30.0`). Upstream is at 2.7.0; OTel SDK shipped 2.x stable since plan was written.
  2. Tracer uses **`resourceFromAttributes()`** instead of `new Resource(...)` — SDK 2.x removed the constructor.
  3. Tracer uses **`spanProcessors` constructor option** instead of `provider.addSpanProcessor(...)` — SDK 2.x removed the method.
  4. Service-name attribute key uses **`ATTR_SERVICE_NAME`** const instead of `SemanticResourceAttributes.SERVICE_NAME` — semconv 1.40 deprecated the namespace object in favor of standalone constants.
  5. Added an **`ANVIL_OTEL_DISABLED=1`** kill-switch (highest precedence in config resolution) — Phase 6 §6.3 documents it but Phase 1 was the natural place to wire it in.
  6. `resetTracer()` is **async** (awaits `forceFlush` + `shutdown`) so tests can ensure spans flush before assertion. Plan §1.4 had it sync.
- **Verified:**
  - `npm install` clean (34 transitive packages added)
  - `npm -w @anvil/agent-core run build` clean
  - 9/9 existing tests pass
  - Config resolution validated across all 5 modes (noop, console, otlp+headers, recordContent flag, kill switch)
  - Smoke: console tracer registers + emits span + shuts down clean

### Phase 2 — Instrument LanguageModel.invoke / invokeStream

- **Status:** Pending
- **Anticipated deviation:** wraps the legacy `ModelAdapter.run` interface, not `LanguageModel.invoke`, because no adapter exposes the new interface natively yet. Documented in §3.4 (Option A).

### Phase 3 — Per-provider span enrichment

- **Status:** Pending

### Phase 4 — Cost annotation + cache cost separation

- **Status:** Pending

### Phase 5 — Exporter recipes (docs + smoke tests)

- **Status:** Pending

### Phase 6 — Tests + dashboard server integration

- **Status:** Pending

---

## 10. Open questions

None at Phase 0. The single question that surfaced during audit (how to handle `LanguageModel.invoke` not being implemented) is answered in §3.4.
