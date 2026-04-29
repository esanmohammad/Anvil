# ADR — Extract `@anvil/agent-core` shared workspace package

> **Companion document** to [`AGENT-CORE-EXTRACT-PLAN.md`](./AGENT-CORE-EXTRACT-PLAN.md). Captures the locked architectural decisions, audit findings, and open notes captured at Phase 0 (2026-04-29).

---

## 1. Decisions (locked at Phase 0)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Package name | `@anvil/agent-core` | Matches `@anvil/knowledge-core` scoping. |
| D2 | Module type | ESM only (`"type": "module"`) | Matches knowledge-core, cli, mcp. |
| D3 | Build target | `tsc -b` with `composite: true`, project-referenced from root | Mirrors `@anvil/knowledge-core`. |
| D4 | LLM abstraction approach | Hand-rolled `LanguageModel` interface, vendor SDKs only | No Vercel AI SDK, LiteLLM-as-proxy, Mastra, LangChain. Replacement cost = one adapter file per provider. |
| D5 | Streaming shape | Anvil Stream Format (NDJSON, superset of Claude CLI `stream-json`) preserved | Existing parsers (`stream-parser.ts`) keep working. |
| D6 | Single-shot shape | Thin wrapper that drains the stream and returns the final block | One implementation, two convenience surfaces. |
| D7 | Subprocess CLI adapters | Kept as adapters behind the same interface | Preserves current deployments. Users with no API key still work. |
| D8 | Provider tier concept | Preserved (`agentic` / `function-calling` / `text-only`) | Already used by `model-router.ts`; rip-out cost is high. |
| D9 | Cost table source | Vendored snapshot of LiteLLM's `model_prices_and_context_window.json` (Apache-2.0) | Same source Aider + Langfuse internally use; refresh by re-running a snapshot script. |
| D10 | Env-var consolidation | New canonical names under `ANVIL_LLM_*`, with backwards-compatible aliases | Single contract going forward; no surprise breakage for existing deployments. |
| D11 | `ProviderRegistry` singleton | Kept | Pattern is sound; cli code already uses `ProviderRegistry.getInstance()`. |
| D12 | `cli/src/agent/` placement | Moves to `agent-core` (subprocess machinery is provider-agnostic) | Both cli and (future) headless agent runner need it. |
| D13 | `cli/src/pipeline/` placement | Stays in cli | Pipeline orchestration is cli-specific (factory.yaml, run records, dashboard hand-off). |
| D14 | Breaking-change tolerance | Zero for runtime behavior; minor for import paths | Same posture that worked for knowledge-core extract. |
| D15 | Existing `ProviderName` enum values | Preserve as-is (`'claude' | 'openai' | 'gemini' | 'openrouter' | 'ollama' | 'gemini-cli' | 'adk'`) | Plan §1 sketched `'anthropic-api' | 'anthropic-cli' | …` but renaming cascades through every adapter, registry resolver, and `model-router`. Keep current names; document. |
| D16 | dashboard's parallel `provider-registry.ts` + `adapters/` | Out of scope this initiative — leave alone | They duplicate provider/registry machinery in JS-only, but live under `dashboard/server/` and only the dashboard consumes them. Future convergence is a separate ADR. |

---

## 2. Pre-flight reality check (executed 2026-04-29)

| Check | Expected | Actual | Status |
|---|---|---|---|
| `packages/cli/src/providers/` files | 12 | 12 (matches plan) | ✅ |
| `packages/cli/src/agent/` files | 9 | 9 (matches plan) | ✅ |
| `packages/knowledge-core/src/` files | 27+ incl. claude-runner.ts | 28 incl. claude-runner.ts | ✅ |
| `packages/agent-core/` exists | no | no | ✅ |
| `npm -w @anvil/knowledge-core test` | 71/71 pass | 71/71 pass | ✅ |
| `npm -w @esankhan3/anvil-cli run build` | green | green | ✅ |
| `npm -w @esankhan3/code-search-mcp run build` | green (13 files) | green (13 files) | ✅ |

All gates green. Safe to proceed to Phase 1.

---

## 3. File inventory + diff buckets

### 3.1 `packages/cli/src/providers/` (12 files)

