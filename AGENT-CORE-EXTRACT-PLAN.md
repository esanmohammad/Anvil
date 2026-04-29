# Plan: Extract `@anvil/agent-core` shared workspace package

> **Status: Proposed.** Self-contained executable plan — does not require prior conversation context. Companion to [`KNOWLEDGE-CORE-EXTRACT-PLAN.md`](./KNOWLEDGE-CORE-EXTRACT-PLAN.md) (already shipped). Sibling plans in this initiative: [`AGENT-OBSERVABILITY-PLAN.md`](./AGENT-OBSERVABILITY-PLAN.md) (executes after this), [`AGENT-HARNESS-PLAN.md`](./AGENT-HARNESS-PLAN.md) (executes after observability).

---

## Goals (what "done" means)

1. A single workspace package `@anvil/agent-core` owns every LLM call surface in the monorepo. Both the streaming/agent shape (today: `packages/cli/src/providers/`) and the single-shot analytical shape (today: `packages/knowledge-core/src/claude-runner.ts`) live behind one `LanguageModel` interface.
2. **No external LLM-abstraction library** in the dependency tree. Each provider adapter calls its vendor's official SDK directly (`@anthropic-ai/sdk`, `openai`, `@google/genai`) or spawns a CLI subprocess. Lock-in surface = one adapter file (~150 LOC) per provider.
3. Existing public API of `cli/src/providers` is preserved — `ProviderRegistry`, `ModelAdapter`, `ProviderName`, etc. stay reachable at the same import names, just from the new package.
4. Existing public API of `knowledge-core/src/claude-runner.ts` is preserved — `runLLM`, `runClaude`, `runGemini`, `isLlmAvailable`, `ClaudeResult` stay reachable. Internally rewritten to delegate to `agent-core`.
5. Both consumers (`cli` + `knowledge-core` + `dashboard`) import the new package; cli's `agent/` subprocess machinery moves with it.
6. Tests pass with the same coverage as today. No behavior regression on the agentic path (`build`/`validate`/`ship` stages) or the analytical path (repo-profiler / service-mesh / rag-evaluator).

---

## Cost-benefit context

### Current footprint (measured at plan-authoring time)

| Tree | Files | Approx LOC |
|---|---|---|
| `packages/cli/src/providers/` | 12 (`claude-adapter`, `openai-adapter`, `gemini-adapter`, `openrouter-adapter`, `ollama-adapter`, `gemini-cli-adapter`, `adk-adapter`, `fallback-adapter`, `registry`, `types`, `stream-format`, `index`) | ~3,500 |
| `packages/cli/src/agent/` | 9 (`agent-manager`, `spawn`, `output-buffer`, `restart-policy`, `stage-validator`, `stream-parser`, `timeout-guard`, `types`, `index`) | ~2,000 |
| `packages/knowledge-core/src/claude-runner.ts` | 1 | ~330 |

Total candidate footprint: ~22 files / ~5,800 LOC.

### Why two shapes today

