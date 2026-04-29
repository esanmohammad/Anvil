# Agent-core LLM Router — Extraction Plan

> Companion to [`AGENT-CORE-LLM-ROUTER-ADR.md`](./AGENT-CORE-LLM-ROUTER-ADR.md). Locks the decisions, public API migration table, config schema, and per-phase commit log.
>
> **Status:** draft 2026-04-29.
> **Depends on:** `@anvil/agent-core` (shipped — `ProviderRegistry`, `ModelAdapter`, `FallbackAdapter`, `cost.ts`, `instrumentModelAdapter`), `@anvil/memory-core` (shipped — SQLite storage primitives reused by the spend ledger).

---

## 1. Pre-flight reality check (verified 2026-04-29)

| Check | Result |
|---|---|
| `packages/agent-core/src/registry.ts` exists | ✅ — `ProviderRegistry` singleton, regex-based routing |
| `packages/agent-core/src/fallback-adapter.ts` exists | ✅ — single `maxRetries`, no per-error policy |
| `packages/agent-core/src/cost.ts` exists with vendored LiteLLM table | ✅ |
| `packages/agent-core/src/telemetry/instrument.ts` wraps `ModelAdapter.run()` | ✅ — wraps **below** retries today |
| Per-error retry / rate-limit / spend-ledger / circuit-breaker | ❌ none of these exist |
| Two contracts coexist (`ModelAdapter.run()`, `LanguageModel.invoke()`) | ✅ — `run()` is canonical for 7 adapters; `invoke()` zero-implementer today |
| Headless `runAgent` requires caller-injected `LanguageModel` | ✅ — `headless/runner.ts:45-49` |

No reconciliation needed before Phase 0.

---

## 2. Why this is the architectural one

LLM routing today is keyword-match (regex on model id) plus a chain-of-tries fallback wrapper. Every operational concern — rate limits, spend caps, per-error retry, circuit breakers, observability of route decisions — is either missing or reinvented per-call site. The fix is one router that owns those concerns; everything else stays as-is.

The reference impl is **LiteLLM Proxy** (Apache-2.0 BerriAI). Anvil adopts the design verbatim except the runtime: TS in-process, no Python sidecar, no external state.

---

## 3. Decisions (deferred to ADR)

The full decision matrix lives in `AGENT-CORE-LLM-ROUTER-ADR.md`. Headlines:

- **R1** — Router lives at `packages/agent-core/src/router/`, sits *above* `ProviderRegistry`, *below* `instrumentModelAdapter` (so retries become sibling spans).
- **R2** — Per-error retry policy table; declarative; per-error class.
- **R3** — Token-bucket rate limit per provider, optionally cross-process via SQLite file lock.
- **R4** — Spend ledger persists in SQLite (matches `memory-core` storage decision); per-tag aggregation; daily/per-run caps.
- **R5** — YAML route config at `~/.anvil/llm-router.yaml` with hard-coded defaults if absent.
- **R6** — Circuit breaker per provider — closed → open → half-open with cooldown.
- **R7** — Caller-tag-based dispatch (`router.invoke({ tag: 'code-gen', ... })`); raw `model: '<id>'` still works for callers that don't migrate.
- **R8** — `FallbackAdapter` deprecated but kept as a no-op shim until callers migrate.
- **R9** — Cost calculation stays in `cost.ts`; router invokes it post-call.
- **R10** — OTel attributes for route decisions: `anvil.router.route_id`, `anvil.router.attempt`, `anvil.router.error_class`, `anvil.router.fallback_index`, `anvil.router.budget_remaining_usd`.

---

## 4. Public API migration table

| Surface | Today | After |
|---|---|---|
| `new FallbackAdapter([a, b], 3, 2000)` | works, single retries knob | works (no-op shim — internally builds a `LlmRouter` with retry policy `default`) |
| `registry.resolveFromModelId('gpt-4o')` | works | works (unchanged — Registry is a sub-component of Router) |
| `adapter.run(config, stream)` | works | works (Router calls this; OTel wraps Router) |
| New: `router.invoke({ tag, prompt, ... })` | — | tag-driven dispatch; reads YAML config |
| New: `router.spend({ runId, project }).get()` | — | spend ledger query API |

---

## 5. Schema shapes (TS, locked verbatim in ADR §4)

