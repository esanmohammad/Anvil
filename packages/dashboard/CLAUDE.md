# CLAUDE.md — `@anvil-dev/dashboard`

Guidance for Claude Code when working inside `packages/dashboard/`. The
dashboard is the WebSocket+HTTP server that drives Anvil's per-run
pipeline orchestrator, plus the React UI rendered against it. Single
process; the boot orchestrator (`server/dashboard-server.ts`) was
decomposed from ~8,300 LOC to ~890 LOC over a 12-round refactor — the
extracted modules live under `server/{setup,handlers,pipeline,http,runs,shared,sandbox,services,events,ws,dev,tools,browser,computer-use,steps,runners}/`. See `DASHBOARD-DECOMPOSITION-PLAN.md` for round-by-round history.

## What this package owns

- **`server/dashboard-server.ts`** (~890 LOC) — boot + lifecycle only:
  loads env, builds the `DashboardStores` bundle, constructs services +
  legacy bridge + socket.io mount, wires the handler registry, threads
  the `HandlerExtras` closure bag, returns the `DashboardServerHandle`.
  Top-of-file invokes `loadAnvilEnv(ANVIL_HOME)` /
  `ensureQuietOtelLogs()` / `autoDetectTelemetry()`. WS event vocabulary
  is typed (`DashboardEvent` union in `server/events/types.ts`).
- **`server/setup/`** — boot-time wiring extracted out of
  `dashboard-server.ts`:
    - `load-env.ts` — `ALLOWED_ENV_KEYS` + `loadAnvilEnv(anvilHome)` +
      `autoDetectTelemetry()` + `ensureQuietOtelLogs()`. Single source
      of truth for the env-var write contract.
    - `stores.ts` — `createDashboardStores(deps)` collapses ~26
      `new XxxStore(ANVIL_HOME)` calls into one factory returning a
      typed `DashboardStores` bundle (plan / review / test / incident /
      KB / cost / pauses / manifest / memory / feature / runs /
      ci-triage / reviewers / dismissals / learnings / regression /
      replay / durable / approval / bound-tests / contract / browser /
      flakiness / shared cost-pricing).
    - `init-payload.ts` — `createInitSender(deps)` returns the
      `SendInitFn` that pushes the projects/runs/state/models/repos
      bootstrap blob on WS connect. Takes a `getOutputBuffer()` getter
      so rebound `let outputBuffer = []` semantics survive.
    - `model-discovery.ts` — `discoverAvailableModels()` walks
      `~/.anvil/models.yaml` + provider env-var presence; returns the
      typed `AvailableModelsResult` consumed by the Settings UI.
    - `server-listen.ts` — terminal `listenAndReturnHandle(deps)` block
      that mounts socket.io, builds the `fauxWsForSocket` adapter, and
      drains `stopHandlers` with per-handler 2 s timeouts on
      `handle.stop()`.
    - `graceful-shutdown.ts` — SIGINT+SIGTERM hooks calling
      `agentManager.killAll()` + 3 s force-exit watchdog.
    - `auto-replay.ts` / `restore-incomplete.ts` / `sleeptime.ts` —
      background daemons started at boot (replay queue, incomplete-run
      restore sweep, memory-core sleeptime ratification).
    - `ws-client.ts` — shared `WsClient` type + `WS_OPEN = 1`.
- **`server/handlers/`** — WS client action handlers (one per
  domain) dispatched via Recipe-7 handler registry:
    - `registry.ts` + `route.ts` — typed dispatch over `ClientMessage`.
      Each handler takes `(msg, extras: HandlerExtras)` and returns
      `Promise<void>`. Unknown actions log + drop, never crash the
      server.
    - `extras-builder.ts` — `buildHandlerExtras(deps): HandlerExtras`
      flattens 40+ deps into a typed bag. Mutable refs via
      `getActivePipelineRunner` / `setActivePipelineRunner` /
      `getActiveChild` callbacks. Spawn closures wrapped in thunks at
      call site to handle declaration-order.
    - One file per domain: `projects`, `runs-pipeline`, `plans` +
      `plans-spawn`, `reviews` + `reviews-spawn`, `tests` +
      `tests-pipeline`, `incidents` + `incidents-spawn`,
      `contracts`, `pauses`, `cost`, `kb`, `project-graph`,
      `learnings`, `ci-triage`, `settings`, `schemas` (Zod input
      validation).
- **`server/pipeline/`** — pipeline-side spawn / cancel / lifecycle
  helpers extracted out of the runner + handlers:
    - `start-pipeline.ts` — `startPipeline()` registers the run on
      `activeRuns` + broadcasts BEFORE `new PipelineRunner(...)`;
      seeds the activity feed with an "Initialising pipeline…" entry.
    - `cancel-legacy.ts` — `createCancelLegacyPipeline(deps)` returns
      the SIGTERM-then-state-flip canceller.
    - `quick-action.ts` / `plan-spawn.ts` / `review-spawn.ts` —
      one-shot agent spawns for ad-hoc commands.
    - `post-run.ts` / `pr-tracking.ts` / `plan-lifecycle.ts` /
      `cost-breach-router.ts` / `review-helpers.ts` /
      `project-overview.ts` / `json-extract.ts`.
- **`server/runs/io.ts`** — `loadRunsSync(runsIndex)` +
  `readStateFile(stateFile)` as pure path-arg readers; the server
  wraps them in `() => loadRunsSync(RUNS_INDEX)` thunks to preserve
  the deps-fn shape downstream.
- **`server/http/`** — non-WS HTTP surface:
    - `static.ts` — `createStaticHandler(deps)` MIME-typed Vite
      `dist/` server with directory-traversal protection.
    - `webhook-routes.ts` — `POST /webhooks/incidents` /
      `POST /webhooks/bound-tests` etc.
- **`server/shared/`** — types + workspace helpers hoisted out of the
  monolith:
    - `server-types.ts` — `ProjectSummary`, `RunSummary`,
      `DashboardStageState`, `DashboardPipeline`, `DashboardState`,
      `ServerMessage`, `ClientMessage`, `DashboardServerOptions`,
      `DashboardServerHandle`.
    - `workspace.ts` — `getWorkspaceFromConfig(project)` +
      `parseFixPatternContent(content)` pure helpers.
