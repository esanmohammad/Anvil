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
- **Active runs** — every pipeline in flight, with optimistic
  insert on click (no "did I press Build?" gap), model fallbacks
  called out, and an interrupt button that actually works.
- **Run history** — every previous run with diffs, PR URLs,
  reviewer verdicts, and a one-click resume from any failed stage.
  Each run exposes a **Durable execution log** disclosure that
  renders every persisted step + effect for incident postmortems.
- **Knowledge graph** — force-directed view of your project graph
  (the one `@anvil/knowledge-core` builds), filterable by repo and
  community, click-through to source.
- **Memory inspector** — query the five-type memory store live,
  see what got proposed, what got ratified, what got drift-flagged.
- **Pipeline policy editor** at `/policy` — *new in 0.3.0*. Master
  toggle, per-stage pause checkboxes (plan, implement, test, ship),
  auto-approve thresholds on risk + confidence, Q&A budget per
  stage. Cost limits + notifications scaffolded as "Coming Soon".
- **In-flight agent Q&A** — *new in 0.3.0*. When an agent asks
  clarifying questions, an inline Q&A card surfaces with a draft
  area per question; answers flow into the durable signal channel
  so a crashed worker resumes without re-asking.
- **Paused-run banner + review modal** — *new in 0.3.0*. Orange
  banner at the top of the run view whenever the policy fires a
  pause. Click Review for an Approve / Reject / Modify-artifact /
  Iterate-with-note / Rerun-from-stage modal. Decisions enqueue a
  durable signal so the agent picks back up exactly where it left
  off, even across a process restart.
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
- **`server/dashboard-server.ts`** — boot orchestrator (~890 LOC
  after the Phase 1–11 decomposition). Wires `AgentManager` /
  `MemoryStore` / `PipelineRunner` / pause store / services, mounts
  socket.io, builds the handler registry, calls `bootDurable` last.
- **`server/setup/`** — boot wiring extracted out of
  `dashboard-server.ts`: `stores.ts` (the `DashboardStores` bundle),
  `auto-replay.ts`, `restore-incomplete.ts`, `sleeptime.ts`,
  `graceful-shutdown.ts`, **`durable.ts` (new in 0.3.0 — migration
  + auto-resume + vacuum)**.
- **`server/pipeline-runner.ts`** — per-run orchestrator. Walks
  the 9 stages, fans out per-repo, runs the validate-fix loop,
  broadcasts state over WS. **v0.3.0**: acquires a TTL'd lease in
  the durable store + attaches `attachDurableLogHook` + threads
  `durableStore` into `Pipeline.run()`.
- **`server/durable-*.ts`** — *new in 0.3.0*. `durable-store-singleton.ts`
  (SQLite handle at `~/.anvil/durable.db`), `durable-migration.ts`
  (Pattern-1 sweep + orphan takeover), `durable-vacuum.ts` (daily
  retention), `durable-resume-queue.ts` (auto-replay reclaimed runs),
  `auto-replay-queue.ts` (bug→test job queue), `replay-pipeline.ts`,
  `replay-store.ts`.
- **`server/pipeline-policy*.ts`** — Policy YAML reader, validator,
  evaluator, overlay merger. `BUILTIN_DEFAULT_POLICY` ships with
  `enabled:false` so first-run is pause-free; opt-in via the UI.
- **`server/pipeline-pause-*.ts`** — `pipeline-pause-store.ts`,
  `pipeline-pause-handlers.ts`, `pipeline-pause-sweeper.ts`,
  `pipeline-pause-types.ts`. Backing store + handlers for the
  paused-run banner + review modal.
- **`server/handlers/`** — typed handler registry (one file per
  domain). v0.3.0 added `handlers/durable.ts` (`get-durable-timeline`,
  `provide-stage-answer`) and extended `handlers/runs-pipeline.ts`'s
  `resume-pipeline` to disambiguate pause-flow vs replay-flow on
  `msg.decision`.
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

### Durable execution &nbsp;<sub><i>new in 0.3.0</i></sub>
Every run acquires a TTL'd lease in `~/.anvil/durable.db` and
heartbeats it at `ttl/3`. Every step + every `ctx.effect()` call
records to the SQLite event log. Kill the dashboard mid-run and
relaunch: the boot daemon's orphan scan finds the expired lease,
claims it, and the auto-resume queue replays the workflow from
the durable cursor — recorded effects return cached results, no
double agent spawns, no re-prompting the user for Q&A answers
they already gave. Opt out per env: `ANVIL_DURABLE_DISABLED=1`,
`ANVIL_DURABLE_AUTO_TAKEOVER=0`, `ANVIL_DURABLE_AUTO_RESUME=0`,
`ANVIL_DURABLE_VACUUM_DISABLED=1`, `ANVIL_DURABLE_RETENTION_DAYS=30`.

### Reviewer pause flow &nbsp;<sub><i>new in 0.3.0</i></sub>
When the policy editor's pause gate fires after a stage,
`pipeline.paused` flows over socket.io. The frontend's
`usePausedRuns` hook surfaces an orange `<PausedBanner>` for the
matching run + opens `<PlanReviewModal>` on Review. Approve /
Reject / Modify-artifact / Iterate-with-note / Rerun-from-stage —
each decision lands on `pauseStore.resume()`, unblocks the
after-stage hook's 1s polling loop, and triggers
`runner.applyArtifactEdit` / `setReviewNote` /
`requestRerunFromStage` as appropriate. The decision is also
enqueued as a durable signal so a crashed process resuming the
run picks back up at the post-decision step, not the pre-decision
pause.

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
door; everything else flows through here. v0.3.0 added durable
execution wiring, multi-process race arbitration, the `/policy`
editor, in-flight Q&A cards, the paused-run banner + review modal,
and the durable execution log viewer.

---

## Part of [Anvil](../../) — the AI development pipeline.