```ts
export type ErrorClass =
  | 'rate_limit'      // 429
  | 'timeout'         // wall-clock or socket
  | 'server_5xx'      // 500-599
  | 'auth'            // 401/403
  | 'content_policy'  // provider safety filter
  | 'invalid_request' // 400 client error
  | 'unknown';

export interface RetryPolicy {
  attempts: number;            // 0 = no retry
  backoff: 'exponential' | 'linear' | 'constant';
  baseMs: number;
  maxMs?: number;              // ceiling for exponential
  jitter?: boolean;            // default true
}

export interface RouteConfig {
  tag: string;                  // 'code-gen', 'planner', etc.
  primary: string;              // model id
  fallbacks?: Array<{
    model: string;
    on?: ErrorClass[];          // restrict to these classes; undefined = any retryable
  }>;
}

export interface BudgetConfig {
  dailyUsd?: number;
  perRunUsd?: number;
  perTagUsd?: Record<string, number>;
  onBreach: 'fail' | 'downgrade' | 'queue';
}

export interface CircuitBreakerConfig {
  failureThreshold: number;     // open after N consecutive failures
  cooldownMs: number;           // half-open after this window
  halfOpenAttempts: number;     // probes during half-open
}

export interface RouterConfig {
  routes: RouteConfig[];
  retryPolicy: Record<ErrorClass, RetryPolicy>;
  rateLimit?: Record<string, { rpm?: number; tpm?: number }>; // per-provider
  budgets?: BudgetConfig;
  circuitBreaker?: CircuitBreakerConfig;
}

export interface InvokeOpts {
  tag: string;
  prompt: string | Array<{ role: 'system'|'user'|'assistant'; content: string }>;
  runId?: string;
  project?: string;
  user?: string;
  // … rest matches LanguageModelInvokeOptions
}

export interface RouteAttempt {
  model: string;
  provider: string;
  attemptIndex: number;          // 0-based within the route
  fallbackIndex: number;         // 0 = primary, N = N-th fallback
  errorClass?: ErrorClass;
  durationMs: number;
  costUsd?: number;
}

export interface RouteOutcome {
  result?: InvokeResult;          // present on success
  error?: Error;                  // present on terminal failure
  attempts: RouteAttempt[];
  totalDurationMs: number;
  totalCostUsd: number;
  budgetRemainingUsd?: number;
}
```

---

## Phase 0 — Audit + decisions (no code change)

**Effort:** 0.5d.

### 0.1 What changes

Lock the decision matrix in `AGENT-CORE-LLM-ROUTER-ADR.md`. Verify the pre-flight checklist (§1). Snapshot today's `FallbackAdapter` behavior (one knob `maxRetries`, fixed delay) so the migration spec is concrete.

### 0.2 Procedure

1. Create `AGENT-CORE-LLM-ROUTER-ADR.md` with §1 pre-flight, §2 decisions R1–R10, §3 persistence inventory (`~/.anvil/router/spend.sqlite`, `~/.anvil/llm-router.yaml`), §4 schema shapes, §5 external importer list (every cli call site that uses `FallbackAdapter`), §6 per-phase commit log scaffold.
2. Greenfield `packages/agent-core/src/router/` directory remains *un-created* until Phase 1.

### 0.3 Validation

```sh
# ADR exists and lints
test -f AGENT-CORE-LLM-ROUTER-ADR.md
# pre-flight items still hold
grep -l 'class FallbackAdapter' packages/agent-core/src/fallback-adapter.ts
```

### 0.4 Acceptance

- [ ] ADR written, R1–R10 each have a one-line `Why`
- [ ] Pre-flight checklist verified
- [ ] Schema shapes (§5) typed in ADR

### 0.5 Rollback

Revert the ADR commit.

---

## Phase 1 — Scaffold `router/` module + types

**Effort:** 0.5d.

### 1.1 What changes

Create `packages/agent-core/src/router/` with the canonical types from §5 and a stub `LlmRouter` class that compiles + smoke-tests but contains no logic yet. Wire the new module into `packages/agent-core/src/index.ts` exports.

### 1.2 Procedure