- **`server/sandbox/`** — workload sandboxing (overlay-fs upper layer
  + container runners). Used by `agent-core`'s `BuiltinToolExecutor`
  when `SANDBOX_HANDLE` is threaded through the spawn config (see
  recent commits 9d8e513 / c7ceb14 / e15334a):
    - `docker-runner.ts` / `firecracker-runner.ts` / `gvisor-runner.ts`
      — three substrate impls behind a shared interface.
    - `overlay-fs.ts` — tmpfs upper layer + state-hash binding for
      reproducible runBash invocations.
    - `pool.ts` / `pooled-runner.ts` — warm-instance pool.
    - `cache-mounts.ts` / `docker-image.ts` /
      `install-exec-wrapper.ts` / `network-policy.ts` /
      `resource-limits.ts` / `register-at-boot.ts`.
- **`server/events/`** — typed event infrastructure (Phase 2–6 of the
  WS extraction):
    - `types.ts` — `DashboardEvent` discriminated union (~60 event
      kinds across run lifecycle, agent stream, pipeline, plans,
      reviews, tests, incidents, KB, cost, project-graph, bind,
      artifact, system). `Topic` enum for socket.io room routing.
      `envelope()` + `nextEventId()` helpers.
    - `replay.ts` — `EventReplay` ring buffer per topic, bounded by
      both event count (default 500) and bytes (default 1 MiB)
      whichever-hits-first. Used by socket.io's `subscribe { since }`
      backfill on reconnect.
    - `topics.ts` — `roomsForEvent(ev)` map (ts-pattern exhaustive
      switch). Adding a new event kind without a topic mapping is a
      compile error.
    - `bridge.ts` — `attachLegacyBridge` subscribes to every service's
      `onAny` and translates each typed emission back to today's
      `{type,payload}` wire shape via `broadcast()`. Keeps the React
      frontend (still raw-WS) working unchanged during migration.
    - `wire-translate.ts` — explicit per-kind unwrap of typed payloads
      into the legacy wire shape (e.g. `run.active-snapshot` →
      `payload: array` instead of `{runs}`). This divergence is the
      reason `src/state/reducer.ts` accepts BOTH shapes per case.
    - `services-bridge.ts` — sibling that fans typed events into
      socket.io rooms via `io.to(rooms).emit`. Used only when
      `mountSocketServer({ coexistWithRawWs: true })` is active
      (env-gated by `ANVIL_SOCKET_IO=1`).
    - `sync-emitter.ts` — synchronous typed pub/sub base class. Used
      instead of Emittery because Emittery dispatches listeners on a
      microtask, which would reorder typed emissions against any
      sibling synchronous `broadcast()` calls and break wire ordering
      (e.g. `stop-run` → `active-runs` → kill chain).
- **`server/services/index.ts`** — domain-scoped event services (one
  `SyncEmitter` subclass per domain): `RunService`, `AgentService`,
  `PipelineService`, `ReviewService`, `PlanService`, `TestService`,
  `BindService`, `IncidentService`, `KbService`, `CostService`,
  `ProjectGraphService`, `SystemService`. `createServices()` returns
  the full bundle; injected via `DashboardServerDeps.services`.
- **`server/ws/socket-server.ts`** — `mountSocketServer({...})` boots
  socket.io. Two modes:
    - default: socket.io's `attach(server)` takes over the http
      server's request listener. Suitable for isolated tests.
    - `coexistWithRawWs: true`: socket.io uses `noServer: true` plus a
      manual upgrade-router that filters `/socket.io/*` URLs and lets
      the raw `WebSocketServer({ path: '/ws' })` keep owning `/ws`.
      This is the production path until raw-WS is removed.
- **`shared/events.ts`** — re-exports from `server/events/types.ts` so
  both the Node server AND the Vite frontend import event types from a
  single namespace.
- **`src/state/reducer.ts`** — pure reducer over `DashboardEvent`.
  Replaces the imperative `handleServerMessage` switch in
  `main.tsx:443`. Includes `wireToEvent(wire)` adapter that converts
  the legacy `{type,payload}` wire shape into a typed envelope so the
  reducer can switch on `kind`. **Wire-shape divergence**: the bridge
  unwraps some typed payloads (`run.active-snapshot` → array,
  `runs.list` → array, `state` → state, `prs.updated` → array) so
  every case that reads payload fields MUST accept both the typed
  envelope (`{runs: [...]}`) and the unwrapped raw shape (`[...]`).
  Don't add a case that only reads one shape — it'll crash with
  `Cannot read properties of undefined (reading 'map')` for whichever
  hop didn't unwrap. ts-pattern's `.exhaustive()` makes adding a new
  event kind a compile error if the reducer doesn't handle it.
- **`server/__tests__/_harness/`** — scenario-test infrastructure
  (Phase 0.5):
    - `boot.ts` — `bootDashboard()` boots a fresh dashboard on an
      ephemeral port with a tmp ANVIL_HOME and an injected
      `FakeAgentManager` (zero real LLM calls).
    - `dashboard-client.ts` — `DashboardClient` abstraction with two
      transport impls (`rawWsClient` / `socketIoClient`); scenario
      tests are transport-agnostic.
    - `fake-agent-manager.ts` — `FakeAgentManager extends AgentManager`
      with scripted spawn/emit/done/error. Lets scenarios pin the
      wire-level contract of agent lifecycle without real LLM
      spawns.
    - `strip-volatile.ts` + `snapshot-store.ts` — snapshot
      normalization + file-based pinning (`__tests__/snapshots/*.snap`).
- **`server/dev/ws-trace.ts`** — opt-in JSONL writer for `broadcast()`
  emissions. When `ANVIL_WS_TRACE=1`, every legacy-shape broadcast
  appends `{ts, type, callerHash}` to `$ANVIL_HOME/ws-trace.jsonl`.
  Used during the migration to inventory event types; safe to keep
  shipping since it no-ops when the env var is unset.
