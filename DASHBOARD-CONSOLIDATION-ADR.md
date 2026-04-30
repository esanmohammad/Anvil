# Dashboard Consolidation — Architecture Decision Record

> Companion to [`DASHBOARD-CONSOLIDATION-PLAN.md`](./DASHBOARD-CONSOLIDATION-PLAN.md). Locks decisions D1–D10, parallel-impl inventory, public API migration table, schema shapes, and per-phase commit log.
>
> **Status:** draft — locked at Phase 0.
> **Depends on:** `@anvil/agent-core`, `@anvil/memory-core`, `@anvil/knowledge-core`, `@anvil/core-pipeline` (all shipped).

---

## 1. Pre-flight reality check (verified 2026-04-29)

| Check | Result |
|---|---|
| `dashboard-server.ts` exists, **6,601 LOC** | ✅ |
| `pipeline-runner.ts` exists, **3,315 LOC** | ✅ — second orchestrator, parallel to cli's |
| Dashboard imports from `@anvil/agent-core` | ❌ — zero |
| Dashboard imports from `@anvil/memory-core` | ❌ — zero |
| Dashboard imports from `@anvil/core-pipeline` | ❌ — zero |
| Dashboard imports from `@anvil/knowledge-core` | ✅ — wired in `b103dae` (graph build path only) |
| `~/.anvil/state.json` polling is the only cross-process pipeline observation point | ✅ |
| Dashboard's adapter family has its own `BaseAdapter` (EventEmitter) — shape differs from agent-core's `LanguageModel` | ✅ |
| Dashboard's `cost-*.ts` cluster (~900 LOC, NDJSON-backed) parallels agent-core's `SpendLedger` (SQLite-backed) | ✅ |
| Dashboard's `memory-store.ts` is Hermes-style markdown — different paradigm from memory-core's SQLite | ✅ — **will be replaced** (D6 flipped 2026-04-29) |
| Dashboard's `pipeline-learner.ts` reproduces cli's dead `autoLearnHook` for dashboard runs | ✅ |
| `DASHBOARD-CONSOLIDATION-ADR.md` does NOT exist yet | ✅ → this file |

---

## 2. Decisions

### D1 — Direction of integration
**Choice:** Dashboard becomes a **consumer** of the four `@anvil/*` packages. No code moves into the dashboard package; consolidation lands by replacing dashboard impls with package imports + thin shims.
**Why:** packages were extracted to be reused. Reversing the direction (moving more code into dashboard) defeats the extraction.

### D2 — Adapter contract unification
**Choice:** Adapter unification on `agent-core`'s `LanguageModel`. Dashboard's `BaseAdapter` (EventEmitter) keeps its event-emit shape via a bridge that wraps a `LanguageModel`. Translates `InvokeUsage` → `AdapterCostInfo`, `StreamEvent` → dashboard's text/tool-use events. Cutover is full: the legacy local-impl adapters are deleted in the same PR that lands the bridge.
**Why:** dashboard's `AgentManager` / `AgentProcess` consume the EventEmitter shape from many call sites (~50). Replacing the consumer surface is a much bigger change than bridging the producer. The bridge is one file; the consumer surface is dozens.

### D3 — Pipeline state observation
**Choice:** Dashboard subscribes directly to `core-pipeline`'s `EventBus` when running in-process with the cli (e.g. dashboard launches the pipeline itself). State-file polling is kept as a fallback for cross-process deployments — that path stays read-only in the dashboard.
**Why:** in-process bus is structured + push-driven; state-file polling is unstructured + pull-driven. Both have valid use cases (single-process, cross-process). D3 is additive.

### D4 — Cost ledger storage
**Choice:** Dashboard's `CostLedger` (NDJSON) and `agent-core`'s `SpendLedger` (SQLite) **stay separate**. A bridge mirrors `record()` calls in both directions so either system's reads see all writes. Storage merge is out of scope.
**Why:** dashboard's NDJSON is per-run + daily-rollup; router's SQLite is queryable + indexed for reporting. Both are well-suited to their primary readers. Merging means picking one and porting all queries — large effort for small win.