1. `mkdir packages/agent-core/src/router/`
2. New files:
   - `types.ts` — paste §5 schemas verbatim
   - `errors.ts` — `RouterError` class + `classifyError(err): ErrorClass` initial impl (heuristic over Error.message + `.status` + `.code`)
   - `router.ts` — `LlmRouter` skeleton with `invoke(opts): Promise<RouteOutcome>` that throws `'not implemented'`
   - `index.ts` — barrel
3. Export from `packages/agent-core/src/index.ts`.
4. Add 3 smoke tests: import shape, type round-trips, error classifier table.

### 1.3 Validation

```sh
npm -w @anvil/agent-core run build
npm -w @anvil/agent-core test
```

### 1.4 Acceptance

- [ ] `LlmRouter` class exported
- [ ] `classifyError` recognizes `429 → rate_limit`, `5xx → server_5xx`, `401/403 → auth`, `'timeout' in message → timeout`, otherwise `unknown`
- [ ] memory-core 119/119, agent-core baseline still green

### 1.5 Rollback

Per-commit. Module is not yet wired into any call site.

### 1.6 Risks

- **Type drift between `LlmRouter` and existing `LanguageModel`:** mitigation — `InvokeOpts` extends `LanguageModelInvokeOptions` with extra dispatch metadata.

---

## Phase 2 — Per-error retry policy engine

**Effort:** 1d.

### 2.1 What changes

Implement the retry loop driven by `RetryPolicy` per `ErrorClass`. Single-adapter scope only — no fallback chain yet.

### 2.2 Procedure

1. `router/retry.ts` — `runWithRetry(fn, policy): Promise<{result, attempts}>` with exponential / linear / constant backoff + jitter.
2. `LlmRouter.invoke` invokes one adapter under `runWithRetry`. Reads `RetryPolicy` from `RouterConfig.retryPolicy[errorClass]`.
3. **Auth + content-policy = `attempts: 0`** by default — short-circuits the retry loop, surfaces error to caller immediately.
4. Default policy table (locked in ADR R2):
   ```ts
   {
     rate_limit:       { attempts: 5, backoff: 'exponential', baseMs: 1000, maxMs: 30000 },
     timeout:          { attempts: 3, backoff: 'linear',      baseMs: 500,  maxMs: 5000  },
     server_5xx:       { attempts: 4, backoff: 'exponential', baseMs: 200,  maxMs: 5000  },
     auth:             { attempts: 0, backoff: 'constant',    baseMs: 0 },
     content_policy:   { attempts: 0, backoff: 'constant',    baseMs: 0 },
     invalid_request:  { attempts: 0, backoff: 'constant',    baseMs: 0 },
     unknown:          { attempts: 1, backoff: 'constant',    baseMs: 1000 },
   }
   ```
5. Honor `Retry-After` header when present (parse from `err.headers['retry-after']` or attached metadata).

### 2.3 Validation

Tests:
- 429 → 5 attempts, exponential delays, eventual success returns
- 401 → 0 retries, throws immediately
- 5xx 3 times then success — succeeds on attempt 4
- `Retry-After: 2` honored over computed backoff

### 2.4 Acceptance

- [ ] `runWithRetry` covers all 7 error classes
- [ ] `Retry-After` honored
- [ ] No retry on `auth` / `content_policy` / `invalid_request`
- [ ] All tests pass deterministically (use injected clock for backoff)

### 2.5 Rollback

Per-commit. Engine is opt-in via `LlmRouter.invoke`; nothing else calls it yet.

### 2.6 Risks

- **Provider-specific error shapes:** `classifyError` is best-effort. Mitigation — adapter-specific overrides registered via `RouterConfig.errorClassifiers[provider]`.

---

## Phase 3 — Token-bucket rate limiter

**Effort:** 1d.

### 3.1 What changes

Per-provider RPM (requests/min) + TPM (tokens/min) rate limit. In-process by default; cross-process via SQLite advisory file when `RouterConfig.rateLimit.crossProcess === true`.

### 3.2 Procedure

1. `router/rate-limiter.ts` — token-bucket impl. Bucket per `(provider, scope)` where scope is `'rpm' | 'tpm'`.
2. **Pre-flight check** before each `LlmRouter.invoke` attempt: `await rateLimiter.acquire(provider, estimatedTokens)`. If bucket dry, return → caller decides via `RouterConfig.onRateLimit: 'wait' | 'fallback' | 'fail'` (default `wait`).
3. **Cross-process mode** (off by default): SQLite table `rate_bucket(provider, scope, tokens, refilled_at)` + `BEGIN IMMEDIATE` advisory. Reuses memory-core's `better-sqlite3` dependency.
4. Hard-coded defaults per ADR R3 — Anthropic Sonnet 50 RPM / 80k TPM, OpenAI GPT-4o 500 RPM / 30k TPM, etc. Override via `RouterConfig.rateLimit`.