| File | LOC (≈) | Bucket | Notes |
|---|---|---|---|
| `claude-adapter.ts` | ~600 | single-tree | Anthropic API adapter. No counterpart elsewhere. |
| `openai-adapter.ts` | ~400 | single-tree | OpenAI API adapter. |
| `gemini-adapter.ts` | ~400 | single-tree | Google GenAI API adapter. |
| `openrouter-adapter.ts` | ~350 | single-tree | OpenRouter API adapter (OpenAI-compat). |
| `ollama-adapter.ts` | ~250 | single-tree | Ollama HTTP adapter. |
| `gemini-cli-adapter.ts` | ~300 | single-tree | Subprocess adapter for `gemini` binary. |
| `adk-adapter.ts` | ~300 | single-tree | Subprocess adapter for Google ADK CLI. |
| `fallback-adapter.ts` | ~150 | single-tree | Wraps primary + secondary, retries. |
| `registry.ts` | ~250 | single-tree | `ProviderRegistry` singleton. Used by `cli/commands/run-feature.ts` only at the cli level. |
| `types.ts` | ~70 | single-tree | `ModelAdapter`, `ProviderName` (current values: see §3.4), capabilities, config, result. |
| `stream-format.ts` | ~80 | single-tree | NDJSON event shape. Leaf module. |
| `index.ts` | ~10 | barrel | Re-exports all of the above. |

**Diff bucket distribution: 100% single-tree.** No part of `cli/src/providers/` is duplicated in `knowledge-core/`. The agent-core extract is therefore a *consolidation*, not a *deduplication* — different shape from knowledge-core extract.

### 3.2 `packages/cli/src/agent/` (9 files)

| File | LOC (≈) | Bucket | Notes |
|---|---|---|---|
| `agent-manager.ts` | ~400 | single-tree | Orchestrates one agent run. |
| `spawn.ts` | ~200 | single-tree | Process spawn + lifecycle. |
| `output-buffer.ts` | ~150 | single-tree | Backpressure-aware buffer. |
| `restart-policy.ts` | ~100 | single-tree | Retry / kill / circuit-break policy. |
| `stage-validator.ts` | ~120 | single-tree | Per-stage output validation. |
| `stream-parser.ts` | ~250 | single-tree | Parses Anvil Stream Format NDJSON. |
| `timeout-guard.ts` | ~120 | single-tree | Stage-level timeout enforcement. |
| `types.ts` | ~80 | single-tree | `AgentEvent`, `AgentProcessConfig`, `AgentProcessState`. |
| `index.ts` | ~30 | barrel | Re-exports the above. |

**Internal cli usage:** only `cli/src/commands/learn.ts` imports from `cli/src/agent/*`. Pipeline orchestration uses `runFeature` (which goes through `providers/` directly) — `agent/` is only used by the `learn` command at the cli level today. Dashboard server has a separate parallel `agent-manager.ts` / `agent-process.ts` under `packages/dashboard/server/` (see D16).

### 3.3 `packages/knowledge-core/src/claude-runner.ts` (1 file)

- ~330 LOC. Subprocess + HTTP API hybrid runner. Independent of `cli/src/providers/`. Has its own env-var contract (`CODE_SEARCH_LLM_*`), its own provider list (`'claude' | 'gemini'`), and its own process tracking via `Set<ChildProcess>`.
- Used by 3 internal callers in knowledge-core: `repo-profiler.ts`, `service-mesh-inferrer.ts`, `rag-evaluator.ts`. Re-exported from `knowledge-core/src/index.ts`.
- One test file: `knowledge-core/src/__tests__/claude-runner.test.ts`.

### 3.4 Naming divergence — actual `ProviderName` values

The plan §1 sketched a richer `ProviderName` enum (`'anthropic-api' | 'anthropic-cli' | 'openai-api' | 'google-api' | 'gemini-cli' | 'openrouter-api' | 'ollama-api' | 'adk'`). **Reality is shorter:** `'claude' | 'openai' | 'gemini' | 'openrouter' | 'ollama' | 'gemini-cli' | 'adk'` (no `*-api` / `*-cli` split for HTTP providers).

Per D15, the existing names are preserved. Renaming would cascade through every `ProviderRegistry.get()` call and `model-router` dispatch. The plan's sketch was illustrative; the audit corrects to actual.

### 3.5 dashboard's parallel provider stack

`packages/dashboard/server/` contains a JS-only parallel implementation:

- `provider-registry.js` (and `.ts`)
- `adapters/claude-adapter.js`, `gemini-cli-adapter.js`, `api-adapter.js`
- `agent-manager.js` + `agent-process.js`

This stack does *not* import from `cli/src/providers/` or `cli/src/agent/`. It is dashboard-internal. Per D16, this initiative leaves it alone. A future ADR can decide whether to converge dashboard onto `@anvil/agent-core`.

---

## 4. Public API surface (preservation contract)

### 4.1 `cli/src/providers/index.ts` exports

