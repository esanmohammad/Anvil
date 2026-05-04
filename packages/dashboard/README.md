# @anvil-dev/dashboard

**Watch your codebase build itself.**

The Anvil control plane — a real-time WebSocket dashboard that
turns the entire stack into one place. Run pipelines, see every
agent's tool calls live, edit project memory, browse the knowledge
graph, manage providers, and ship PRs across repos. Every piece
of Anvil shows up here.

---

## What you actually see

When you run `anvil dashboard`, a single Node process boots and
serves both the React UI and the WebSocket backend. Open the
browser tab and you get:

- **Pipeline view** — kick off a feature, watch the 9 stages walk
  in real time, see every spawned agent's tool calls, file edits,
  and shell output as they happen.
- **Active runs** — every pipeline in flight, with cost ticking up
  per call, model fallbacks called out, and an interrupt button
  that actually works.
- **Run history** — every previous run with diffs, PR URLs,
  reviewer verdicts, and a one-click resume from any failed stage.
- **Knowledge graph** — force-directed view of your project graph
  (the one `@anvil/knowledge-core` builds), filterable by repo and
  community, click-through to source.
- **Memory inspector** — query the five-type memory store live,
  see what got proposed, what got ratified, what got drift-flagged.
- **Pipeline policy editor** — model-per-stage routing in a UI; no
  YAML edit needed.
- **Settings** — provider keys, OTel endpoint, Ollama host, all
  written to `~/.anvil/.env` from the browser.

It's the same engine the CLI uses, with a window into every
millisecond of it.

---

## How everything connects

The dashboard is the *integration point*. It doesn't reimplement
anything — it composes every `@anvil/*` package into one coherent
surface.

```
                       ┌──────────────────────────────┐
                       │   anvil dashboard  (CLI)     │
                       └──────────────┬───────────────┘
                                      │ spawns
                                      ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  @anvil-dev/dashboard  (this package)                       │
   │   ┌─────────────────────────────────────────────────────┐   │
   │   │  React UI                                           │   │
   │   │  pipeline · runs · graph · memory · policy · diff   │   │
   │   └────────────────────────┬────────────────────────────┘   │
   │                            │ WebSocket + HTTP               │
   │                            ▼                                │
   │   ┌─────────────────────────────────────────────────────┐   │
   │   │  dashboard-server.ts                                │   │
   │   │  ~50 WS message types · run store · prUrls ·        │   │
   │   │  costLedger · interrupted-pipeline restore          │   │
   │   └────────────────────────┬────────────────────────────┘   │
   │                            │ orchestrates                   │
   │                            ▼                                │
   │   ┌─────────────────────────────────────────────────────┐   │
   │   │  pipeline-runner.ts                                 │   │
   │   │  9-stage walker · per-repo fan-out · validate-fix   │   │
   │   │  loop · chain-fallback on UpstreamError             │   │
   │   └─┬───────┬────────┬─────────┬──────────┬─────────────┘   │
   └─────┼───────┼────────┼─────────┼──────────┼─────────────────┘
         │       │        │         │          │
         ▼       ▼        ▼         ▼          ▼
   ┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │ agent-   │ │ core-    │ │ knowledge-   │ │ memory-      │ │ convention-  │
   │ core     │ │ pipeline │ │ core         │ │ core         │ │ core         │
   ├──────────┤ ├──────────┤ ├──────────────┤ ├──────────────┤ ├──────────────┤
   │ 8 LLM    │ │ Step<I,O>│ │ AST chunks   │ │ Hybrid memory│ │ Convention   │
   │ adapters │ │ + bus +  │ │ + project    │ │ + drift +    │ │ extractor +  │
   │ + router │ │ hooks    │ │ graph + RAG  │ │ proposal Q   │ │ rule engine  │
   │ + cost   │ │          │ │              │ │              │ │ + promotion  │
   │ + OTel   │ │          │ │              │ │              │ │ ledger       │
   └────┬─────┘ └──────────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
        │                           │                 │                 │
        ▼                           ▼                 ▼                 ▼
   ~/.anvil/                  ~/.anvil/           ~/.anvil/         ~/.anvil/
   models.yaml                runs/<id>/          knowledge-base/   conventions/
   stage-policy.yaml          state.json          <project>/        <project>/
   .env (keys)                features/<slug>/    lancedb/          conventions.md
                                                                    rules.json
```

Read top to bottom: the CLI launches the dashboard process. The
dashboard hosts the UI and the WebSocket backend. The backend
delegates pipeline orchestration to its `pipeline-runner` which is
built on `@anvil/core-pipeline`. The runner spawns agents through
`@anvil/agent-core` (which picks the right model, retries, tracks
cost, emits OTel spans). Knowledge retrieval flows through
`@anvil/knowledge-core`. Memory writes go through
`@anvil/memory-core`'s proposal queue. Convention checks come from
`@anvil/convention-core`. Each package owns its on-disk artifacts
under `~/.anvil/`.