- **Streaming/agent shape** (`ModelAdapter.run(config, output: WritableStream): Promise<Result>`): writes NDJSON in "Anvil Stream Format" (a superset of Claude CLI's `stream-json`) so existing parsers (`stream-parser.ts`, `agent-manager.ts`) work uniformly. Used by `build`/`validate`/`ship` agentic stages — the LLM uses tools, modifies files, runs commands.
- **Analytical shape** (`runLLM(prompt, systemPrompt, opts): Promise<{result, costUsd, ...}>`): drains all tokens, returns the final string + cost block. Used by `repo-profiler` / `service-mesh-inferrer` / `rag-evaluator` — single-shot text-in / text-out.

The analytical shape is a thin draining wrapper over the streaming shape. They need to converge or the codebase keeps two parallel pricing tables, two parallel env-var contracts, and two parallel auth-resolution paths.

### Net hand-edited LOC

- ~600 LOC of new code (interface skeletons, single-shot wrapper, cost-table loader)
- ~150 LOC of edits in callers (import path swaps)
- ~5,800 LOC of moves (most cancel out — the file lives in one place after the move)

### Lock-in budget

- **Vendor SDKs**: `@anthropic-ai/sdk` (MIT), `openai` (Apache-2.0), `@google/genai` (Apache-2.0). All three are thin HTTP clients maintained by the vendor. Replacement cost: rewrite that one adapter file (~150 LOC). Acceptable.
- **Cost table**: vendored snapshot of LiteLLM's `model_prices_and_context_window.json` (Apache-2.0). Snapshot, not runtime dep.
- **No other libraries.** No Vercel AI SDK, no LiteLLM, no Mastra, no LangChain, no abstraction framework of any kind.

---

## Current state assumed (snapshot 2026-04-28)

This plan assumes the following starting state. If reality has drifted, run §"Pre-flight reality check" before Phase 0.

- `packages/agent-core/` does not exist.
- `packages/cli/src/providers/` contains 12 files including 7 working adapters, a `ProviderRegistry` singleton, and a `ModelAdapter` TypeScript interface that takes a `WritableStream` and returns a `ModelAdapterResult`.
- `packages/cli/src/agent/` contains the subprocess execution machinery (`spawn`, `stream-parser`, `output-buffer`, `restart-policy`, `timeout-guard`, `agent-manager`).
- `packages/knowledge-core/` was extracted across phases 0–9 of `KNOWLEDGE-CORE-EXTRACT-PLAN.md` and now owns chunking/retrieval/AST/etc.
- `packages/knowledge-core/src/claude-runner.ts` (~330 LOC) exports `runClaude`, `runGemini`, `runLLM`, `isLlmAvailable`, `resetLlmConfig`, `LLMRunOptions`, `ClaudeResult`. It supports `CODE_SEARCH_LLM_MODE = cli | api | none` with auto-detection.
- 14 LLM-related env vars exist across the repo: `ANTHROPIC_API_KEY`, `ANVIL_AGENT_CMD`, `CLAUDE_BIN`, `FF_AGENT_CMD`, `GEMINI_API_KEY`, `GEMINI_BIN`, `GEMINI_CLI_BIN`, `GOOGLE_API_KEY`, `OLLAMA_HOST`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `CODE_SEARCH_LLM_*` (multiple).
- All 71 knowledge-core tests pass; dashboard tests 430/436 (6 pre-existing failures unrelated to this work).

### Pre-flight reality check (run before Phase 0)

```sh
# Confirm the assumed file layout
ls packages/cli/src/providers/        # expect: 12 files
ls packages/cli/src/agent/            # expect: 9 files
ls packages/knowledge-core/src/       # expect: 27+ files including claude-runner.ts

# Confirm tests are currently green (any failures are pre-existing and unrelated)
npm -w @anvil/knowledge-core test     # expect: 71/71 pass
npm -w @esankhan3/anvil-cli run build # expect: green
npm -w @esankhan3/code-search-mcp run build # expect: green

# Confirm no existing agent-core package
test ! -d packages/agent-core || { echo "FAIL: agent-core already exists; abort and reconcile"; exit 1; }
```

If any check fails, stop and reconcile rather than proceeding.

---

## Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Package name | `@anvil/agent-core` | Matches `@anvil/knowledge-core` scoping. |
| D2 | Module type | ESM only (`"type": "module"`) | Matches knowledge-core, cli, mcp. Avoids interop shims. |
| D3 | Build target | `tsc -b` with `composite: true`, project-referenced from root | Mirrors `@anvil/knowledge-core`. |
| D4 | LLM abstraction approach | Hand-rolled `LanguageModel` interface, vendor SDKs only | No Vercel AI SDK, LiteLLM-as-proxy, Mastra, LangChain. Replacement cost = one adapter file per provider. |
| D5 | Streaming shape | Anvil Stream Format (NDJSON, superset of Claude CLI `stream-json`) preserved | Existing parsers (`stream-parser.ts`) keep working. |
| D6 | Single-shot shape | Thin wrapper that drains the stream and returns the final block | One implementation, two convenience surfaces. |
| D7 | Subprocess CLI adapters | Kept as adapters behind the same interface | Preserves current deployments. Users with no API key still work. |
| D8 | Provider tier concept | Preserved (`agentic` / `function-calling` / `text-only`) | Already used by `model-router.ts`; rip-out cost is high. |
| D9 | Cost table source | Vendored snapshot of LiteLLM's `model_prices_and_context_window.json` (Apache-2.0) | Same source Aider + Langfuse internally use; refresh by re-running a snapshot script. |
| D10 | Env-var consolidation | New canonical names under `ANVIL_LLM_*`, with backwards-compatible aliases | Single contract going forward; no surprise breakage for existing deployments. |
| D11 | `ProviderRegistry` singleton | Kept | Pattern is sound; cli code already uses `ProviderRegistry.getInstance()` extensively. |
| D12 | `cli/src/agent/` placement | Moves to `agent-core` (subprocess machinery is provider-agnostic) | Both cli and (future) headless agent runner need it. |
| D13 | `cli/src/pipeline/` placement | Stays in cli | Pipeline orchestration is cli-specific (factory.yaml, run records, dashboard hand-off). |
| D14 | Breaking-change tolerance | Zero for runtime behavior; minor for import paths | Same posture that worked for knowledge-core extract. |

---

## Phase 0 — Audit + decisions (no code change)

**Effort:** 0.5d.

### 0.1 Audit deliverables

Produce `AGENT-CORE-ADR.md` at repo root (sibling to this plan). Contents:

1. The decisions table above, formalized.
2. File inventory with diff buckets (paired clones / mild drift / single-tree). For agent-core, expect mostly **single-tree** — cli/providers and knowledge-core/claude-runner aren't duplicated; they're complementary. Document the seams instead of overlap.
3. Public API surface of `cli/src/providers/index.ts` and `knowledge-core/src/claude-runner.ts` — every exported symbol, with whether it's "preserved as-is" / "moved with rename" / "replaced".
4. List of every external importer of either tree (run grep against the codebase).
5. List of all 14 LLM env vars + plan for `ANVIL_LLM_*` aliasing.
6. Vendor SDK versions in current `package.json` files (today: none directly; subprocesses go through CLI binaries).

### 0.2 Acceptance

- [ ] ADR written at `AGENT-CORE-ADR.md`
- [ ] Audit document reviewed (or self-reviewed if solo)
- [ ] All 12 reality-check assertions in §"Pre-flight reality check" pass

### 0.3 Rollback

N/A — doc-only.

---

## Phase 1 — Scaffold `@anvil/agent-core` + proof-of-life

**Effort:** 0.5d.

### 1.1 Create the package skeleton

```
packages/agent-core/
├── package.json          (~40 LOC)
├── tsconfig.json         (~20 LOC, extends root)
├── src/
│   ├── index.ts          (~30 LOC, public barrel)
│   ├── types.ts          (~60 LOC, LanguageModel interface + supporting types)
│   └── version.ts        (~5 LOC, exports VERSION constant)
└── README.md             (~50 LOC)
```

`package.json` shape (matching `@anvil/knowledge-core`):

```json
{
  "name": "@anvil/agent-core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./*.js": { "types": "./dist/*.d.ts", "default": "./dist/*.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b",
    "dev": "tsc -b --watch",
    "test": "tsc -b && node --test dist/__tests__/*.test.js"
  },
  "dependencies": {},
  "devDependencies": { "@types/node": "^22.15.2" }
}
```

`src/types.ts` defines the new unified interface (no `WritableStream` requirement for the inner shape — the streaming surface is an `AsyncIterable<StreamEvent>` that can be optionally piped to a `WritableStream` adapter):

```ts
export type ProviderName =
  | 'anthropic-api' | 'anthropic-cli'
  | 'openai-api'
  | 'google-api' | 'gemini-cli'
  | 'openrouter-api'
  | 'ollama-api'
  | 'adk';
export type ProviderTier = 'agentic' | 'function-calling' | 'text-only';

export interface LanguageModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; }

export interface LanguageModelInvokeOptions {
  model: string;
  messages: LanguageModelMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  cacheBreakpoint?: number;        // index in messages[] where cache should be inserted
  providerOptions?: Record<string, unknown>; // escape hatch for provider-specific knobs
  signal?: AbortSignal;
}

export interface ToolSchema { name: string; description: string; inputSchema: Record<string, unknown>; }

export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: 'finish'; reason: 'end' | 'tool-use' | 'length' | 'error'; error?: string };

export interface InvokeResult {
  text: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  costUsd: number;
  durationMs: number;
  provider: ProviderName;
  model: string;
}

export interface LanguageModel {
  readonly provider: ProviderName;
  readonly capabilities: ProviderCapabilities;
  supportsModel(modelId: string): boolean;
  getModelPricing(modelId: string): [number, number] | null; // [inputPer1M, outputPer1M]
  checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }>;
  /** Streaming surface — yields events as the provider produces them. */
  invokeStream(opts: LanguageModelInvokeOptions): AsyncIterable<StreamEvent>;
  /** Single-shot surface — drains the stream and returns the final block. Default impl provided. */
  invoke(opts: LanguageModelInvokeOptions): Promise<InvokeResult>;
}

export interface ProviderCapabilities {
  tier: ProviderTier;
  streaming: boolean;
  toolUse: boolean;
  fileSystem: boolean;
  shellExecution: boolean;
  sessionResume: boolean;
  promptCaching: boolean;
}
```

### 1.2 Wire workspace

- Root `tsconfig.json` `references[]` — add `{ "path": "packages/agent-core" }` (currently lists `knowledge-core`, `cli`, `dashboard`).
- Root `package.json` workspaces glob already covers `packages/*`. No change.
- `packages/cli/package.json` — add `"@anvil/agent-core": "*"` to `dependencies`. (Note: must use `"*"` not `"workspace:*"` per the npm-version constraint discovered during knowledge-core extract.)
- `packages/knowledge-core/package.json` — add same dep (will need it in Phase 5).
- `packages/code-search-mcp/package.json` — add same dep (transitive consumer).
- `packages/dashboard/package.json` — add same dep (dashboard server hits agent-core for run cost tracking).

### 1.3 Validation

```sh
# Build the new package
npm install
npm -w @anvil/agent-core run build

# Confirm no consumers broken (they don't import yet)
npm -w @anvil/knowledge-core test    # 71/71 pass
npm -w @esankhan3/anvil-cli run build
npm -w @esankhan3/code-search-mcp run build

# Confirm package resolves from each consumer
test -L node_modules/@anvil/agent-core
```

### 1.4 Acceptance

- [ ] `packages/agent-core/` exists with 5 files (package.json, tsconfig.json, src/index.ts, src/types.ts, README.md)
- [ ] `npm -w @anvil/agent-core run build` succeeds (emits `dist/`)
- [ ] All consumers' builds + tests still green
- [ ] Workspace symlink `node_modules/@anvil/agent-core` exists

### 1.5 Rollback

Single commit revert. No persisted state.

### 1.6 Risks

- **ESM resolution gotcha** (same as knowledge-core Phase 1) — if `@anvil/agent-core` isn't picked up, fix once at the package boundary, not per-file. Likely cause: `package.json exports` typo or missing `tsconfig` `composite: true`.

---

## Phase 2 — Hoist `stream-format.ts` (true clone proof-of-life)

**Effort:** 0.5d.

### 2.1 Scope

Move `packages/cli/src/providers/stream-format.ts` to `packages/agent-core/src/stream-format.ts`. This file defines the NDJSON event shapes shared by every adapter. Single-tree (no duplicate to reconcile), small (~80 LOC), low-risk.

### 2.2 Procedure

1. `cp packages/cli/src/providers/stream-format.ts packages/agent-core/src/stream-format.ts`
2. `rm packages/cli/src/providers/stream-format.ts`
3. Update `packages/agent-core/src/index.ts` — add `export * from './stream-format.js';`
4. Update every cli importer of `stream-format.ts`:
   ```sh
   grep -rln "from ['\"]\\./stream-format\\.js['\"]" packages/cli/src/providers
   grep -rln "from ['\"][^'\"]*providers/stream-format\\.js['\"]" packages/cli/src
   # rewrite to from '@anvil/agent-core'
   ```
5. Update `packages/cli/src/providers/index.ts` — drop `export * from './stream-format.js'` (now sourced from the package).

### 2.3 Validation

```sh
npm -w @anvil/agent-core run build
npm -w @esankhan3/anvil-cli run build
npm -w @esankhan3/anvil-cli test
```

### 2.4 Acceptance

- [ ] `stream-format.ts` exists exactly once (in `agent-core/src/`)
- [ ] All 7 adapter files in cli still build (they import the stream-format types)
- [ ] cli's `stream-parser.ts` still parses the format correctly (existing tests cover this)

### 2.5 Rollback

Per-file revert. Worst case: `git mv` it back, restore the cli barrel re-export.

### 2.6 Risks

Trivial. If anything breaks here, the package wiring (Phase 1) was wrong.

---

## Phase 3 — Hoist `providers/types.ts` and `providers/registry.ts`

**Effort:** 1d.

### 3.1 Scope

Move the two foundational provider modules:

- `packages/cli/src/providers/types.ts` — `ModelAdapter`, `ProviderName`, `ProviderTier`, `ProviderCapabilities`, `ModelAdapterConfig`, `ModelAdapterResult`. Total ~80 LOC.
- `packages/cli/src/providers/registry.ts` — `ProviderRegistry` class with the singleton, tier enforcement for `AGENTIC_STAGES`, default-registration logic. Total ~250 LOC.

### 3.2 Reconcile two type systems

The new package defined `LanguageModel` in Phase 1. cli's `ModelAdapter` is the existing interface. **Both must coexist for a transition window.** Strategy:

1. **Keep the legacy `ModelAdapter` interface as-is** (in agent-core's types.ts) so existing 7 adapters keep compiling.
2. Add the new `LanguageModel` interface alongside it (also in types.ts).
3. Provide a free function `legacyAdapterToLanguageModel(adapter: ModelAdapter): LanguageModel` that wraps a legacy adapter behind the new interface (drains its stream, parses NDJSON, emits `StreamEvent`s). ~200 LOC of glue.
4. Future phases can choose to migrate adapters from `ModelAdapter` to `LanguageModel` natively, but this is not required for Phase 3.

This DI seam means cli's `ProviderRegistry` keeps returning `ModelAdapter` and existing callers keep working. New callers (Phase 5 onwards, claude-runner replacement) use `LanguageModel` directly.

### 3.3 Procedure

1. Move `types.ts` → `agent-core/src/types-legacy.ts` (rename to avoid clash with the new types.ts already in place). Or merge: append the legacy types into agent-core/src/types.ts under a `// ── Legacy adapter shape ─────────────────────────────` separator. The latter keeps the import path uniform.
2. Move `registry.ts` → `agent-core/src/registry.ts`. Update its import from `'./types.js'` to relative `./types.js` (no path change since both are in the same dir post-move).
3. Update agent-core barrel:
   ```ts
   export * from './stream-format.js';
   export * from './types.js';
   export * from './registry.js';
   ```
4. Update cli importers — every `from '../../providers/types.js'`, `from '../providers/types.js'`, `from './types.js'` (within `cli/src/providers/`), `from '../providers/registry.js'` should become `from '@anvil/agent-core'`. Use the same scoped sed pattern proven during knowledge-core extract.
5. Update `cli/src/providers/index.ts` to drop the now-redundant lines and add `export * from '@anvil/agent-core';` for backwards compat with cli's existing barrel consumers.

### 3.4 Validation

```sh
npm -w @anvil/agent-core run build
npm -w @esankhan3/anvil-cli run build         # may surface stragglers; fix as found
npm -w @esankhan3/anvil-cli test
npm -w @esankhan3/code-search-mcp run build
cd packages/dashboard && npx tsc -p server/tsconfig.json && node --test server/out/__tests__/*.test.js | tail -10
```

### 3.5 Acceptance

- [ ] `types.ts` and `registry.ts` exist exactly once (in `agent-core/src/`)
- [ ] All 7 adapter files compile with imports rewritten
- [ ] `ProviderRegistry.getInstance()` callers across cli still work
- [ ] dashboard tests 430/436 (or whatever the current baseline is — must not regress)

### 3.6 Rollback

Larger blast radius than Phase 2. Split into two commits (types.ts move + registry.ts move) so partial revert is possible.

### 3.7 Risks

- **Import path divergence:** ~30+ cli files import `./types.js` from inside `providers/`. Must scope sed carefully to not catch unrelated `./types.js` files in `cli/src/agent/`, `cli/src/pipeline/`, etc.
- **Circular import:** `registry.ts` imports `types.ts`; both move. Verify the relative `./` import survives within agent-core.

---

## Phase 4 — Hoist 7 provider adapters

**Effort:** 2d total, split into three sub-phases.

### Phase 4a — API adapters (claude / openai / gemini / openrouter / ollama)

**Effort:** 1d.

5 adapters that wrap HTTP providers. All consume `ModelAdapterConfig`, all write the `stream-format` NDJSON. They are largely independent of each other.

#### Procedure (apply to each)

1. `cp packages/cli/src/providers/<X>-adapter.ts packages/agent-core/src/<X>-adapter.ts`
2. `rm packages/cli/src/providers/<X>-adapter.ts`
3. Update relative imports inside the moved file: `from './types.js'` → still works (same dir). `from './stream-format.js'` → still works.
4. Update `packages/agent-core/src/index.ts` — add `export { ClaudeAdapter } from './claude-adapter.js';` etc.
5. Update `packages/cli/src/providers/index.ts` — drop the explicit `export { ClaudeAdapter } from './claude-adapter.js'` lines. They're now reachable via `@anvil/agent-core`.
6. Update `packages/cli/src/providers/registry.ts` (now in agent-core) — its `registerDefaults()` method instantiates each adapter; adjust import paths if needed.

#### Vendor SDK declaration

This is where the lock-in question gets concrete. Examine each existing adapter's network call:

- `claude-adapter.ts` — currently uses `fetch()` against `https://api.anthropic.com/v1/messages`? Or wraps `@anthropic-ai/sdk`? **Check, then decide:** stay with `fetch()` for portability, or upgrade to the official SDK for streaming/error-handling robustness. Per D4, official SDK is fine if it's MIT/Apache and the behavior is unchanged.
- `openai-adapter.ts` — same call: `fetch()` vs `openai` package.
- `gemini-adapter.ts` — same: `fetch()` vs `@google/genai`.
- `openrouter-adapter.ts` — uses OpenAI-compat schema; can use `openai` SDK with `baseURL` override.
- `ollama-adapter.ts` — uses Ollama HTTP API; pure `fetch()` is sufficient.

**Default decision for Phase 4a:** keep whatever the current adapter uses. Don't introduce new SDK deps in this phase. SDK upgrade is a Phase-12 follow-up if desired.

#### Validation (after each adapter move)

```sh
npm -w @anvil/agent-core run build
npm -w @esankhan3/anvil-cli run build
npm -w @esankhan3/anvil-cli test
```

#### Acceptance

- [ ] 5 API adapters live in `agent-core/src/`
- [ ] cli's `providers/index.ts` is now a thin re-export layer
- [ ] `ProviderRegistry.getInstance()` still resolves all 5 adapters
- [ ] Smoke test: `anvil index` against a fixture project succeeds (it embeds chunks via the embedder, which Phase 4b adapters cover)

### Phase 4b — Subprocess adapters (gemini-cli / adk)

**Effort:** 0.5d.

2 adapters that spawn external CLI processes. `gemini-cli-adapter.ts` calls `gemini` binary; `adk-adapter.ts` calls Google's ADK CLI.

#### Procedure

Same pattern as 4a. These adapters depend on `ANVIL_AGENT_CMD`, `GEMINI_CLI_BIN`, etc. — those env vars stay readable from `process.env` regardless of which package the file lives in.

#### Validation

```sh
# Confirm subprocess discovery still works
ANVIL_AGENT_CMD=$(which claude) npm -w @esankhan3/anvil-cli test
GEMINI_CLI_BIN=$(which gemini) npm -w @esankhan3/anvil-cli test
```

#### Acceptance

- [ ] Both subprocess adapters live in `agent-core/src/`
- [ ] Subprocess invocation still works (the move didn't change `spawn()` semantics)

### Phase 4c — Fallback adapter

**Effort:** 0.5d.

`fallback-adapter.ts` is special: it wraps a primary adapter, retries on failure, falls back to a secondary adapter on persistent failure. Keep its semantics identical.

#### Procedure

Same as 4a. Surface no behavior changes.

#### Acceptance

- [ ] Fallback chain resolves through agent-core's registry
- [ ] Existing fallback tests pass (if any)

### 4.4 Combined Phase 4 acceptance

- [ ] All 7 adapters in `agent-core/src/`
- [ ] `cli/src/providers/` shrunk to just `index.ts` (and possibly nothing — if so, delete the dir entirely and have callers import from `@anvil/agent-core` directly)
- [ ] All cli tests pass
- [ ] dashboard tests don't regress

### 4.5 Rollback

Per-adapter revert. Each adapter is independent. Phase 4a's 5 adapters can be reverted individually; 4b and 4c are atomic units.

### 4.6 Risks

- **Hidden adapter coupling:** if any adapter imports from `cli/src/agent/` (it shouldn't, but verify), Phase 6 must precede Phase 4 instead of follow it. Run `grep -rn "from ['\"][^'\"]*\\./agent/" packages/cli/src/providers/` first.
- **Native deps:** if any adapter pulls in a vendor SDK, that SDK must be declared in `agent-core/package.json`. Detect via `grep -rEn "import .* from ['\"][^.][^'\"]*['\"]" packages/cli/src/providers/`.

---

## Phase 5 — Converge `claude-runner.ts` into agent-core

**Effort:** 1d.

### 5.1 Why this is the architectural one

`packages/knowledge-core/src/claude-runner.ts` is a 330-LOC analytical-shape runner: subprocess spawn + HTTP API + streaming drain → returns `{result, costUsd, ...}`. It evolved separately from `cli/src/providers/` and has its own provider list (claude / gemini), env var contract (`CODE_SEARCH_LLM_*`), and process tracking.

The merge target: a single-shot helper in `agent-core` that wraps `LanguageModel.invoke(opts)` and returns the same `ClaudeResult`-shaped object. Existing `claude-runner.ts` becomes a thin compatibility shim.

### 5.2 Procedure

1. **Create `agent-core/src/single-shot.ts`** — exports `runLLM`, `runClaude`, `runGemini`, `isLlmAvailable`, `resetLlmConfig`, `LLMRunOptions`, `ClaudeResult`. The implementation:
   ```ts
   import { ProviderRegistry } from './registry.js';
   import type { LanguageModel, LanguageModelInvokeOptions } from './types.js';
   // ... same env var resolution as today's claude-runner ...
   export async function runLLM(prompt: string, systemPrompt: string, opts?: LLMRunOptions): Promise<ClaudeResult> {
     const provider = opts?.provider ?? 'claude';
     const adapter = ProviderRegistry.getInstance().get(provider === 'gemini' ? 'gemini-cli' : 'anthropic-cli');
     // ... wrap as messages, call invoke(), translate result back to ClaudeResult ...
   }
   ```
2. **Update `agent-core/src/index.ts`** — `export * from './single-shot.js';`
3. **Replace `knowledge-core/src/claude-runner.ts`** with a re-export shim:
   ```ts
   /** @deprecated import from @anvil/agent-core instead. Re-exported for backwards compat. */
   export {
     runLLM, runClaude, runGemini, isLlmAvailable, resetLlmConfig,
     type LLMRunOptions, type ClaudeResult,
   } from '@anvil/agent-core';
   ```
4. **Verify the 3 internal users** (`repo-profiler.ts`, `service-mesh-inferrer.ts`, `rag-evaluator.ts`) still work — they import from `'./claude-runner.js'` (shim) which forwards to `@anvil/agent-core`.

### 5.3 Env-var aliasing

The shim must read both old and new env-var names so neither consumer breaks:

| Old | New | Notes |
|---|---|---|
| `CODE_SEARCH_LLM_MODE` | `ANVIL_LLM_MODE` | Add new; keep old as fallback. Log deprecation warning if old is set. |
| `CODE_SEARCH_LLM_API_KEY` | `ANVIL_LLM_API_KEY` | Same. |
| `CODE_SEARCH_LLM_MODEL` | `ANVIL_LLM_MODEL` | Same. |
| `CODE_SEARCH_LLM_PROVIDER` | `ANVIL_LLM_PROVIDER` | Same. |
| `CODE_SEARCH_LLM_BASE_URL` | `ANVIL_LLM_BASE_URL` | Same. |
| `CODE_SEARCH_CLAUDE_BIN` | `ANVIL_CLAUDE_BIN` | Same. |

Resolution order: new var → old var → default. Deprecation warning to stderr if old var is set without new var. Keep this for at least one minor version, removable in a future deprecation phase.

### 5.4 Validation

```sh
npm -w @anvil/agent-core run build
npm -w @anvil/knowledge-core test     # 71/71 pass — claude-runner tests still pass via shim
npm -w @esankhan3/anvil-cli run build
npm -w @esankhan3/code-search-mcp run build

# Smoke test: profiling actually runs
cd /tmp && mkdir test-profiling && cd test-profiling
git init && echo "console.log('hi')" > index.js && git add -A && git commit -m init
ANVIL_LLM_MODE=none anvil index test-proj $(pwd)  # should not error; LLM features skip
```

### 5.5 Acceptance

- [ ] `agent-core/src/single-shot.ts` exists
- [ ] `knowledge-core/src/claude-runner.ts` is a shim (≤ 20 LOC)
- [ ] `repo-profiler.ts` / `service-mesh-inferrer.ts` / `rag-evaluator.ts` work unchanged
- [ ] Both env-var contracts resolve correctly (test with both old + new vars)
- [ ] Deprecation warning fires on old-only var usage

### 5.6 Rollback

Single-commit revert. The shim approach means all callers' imports stay unchanged, so the revert just restores the original file.

### 5.7 Risks

- **`runLLM`'s gemini provider:** today's claude-runner spawns the `gemini` binary directly. After the merge, it routes through `gemini-cli-adapter`. Verify the adapter's CLI invocation matches today's behavior — `gemini -p '<prompt>' --model <model>` etc.
- **Process tracking:** today's claude-runner uses a `Set<ChildProcess>` + SIGINT/SIGTERM handlers for cleanup. The merged version must preserve this. Check that the gemini-cli-adapter (and other subprocess adapters) implement equivalent cleanup, or hoist the tracking into agent-core itself.
- **Cost reporting parity:** today's `ClaudeResult.costUsd` is reported by Claude CLI's `--output-format stream-json` `result` message. After the merge, cost comes from the cost table (Phase 7). Until then, the shim might report `costUsd: 0` for non-CLI providers. Acceptable temporarily; Phase 7 fixes it.

---

## Phase 6 — Hoist `cli/src/agent/` subprocess machinery

**Effort:** 1d.

### 6.1 Scope

Move 9 files from `cli/src/agent/` to `agent-core/src/agent/`:

| File | LOC | Notes |
|---|---|---|
| `agent-manager.ts` | ~400 | Wraps a single agent run, handles retries via `restart-policy.ts`. |
| `spawn.ts` | ~200 | Process spawn + lifecycle. Generic, provider-agnostic. |
| `output-buffer.ts` | ~150 | Backpressure-aware buffer for stream output. |
| `restart-policy.ts` | ~100 | Retry / kill / circuit-break policy. |
| `stage-validator.ts` | ~120 | Per-stage output validation rules. |
| `stream-parser.ts` | ~250 | Parses Anvil Stream Format NDJSON. |
| `timeout-guard.ts` | ~120 | Stage-level timeout enforcement. |
| `types.ts` | ~80 | `AgentEvent`, `AgentProcessConfig`, `AgentProcessState`. |
| `index.ts` | ~30 | Barrel. |

These are subprocess execution machinery. They belong in `agent-core` because (a) cli + future headless runner need them, (b) they're inherently coupled to the streaming format defined in agent-core, and (c) keeping them in cli forces cli to know about subprocess details that should be encapsulated.

### 6.2 Procedure

1. `mkdir -p packages/agent-core/src/agent`
2. `git mv packages/cli/src/agent/* packages/agent-core/src/agent/`
3. Update internal imports — the moved files reference each other; relative imports survive.
4. Update agent-core barrel:
   ```ts
   export * from './agent/types.js';
   export * from './agent/spawn.js';
   export * from './agent/agent-manager.js';
   export * from './agent/stream-parser.js';
   // etc — match cli/agent/index.ts's current export list
   ```
5. Update cli importers — every `from '../agent/X.js'` → `from '@anvil/agent-core'`.
6. Decide: should `cli/src/agent/index.ts` survive as a re-export shim, or be deleted?  
   **Decision:** Delete. Callers import from `@anvil/agent-core` directly. Cleaner, no shim drift.

### 6.3 Validation

```sh
npm -w @anvil/agent-core run build
npm -w @esankhan3/anvil-cli run build
npm -w @esankhan3/anvil-cli test
# Pipeline integration test: actually run a stage end-to-end
ANVIL_LLM_MODE=cli anvil run --project <fixture> --stage clarify
```

### 6.4 Acceptance

- [ ] `cli/src/agent/` is deleted
- [ ] All 9 files in `agent-core/src/agent/`
- [ ] cli + dashboard + mcp builds green
- [ ] A real stage execution against a fixture works end-to-end

### 6.5 Rollback

Single-commit revert. Larger blast radius — touches every cli pipeline file via import-path changes. Mitigation: pre-commit, run the smoke pipeline against a known-good fixture.

### 6.6 Risks

- **Pipeline coupling:** `cli/src/pipeline/orchestrator.ts` is the heaviest consumer of `agent/agent-manager.ts`. Verify orchestrator still type-checks after the move.
- **Test infrastructure:** if agent integration tests live in `cli/src/agent/__tests__/`, they move with the source.

---

## Phase 7 — Cost table integration

**Effort:** 0.5d.

### 7.1 Scope

Vendor LiteLLM's `model_prices_and_context_window.json` as a snapshot inside `agent-core`. Provide a typed loader, used by:

- Each adapter's `getModelPricing(modelId)` method (currently hand-coded per adapter).
- `agent-core/src/cost.ts` — central cost calculator that takes `usage` + `model` and returns USD.
- Future Phase 11 (telemetry) — cost annotation on every span.

### 7.2 Procedure

1. **Snapshot script** at `packages/agent-core/scripts/refresh-cost-table.mjs`:
   ```js
   #!/usr/bin/env node
   const URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
   const res = await fetch(URL);
   const data = await res.text();
   await import('node:fs').then(({ writeFileSync }) =>
     writeFileSync(new URL('../src/data/model-prices.json', import.meta.url), data));
   console.log('refreshed model-prices.json');
   ```
2. **Initial snapshot:** run the script once. The JSON file is ~150 KB. Commit it.
3. **Loader** at `agent-core/src/cost.ts`:
   ```ts
   import modelPrices from './data/model-prices.json' with { type: 'json' };
   export function getModelPricing(model: string): { inputPer1M: number; outputPer1M: number; cacheReadPer1M?: number; cacheWritePer1M?: number } | null {
     const entry = (modelPrices as any)[model];
     if (!entry || typeof entry.input_cost_per_token !== 'number') return null;
     return {
       inputPer1M: entry.input_cost_per_token * 1_000_000,
       outputPer1M: entry.output_cost_per_token * 1_000_000,
       cacheReadPer1M: entry.cache_read_input_token_cost ? entry.cache_read_input_token_cost * 1_000_000 : undefined,
       cacheWritePer1M: entry.cache_creation_input_token_cost ? entry.cache_creation_input_token_cost * 1_000_000 : undefined,
     };
   }
   export function calculateCost(model: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number {
     const p = getModelPricing(model);
     if (!p) return 0;
     const inUsd = (usage.inputTokens / 1_000_000) * p.inputPer1M;
     const outUsd = (usage.outputTokens / 1_000_000) * p.outputPer1M;
     const cacheReadUsd = usage.cacheReadTokens && p.cacheReadPer1M ? (usage.cacheReadTokens / 1_000_000) * p.cacheReadPer1M : 0;
     const cacheWriteUsd = usage.cacheWriteTokens && p.cacheWritePer1M ? (usage.cacheWriteTokens / 1_000_000) * p.cacheWritePer1M : 0;
     return inUsd + outUsd + cacheReadUsd + cacheWriteUsd;
   }
   ```
4. **Migrate each adapter** to use the central `getModelPricing` instead of hand-coded prices. Each adapter's `getModelPricing(modelId)` becomes a one-liner forwarding to the central loader.

### 7.3 Validation

```sh
npm -w @anvil/agent-core run build
# unit test the loader
node -e "import('./packages/agent-core/dist/cost.js').then(c => { console.log(c.getModelPricing('claude-sonnet-4-6')); console.log(c.calculateCost('claude-sonnet-4-6', { inputTokens: 1000, outputTokens: 500 })); })"
```

### 7.4 Acceptance

- [ ] `data/model-prices.json` exists in agent-core (committed snapshot)
- [ ] `cost.ts` exposes `getModelPricing` and `calculateCost`
- [ ] Snapshot script runs cleanly
- [ ] Each adapter's `getModelPricing` delegates to the central loader

### 7.5 Rollback

Single-commit revert. Adapters keep their hand-coded prices in the meantime.

### 7.6 Risks

- **Stale prices:** the JSON is a snapshot. Document a refresh cadence (e.g., quarterly + on adding a new model). The script makes refresh a one-liner.
- **Model ID mismatch:** LiteLLM's keys (e.g. `claude-3-5-sonnet-20241022`) may differ from how Anvil internally names models (e.g. `claude-sonnet-4-6`). Ship a small alias table at the loader boundary.
- **JSON import:** `with { type: 'json' }` requires Node ≥20.10. Confirm Anvil's Node baseline.

---

## Phase 8 — Test migration

**Effort:** 0.5d.

### 8.1 Scope

Move tests that exercise agent-core internals from cli to agent-core. Audit `cli/src/providers/__tests__/` (if any), `cli/src/agent/__tests__/` (if any), `knowledge-core/src/__tests__/claude-runner.test.ts`.

### 8.2 Procedure

1. `mkdir -p packages/agent-core/src/__tests__`
2. `git mv` each relevant test file. Update import paths from `../X.js` (relative to old location) to `../X.js` (relative to new location) — usually unchanged because tests live next to source.
3. Update `agent-core/package.json` — confirm `test` script: `"tsc -b && node --test dist/__tests__/*.test.js"`.
4. Update consumer test scripts:
   - cli's per-workspace test script becomes a no-op (pattern from knowledge-core extract Phase 7) since the testable surface moved.
   - knowledge-core's test script keeps running its own tests; the claude-runner test now lives in agent-core.

### 8.3 Validation

```sh
npm -w @anvil/agent-core test       # NEW — should pass
npm -w @anvil/knowledge-core test   # 71/71 still pass (one fewer test file)
npm -w @esankhan3/anvil-cli test    # echo no-op
cd packages/dashboard && node --test server/out/__tests__/*.test.js | tail -5
```

### 8.4 Acceptance

- [ ] All agent-related tests live in `agent-core/src/__tests__/`
- [ ] Total test count across all packages is ≥ pre-refactor count
- [ ] No new test failures

### 8.5 Rollback

Per-test-file revert. Tests are independent.

---

## Phase 9 — Build/CI consolidation

**Effort:** 0.5d.

### 9.1 Native dep dedup

If Phase 4 introduced any vendor SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`), declare them on `agent-core/package.json` only. Remove from cli + knowledge-core if they happened to declare them too. Run `npm install` to regenerate the lockfile.

### 9.2 mcp build verification

mcp's `build.mjs` does file-by-file esbuild without bundling, so `@anvil/agent-core` is imported by name at runtime. Confirm `node_modules/@anvil/agent-core` resolves from inside the mcp dist when tested.

### 9.3 CI matrix

If a CI workflow exists, add `@anvil/agent-core` to:

- The build matrix
- The test matrix
- The lint matrix

(`tsc -b` from root with project references already covers all packages, so root-level CI may not need per-package entries.)

### 9.4 Validation

```sh
rm -rf node_modules package-lock.json
npm install
npm -w @anvil/agent-core run build
npm -w @anvil/agent-core test
npm -w @anvil/knowledge-core test
npm -w @esankhan3/anvil-cli run build
npm -w @esankhan3/code-search-mcp run build
cd packages/dashboard && npx tsc -p server/tsconfig.json && node --test server/out/__tests__/*.test.js | tail -5
```

### 9.5 Acceptance

- [ ] Fresh `npm install` succeeds
- [ ] All build + test gates green
- [ ] Lockfile committed

---

## Phase 10 — Docs + ADR

**Effort:** 0.5d.

### 10.1 Deliverables

1. `packages/agent-core/README.md` — what the package is, public API surface (the legacy `ModelAdapter` interface + the new `LanguageModel` interface, with a note that `LanguageModel` is the forward-looking shape), how to consume it, env vars, cost-table refresh procedure.
2. `AGENT-CORE-ADR.md` — finalized with a "What actually shipped" section listing per-phase commits, deviations from the plan, and any plan corrections.
3. Banner this plan file with a "Shipped" status pointing at the ADR (mirroring the knowledge-core extract pattern).

### 10.2 Acceptance

- [ ] README is enough for a fresh contributor to consume the package
- [ ] ADR documents the legacy/new dual-interface decision and its sunset path

---

## Cross-cutting: validation strategy

After each phase:

1. `npm install` from root (catches lockfile + workspace issues).
2. `tsc --build` from root (catches type errors across project refs).
3. Per-package: `npm -w <name> run build` and `npm -w <name> test`.
4. **Pipeline smoke** (Phases 4+): run a real `anvil run` against a fixture project, with `ANVIL_LLM_MODE=cli` and a known-good Claude binary.
5. **Analytical smoke** (Phase 5+): run `anvil index <fixture>` with `ANVIL_LLM_MODE=none` (skips LLM features) and confirm chunks are produced.

If any check fails, do not advance phases. Fix or roll back.

---

## Cross-cutting: order rationale

| # | Phase | Why this order |
|---|---|---|
| 0 | Audit / decisions | Lock the architecture before any move. |
| 1 | Scaffold + types | Validate package wiring with zero risk. |
| 2 | stream-format hoist | Smallest possible move, validates that the move pattern works. |
| 3 | types + registry | Foundation for adapters; both must be in shared before adapters can be. |
| 4 | 7 adapters | Highest-LOC-per-effort; once these move, cli's `providers/` can be deleted. |
| 5 | claude-runner convergence | Now that adapters are in shared, the analytical shape can wrap them. |
| 6 | agent/ subprocess machinery | After adapters; the machinery is provider-agnostic but conceptually downstream of providers. |
| 7 | Cost table | Adapters are in place; central cost is the next refactor. |
| 8 | Test migration | Move tests now that source is settled. |
| 9 | Build/CI | Native dep dedup is risky enough to deserve its own phase. |
| 10 | Docs | Last so docs reflect what shipped. |

---

## Summary table

| Phase | Effort | LOC moved | LOC written | Risk |
|---|---|---|---|---|
| 0 — Audit | 0.5d | 0 | ~80 (ADR) | low |
| 1 — Scaffold | 0.5d | 0 | ~200 | low |
| 2 — stream-format | 0.5d | ~80 | ~10 | low |
| 3 — types + registry | 1d | ~330 | ~250 (DI bridge) | medium |
| 4 — 7 adapters | 2d | ~3,200 | ~50 | medium |
| 5 — claude-runner converge | 1d | ~330 | ~200 (single-shot wrapper + env aliases) | medium |
| 6 — agent/ machinery | 1d | ~1,450 | ~50 | medium-high |
| 7 — cost table | 0.5d | 0 | ~250 (cost.ts + script + JSON snapshot) | low |
| 8 — Tests | 0.5d | varies | ~50 | low |
| 9 — Build/CI | 0.5d | 0 | ~50 | medium |
| 10 — Docs | 0.5d | 0 | ~250 | low |
| **Total** | **~9d** | **~5,400** | **~1,400** | — |

Plus a 30% risk premium → realistic calendar **~12 days for a solo eng**, or **~10–12 conversation turns** if executed phase-by-phase like the knowledge-core extract.

---

## Failure modes to watch

1. **Breaking the `ModelAdapter` interface during the bridge to `LanguageModel`** silently regresses one of the 7 adapters. Mitigation: keep `ModelAdapter` 100% intact in Phase 3; the bridge is opt-in.
2. **Subprocess spawning post-move loses an env var**. Mitigation: list all 14 LLM env vars in Phase 0 and grep-verify each is read at the same call sites post-move.
3. **`runLLM`'s gemini path** spawns `gemini` binary directly today. Routing it through `gemini-cli-adapter` may introduce subtle semantic differences (different argv shape, different model ID resolution). Mitigation: write a smoke test that runs `runLLM(prompt, system, { provider: 'gemini' })` against a real `gemini` binary before and after Phase 5.
4. **Cost table mismatch** between LiteLLM's model IDs and Anvil's. Mitigation: alias table at the loader.
5. **Process tracking loss** during Phase 5 (Set-of-children + SIGINT/SIGTERM cleanup). Mitigation: hoist the tracking into agent-core's spawn machinery (Phase 6) so it covers every subprocess adapter.
6. **Vendor SDK lock-in creep** — easy to start with `@anthropic-ai/sdk` and end up depending on its `Anthropic.Messages.Stream` type pervasively. Mitigation: confine each SDK behind one adapter file; never let SDK types leak out of the adapter.
7. **`LanguageModel` interface drift** — designing the interface in Phase 1 against current adapters; reality of all 7 may surface needs not anticipated. Acceptable: amend the interface in early Phase 4 if the first migrated adapter forces it; otherwise stable.

---

## Glossary

- **Streaming shape:** `LanguageModel.invokeStream(opts) → AsyncIterable<StreamEvent>`. Used for agentic stages that consume tool calls + text deltas progressively.
- **Single-shot shape:** `LanguageModel.invoke(opts) → Promise<InvokeResult>`. Used for analytical calls (profiling, eval). Default impl drains the stream.
- **Anvil Stream Format:** the NDJSON event format on disk + over pipes. Defined in `stream-format.ts`. Superset of Claude CLI's `--output-format stream-json`.
- **Legacy adapter:** the existing `ModelAdapter` interface in `cli/src/providers/types.ts`. Kept for backwards compat. Bridged to `LanguageModel` via `legacyAdapterToLanguageModel()`.
- **Anvil-LLM env vars:** the `ANVIL_LLM_*` consolidated env var contract introduced in Phase 5. Aliases for old `CODE_SEARCH_LLM_*` names with deprecation warnings.
- **Lock-in surface:** the part of the dependency graph that costs >>1 day to swap. For agent-core: each vendor SDK is its own ~150-LOC adapter; replacement = rewrite that file.
- **Tier:** `agentic` | `function-calling` | `text-only`. Used by `model-router.ts` to enforce that `build`/`validate`/`ship` stages can't run on text-only models.

---

## Appendix A — Proven patterns from the knowledge-core extract

These patterns worked across `KNOWLEDGE-CORE-EXTRACT-PLAN.md` execution and apply directly to this plan:

1. **Bulk-rewrite imports via scoped sed.** Build a sed expression list with both single-quoted and double-quoted string variants, scoped to specific file lists (not globs that survive variable interpolation). Pattern proven across phases 2–6 of the knowledge-core extract.
2. **Verify post-rewrite via grep.** After each sed pass, grep for the old import paths to confirm zero stragglers. Use `-E` for extended regex or escape carefully for BSD vs GNU grep differences.
3. **One commit per phase.** Each phase produces one commit with a structured message (intent, what moved, what merged, validation gates).
4. **Detect dependency-ordering issues early.** If a moved file's deps haven't moved yet, the build will fail. Resolve by either (a) moving the deps first, (b) deferring the file, or (c) introducing a thin shim. The knowledge-core extract used all three; this plan should expect similar adjustments.
5. **Trust `tsc -b` over IDE diagnostics.** IDE may surface false positives during transitions; run `tsc -b` from CLI to verify ground truth.

---

## Appendix B — Env var migration matrix

For Phase 5's deprecation strategy, the full mapping:

| Legacy var | New canonical name | Default | Notes |
|---|---|---|---|
| `CODE_SEARCH_LLM_MODE` | `ANVIL_LLM_MODE` | `cli` | `cli` / `api` / `none` |
| `CODE_SEARCH_LLM_API_KEY` | `ANVIL_LLM_API_KEY` | unset | required for `api` mode |
| `CODE_SEARCH_LLM_PROVIDER` | `ANVIL_LLM_PROVIDER` | `anthropic` | `anthropic` / `openai` / `custom` |
| `CODE_SEARCH_LLM_MODEL` | `ANVIL_LLM_MODEL` | `sonnet` | aliased to a specific version by the adapter |
| `CODE_SEARCH_LLM_BASE_URL` | `ANVIL_LLM_BASE_URL` | unset | for OpenAI-compat custom endpoints |
| `CODE_SEARCH_CLAUDE_BIN` | `ANVIL_CLAUDE_BIN` | `claude` | path to claude CLI |
| `ANVIL_AGENT_CMD` | `ANVIL_CLAUDE_BIN` | (alias) | already cli-side; consolidate |
| `FF_AGENT_CMD` | `ANVIL_CLAUDE_BIN` | (alias) | legacy "feature factory" name |
| `CLAUDE_BIN` | `ANVIL_CLAUDE_BIN` | (alias) | unscoped legacy |
| `GEMINI_BIN` | `ANVIL_GEMINI_BIN` | `gemini` | |
| `GEMINI_CLI_BIN` | `ANVIL_GEMINI_BIN` | (alias) | |
| `OPENAI_API_KEY` | `ANVIL_OPENAI_API_KEY` | unset | OpenAI directly; conventional name kept as alias |
| `OPENAI_BASE_URL` | `ANVIL_OPENAI_BASE_URL` | unset | |
| `OPENROUTER_API_KEY` | `ANVIL_OPENROUTER_API_KEY` | unset | |
| `OPENROUTER_BASE_URL` | `ANVIL_OPENROUTER_BASE_URL` | unset | |
| `ANTHROPIC_API_KEY` | `ANVIL_ANTHROPIC_API_KEY` | unset | conventional name kept as alias |
| `GEMINI_API_KEY` | `ANVIL_GOOGLE_API_KEY` | (alias) | |
| `GOOGLE_API_KEY` | `ANVIL_GOOGLE_API_KEY` | (alias) | |
| `OLLAMA_HOST` | `ANVIL_OLLAMA_HOST` | `http://localhost:11434` | |

Resolution order in every case: `ANVIL_*` → legacy alias(es) → default. Emit a `[anvil-llm] DEPRECATED: $LEGACY_VAR is set without $ANVIL_VAR. Migrate by 1.0.` warning to stderr if a legacy var is set without its canonical counterpart.