| Symbol | Source file | Disposition |
|---|---|---|
| `ProviderName`, `ProviderTier`, `ProviderCapabilities`, `ModelAdapterConfig`, `ModelAdapterResult`, `ModelAdapter` | `types.ts` | Move-with-rename: → `@anvil/agent-core` (legacy section of `types.ts`). Names preserved. |
| Stream format types (`StreamEvent`, `MessageStreamEvent`, etc. — read from file in Phase 2) | `stream-format.ts` | Move as-is to `@anvil/agent-core`. |
| `ProviderRegistry` | `registry.ts` | Move as-is to `@anvil/agent-core`. |
| `ClaudeAdapter`, `OpenAIAdapter`, `GeminiAdapter`, `OpenRouterAdapter`, `OllamaAdapter`, `GeminiCliAdapter`, `AdkAdapter` | per-adapter files | Move as-is to `@anvil/agent-core`. |

After the move, `cli/src/providers/index.ts` becomes a thin re-export shim (`export * from '@anvil/agent-core';`) for any cli-internal consumer that imports from the old path. Eventually deletable once cli's own files are rewritten to point at `@anvil/agent-core` directly.

### 4.2 `cli/src/agent/index.ts` exports

All preserved as-is, moving to `@anvil/agent-core`:
- Types: `AgentProcessConfig`, `AgentProcessState`, `AgentEvent`, `AgentResult`, `ValidationResult`
- Constants/funcs: `STAGE_TIMEOUT_DEFAULTS`, `getDefaultTimeout`, `createDefaultConfig`
- Classes/funcs: `spawnAgent`, `AgentProcess`, `StreamParser`, `OutputBuffer`, `RestartPolicy`, `TimeoutGuard`, `StageValidator`, `AgentManager`, `SpawnFn`

### 4.3 `knowledge-core/src/claude-runner.ts` exports

| Symbol | Disposition |
|---|---|
| `runClaude`, `runGemini`, `runLLM` | Re-export from `@anvil/agent-core/single-shot.js` via shim. |
| `isLlmAvailable`, `resetLlmConfig` | Same. |
| `ClaudeResult`, `LLMRunOptions` | Same. |

Shim becomes ~10 LOC after Phase 5.

---

## 5. External importers (single source of truth)

| Tree | Importing file (cli-internal) | Symbols |
|---|---|---|
| `cli/src/providers/*` | `cli/src/commands/run-feature.ts` | `ProviderRegistry`, `ProviderName` |
| `cli/src/agent/*` | `cli/src/commands/learn.ts` | (all from agent barrel) |
| `knowledge-core/src/claude-runner.ts` | `knowledge-core/src/{index,indexer,rag-evaluator,service-mesh-inferrer,repo-profiler}.ts` + tests | `runLLM`, `runClaude`, `isLlmAvailable`, `ClaudeResult` |

**Cross-package external importers: zero today.** dashboard, mcp, and other packages do not import from cli's `providers/` or `agent/`. After the agent-core extract, those packages will be free to import from `@anvil/agent-core` if needed, but no rewrites are *forced* on them by this initiative.

---

## 6. LLM env vars (full inventory + Phase-5 alias plan)

Detected via `grep -rE "CODE_SEARCH_LLM_|ANVIL_AGENT_CMD|FF_AGENT_CMD|CLAUDE_BIN|GEMINI_BIN|GEMINI_CLI_BIN|ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|OLLAMA_HOST|OPENAI_BASE_URL|OPENROUTER_BASE_URL"` in `packages/`.

| Legacy | Canonical (post-Phase 5) | Notes |
|---|---|---|
| `CODE_SEARCH_LLM_MODE` | `ANVIL_LLM_MODE` | `cli` / `api` / `none` |
| `CODE_SEARCH_LLM_API_KEY` | `ANVIL_LLM_API_KEY` | required for `api` mode |
| `CODE_SEARCH_LLM_PROVIDER` | `ANVIL_LLM_PROVIDER` | `anthropic` / `openai` / `custom` |
| `CODE_SEARCH_LLM_MODEL` | `ANVIL_LLM_MODEL` | aliased to specific version |
| `CODE_SEARCH_LLM_BASE_URL` | `ANVIL_LLM_BASE_URL` | OpenAI-compat custom endpoint |
| `CODE_SEARCH_CLAUDE_BIN` | `ANVIL_CLAUDE_BIN` | path to claude CLI |
| `ANVIL_AGENT_CMD` | `ANVIL_CLAUDE_BIN` | already cli-side; consolidate |
| `FF_AGENT_CMD` | `ANVIL_CLAUDE_BIN` | legacy "feature factory" name |
| `CLAUDE_BIN` | `ANVIL_CLAUDE_BIN` | unscoped legacy |
| `GEMINI_BIN` | `ANVIL_GEMINI_BIN` | |
| `GEMINI_CLI_BIN` | `ANVIL_GEMINI_BIN` | |
| `ANTHROPIC_API_KEY` | `ANVIL_ANTHROPIC_API_KEY` | conventional name kept as alias |
| `OPENAI_API_KEY` | `ANVIL_OPENAI_API_KEY` | conventional name kept as alias |
| `OPENAI_BASE_URL` | `ANVIL_OPENAI_BASE_URL` | |
| `OPENROUTER_API_KEY` | `ANVIL_OPENROUTER_API_KEY` | |
| `OPENROUTER_BASE_URL` | `ANVIL_OPENROUTER_BASE_URL` | |
| `GEMINI_API_KEY` | `ANVIL_GOOGLE_API_KEY` | alias |
| `GOOGLE_API_KEY` | `ANVIL_GOOGLE_API_KEY` | alias |
| `OLLAMA_HOST` | `ANVIL_OLLAMA_HOST` | default `http://localhost:11434` |

