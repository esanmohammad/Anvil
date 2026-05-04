# @anvil/agent-core

**One LLM stack. Every provider. Agentic by default.**

The runtime that powers every Anvil agent — a single, vendor-neutral
core that turns prompts into production-grade agent loops with cost
tracking, retries, and observability built in.

---

## Why agent-core

Building an agent today means stitching together SDKs, retry logic,
cost math, tool dispatch, and observability — per provider. Then
doing it again when you swap models.

**agent-core gives you one stack.** Switch from Claude to GPT-4 to a
local Ollama model by changing one string. Every adapter speaks the
same streaming format, throws the same errors, reports cost the same
way, and emits the same OpenTelemetry spans.

```ts
import { runLLM } from '@anvil/agent-core';

const result = await runLLM({
  model: 'claude-sonnet-4-6',           // or 'gpt-5', 'gemini-2.5-pro',
                                        //    'opencode/kimi-k2.6', 'qwen3:14b'
  prompt: 'Refactor this function for clarity.',
  workspaceDir: process.cwd(),
});

console.log(result.output);
console.log(`cost: $${result.costUsd}`);
```

That's it. No SDK to import. No retry loop to write. No cost table
to maintain. The model name is the only thing that changes.

---

## What you get

### Eight providers, one interface
Claude · OpenAI · Gemini · OpenRouter · Ollama · Gemini CLI · Google
ADK · OpenCode. Six drive a real agentic tool loop out of the box.
New provider? Add an adapter file. The registry, router, telemetry,
and cost layer pick it up automatically.

### Production-grade router
Tag-based routing, per-error retry, chain-fallback across models,
per-provider rate limiting, circuit breaker, and a SQLite spend
ledger — all configurable via a single YAML file. Sensible defaults
ship compiled in, so the zero-config path just works.

### Built-in agentic tools
A path-guarded `BuiltinToolExecutor` ships seven safe primitives —
`read_file`, `write_file`, `edit`, `bash`, `grep`, `glob`, `list` —
that any non-Claude adapter can pair with to drive a true tool loop.
No more "model can't edit files" workarounds.

### Skills + MCP, first-class
Drop in Anthropic-format `SKILL.md` files for reusable agent
behaviors, or wire up any Model Context Protocol server — both
compose into the same prompt + tool surface that adapters consume.

### Observability that doesn't hurt
OpenTelemetry spans with GenAI semantic conventions, a parent
`anvil.agent.session` span that links every resume, automatic cost
breakdown per call. Plug in any OTLP collector — Langfuse, Tempo,
Honeycomb — via standard env vars. Off by default. Privacy-safe
prompt redaction.

### Deterministic checkpoints
SHA-keyed per-call output cache, scoped by project, run, and stage.
Re-run the same pipeline, get the same answers. Free retries on
flaky upstreams. Free regression tests on prompt changes.

---

## Provider matrix

| Provider | Tier | Agentic loop | Streaming | Tool use |
|---|---|---|---|---|
| **Claude** (CLI subprocess) | agentic | ✓ | ✓ | native |
| **OpenAI** (HTTP) | agentic | ✓ | ✓ | OpenAI tools |
| **Gemini** (HTTP) | agentic | ✓ | ✓ | function call |
| **OpenRouter** (HTTP) | agentic | ✓ | ✓ | OpenAI tools |
| **OpenCode** (HTTP, Go subscription) | agentic | ✓ | ✓ | OpenAI tools |
| **Ollama** (local) | agentic | ✓ | ✓ | OpenAI tools |
| **Gemini CLI** (subprocess) | utility | — | ✓ | — |
| **Google ADK** (`@google/adk`) | agentic | ✓ | ✓ | ADK runner |

All adapters share the same Anvil Stream Format (NDJSON), the same
`UpstreamError` shape for retry/fallback, and the same per-call
`AbortController` semantics for safe concurrency.

---

## Architecture at a glance

```
┌─ runLLM / runClaude / runGemini ─────────── one-shot
└─ AgentManager ──── AgentProcess ──── LanguageModelBridge
                                         │
                                         └─ ModelAdapter (one of 8)
                                              ↑
                                         ProviderRegistry
                                              ↑
                                         LlmRouter   (retries, fallbacks, rate limit)
                                              ↑
                                         Telemetry   (OTel spans + cost)
                                              ↑
                                         Checkpoint  (deterministic cache)
```

Each layer is opt-in. Use a single adapter directly, or compose the
full stack — the same interfaces flow all the way up.

---

## Philosophy

**No vendor SDKs.** Every HTTP adapter is hand-rolled `fetch()`. No
`@anthropic-ai/sdk`, no `openai` package, no LangChain, no Vercel AI
SDK. Lock-in stays at zero.

**Cost is observable, not estimated.** Every call attaches a real
`gen_ai.usage.cost` attribute computed from a vendored LiteLLM
pricing snapshot. Refresh on demand: `npm run refresh-cost-table`.

**Agentic isn't a flag.** When a model supports tool calls, the
adapter drives the loop — multi-turn, with safe builtins. No
"agent mode" toggle. No special prompt template required.

**One source of truth per concern.** Cost lives in `cost.ts`. Spans
live at the registry seam. Tool execution lives in
`BuiltinToolExecutor`. Adding a new provider doesn't touch any of
them.

---

## Part of [Anvil](../../) — the AI development pipeline.