### D5 — pipeline-runner feature lift
**Choice:** Dashboard's pipeline-runner.ts features (per-repo parallelism, FeatureStore, manifests, plan-risk scoring, engineer-task bundling, interactive WebSocket clarify, cost-budget enforcement) lift into `Step<I, O>` implementations under `packages/core-pipeline/src/steps/dashboard/`. Once hoisted they become reusable from cli too.
**Why:** these aren't dashboard-only concerns; they're orchestration features that any caller (cli, dashboard, future tooling) benefits from. Hoisting them into core-pipeline as Steps avoids the parallel-implementation trap that knowledge-core hit before the b103dae fix.

### D6 — Memory-store migration
**Choice:** Dashboard's `memory-store.ts` (329 LOC, Hermes-style markdown) is **replaced** by `@anvil/memory-core`. Dashboard reads/writes through memory-core's `SqliteHotIndex` + namespace API. Existing `~/.anvil/memories/<project>/{MEMORY.md,USER.md}` files are migrated once via memory-core's `migrate/` importer on first launch and then archived to `~/.anvil/memories/_archive_<ts>/`. Markdown files are no longer the source of truth.
**Why (revised 2026-04-29):** the user wants structured memory across cli + dashboard rather than two parallel paradigms. Dashboard's two-bucket markdown surface (`memory` / `user`) maps cleanly onto memory-core's `MemoryKind` taxonomy (`semantic` / `procedural` for `memory`; `semantic.preference` for `user`). The dashboard's WebSocket API (`memory:add` / `memory:replace` / `memory:remove`) keeps its existing payload shapes per D10 — only the storage backend changes.
**How to apply:** the dashboard's `MemoryStore` class is rewritten as a thin façade over memory-core that preserves the 5 operations consumed today (`add`, `replace`, `remove`, `getEntriesWithMeta`, `formatForPrompt`). `formatForPrompt` becomes a memory-core retrieve query (BM25 over the project's namespace, sorted by `addedAt`).

### D7 — Auto-learn wiring
**Choice:** Dashboard's `pipeline-learner.ts` becomes a `learners.hook` subscriber on the core-pipeline bus. The hook's callback invokes the dashboard's existing learner functions (`recordFixPattern`, `recordSuccess`, `recordApproach` — all in `pipeline-learner.ts`). Replaces cli's dead `autoLearnHook` for dashboard-driven runs.
**Why:** core-pipeline's `attachLearnersHook` is the canonical seam. Dashboard's `pipeline-learner.ts` already has the markdown-aware learner functions; no rewrite needed — only the trigger source changes from inline pipeline-runner calls to bus events.

### D8 — Migration strategy
**Choice:** No feature flags. Each phase is a full cutover landed as its own PR after parity testing on a release branch. Legacy code is deleted in the same PR that introduces the replacement. Phases are still sequential and independently revertable (rollback = `git revert`), but the running system never carries dual code paths.
**Why:** the user has decided this lands as a fresh release after extensive testing, not as a gradual rollout to a live audience. Flag plumbing would add code that gets deleted anyway, complicate every call site with two branches, and obscure parity issues that only surface when the legacy fallback is gone. Branch-level QA replaces flag-gated production parallel-running.
**How to apply:** treat each phase's PR as the single switching point. Before merging: run the dashboard fixture pipeline against `main` and the phase branch, diff the WebSocket transcript + audit JSONL + cost ledger output, fix any deltas before merge. Ship phases one at a time on the release branch; cut a single tagged release once Phase 6 lands.

### D9 — No new shared package
**Choice:** All consolidation lands in existing packages (`@anvil/agent-core`, `@anvil/core-pipeline`). No new `@anvil/dashboard-shared` or similar.
**Why:** the only thing that would justify a new package is shared types between dashboard server + dashboard React UI. Those already live in `dashboard/src/` with type-only imports — no runtime sharing needed.

### D10 — WebSocket protocol invariant
**Choice:** The dashboard's 133 WebSocket message types **keep their existing payload shapes** through the migration. New messages may be added; existing ones do not change.
**Why:** dashboard's React client + any third-party consumers depend on the protocol. Breaking it forces a synchronized client update.

---

## 3. Parallel-implementation inventory