- **`server/pipeline-runner.ts`** (~560 LOC) — per-run orchestrator.
  Drives via `Pipeline.run()` from `core-pipeline` over an
  `InMemoryStepRegistry` built from `STAGES` in core-pipeline; each
  Step's `run` calls `runOneStage(i)` which contains the per-stage body
  (resume skip, planSeed branch, dispatch to clarify/perRepo/single,
  validate-fix loop, after-stage hook, ship deploy). Control-flow exits
  (`continue` / `break` / early-return / reviewer rewind) translate to
  thrown sentinel errors with `__anvilCancel` / `__anvilFailReturn` /
  `__anvilRewind` markers; the outer try unwinds to the right exit.
  Reviewer rewind is handled by trimming `completedSteps` and
  re-invoking `Pipeline.run()` from the rewind target. The runner
  emits to its own `EventEmitter` (`state-change`, `waiting-for-input`,
  `clarify-question`, etc.); `dashboard-server.ts` subscribes via
  `runner.on(...)` and translates each event to the appropriate
  `services.<X>.emit(...)` typed call. Bus subscribers
  (`attachAuditLogHook`, `attachCostTrackerHook` from core-pipeline)
  are wired to the runner's `pipelineBus` for forensic audit + cost
  rollup.
- **`server/prompt-context-cache.ts`** — memoised system-prompt
  inputs (memory block, conventions, project YAML slice, KB block,
  manifest). `formatContent(content: unknown)` JSON-stringifies
  non-string memory entries before `.replace()`-style normalization,
  because `semantic:fix-pattern` memories from sleeptime store
  `{error, fix}` objects, not strings. Previously crashed pipeline
  start with `TypeError: content.replace is not a function` —
  logged as `[pipeline] BM25 memory retrieval failed`.
- **`server/steps/`** — Step factories + pure helpers extracted out
  of `pipeline-runner.ts` over the Phase-4 series. See README §
  "Pipeline runner shape (Phase 4)" for the full module table.
- **`server/runners/`** — adapters that satisfy the canonical
  `AgentRunner` / `AgentSession` interfaces (from `core-pipeline`)
  over the dashboard's heavyweight `AgentManager`:
    - `agent-manager-runner.ts` — `AgentManagerRunner` is the one-shot
      runner. Wraps `spawnAndWait` + `runWithChainFallback`. Used by
      `runOneStage`'s single-stage / per-repo / per-task delegations.
    - `agent-manager-session.ts` — `AgentManagerSession` is the
      multi-turn session. Wraps `agentManager.spawn` for `start()` and
      `agentManager.sendInput + waitForAgent` for `sendInput()`. Used
      by clarify (explore→Q&A→synthesize) and fix-loop (resume across
      attempts).
    - `pipeline-step-registry.ts` — `buildPipelineStepRegistry(opts)`
      assembles the `InMemoryStepRegistry` driven by `Pipeline.run()`.
- **`server/provider-registry.ts`** — discovery layer for the Settings
  UI. Reports each provider's display name, env var, model list,
  setup hint. Visibility toggles on env-var presence.
- **`server/provider-liveness.ts`** — thin re-export shim over
  `@esankhan3/anvil-agent-core`'s provider-liveness module. The
  implementation moved to agent-core so cli + dashboard share one
  module-scoped probe cache.
- **`server/memory-store.ts`** — thin façade over
  `@anvil/memory-core`'s `HybridMemoryStore`, with the dashboard's
  legacy markdown-migration path on first read/write.
- **`server/feature-store.ts`** — owns
  `~/.anvil/features/<project>/<slug>/` artifacts (CLARIFICATION.md,
  REQUIREMENTS.md, …).
- **`server/knowledge-base-manager.ts`** — wraps the cli's `anvil index`
  command so KB indexing runs out-of-process.
- **`scripts/copy-out.mjs`** — post-`tsc` walker that mirrors
  `server/out/**/*` into `server/**/*` recursively (excluding
  `__tests__`). Replaces the previous hardcoded `cp` chain that broke
  every time a new subdirectory was added. Filter: `.js` / `.d.ts` /
  `.map`. Without it the cli bundle silently misses `services/`,
  `setup/`, `handlers/`, `pipeline/`, `http/`, `runs/`, `shared/`,
  `sandbox/` at import time.
- **`src/`** — React + Vite frontend. Mounts on the WS server's port,
  renders run history, change diffs, activity log, KB graph,
  pipeline-policy editor, settings. Phase-4 pipeline event vocabulary
  is rendered by `src/components/output/`.
- **`server/events/`** — typed event infrastructure (Phase 2–6 of the
  WS extraction):
    - `types.ts` — `DashboardEvent` discriminated union (~60 event
      kinds across run lifecycle, agent stream, pipeline, plans,
      reviews, tests, incidents, KB, cost, project-graph, bind,
      artifact, system). `Topic` enum for socket.io room routing.
      `envelope()` + `nextEventId()` helpers.
    - `replay.ts` — `EventReplay` ring buffer per topic, bounded by
      both event count (default 500) and bytes (default 1 MiB)
      whichever-hits-first. Used by socket.io's `subscribe { since }`
      backfill on reconnect.
    - `topics.ts` — `roomsForEvent(ev)` map (ts-pattern exhaustive
      switch). Adding a new event kind without a topic mapping is a
      compile error.
    - `bridge.ts` — `attachLegacyBridge` subscribes to every service's
      `onAny` and translates each typed emission back to today's
      `{type,payload}` wire shape via `broadcast()`. Keeps the React
      frontend (still raw-WS) working unchanged during migration.
    - `services-bridge.ts` — sibling that fans typed events into
      socket.io rooms via `io.to(rooms).emit`. Used only when
      `mountSocketServer({ coexistWithRawWs: true })` is active
      (env-gated by `ANVIL_SOCKET_IO=1`).
    - `sync-emitter.ts` — synchronous typed pub/sub base class. Used
      instead of Emittery because Emittery dispatches listeners on a
      microtask, which would reorder typed emissions against any
      sibling synchronous `broadcast()` calls and break wire ordering
      (e.g. `stop-run` → `active-runs` → kill chain).