**The CLI consumes the same engine** — `anvil dashboard` just
starts the server. Everything else (pipeline runner, agent stack,
knowledge, memory, conventions) is shared code paths. The
dashboard is the visualization, not a fork.

**`@esankhan3/code-search-mcp`** is the *external* surface — the
same `@anvil/knowledge-core` retriever exposed over MCP so any
client (Claude Code, Claude Desktop, Cursor) can search your
indexed repos. Three different fronts, one knowledge stack.

---

## What lives in this package

### Server
- **`server/dashboard-server.ts`** — single-process HTTP + WS host.
  ~50 WebSocket message types, instantiates the `AgentManager` /
  `MemoryStore` / `PipelineRunner` / `PipelinePauseStore`, owns the
  `prUrls` / `costLedger` / `runStore` rollups, scans the feature
  store for prior PR URLs on boot.
- **`server/pipeline-runner.ts`** — per-run orchestrator. Walks
  the 9 stages, fans out per-repo, runs the validate-fix loop,
  broadcasts state over WS. Delegates every spawn, prompt build,
  and shell op to a Step factory or pure helper under `steps/`.
- **`server/steps/`** — Step factories + helpers. Adding a stage
  starts here.
- **`server/provider-registry.ts`** — visibility layer for the
  Settings UI; reports each provider's display name, env var,
  setup hint.
- **`server/provider-liveness.ts`** — pre-call liveness probe +
  chain-walker that picks the first alive model in a tier-chain.
- **`server/memory-store.ts`** — thin façade over `@anvil/memory-core`.
- **`server/feature-store.ts`** — owns
  `~/.anvil/features/<project>/<slug>/` artifacts (clarification,
  requirements, tasks, …).
- **`server/knowledge-base-manager.ts`** — wraps the CLI's
  `anvil index` so KB indexing runs out-of-process.

### Frontend
- **`src/`** — React + Vite frontend. Mounts on the same port as
  the WS server. Renders run history, change diffs, activity log,
  KB graph, pipeline-policy editor, memory inspector, settings.

### Build
`vite build` for the frontend, `tsc` for the server. The `cli`
package's build step then bundles the entire `dist/` (UI assets +
compiled server) into its own `dist/dashboard/` so a single
`anvil` install ships everything.

---

## Concurrency, cost, and reliability

### Per-stage tool permissions
Every spawn threads `allowedToolsForStage(stage)` from
`@anvil/core-pipeline` so non-Claude agentic adapters (Ollama,
OpenRouter, OpenCode) get the right `BuiltinToolExecutor` scope.
Build can edit; review is read-only.

### Chain-fallback on retryable upstream errors
`runStageWithFallback` catches `UpstreamError` shapes from
`@anvil/agent-core`, burns the failed model in
`runtimeBurnedModels`, and re-resolves the stage's chain via
`pickAliveModelFromChainSync`. Quota bursts on a single provider
don't sink the run.

### Pre-flight liveness
`prefetchProviderLiveness` runs at pipeline start and probes every
distinct provider in `~/.anvil/models.yaml`. Cloud probes are env-
var-presence; Ollama hits `/api/tags`. Cached for
`walker.liveness_ttl_ms` (default 30s).

### Per-repo stage atomicity
One repo failing rejects the whole stage. Half-shipped is worse
than not-shipped.

### PR URL extraction
The `gh pr create` URL appears in the agent's `tool_result`. The
bridge emits a `kind:'text'` activity for each `tool_result` so the
dashboard's `extractPRUrls` scanner picks it up. URLs land in the
active run's `prUrls: Set<string>` and surface in the run-history
detail view as soon as `gh` returns.

---

## Things that don't exist (intentionally)

- **No legacy if-tree orchestrator.** The dashboard rides on
  `@anvil/core-pipeline` indirectly through `pipeline-runner.ts`'s
  Step factories.
- **No feature flags.** Per the dashboard-consolidation rule we
  don't gate behavior changes on flags — branch-parity diff
  replaces flag-gated rollout.
- **No vendor LLM SDK imports.** All provider work routes through
  `@anvil/agent-core`'s `AgentManager`.
- **No direct `@anvil/knowledge-core` imports for KB ops.** They
  shell out to the CLI's `anvil index` via `KnowledgeBaseManager`
  so indexing doesn't share a heap with the dashboard.

---

## Status

The canonical interface for running Anvil pipelines as of MVP 2.
The CLI's `init` / `doctor` / `dashboard` commands are the front
door; everything else flows through here.

---

## Part of [Anvil](../../) — the AI development pipeline.