Resolution order in every case: `ANVIL_*` → legacy alias(es) → default. Emit a `[anvil-llm] DEPRECATED: $LEGACY_VAR is set without $ANVIL_VAR. Migrate by 1.0.` warning to stderr if a legacy var is set without its canonical counterpart.

---

## 7. Vendor SDK declarations (current state)

`grep -rEn "import .* from ['\"][^.][^'\"]*['\"]" packages/cli/src/providers/` shows every adapter currently uses `node:child_process` (subprocess adapters) or hand-rolled `fetch()` (HTTP adapters) — **no vendor SDKs in `package.json` today**.

Per D4 default decision in Phase 4a: *keep what each adapter currently uses*. SDK adoption (`@anthropic-ai/sdk`, `openai`, `@google/genai`) is a Phase-12 follow-up, not part of this initiative's MVP. This keeps Phase 4a's risk profile low.

---

## 8. Open notes / risks captured at audit time

1. **Plan §1 sketch vs reality on `ProviderName`** — divergence flagged in §3.4; resolved via D15.
2. **dashboard duplicate provider stack** — flagged in §3.5; resolved via D16 (out of scope).
3. **`learn.ts` is the only cli consumer of `cli/src/agent/`** — Phase 6 must verify `learn.ts` still type-checks after the import-path swap. Low risk (single file).
4. **`run-feature.ts` is the only cli consumer of `cli/src/providers/`** — Phase 3+4 must verify `run-feature.ts` still type-checks. Low risk (single file).
5. **knowledge-core's claude-runner has its own subprocess tracking** — Phase 5 risk; spelled out in plan §5.7 risk #2.
6. **`with { type: 'json' }` import attribute (Phase 7)** — requires Node ≥20.10. Anvil's `package.json` engines field should be checked before Phase 7.

---

## 9. What actually shipped (filled in at Phase 10)

_Populated incrementally as each phase completes. Format per phase: commit hash, deviations from plan, plan corrections to back-port._

- **Phase 0** — `6c49f8c` — ADR written + 4 sibling plan files committed. No code change.
- **Phase 1** — `e6ffe39` — Scaffold landed. Deviation: `@anvil/agent-core` dep skipped on `packages/dashboard/package.json` per D16 (dashboard's parallel provider stack is out of scope; adding the dep without a consumer is lockfile churn). Plan §1.2 over-specified.
- **Phase 2** — `b3cd41f` — `stream-format.ts` hoisted. Followed plan exactly. 7 adapter imports rewritten from `'./stream-format.js'` to `'@anvil/agent-core'`; cli providers barrel keeps backwards-compat re-exports.
- **Phase 3** — `4236d65` — _types-only scope_ — Deviation: plan §3 bundled `types.ts + registry.ts`, but `registry.ts`'s `registerDefaults()` uses `require('./X-adapter.js')` for each of the 7 adapters; moving registry to agent-core before the adapters move would silently break `ProviderRegistry.getInstance().get('claude')` (the try/catch swallows the missing-module error). Phase 3 ships `types.ts` only; `registry.ts` rolls into Phase 4 alongside the adapters. Plan §3 should be back-ported to reflect this ordering.
- **Phase 4** — _registry + 7 adapters + fallback_ — Moves all 9 files. `cli/src/providers/` directory deleted entirely. **Latent bug fix:** `ProviderRegistry.registerDefaults()` historically used `require('./X-adapter.js')` wrapped in try/catch; under ESM (`"type": "module"`) `require` is undefined, so every adapter registration silently failed. The bug was masked because cli's normal flow may not have exercised an empty-registry resolution. Replaced with static ESM imports — verified via runtime smoke that all 7 providers (`adk, claude, gemini, gemini-cli, ollama, openai, openrouter`) register on `ProviderRegistry.getInstance()`. Plan §4's risk list should be amended to call out this trap. Pre-Phase-4 internal package self-imports (`from '@anvil/agent-core'` inside agent-core files, residue from Phase 3's bulk sed) also normalized to relative paths (`./types.js`, `./stream-format.js`).