- **`server/services/index.ts`** — domain-scoped event services (one
  `SyncEmitter` subclass per domain): `RunService`, `AgentService`,
  `PipelineService`, `ReviewService`, `PlanService`, `TestService`,
  `BindService`, `IncidentService`, `KbService`, `CostService`,
  `ProjectGraphService`, `SystemService`. `createServices()` returns
  the full bundle; injected via `DashboardServerDeps.services`.
- **`server/ws/socket-server.ts`** — `mountSocketServer({...})` boots
  socket.io. Two modes:
    - default: socket.io's `attach(server)` takes over the http
      server's request listener. Suitable for isolated tests.
    - `coexistWithRawWs: true`: socket.io uses `noServer: true` plus a
      manual upgrade-router that filters `/socket.io/*` URLs and lets
      the raw `WebSocketServer({ path: '/ws' })` keep owning `/ws`.
      This is the production path until raw-WS is removed.
- **`shared/events.ts`** — re-exports from `server/events/types.ts` so
  both the Node server AND the Vite frontend import event types from a
  single namespace.
- **`src/state/reducer.ts`** — pure reducer over `DashboardEvent`.
  Replaces the imperative `handleServerMessage` switch in
  `main.tsx:443`. Includes `wireToEvent(wire)` adapter that converts
  the legacy `{type,payload}` wire shape into a typed envelope so the
  reducer can switch on `kind`. ts-pattern's `.exhaustive()` makes
  adding a new event kind a compile error if the reducer doesn't
  handle it.
- **`server/__tests__/_harness/`** — scenario-test infrastructure
  (Phase 0.5):
    - `boot.ts` — `bootDashboard()` boots a fresh dashboard on an
      ephemeral port with a tmp ANVIL_HOME and an injected
      `FakeAgentManager` (zero real LLM calls).
    - `dashboard-client.ts` — `DashboardClient` abstraction with two
      transport impls (`rawWsClient` / `socketIoClient`); scenario
      tests are transport-agnostic.
    - `fake-agent-manager.ts` — `FakeAgentManager extends AgentManager`
      with scripted spawn/emit/done/error. Lets scenarios pin the
      wire-level contract of agent lifecycle without real LLM
      spawns.
    - `strip-volatile.ts` + `snapshot-store.ts` — snapshot
      normalization + file-based pinning (`__tests__/snapshots/*.snap`).
- **`server/dev/ws-trace.ts`** — opt-in JSONL writer for `broadcast()`
  emissions. When `ANVIL_WS_TRACE=1`, every legacy-shape broadcast
  appends `{ts, type, callerHash}` to `$ANVIL_HOME/ws-trace.jsonl`.
  Used during the migration to inventory event types; safe to keep
  shipping since it no-ops when the env var is unset.
- **`server/pipeline-runner.ts`** — per-run orchestrator. Drives via
  `Pipeline.run()` from `core-pipeline` over an `InMemoryStepRegistry`
  built from `STAGES` in core-pipeline; each Step's `run` calls
  `runOneStage(i)` which contains the per-stage body (resume skip,
  planSeed branch, dispatch to clarify/perRepo/single, validate-fix
  loop, after-stage hook, ship deploy). Control-flow exits
  (`continue` / `break` / early-return / reviewer rewind) translate to
  thrown sentinel errors with `__anvilCancel` / `__anvilFailReturn` /
  `__anvilRewind` markers; the outer try unwinds to the right exit.
  Reviewer rewind is handled by trimming `completedSteps` and
  re-invoking `Pipeline.run()` from the rewind target. The runner
  emits to its own `EventEmitter` (`state-change`, `waiting-for-input`,
  `clarify-question`, etc.); `dashboard-server.ts` subscribes via
  `runner.on(...)` and translates each event to the appropriate
  `services.<X>.emit(...)` typed call. Bus subscribers
  (`attachAuditLogHook`, `attachCostTrackerHook` from core-pipeline)
  are wired to the runner's `pipelineBus` for forensic audit + cost
  rollup.
- **`server/steps/`** — Step factories + pure helpers extracted out
  of `pipeline-runner.ts` over the Phase-4 series. See README §
  "Pipeline runner shape (Phase 4)" for the full module table.
- **`server/runners/`** — adapters that satisfy the canonical
  `AgentRunner` / `AgentSession` interfaces (from `core-pipeline`)
  over the dashboard's heavyweight `AgentManager`:
    - `agent-manager-runner.ts` — `AgentManagerRunner` is the one-shot
      runner. Wraps `spawnAndWait` + `runWithChainFallback`. Used by
      `runOneStage`'s single-stage / per-repo / per-task delegations.
    - `agent-manager-session.ts` — `AgentManagerSession` is the
      multi-turn session. Wraps `agentManager.spawn` for `start()` and
      `agentManager.sendInput + waitForAgent` for `sendInput()`. Used
      by clarify (explore→Q&A→synthesize) and fix-loop (resume across
      attempts).
    - `pipeline-step-registry.ts` — `buildPipelineStepRegistry(opts)`
      assembles the `InMemoryStepRegistry` driven by `Pipeline.run()`.
- **`server/provider-registry.ts`** — discovery layer for the Settings
  UI. Reports each provider's display name, env var, model list,
  setup hint. Visibility toggles on env-var presence.
- **`server/provider-liveness.ts`** — thin re-export shim over
  `@esankhan3/anvil-agent-core`'s provider-liveness module. The
  implementation moved to agent-core so cli + dashboard share one
  module-scoped probe cache.
- **`server/memory-store.ts`** — thin façade over
  `@anvil/memory-core`'s `HybridMemoryStore`, with the dashboard's
  legacy markdown-migration path on first read/write.
- **`server/feature-store.ts`** — owns
  `~/.anvil/features/<project>/<slug>/` artifacts (CLARIFICATION.md,
  REQUIREMENTS.md, …).
- **`server/knowledge-base-manager.ts`** — wraps the cli's `anvil index`
  command so KB indexing runs out-of-process.