| Path | LOC | Dashboard role | Maps to | Phase |
|---|---:|---|---|---|
| `dashboard/server/adapters/base-adapter.ts` | 176 | EventEmitter contract + AdapterCapabilities | `agent-core/types.ts:LanguageModel` | 1 |
| `dashboard/server/adapters/claude-adapter.ts` | 267 | Claude CLI invocation | `agent-core/claude-adapter.ts` (different shape) | 1 |
| `dashboard/server/adapters/gemini-cli-adapter.ts` | 132 | Gemini CLI invocation | `agent-core/gemini-cli-adapter.ts` | 1 |
| `dashboard/server/adapters/api-adapter.ts` | 278 | OpenRouter / OpenAI / Gemini API | `agent-core/openai-adapter.ts` etc. | 1 |
| `dashboard/server/adapters/adapter-factory.ts` | 92 | Heuristic provider routing | `agent-core/registry.ts:ProviderRegistry` | 1 |
| `dashboard/server/agent-runner-wrapper.ts` | 189 | **Checkpoint cache** — orthogonal to agent-core | unchanged | n/a |
| `dashboard/server/agent-manager.ts` | 444 | Process lifecycle + WS broadcast | unchanged (consumer of bridge) | 1 (consumer) |
| `dashboard/server/agent-process.ts` | 120 | child_process spawn helper | unchanged | n/a |
| `dashboard/server/cost-ledger.ts` | 226 | Per-run NDJSON | bridge to `agent-core/router/SpendLedger` | 3 |
| `dashboard/server/cost-pricing.ts` | 85 | Provider price table | overlaps `agent-core/data/model-prices.json` | 3 |
| `dashboard/server/cost-types.ts` | 101 | CostEntry shape | overlaps `agent-core/router/types.ts:SpendRow` | 3 |
| `dashboard/server/cost-breach-handler.ts` | 389 | Per-stage budget gating | will become hook subscriber | 4 |
| `dashboard/server/cost-breach-sweeper.ts` | 91 | Background sweep | unchanged | n/a |
| `dashboard/server/pipeline-runner.ts` | 3,315 | **Second orchestrator** | decomposed into `Step`s | 4 |
| `dashboard/server/pipeline-audit-log.ts` | 227 | JSONL writer | replaced by `attachAuditLogHook` | 4 |
| `dashboard/server/pipeline-approval-tokens.ts` | 143 | Approval gate tokens | becomes Step + hook | 4 |
| `dashboard/server/pipeline-learner.ts` | 139 | Auto-learn helpers | wired via `attachLearnersHook` | 4 |
| `dashboard/server/memory-store.ts` | 329 | Hermes-style MD store | **replaced** by memory-core façade (D6) | 5 |

**Total in scope:** ~6,000 LOC. **Total in plan:** ~6,000 LOC reduced to ~3,000 LOC by end of Phase 4.

---

## 4. Public API migration table

| Surface | Today | After |
|---|---|---|
| `BaseAdapter` consumers (AgentManager / AgentProcess) | local impls | unchanged — bridge preserves shape |
| `dashboard-server.ts` 133 WS msg types | unchanged | unchanged (D10) |
| `~/.anvil/state.json` polling | primary read | secondary fallback |
| `pipeline-runner.ts` exports (`runPipeline`, etc.) | local | thin caller — `Pipeline.run()` from core-pipeline |
| `CostLedger.record()` | NDJSON only | NDJSON + SpendLedger.record (mirrored) |
| `pipeline-learner.ts` `learn*()` functions | called inline from runner | called from `attachLearnersHook` callback |
| `MemoryStore.{add,replace,remove,getEntriesWithMeta,formatForPrompt}` | local markdown files | façade over memory-core SQLite — same method shapes |
| `~/.anvil/memories/<project>/{MEMORY,USER}.md` | source of truth | one-shot migration source; archived after import |

---

## 5. External callers requiring migration (audit before each phase)

Phase 1: every `import { ClaudeAdapter | GeminiCliAdapter | ApiAdapter } from './adapters/...'` site (≈ 8 hits in `agent-manager.ts`, `agent-runner-wrapper.ts`, `dashboard-server.ts`).

Phase 2: every `readDashboardState()` + `writeDashboardState()` call (≈ 30 hits).

Phase 3: every `costLedger.record()` site (≈ 13 hits).

Phase 4: every reference to `pipeline-runner.ts` exports + every `if (msg.type === 'pipeline-*')` branch in `dashboard-server.ts` (≈ 40 hits).