### 3.3 Validation

Tests:
- 100 concurrent invokes against bucket of 10 RPM — 90 wait, 10 succeed-immediate
- Bucket refills over time (deterministic clock)
- Cross-process: 2 fake processes share a SQLite bucket; combined throughput ≤ limit

### 3.4 Acceptance

- [ ] In-process limiter passes 4 tests above
- [ ] Cross-process mode is opt-in and documented
- [ ] Default limits match published provider docs as of 2026-04-29

### 3.5 Risks

- **Default limits drift:** providers update RPM/TPM quarterly. Mitigation — ship a refresh script that pulls from LiteLLM's published tables (same approach as `cost.ts`).

---

## Phase 4 — Spend ledger (SQLite)

**Effort:** 1d.

### 4.1 What changes

Persistent ledger for every router-mediated call. Schema lives at `~/.anvil/router/spend.sqlite`.

### 4.2 Procedure

1. `router/spend-ledger.ts` — class wrapping a `better-sqlite3` connection.
2. Schema (locked in ADR §4):
   ```sql
   CREATE TABLE IF NOT EXISTS spend (
     id TEXT PRIMARY KEY,
     ts TEXT NOT NULL,
     run_id TEXT,
     project TEXT,
     user TEXT,
     tag TEXT NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     input_tokens INTEGER NOT NULL,
     output_tokens INTEGER NOT NULL,
     cache_read_tokens INTEGER NOT NULL DEFAULT 0,
     cache_write_tokens INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL NOT NULL,
     duration_ms INTEGER NOT NULL,
     fallback_index INTEGER NOT NULL DEFAULT 0,
     attempt_count INTEGER NOT NULL DEFAULT 1
   );
   CREATE INDEX idx_spend_run ON spend(run_id, ts);
   CREATE INDEX idx_spend_project ON spend(project, ts);
   CREATE INDEX idx_spend_tag ON spend(tag, ts);
   ```
3. `LlmRouter` writes one row per terminal outcome (success or final failure).
4. Query API: `ledger.totalUsd({ runId?, project?, tag?, since? })`, `ledger.recent({ limit })`.
5. Pre-flight budget enforcement: before invoke, compute remaining budget from ledger; if exhausted, apply `BudgetConfig.onBreach` (default `'fail'`).

### 4.3 Validation

- Ledger round-trips a synthetic 1000-call sequence
- `totalUsd({ runId: 'r1' })` matches sum of inputs
- Budget breach triggers the configured behavior (`fail`/`downgrade`/`queue`)

### 4.4 Acceptance

- [ ] One row per call, including failed calls (`cost_usd = 0`)
- [ ] Budget pre-flight + post-flight both implemented
- [ ] Schema migration is idempotent (same `ALTER TABLE IF NOT EXISTS` pattern as memory-core Phase 5)

### 4.5 Risks

- **Pre-flight estimation bias:** TPM check uses estimated tokens; underestimate → over-spend by one call. Mitigation — log estimation error post-flight; tune defaults.

---

## Phase 5 — Fallback chain with degradation rules

**Effort:** 1d.

### 5.1 What changes

Replace `FallbackAdapter` semantics with router-driven fallback walks. Per-error fallback gates (`on: ['rate_limit', 'server_5xx']`) — content-policy errors *never* fall back to a different provider.

### 5.2 Procedure

1. `LlmRouter.invoke` builds attempt sequence: primary (with retry policy) → fallback[0] (with retry policy) → fallback[N] until success or chain exhausted.
2. Each fallback declares which `ErrorClass`es trigger it. Default rules per ADR R5:
   - `rate_limit` → next-tier-down model (Sonnet → Haiku) before cross-provider
   - `server_5xx` / `provider_down` → cross-provider (Anthropic → OpenAI → Gemini)
   - `auth` / `content_policy` / `invalid_request` → never fallback (surfaces immediately)