- **`src/`** — React + Vite frontend. Mounts on the WS server's port,
  renders run history, change diffs, activity log, KB graph,
  pipeline-policy editor, settings. Phase-4 pipeline event vocabulary
  is rendered by `src/components/output/`.

## Build + test

```sh
npm -w @anvil-dev/dashboard run build       # tsc + Vite
npm -w @anvil-dev/dashboard run test:server # node --test on server out/
npm -w @anvil-dev/dashboard run dev         # Vite frontend on 5173
node packages/dashboard/server/dashboard-server.js   # WS+HTTP backend
```

### ⚠ `anvil-loc dashboard` runs the CLI's bundled copy, not this workspace

The CLI symlink `anvil-loc` boots
`packages/cli/dist/dashboard/server/dashboard-server.js`, NOT
`packages/dashboard/server/dashboard-server.js`. After editing
anything under `packages/dashboard/`, you MUST run:

```sh
npm -w @esankhan3/anvil-cli run build
```

That cascades: rebuilds this workspace → mirrors fresh output into
`cli/dist/dashboard/` via `bundle-dashboard.mjs`. Without that final
step, `anvil-loc dashboard` keeps executing the previously-bundled
code and your fix appears not to work. See
`packages/cli/CLAUDE.md` → "Dashboard changes need the **CLI** build"
for the full diagnosis.

The build pipeline is `vite build && tsc -p server/tsconfig.json &&
node ./scripts/copy-out.mjs`. `tsc` writes to `server/out/`;
`copy-out.mjs` walks the tree recursively and mirrors every
`.js` / `.d.ts` / `.map` (skipping `__tests__`) back into
`server/**/` so the cli can `dynamic import` without a build step on
the user's machine. **Adding a new server subdirectory requires no
copy-out change** — the walker picks it up automatically. The
`package.json` `files` field follows the same convention
(`server/**/*.js`, `server/**/*.d.ts`).