Phase 5: every `memoryStore.{add,replace,remove,getEntriesWithMeta,formatForPrompt}` call site (≈ 15 hits across `dashboard-server.ts`, `pipeline-runner.ts`, `pipeline-learner.ts`) + the `MemoryTarget` type re-export.

---

## 6. Per-phase commit log

Plan ships in 7 phases (0 through 6). Updated incrementally as phases land.

| Phase | Status | Commit | Deviations |
|---|---|---|---|
| 0 — Audit + decisions | landed | `6d4fa89` | — |
| 1 — agent-core adapter consolidation | landed | `9c4ce19` | Phase 1.4 risk widened: in addition to the planned `cache` capability bit, `ProviderCapabilities` also gained `cacheTtlSeconds` / `structuredOutput` / `maxOutputTokens` and `ModelAdapterConfig` gained `maxOutputTokens`, `ModelAdapterResult` gained `stopReason`. All additive — no breaking change. The dashboard's per-stage output ceiling + finish_reason normalization moved from `ApiAdapter` into agent-core's `OpenAIAdapter` so behavior survives the cutover. |
| 2 — core-pipeline EventBus subscription | landed | `7455089` | Wiring is in place but no publishers yet — pipeline-runner.ts still runs the legacy in-process orchestrator. Phase 4 swaps publishers onto the bus. |
| 3 — Cost-ledger ↔ spend-ledger bridge | landed | `02fea5c` | `BridgedCostLedger` lands as a `CostLedger` subclass so the existing `CostBreachHandler` and 6 read sites are unchanged. Mirroring is one-way (dashboard → SpendLedger); the plan's symmetric `onRecord` hook on the router side is deferred — no current cli writer is producing rows the dashboard would want to mirror back, so the reverse path can land lazily when needed. Provider is inferred from model id (claude → anthropic, gpt/o1/o3/o4 → openai, gemini → google, llama/mistral/qwen/phi → ollama) since `CostEntry` doesn't carry a provider field. |
| 4 — Lift pipeline-runner features into Steps | in progress | — | Plan §4.2 procedure (6 ordered Step lifts) is being landed as 6 sequential sub-PRs (4a–4f) rather than one mega-PR — pipeline-runner.ts is 3,315 LOC of intertwined state and a single landing was judged too risky to revert cleanly. Each sub-PR is parity-checked against the prior commit before the next lands; D8 (no flags, full cutover per PR) holds at the *sub-phase* boundary. |
| 4a — per-repo fanout + Step scaffold | landed | `d4af145` | core-pipeline `Step.parallelism: 'per-repo'` implemented in the walker (Promise.all fanout, `ctx.repoName` populated, `Record<string, O>` aggregation). `StepContext` gains `repoName?: string`. New `packages/dashboard/server/steps/` scaffold (`buildDashboardStepRegistry`) is empty — 4b–4f register real Steps. `pipeline-runner.ts` is untouched. |
| 4b — FeatureStore Step (FEATURE-MANIFEST.json) | landed | `7e7db5d` | Lifts `pipeline-runner.ts:extractAndUpdateManifest()` into `createFeatureManifestStep` (one Step per pipeline stage). The plan's "wraps `FeatureStore`" framing is narrowed: the new Step wraps `FeatureManifestStore` + the seven extractors only — `FeatureStore` itself is still consumed directly by `pipeline-runner.ts` (writing per-stage artifacts to disk) and stays untouched until Phase 4f. The Step passes the artifact through unchanged as its output so it's drop-in between any two persona steps. |
| 4c — Plan-risk-scorer Step (PLAN-RISK.json) | landed | `709dde0` | One-shot `Step<Plan, Plan>` factory wraps `scorePlan` + `computeRiskTier`. Registered manually via `createPlanRiskStep` rather than auto-injected by `buildDashboardStepRegistry` — Phase 4f decides where in the registry order to insert it (after the planning persona step). Replaces `pipeline-runner.ts:cachedRisk`: downstream consumers read `ctx.artifacts.read('PLAN-RISK.json')` instead. |
| 4d — Engineer-task-bundler Step (TASK-BUNDLES.json) | landed | `8223c4a` | Lifts `parseTasks()` + `groupTasksForExecution()` only — `bundleFiles()` stays inline (it reads from disk per task, lives inside the per-task build fanout). Splitting parse/pack keeps the Step pure for parity testing. Per-repo artifact id `TASK-BUNDLES.json:<repo>` lets multiple per-repo Steps coexist when Phase 4f composes them. |
| 4e — Interactive-clarify Step + cost-budget hook | landed | `aa36dfd` | Clarify Step lifts only the **deterministic** Q&A orchestration (parseQuestions, ask/await loop, synthesis-prompt assembly) — the AgentManager-coupled explore + synthesize LLM calls stay in `pipeline-runner.ts` until 4f composes them around this Step. Cost-budget hook lands as **additive** — the existing per-LLM-call breach evaluation in `agentManager.setCostHook` is untouched; the bus hook adds an end-of-step checkpoint. Phase 4f decides whether to drop the per-LLM-call hook. Neither artifact is auto-registered by `buildDashboardStepRegistry` yet. |
| 4f — pipeline-runner.ts → ≤300-LOC façade | in progress | — | Multi-session lift. Tracked as 4f.1, 4f.2, … each landing one method/method-group from `pipeline-runner.ts` into Steps (or shared helpers under `steps/`). Each sub-PR is parity-checked against the previous. The ≤300-LOC target lands when 4f.last cuts the final dependency. |
| 4f.1 — agent-spawner helper + runSingleStage refactor | landed | `0605836` | New `steps/agent-spawner.ts` exports `spawnAndWait` + `waitForAgent` — pure helpers covering AgentManager.spawn + poll-until-done. `pipeline-runner.ts:waitForAgent()` delegates to the helper (so the per-repo fanout, per-task build, and fix-loop callers all flow through the new path automatically). `runSingleStage` rewritten to use `spawnAndWait` directly. pipeline-runner: 3,315 → 3,306 LOC. Behavior parity: full dashboard suite green minus the 6 pre-existing failures. |
| 4f.2 — per-repo stage Step + helper | landed | `a6ef3d7` | New `steps/per-repo-stage.step.ts` exports `runPerRepoStageForRepo` (single-repo helper that wraps `spawnAndWait` with the persona-aware `disallowedTools` rule), `combinePerRepoArtifacts` (legacy `## <repo>\n\n<artifact>` separator), and `createPerRepoStageStep` (`Step<string, RunPerRepoStageResult>` factory with `parallelism: 'per-repo'`). `pipeline-runner.runPerRepoStage` keeps its loop today but each iteration delegates to the helper — the build-stage branch (`runBuildForRepo`) is untouched here, that's Phase 4f.3. `disallowedToolsForPersona(persona)` consolidates the engineer-vs-tester-vs-other rule that was inlined at three callsites in pipeline-runner. The Step factory is NOT auto-registered (4f.7 wires registration once `Pipeline.run()` becomes the orchestrator). pipeline-runner: 3,306 → 3,300 LOC. Behavior parity: 6 pre-existing failures, 0 new regressions. |
| 4f.3 — per-repo build Step (per-task fanout) | landed | `5384d55` | New `steps/per-repo-build.step.ts` exports `runBuildForOneRepo` (single-repo helper covering the parse → group → fanout → combine flow), `combineTaskArtifacts` (preserves original task order, joins with the legacy `\n\n---\n\n` separator), `BUILD_DISALLOWED_TOOLS` (`['Read', 'Grep', 'Glob', 'Agent']` — distinct from the general persona rule because per-task prompts pre-bundle every file the engineer needs), and `createPerRepoBuildStep` (`Step<unknown, RunBuildForRepoResult>` factory with `parallelism: 'per-repo'`). Per-task failures are swallowed into `UNRESOLVED:` placeholder artifacts (legacy parity); the fallback path propagates errors. Cancellation is checked at the top of each group iteration. `pipeline-runner.runBuildForRepo` shrinks from ~120 LOC to ~50 LOC by delegating to the helper with closures for prompt builders, state mutation, and project events. pipeline-runner: 3,300 → 3,234 LOC (−66). Behavior parity: 6 pre-existing failures, 0 new regressions. |
| 4f.4+ — remaining stage methods → Steps | pending | — | — |
| 5 — MemoryStore → memory-core replacement | pending | — | — |
| 6 — Tests + docs + ADR finalize | pending | — | — |