3. Each fallback step gets its own `RouteAttempt` recorded in `RouteOutcome.attempts`.
4. **Spend rule:** every attempt — including failed ones that incurred cost — is ledgered.

### 5.3 Validation

Synthetic provider matrix:
- Sonnet → 429 → Haiku succeeds: `attempts.length === 2`, both ledgered
- Sonnet → 401 → terminal: `attempts.length === 1`, no fallback walk
- All providers down → throws aggregate `RouterError` with full attempt history

### 5.4 Acceptance

- [ ] Fallback walks honor per-class gates
- [ ] Content-policy errors never trigger cross-provider fallback (security default)
- [ ] Aggregate error includes every attempt's classification

### 5.5 Risks

- **Cost surprise from fallback walks:** ten provider hops at $0.05 each = $0.50 a single call. Mitigation — per-call hard cap `RouterConfig.maxFallbackCostUsd` (default 1.0).

---

## Phase 6 — Circuit breaker per provider

**Effort:** 0.5d.

### 6.1 What changes

Closed → Open → Half-Open per provider; trip on N consecutive non-retryable failures within window; cooldown then probe.

### 6.2 Procedure

1. `router/circuit-breaker.ts` — state machine per provider, in-memory only (cross-process is overkill).
2. Defaults per ADR R6: `failureThreshold: 5`, `cooldownMs: 30_000`, `halfOpenAttempts: 1`.
3. Open state → all calls to that provider fall straight to fallback chain without attempting.
4. Half-open → 1 probe call decides: success closes, failure re-opens with longer cooldown.

### 6.3 Validation

- 5 consecutive 5xx → opens; next call skips that provider
- 30s wait → half-open probe; if success → closed; if fail → open with `2 * cooldownMs`

### 6.4 Acceptance

- [ ] State transitions deterministic under injected clock
- [ ] Probe semantics match standard CB pattern (Hystrix / resilience4j)

---

## Phase 7 — YAML route config

**Effort:** 0.5d.

### 7.1 What changes

Routes, policies, budgets, rate limits, breaker config — all readable from `~/.anvil/llm-router.yaml`. Hard-coded defaults if absent.

### 7.2 Procedure

1. `router/config-loader.ts` — `loadRouterConfig(path?): RouterConfig`. Search order:
   1. `process.env.ANVIL_ROUTER_CONFIG` if set
   2. `<workspace>/.anvil/llm-router.yaml`
   3. `~/.anvil/llm-router.yaml`
   4. compiled-in defaults
2. Pulls `js-yaml` as a new dep (light, MIT, already in tree somewhere — check before adding).
3. `${env:VAR}` substitution for API keys / tenant tokens (matches MCP config-loader pattern from agent-harness).

### 7.3 Validation

Sample config in `packages/agent-core/test-fixtures/router/sample.yaml`; loader round-trips it; missing-file path returns defaults.

### 7.4 Acceptance

- [ ] Config schema documented
- [ ] Search-order fallback works
- [ ] Default config compiles in (no required external file)

---

## Phase 8 — OTel telemetry repositioning + spend export

**Effort:** 0.5d.

### 8.1 What changes

Move `instrumentModelAdapter` wrap to be *above* the router so retry attempts become sibling spans, not nested under one parent span. New attributes per ADR R10.

### 8.2 Procedure

1. New `router/telemetry.ts` — wraps `LlmRouter.invoke` in a parent span (`anvil.router.invoke`); each `RouteAttempt` is a child span (`anvil.router.attempt`).
2. Existing `instrumentModelAdapter` keeps wrapping `ModelAdapter.run()` — those become grandchildren.
3. Span attributes: `anvil.router.route_id`, `anvil.router.attempt`, `anvil.router.error_class`, `anvil.router.fallback_index`, `anvil.router.budget_remaining_usd`, `anvil.router.circuit_breaker_state`.
4. Spend ledger entries link back to the parent span via `traceId`.

### 8.3 Validation

Synthetic in-memory exporter assertion: 1 router call with 3 retries + 1 fallback = 1 parent span + 4 child spans + 4 grandchild spans (the actual HTTP calls).

### 8.4 Acceptance

- [ ] Parent/child relationship correct
- [ ] All R10 attributes present
- [ ] OTel test count remains green (no regressions in agent-core 81/81)

---