Vite is configured with `sourcemap: true` so a crashed stack trace
in the browser shows the original `src/...` filename + line, not the
minified bundle position. **Important**: never let a stale
`vite.config.js` / `.js.map` / `.d.ts` from a previous `tsc` run sit
alongside the `.ts` — Vite prefers the `.js` and silently ignores
the `.ts` config (the canonical "sourcemaps not generated despite
config change" symptom).

## Conventions

### Typed event emission — never call `broadcast()` directly

The WS extraction (Phases 0–6) replaced ~90+ inline `broadcast({ type, payload })`
call sites with typed `services.<X>.emit(kind, payload)` emissions. Adding a
new wire event MUST follow this recipe — bypassing it (i.e., calling
`broadcast(...)` directly again) is the canonical regression because the
new event won't appear in `EventReplay`, won't route correctly across
socket.io rooms, and won't be exhaustively matched by the frontend reducer.

**Adding a new event:**

1. Add a new `EventEnvelope<'kind.subkind', PayloadType>` alias to
   `server/events/types.ts` and add it to the `DashboardEvent` union.
2. Add a `.with({ kind: 'kind.subkind' }, … )` clause to
   `server/events/topics.ts` (ts-pattern errors if missing).
3. Add a `.with({ kind: 'kind.subkind' }, e => ({ type: 'kind-subkind',
   payload: e.payload }) as LegacyMessage)` clause to
   `server/events/bridge.ts` (ts-pattern errors if missing).
4. Add the kind to the appropriate service's `EventMap` interface in
   `server/services/index.ts` so `services.<X>.emit('kind.subkind', ...)`
   is typed.
5. Emit at the call site: `services.<X>.emit('kind.subkind', payload)`.

Both the legacy bridge (raw-WS → React frontend) and the socket.io
bridge fan typed emissions to subscribers automatically. No further
plumbing needed.

**The synchronous-emit invariant.** Services extend `SyncEmitter`, not
Emittery. Emittery dispatches every listener on a microtask, which
would reorder bridge-driven `broadcast()` calls against sibling
synchronous broadcasts (e.g. the `stop-run` handler must emit
`run-stopped` BEFORE the kill-chain emits agent events — see the 1.3
scenario in `__tests__/run-lifecycle.test.ts`). `SyncEmitter` calls
listeners in-line during `emit()` so wire ordering is preserved.

### socket.io coexists with raw WS, env-gated

`mountSocketServer` runs in two modes; the dashboard always uses
`coexistWithRawWs: true` to keep the React frontend working on raw WS
during the Phase 5–6 transition. The socket.io mount itself is gated
behind `ANVIL_SOCKET_IO=1`. Phase 7+ (frontend hook swap) will flip
the gate on by default and Phase 8 cleanup will delete the raw-WS
pipeline.

**Why the gate exists.** socket.io's `Server.attach(httpServer)`
replaces the http server's request listener, which can disrupt the
raw `WebSocketServer({ path: '/ws' })`. `coexistWithRawWs: true` uses
`noServer: true` + a manual upgrade router that filters `/socket.io/*`
URLs so both transports coexist. Tested in isolation (no dashboard
boot) by `__tests__/socket-io-smoke.test.ts`.

### Scenario tests: transport-agnostic by design

`DashboardClient` in `__tests__/_harness/dashboard-client.ts` is the
abstraction tests speak to. The harness picks the underlying transport
(`rawWsClient` today; can flip to `socketIoClient` for the same tests).
This is what makes Phase 7's transport swap a one-file edit, not a
test rewrite.

### Per-stage tool permissions

Every `spawnAndWait` call in `pipeline-runner.ts` MUST thread
`allowedTools: this.allowedToolsForCurrentStage(stageName)` into the
spawn spec — `LanguageModelBridge` reads this to scope the
`BuiltinToolExecutor` for non-Claude agentic adapters
(Ollama / OpenRouter / OpenCode). The five spawn sites are:
`runClarifyForProject`, generic per-repo (`runPerRepoStageForRepo`),
per-repo build (`runBuildForOneRepo`), single-stage (`spawnAndWait`),
and fix-loop (`runFixLoop`). Forgetting one is the canonical "qwen
ran but produced no diff" symptom.

### Chain-fallback on retryable upstream errors

`runStageWithFallback<T>(stageName, attemptFn)` (max attempts read from
`walker.max_attempts` in `~/.anvil/models.yaml`, default 5) wraps each
spawn site. When the inner attempt throws an `UpstreamError`-shape
(duck-typed: `name === 'UpstreamError' && retryable === true`), the
runner adds the failed model to `runtimeBurnedModels` and re-resolves
the stage's chain via `pickAliveModelFromChainSync(..., excludeModels=runtimeBurnedModels)`.
The 429/quota burst on Alibaba upstream for `qwen3.5-plus` (an
OpenCode→upstream provider quota issue, not the user's) is the
canonical case this guards.

The chain walker is reactive (post-failure burn) **plus** proactive
(pre-call liveness probe). `prefetchProviderLiveness` runs once at
pipeline start and probes every distinct provider in
`~/.anvil/models.yaml`'s `models:` array (auto-derived — no hardcoded
list). Cloud probes are env-var-presence only (`ANTHROPIC_API_KEY`,
`OPENCODE_API_KEY`, etc.); Ollama hits `127.0.0.1:11434/api/tags`
(IPv4 literal — `localhost` triggers macOS's IPv6→IPv4 fallback that
can blow past the 2s `AbortSignal.timeout` when Ollama only binds v4);
ADK probes the union of Anthropic+Gemini keys (it dispatches to
either). Probe results cache for `walker.liveness_ttl_ms` (default
30000ms; set to 0 to disable caching). Probe + chain-walker live in
`server/provider-liveness.ts`.

### Per-repo stage atomicity

When a per-repo step fans out across N repos and any one repo fails,
the stage halts:

```ts
if (failedRepos.length > 0) throw new Error(`stage ${stage.name} failed for ${failedRepos.length} repo(s)`);
```

The earlier behavior — only halting when ALL repos failed — silently
advanced with a half-written codebase.

### Run-start visibility — register before any setup work

`startPipeline()` calls `activeRuns.set(pipelineRunId, {...})` +
`broadcastActiveRuns()` at the TOP of the function, before
`new PipelineRunner(...)`, before any hook wiring (cost ledger,
checkpoint cache, after-stage policy hook), and before
`runner.run()` is scheduled. The hook chain is synchronous JS but
still long enough that the Active Runs panel was visibly stale for a
beat after Build was clicked. A seed `kind:'project'` activity
(`"Initialising pipeline — workspace + provider liveness…"`) is
pushed into the run's activity feed and broadcast on the same tick,
so the per-stage Output panel isn't blank during the workspace +
walker prefetch gap. Do NOT move the registration back down — the
late-broadcast bug was the canonical "I clicked Build and nothing
happened" symptom.

### MCP for non-Claude adapters

Every spawned agent — Claude OR non-Claude — now sees MCP-server tools
when `mcp.json` is configured for the workspace. Naming follows Claude
Code's convention: `mcp__<server>__<tool>`.

- **Claude path**: unchanged. `defaultAdapterFactory` resolves the
  `mcp.json` path and forwards it to `claude-cli` via `--mcp-config`,
  which loads its own connections.
- **Non-Claude path** (ollama, openrouter, opencode, openai, gemini,
  adk, gemini-cli): `AgentProcess` constructs a session-scoped
  `McpClientPool` lazily on first `start()`, attaches it to
  `AdapterRequest.mcpPool`, and `LanguageModelBridge` wraps it together
  with the builtin executor in a `MergedToolExecutor`. Resume turns
  (`sendInput`) reuse the same pool — no reconnect cost. `kill()`
  cancels in-flight MCP calls (via `notifications/cancelled`) and
  closes the pool.
- **Per-stage allowlist** (`core-pipeline/src/routing/stage-permissions.ts`):
  `STAGE_MCP_ALLOW` declares which MCP tool ids each stage may call.
  `mcp__*` is a shortcut that the merged executor expands to per-server
  globs when the pool reports its server set. Destructive MCP tools
  (annotated `destructiveHint: true`) are hidden from the model unless
  the stage's allowlist names them exactly — opt-in per-tool, not
  per-server.
- **Failure isolation**: one server failing to connect doesn't fail the
  spawn. The pool records `{ server, reason }` in `failures[]`; the
  agent still runs with the other servers + the builtins.

### Stopping a build — UI first, kill chain in background

`stop-run` removes the run from `activeRuns` AND broadcasts FIRST,
then defers `runner.cancel()` + the agent-kill walk into a
`queueMicrotask` so the UI gets its `active-runs` payload without
waiting for any of that to finish. The runner's `cancel()` is
synchronous (sets `this.cancelled = true`), but if its body is stuck
inside an `await` with no `AbortSignal` wired (e.g. a hung HTTP
fetch in a non-Claude adapter, an embedder call inside KB
retrieval), flipping the flag won't unblock it. We accept that the
runner may keep churning in the background until the underlying
Promise rejects on its own — the user's Active Runs row is gone
immediately, which is what matters. The kill chain
(`AgentManager.kill` → `AgentProcess.kill` → `adapter.kill()` →
per-call `AbortController`) still runs and severs in-flight HTTP
requests on Ollama/OpenRouter/OpenCode adapters + SIGTERMs CLI
subprocesses; it just happens *after* the UI has updated.

**Optimistic placeholder for Build clicks.** The frontend inserts a
`pending-build-<base36>` row into `activeRunsList` the moment the
user clicks Build, so the run appears in Active Runs instantly
instead of after the server round-trip. When the server's
`active-runs` payload arrives, the reducer at
`src/main.tsx:506` MERGES (not replaces) — preserving any
`pending-*` rows whose `(project, description, type)` triple isn't
yet present in the server list. After 15 s a pending placeholder
that's never been claimed is dropped (treated as orphaned —
server rejected the start). Without this merge, the placeholder
would be wiped on the very next server broadcast and the user would
see nothing until the server got around to registering the run.

### PR URL extraction from `tool_result`