## Phase 9 — `FallbackAdapter` shim + caller migration

**Effort:** 0.5d.

### 9.1 What changes

`FallbackAdapter` becomes a no-op shim that internally constructs an `LlmRouter` with the supplied chain wrapped as an ad-hoc route. Callers using `FallbackAdapter([a, b])` keep working unchanged.

### 9.2 Procedure

1. `fallback-adapter.ts` rewritten — preserves public API, body delegates to `LlmRouter`.
2. Deprecation comment + `@deprecated` JSDoc.
3. Audit external callers: every spot that constructs `new FallbackAdapter(...)`. Migrate cli pipeline + headless runner to call `LlmRouter.invoke({tag,...})` directly.

### 9.3 Validation

- Existing tests that use `FallbackAdapter` still pass
- New router-direct call sites have parity with the old behavior

### 9.4 Acceptance

- [ ] All `FallbackAdapter` callers either migrated or shimmed
- [ ] No behavior regression in cli pipeline runs

### 9.5 Risks

- **Hidden caller in dashboard server:** dashboard-server.ts has 6605 LOC of routes; some may instantiate `FallbackAdapter` directly. Mitigation — `git grep -n 'new FallbackAdapter'` before shim lands, audit each.

---

## Phase 10 — Tests + docs + ADR finalize

**Effort:** 0.5d.

### 10.1 What changes

End-to-end smoke: 1 cli pipeline run with router enabled; verify spend ledger row count, retry attempts visible in trace, fallback chain walked at least once. README updated with router architecture diagram.

### 10.2 Procedure

1. `packages/agent-core/README.md` gains a "LLM Router" section: pipeline diagram, config example, spend query example, env var reference.
2. ADR §6 finalized with per-phase commit log (mirrors `MEMORY-CORE-ADR.md §8`).
3. `npm -w @anvil/agent-core test` ≥ 100 tests (today's 81 + ~20 router tests).

### 10.3 Acceptance

- [ ] README has 6 sections from ADR R10
- [ ] ADR §6 fully populated
- [ ] All gates green (memory-core 119, agent-core ≥100, knowledge-core 62, cli/dashboard/mcp builds)

---

## Cross-cutting validation strategy

After each phase:

1. `npm -w @anvil/agent-core run build` — type-check
2. `npm -w @anvil/agent-core test` — unit + integration
3. `npm -w @esankhan3/anvil-cli run build` — cli stays green (caller compat)
4. Smoke: simulated 100-call sequence against fake providers; verify spend ledger row count + sum

---

## Cross-cutting order rationale

| # | Phase | Why this order |
|---|---|---|
| 0 | Audit + decisions | Lock R1–R10 before code |
| 1 | Scaffold | Types come first; phases 2–6 depend on them |
| 2 | Retry engine | Standalone — usable immediately |
| 3 | Rate limiter | Prereq for budget enforcement timing |
| 4 | Spend ledger | Prereq for budget enforcement decisions |
| 5 | Fallback chain | Builds on retry + ledger |
| 6 | Circuit breaker | Sits across the fallback chain |
| 7 | YAML config | Now there's something worth configuring |
| 8 | OTel reposition | All the new layers are in place; rewire spans once |
| 9 | Shim + migration | Last — backwards compat before deprecation |
| 10 | Docs + ADR finalize | Standard close-out |

**Total effort:** ~7d. **Total LOC delta:** +1500 router/, –200 from `FallbackAdapter` simplification, ~+800 tests. Net ~+2100 LOC, all in one new module.

---

## Out of scope / known follow-ups

1. **Hosted gateway (Option C in analysis)** — LiteLLM proxy or OpenRouter as backend. Not in this plan; `LlmRouter` could front one in a future phase by treating it as a single "provider" with built-in fallback.
2. **LLM-driven routing** — picking model based on prompt complexity classification. Out of scope.
3. **Streaming-aware fallback** — today's fallback walk is per-call; mid-stream provider failure is harder. Out of scope; surfaces as terminal error today.
4. **Multi-tenant virtual keys (Portkey-style)** — per-user API key abstraction with quotas. Defer until Anvil has a real multi-tenant story.
5. **Embeddings + image-gen routing** — same router shape applies but covers different cost tables. Defer until embedding-driven workflows materialize (memory-core Phase 8 vector retrieval).