`gh pr create`'s URL appears in the agent's `tool_result` content,
not in a top-level text block. The bridge's `handleUserBlocks` emits
a `kind:'text'` activity for each `tool_result` (capped at 4 KB) so
the dashboard's `extractPRUrls(content)` scanner picks it up. The
URL lands in the active run's `prUrls: Set<string>` and surfaces in
the run-history detail view as soon as `gh pr create` returns.

### Tool-naming convention in the Changes panel

Filter uses `Set` dispatch to accept BOTH Claude-CLI PascalCase
(`Edit`, `Write`, `file_path`) AND `BuiltinToolExecutor` snake_case
(`edit`, `write_file`, `path`):

```ts
const editTools  = new Set(['Edit', 'edit']);
const writeTools = new Set(['Write', 'write_file']);
const filePath   = input.file_path ?? input.path;
```

Without this, file changes from non-Claude adapters never render.

### `ALLOWED_ENV_KEYS` (the WS env-write contract)

`set-env-var` only writes keys present in `ALLOWED_ENV_KEYS`
(`server/dashboard-server.ts`). Adding a new provider env var
requires adding it here; otherwise the Settings UI cannot persist
the value.

Currently allowed (highlights):
- `OPENCODE_API_KEY`, `OPENCODE_BASE_URL`
- `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` /
  `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`
- `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
  `OTEL_RESOURCE_ATTRIBUTES`
- `ANVIL_OTEL_CONSOLE`, `ANVIL_OTEL_DISABLED`,
  `ANVIL_OTEL_RECORD_CONTENT`, `ANVIL_ENV`

`test-auth` has a dedicated branch per provider (e.g. `opencode`
issues `GET /v1/models` with the Bearer token).

### OTel auto-detection

On startup `autoDetectTelemetry()` probes `localhost:3000` (HEAD on
`/`, ~800 ms). If alive AND the user hasn't already set
`OTEL_EXPORTER_OTLP_ENDPOINT`, the dashboard auto-wires it to
`localhost:3000/api/public/otel/v1/traces` so the local Langfuse
stack at `infra/observability/docker-compose.yml` lights up with
zero config. `ANVIL_OTEL_DISABLED=1` short-circuits the probe;
`ANVIL_OTEL_CONSOLE=1` dumps spans to stderr.

### Project-prompt cache invariants (P1)

`buildProjectPromptHelper` / `buildRepoProjectPromptHelper` results
are cached on `pipeline-runner.ts` keyed by
`(projectId, repoName?, stageBucket)`. Mutating these prompts mid-run
breaks reproducibility — only invalidate on explicit `clearCache()`.

## Things that don't exist in this package (intentionally)

- No legacy if-tree orchestrator. The dashboard rides on
  `@anvil/core-pipeline` indirectly (via `pipeline-runner.ts`'s Step
  factories). The cli still has the legacy if-tree and the
  consolidation is in flight (see `CORE-PIPELINE-CONSOLIDATION-*.md`
  at the repo root).
- No feature flags. Per the dashboard-consolidation rule we don't
  gate behavior changes on flags — branch-parity diff replaces
  flag-gated rollout (see `feedback_no_feature_flags_dashboard_consolidation`
  in user memory).
- No vendor LLM SDK imports. All provider work routes through
  `@anvil/agent-core`'s `AgentManager`.
- No reimplementation of indexing / retrieval. `KnowledgeBaseManager`
  in `server/knowledge-base-manager.ts` is a thin wrapper: it
  dynamic-imports `@esankhan3/anvil-knowledge-core`'s `KnowledgeIndexer`
  + `getRetriever` for chunking, AST graph build, embeddings, LanceDB,
  and hybrid retrieval. The dashboard owns only the lifecycle layer on
  top — `origin/main` SHA resolution + detached `git worktree` so the
  user's working tree isn't touched, `getRepoStatus` / `getStatus` for
  the Project Overview UI (reads knowledge-core's `index_meta.json` for
  `lastIndexedSha` / `lastIndexedAt`), `SYSTEM_REPORT.md` deterministic
  synthesis (cheap companion to knowledge-core's LLM-driven
  `PROJECT_SUMMARY.md`), `project_index.json` compact keyword index for
  prompt injection, yaml-based transport extraction, and the in-flight
  hybrid-context cache (`prefetchHybridContext`).

## Where to look first

- Adding a new pipeline stage? `core-pipeline/src/stages/registry.ts`
  is the canonical `STAGES` array; the per-stage body lives in
  `pipeline-runner.ts:runOneStage` (split by `stage.name`); the actual
  agent prompt + dispatch lives in `core-pipeline/src/stages/<name>.ts`.
- Pipeline orchestration end-to-end? `pipeline-runner.ts:run()` →
  builds `pipelineBus` + `buildPipelineStepRegistry` →
  `new Pipeline().run()`. Each Step's `run()` calls
  `runOneStage(i)`. Cancellation / fail-early-return / reviewer rewind
  flow through thrown sentinel errors.
- WS message vocabulary? `server/handlers/registry.ts` +
  `server/handlers/route.ts` are the typed dispatch surface. One
  handler file per domain under `server/handlers/<domain>.ts`. Don't
  add a `case '<msg>'` switch to `dashboard-server.ts` — register
  through the handler registry so it gets the typed `HandlerExtras`
  bag.
- Stage doing the wrong work (e.g. ship/validate editing source
  code instead of opening a PR / running tests)? Check
  `core-pipeline/src/routing/stage-permissions.ts` — `ship` and
  `validate` are currently `['read', 'write', 'exec']` so the model
  has `edit` + `write_file` even though the prompts forbid it. The
  prompt is a soft constraint; permissions are the hard one. Tighten
  perms before tightening prompts.
- Settings UI doesn't show a provider? `server/provider-registry.ts`
  detects via env-var presence; the Settings panel reads
  `discover-providers`.
- PR URLs not surfacing? Verify the bridge's `handleUserBlocks`
  emits `kind:'text'` for `tool_result` (the source of truth lives
  in `@anvil/agent-core`'s `language-model-bridge.ts`).
- Activity log shows one word per row? Check that the adapter's
  `emitContent` is buffered (flush on '\n' OR ~80 chars) — the
  pattern lives in agent-core's `OpenRouterAdapter` /
  `OllamaAdapter`.
- Per-repo stage advancing despite failures? Verify the
  `failedRepos.length > 0 → throw` branch in `pipeline-runner.ts`.

## Architecture + flow docs

- `README.md` — package overview, build commands, storage layout,
  pipeline runner shape, provider matrix.
- `ARCHITECTURE.md` — module map, single-process layout, WS protocol
  surface, hot-path sequence.

## Durable execution (server wiring)

**v0.3.0** wires the dashboard to `@esankhan3/anvil-core-pipeline`'s
durable execution module. Three boot-time daemons + a runner
integration + four WS handlers + three React surfaces.

**Server wiring** (the dashboard IS the orchestrator that drives
durable runs):
- **`server/durable-store-singleton.ts`** — process-wide SQLite store
  at `~/.anvil/durable.db`. `getDurableStore()` returns the shared
  handle; `null` when `ANVIL_DURABLE_DISABLED=1` (opt-out for tests).
  `durableHolderId()` returns `${pid}@${hostname}` for lease tracking.
- **`server/durable-migration.ts`** — boot scanner. Pattern-1 sweep
  (incomplete audit logs → durable table as `failed` + marker) +
  orphan takeover (claim expired leases via `tryTakeOverLease`).
  Set `ANVIL_DURABLE_AUTO_TAKEOVER=0` to revert to mark-failed.
- **`server/durable-vacuum.ts`** — `scheduleDurableVacuum(store)`
  runs once at boot + daily on `setInterval`. Drops terminal runs
  older than `ANVIL_DURABLE_RETENTION_DAYS` (default 30).
- **`server/durable-resume-queue.ts`** — `dispatchTakenOverRuns()`
  derives resume-from-stage from cursor + events, calls
  `startPipeline(project, feature, {resumeFromStage})`. **Disabled by
  default** as of 2026-05-17 — auto-starting an old run on every
  dashboard boot is surprising and ties the user's hands. Set
  `ANVIL_DURABLE_AUTO_RESUME=1` to opt in.
- **`server/setup/durable.ts`** — `bootDurable()` orchestrates the
  three daemons above. Called from `dashboard-server.ts` near the end
  of boot, before `listenAndReturnHandle`. Returns a stop handle
  registered with the shutdown chain. **Orphan-claim status flip**:
  `tryTakeOverLease` updates only the `lease_holder` + `lease_expires`
  columns; it does NOT touch `status`. So when an old dashboard died
  with a run at `status='running'`, the row stays `running` even
  after takeover. To prevent the UI from rendering "auto-resumed"
  green-pulsing entries that aren't actually executing, `bootDurable`
  now flips claimed orphans to `paused` whenever auto-resume is
  disabled. Boot log:
  `[dashboard] auto-resume disabled — N orphan(s) marked paused`.
- **`server/pipeline-runner.ts`** — every `run()` acquires a lease
  via `LeaseManager`, attaches `attachDurableLogHook(bus, store,
  runId)`, threads `durableStore` + `durableHolder` into
  `Pipeline.run()`. On termination releases the lease + stops the
  heartbeat. Q&A reviewer-decision waits go through
  `ctx.waitForSignal()` so they survive process restart.

**WS handlers** (in `server/handlers/durable.ts`):
- `get-durable-timeline` → `{run, events}` for the Run Detail UI.
- `provide-stage-answer` → routes Q&A answer to active runner;
  emits a durable signal so crash-recovery skips past the pause.

**React surfaces**:
- `/policy` route — `src/components/policy/PolicyPage.tsx` —
  pause-stage toggles, cost-budget caps, auto-approve thresholds,
  Q&A enabled flag + max-questions.
- `RunDetail → Durable execution log` — collapsible disclosure that
  mounts `DurableTimeline` to render per-run event log.
- `PipelineContainer → StageQuestionsPanel` — surfaces in-flight
  agent Q&A; user types answers; sends `provide-stage-answer`.
- **`Active Runs row → Replay button`** — for any row with status
  `failed` / `cancelled` / `paused`, surfaces a Replay action that
  sends `{action:'resume', runId}` to the server. The server's
  `runs-pipeline.ts:resume` handler reads durable storage to derive
  the resume-from-stage and re-dispatches via `startPipeline`. This
  is how users manually replay orphan-claimed runs now that
  auto-resume is off by default.
- **`RunDetail → Replay button`** (top right) — same wire as
  Active Runs' button. Alt-click opens a stage picker for resume
  from an arbitrary stage. The previously-adjacent Rollback button
  was removed — rollback semantics weren't reliable, and the
  reviewer's revert flow has its own surface.

**Wire-protocol gotcha for durable WS handlers**: the dashboard's
handler registry routes on `msg.action`, not `msg.type`. The
original `DurableTimeline.tsx` sent
`{ type: 'get-durable-timeline', runId }` and the server silently
dropped the message — the timeline disclosure spun on "Loading…"
forever. Any new durable component MUST use
`ws.send(JSON.stringify({ action: '<handler-name>', ... }))`.

**Env knobs**:
- `ANVIL_DURABLE_DISABLED=1` — bypass durable persistence entirely.
- `ANVIL_DURABLE_AUTO_TAKEOVER=0` — disable orphan claiming.
- `ANVIL_DURABLE_AUTO_RESUME=0` — disable auto-resume dispatch.
- `ANVIL_DURABLE_VACUUM_DISABLED=1` — disable retention sweep.
- `ANVIL_DURABLE_RETENTION_DAYS=30` — retention window.

**Where to look first** (durable-specific):
- New durable WS message? Add a route to
  `server/handlers/durable.ts` + register via `durableRoutes()` in
  `handlers/registry.ts`.
- Effect not replaying? `core-pipeline/src/durable/effect-runtime.ts`
  + `npm run -w @esankhan3/anvil-core-pipeline durable-lint`.
- Auto-takeover not firing? `server/setup/durable.ts` → log line
  `[dashboard] auto-takeover: claimed N orphaned run(s)`.
