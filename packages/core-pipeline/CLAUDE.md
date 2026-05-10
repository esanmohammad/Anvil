# CLAUDE.md — `@anvil/core-pipeline`

Guidance for Claude Code when working inside `packages/core-pipeline/`.
Typed `Step<I, O>` graph + `EventBus` + `StepRegistry` + lifecycle
hooks. Decouples pipeline orchestration from cli's monolithic
`orchestrator.ts` if-tree so dashboard / cli / future tooling can
drive the same pipeline shape.

## What this package owns

- **`Step<I, O>` contract** (`src/types.ts`) — `id`, async `run(ctx)`,
  optional `subSteps`, optional `retryPolicy` (attempts, backoff,
  retryOn), optional `parallelism: 'serial' | 'per-project' | 'per-repo'`.
- **`StepContext<I>`** — `runId`, `workspaceDir`, `repoPaths?`,
  `input` (prior step's output), `artifacts` (read-only),
  `emit(artifactId, data)`, `bus`, `memory?`, `llm?`, `signal`,
  and `shared: Record<string, unknown>` for cross-stage state that
  doesn't fit the `I→O` chain (D4 in
  `CORE-PIPELINE-CONSOLIDATION-ADR.md`).
- **`EventBus`** (`src/event-bus.ts`) — async-aware `emit` (awaits
  listeners) + `emitFireAndForget` for non-critical updates +
  `request<P, R>(channel, payload)` / `respond<R>(channel, requestId,
  response)` for human-in-the-loop steps (clarify Q&A, approval gate).
- **`StepRegistry`** (`src/step-registry.ts`) — `register`,
  `insertBefore`, `insertAfter`, `replace`, `remove`. ID-based
  extension (Hapi.js plugin lifecycle pattern).
- **`Pipeline`** (`src/pipeline.ts`) — graph walker. Iterates the
  registry in order, threads each Step's output into the next
  Step's `ctx.input`, fans out per-repo when `parallelism:
  'per-repo'`, runs `subSteps` sequentially before the parent's
  `run()`, applies `retryPolicy` to each Step. Accepts
  `{ resumeFromStep?, completedSteps? }` so resume-from-stage
  works (see `step:skipped` event).
- **Lifecycle hooks** (`src/hooks/`) — in-tree hooks:
    - `attachAuditLogHook` — JSONL audit at
      `~/.anvil/runs/<runId>/audit.jsonl`.
    - `attachDashboardStateHook` — debounced JSON snapshot at
      `~/.anvil/state.json`.
    - `attachDashboardStateRollupHook` — mutates a caller-supplied
      `state` object on `pipeline:*` / `step:*` / `stage:repo-progress`
      / `stage:cost-update` / `stage:fix-attempt` / `reviewer:note` and
      fires a debounced `broadcast()` callback. Replaces the
      dashboard's ~30 inline `this.broadcastState()` calls. See ADR
      §4.5.
    - `attachCostTrackerHook` — running USD spend; `.totals()`.
    - `attachLearnersHook` — invokes memory-core write-back on
      `step:completed`. Wires the previously-dead `autoLearnHook`.
    - `attachRunStoreHook` — persists run records (caller-injected
      `RunStore` shape).
    - `attachFeatureStoreHook` — writes known artifacts to
      `~/.anvil/features/<project>/<slug>/`.
    - `attachApprovalGateHook` — wires `bus.request('approval:gate',
      stageIndex)` to a caller-injected `getApprovalDecision(...)`.
      cli provides a stdin/state-file responder; dashboard provides
      a WS responder.
- **Stage permissions** (`src/routing/stage-permissions.ts`) —
  `allowedToolsForStage(stage)` and `permissionClassesForStage(stage)`.
  Both the cli step adapters and the dashboard's pipeline runner
  thread the result into spawn specs as `allowedTools`, which
  `LanguageModelBridge` uses to scope the `BuiltinToolExecutor` for
  non-Claude agentic adapters. The 9 declared stages match the CLI's
  `STAGE_NAMES` plus the dashboard's `test` stage:
  `clarify · requirements · repo-requirements · specs · tasks ·
  build · test · validate · ship`. (Historical: `project-requirements`
  was renamed to `repo-requirements` to match the dashboard naming.)
- **Routing helpers** (`src/routing/`) — `resolveModelForStage`,
  `resolveModelForTask`, `extractTaskEnvelopes`, `loadStagePolicy`,
  `task-envelope`. Pure helpers for picking models per stage / task
  given a `stage-policy.yaml`.

**`stage-policy.yaml` resolution order** (mirrors `models.yaml` so end
users have a single mental model):

```
1. process.env.ANVIL_STAGE_POLICY (full path)
2. <workspaceRoot>/.anvil/stage-policy.yaml         — per-workspace
3. ${ANVIL_HOME or $HOME/.anvil}/stage-policy.yaml  — per-user (canonical)
4. Bundled default at packages/core-pipeline/src/routing/stage-policy.yaml
```

Step 3 is where end users put their custom routing. Bootstrap with:

```sh
cp packages/core-pipeline/src/routing/stage-policy.yaml ~/.anvil/stage-policy.yaml
```

Overrides are **full replacements**, not merges — declare every stage
you want supported, otherwise the resolver throws `UnknownStageError`.
- **Artifact store** (`src/artifacts.ts`) — write-once
  in-memory store. Steps `ctx.emit(id, data)` and downstream Steps
  read from `ctx.artifacts`.
- **Agent invocation surface** (`src/agent-runner.ts`,
  `src/agent-session.ts`) — `AgentRunner` is the canonical one-shot
  shape (`run(req) → AgentRunResult` with output + cost + tokens +
  cache + stop reason). `AgentSession` is the multi-turn shape
  (`start` + `sendInput` + `kill`), used for stages that resume an
  agent across user turns (clarify's explore→Q&A→synthesize, fix-loop's
  iterative fixes). Both consumers (cli's lightweight runner and the
  dashboard's `AgentManagerRunner`/`AgentManagerSession`) implement
  these so stage logic stays substrate-agnostic.
- **Stage logic** (`src/stages/`) — the canonical implementations of
  every pipeline stage owned by this package. Both cli and dashboard
  consume the same primitives:
    - `ship.ts` — `buildShipUserPrompt` (PR creation + nexus deploy
      in one agent turn) + `extractPrUrls` / `extractSandboxUrl`.
    - `per-repo.ts` — `runPerRepoStage(ctx, opts)` over `AgentRunner`.
      Empty-artifact retry baked in (≤50 chars throws retryable
      UpstreamError). Used by repo-requirements / specs / tasks.
    - `build.ts` — `runBuildStage(ctx, opts)` over `AgentRunner`,
      driving per-task spawns through a caller-injected dependency-graph
      scheduler (so node-fs deps stay in dashboard's task-bundler).
    - `validate.ts` — `runValidateStage(ctx, opts)` with built-in
      validate→fix-loop recursion (capped at `maxFixAttempts`,
      default 3). cli adopts and gets the loop for free.
    - `clarify.ts` — `parseClarifyQuestions`, `formatQAPairs`,
      `buildClarifySynthesisPrompt`, `runClarifyQALoop`,
      `deriveClarifyQuestions`. The runner-agnostic primitives;
      callers wire their own input resolver.
    - `qa.ts` — generic stage Q&A primitives shared across the
      planning stages (requirements / repo-requirements / specs).
      Exports `STAGE_QA_PROMPT_HEADER(maxQuestions)` (the prompt
      prefix that opts an agent into asking up to N questions in a
      `<questions>...</questions>` block before producing the
      artifact), `parseStageQuestions(text, max)` (extracts the
      block; `[]` when missing — signal the agent is producing the
      artifact directly), and `formatStageAnswers(pairs)` (renders
      the `<answers>...</answers>` block sent on resume). The
      dashboard's `runStageWithQA` wires these into a multi-turn
      session.
    - `telemetry.ts` — `writePerRepoTelemetry` writes JSONL records to
      `~/.anvil/runs/<runId>/per-repo-telemetry.jsonl` so silent-empty
      artifacts and cost anomalies leave a forensic trail.
    - `types.ts` + `registry.ts` — `StageContext`, `StageOutput`,
      `StageTokens`, the canonical `STAGES` array (9 stages with
      name/label/persona/perRepo).
- **Chain-fallback** (`src/routing/with-fallback.ts`) —
  `runWithChainFallback(opts, attempt)` retries on
  retryable `UpstreamError` (HTTP 429/5xx, or `name === 'UpstreamError'
  && retryable === true`). Burns the failing model in a per-call set;
  caller-supplied `resolveModel(burned)` picks the next chain entry.
  Both cli's lightweight runner and dashboard's `AgentManagerRunner`
  wrap their attempts with this.

Public barrel: `src/index.ts`.

## Build + test

```sh
npm -w @anvil/core-pipeline run build       # tsc -b
npm -w @anvil/core-pipeline test            # node --test on dist/**/*.test.js
```

40+ tests under `src/__tests__/`. Coverage spans bus-request,
resume, shared-state, retry, sub-steps, hooks, stage-permissions,
routing.

## Conventions

### Step authoring

- Steps MUST be idempotent — the walker MAY retry on transient
  failure (per `retryPolicy.retryOn`).
- Steps MUST NOT mutate `ctx.input`. Use `ctx.shared` for
  cross-stage mutable state.
- Steps SHOULD `ctx.emit(artifactId, data)` for any output a
  downstream step needs. Don't return ad-hoc shapes — the pipeline
  threads the return type as `next.ctx.input`, not as artifacts.
- Steps that need stage-scoped tool access (Claude Code, Ollama,
  OpenRouter, OpenCode) MUST source `allowedTools` from
  `allowedToolsForStage(step.id)` — don't hard-code tool lists.

### Hook authoring

- Hooks are subscribers — they own no state the bus doesn't already
  own. State must live in caller-injected dependencies (e.g.
  `RunStore`, file-system path).
- Hooks attach to specific event names with a numeric priority
  convention (audit=100, learners=50, cost-tracker=20,
  dashboard-state=10). Listener registration order is preserved at
  equal priorities (FIFO).
- Hooks MUST tolerate `step:skipped` (resume-from-step) without
  treating it as `step:completed` AND without dropping it
  silently — the convention is "mark done in own state, don't
  emit secondary events".

### `EventBus.request/respond`

Pure addition — synchronous in registering the pending entry before
emitting `request:<channel>`. Default timeout 30 minutes (matches
legacy `waitForApproval`). Don't block the bus — the responder
attaches via `bus.on('request:<channel>')` BEFORE the step that
issues the request runs.

### `parallelism: 'per-repo'`

Fan-out is fail-any: if any repo's `Step.run` rejects, the parent
step rejects. Concurrent steps share `ctx.shared` — Steps are
responsible for their own thread safety inside it (typed contracts
+ explicit locking when relevant; the walker doesn't add a
mutex).

## Durable execution module (`src/durable/`)

Phase D1–D6 + E0–E10 + F1–F9. Implements Pattern-2 — Temporal-class
durable execution where every external effect is checkpointed and
step bodies replay deterministically. See
`docs/durable-execution-plan.md` (engine) +
`docs/durable-effect-conversion-plan.md` (effect-site conversion).

- **`durable/types.ts`** — `RunStatus`, `RunRecord`, `EventRecord`,
  `SignalRecord`, `EffectEventPair`, plus error taxonomy
  (`DeterminismViolationError`, `DurableStoreUnavailableError`,
  `EffectResultNotSerialisableError`, `Pattern1MigrationError`).
- **`durable/store.ts`** — `DurableStore` interface (lifecycle +
  events + signals + lease + vacuum). The single seam every driver
  implements.
- **`durable/sqlite-store.ts`** — `SQLiteDurableStore` (default).
  Better-sqlite3 + WAL mode. Schema in `~/.anvil/durable.db`.
  Three tables: `runs`, `events`, `signals` + `meta`.
- **`durable/in-memory-store.ts`** — `InMemoryDurableStore` (tests
  + dev). Bit-identical contract to the SQLite driver.
- **`durable/effect-runtime.ts`** — `EffectRuntime` implements
  `ctx.effect / now / uuid / random / sleep / waitForSignal`. Owns
  the per-step monotonic effect counter (idx). Replay protocol:
  cursor over recordedEffects; matching `(name, idx)` returns the
  recorded payload; mismatch → `DeterminismViolationError`. The
  optional `effectFilter` predicate scopes the cursor for per-repo
  fanout (Phase F6) — each repo's runtime sees only its own events.
- **`durable/effect-helpers.ts`** — `serializeAgentRunResult` (drops
  Set/Map/Buffer/undefined for JSON round-trip),
  `contentHash(s, len)` (SHA-256 prefix), `artifactIdempotencyKey`
  (stage|scope|hash format).
- **`durable/lease-manager.ts`** — `LeaseManager` with periodic
  heartbeat against `store.renewLease`. Emits `lost` when a peer
  steals the lease. `tryTakeOverLease` for failover; `findOrphanedRuns`
  for boot-time scan.
- **`durable/lint.ts`** — `lintStepSource(src) → LintViolation[]`.
  7 rules: no-direct-{date-now, math-random, crypto-uuid, fs-write,
  fs-read, exec, setTimeout}. `(?<![.\w])` lookbehind avoids
  flagging method calls (e.g. `regex.exec` is fine).
- **`durable/replay-equivalence.ts`** — `seedStoreFromLog` +
  `throwingSpy` / `countingSpy`: test seams for the canonical
  two-pass replay-equivalence test pattern.

### Effect protocol on `StepContext`

`StepContext<I>` extends with six methods (always present; non-durable
mode uses passthrough wrappers):

```ts
ctx.effect<T>(name, fn, opts?): Promise<T>   // record + replay
ctx.now(): Promise<number>                   // recorded Date.now
ctx.uuid(): Promise<string>                  // recorded randomUUID
ctx.random(): Promise<number>                // recorded Math.random
ctx.sleep(ms): Promise<void>                 // durable timer
ctx.waitForSignal<T>(channel): Promise<T>    // durable signal queue
```

`Step` gains optional `version: number` (D4 — mismatch on replay
throws DeterminismViolationError) and `compensate(ctx, output)`
hook (D4 — invoked in reverse order on non-success terminal status).

### Hooks involved

- **`hooks/durable-log.hook.ts`** — primary persistence consumer.
  Priority 200 (above audit-log's 100). Subscribes to step:* +
  effect:* + signal:* events; awaited so a failure rejects the
  bus emit (engine treats this as fatal infra-error).

## Things that don't exist in this package (intentionally)

- No cross-process pub/sub. `EventBus` is in-process only. Distant
  consumers (other CLI invocations, dashboards) read via the
  durable store (primary) + audit log + state file (secondary
  projections).
- No vendor-specific code. Hooks accept structural types
  (e.g. `{ updateRun(record): Promise<void> }` for `RunStore`),
  not concrete classes — the cli passes its `RunStore`, the
  dashboard could pass a different impl.

## Where to look first

- Pipeline run end-to-end? `pipeline.ts:Pipeline.run()`.
- New event type? Add to `StepHookPoint` in `event-bus.ts`, fire
  from `pipeline.ts`, document in README.
- New hook? Mirror `audit-log.hook.ts` shape: factory function that
  returns `void`, subscribes via `bus.on(...)`, accepts an injected
  dep struct, exposes test seams (deterministic clock, fake fs).
- Stage permissions? `routing/stage-permissions.ts` — both lookups
  (`allowedToolsForStage` + `permissionClassesForStage`) round-trip
  through `BuiltinToolExecutor.listSchemas()` in tests.
- New stage logic? `stages/<name>.ts` — write the canonical impl
  taking `StageContext` + opts + `AgentRunner` (or `AgentSession` for
  multi-turn). Both consumers wrap it; behavior parity is the contract.
- Stage Step factory? cli adopts via thin wrappers in
  `cli/src/pipeline/steps/*.step.ts`; dashboard via per-stage delegate
  in `dashboard/server/pipeline-stages.ts:runOneStage`. Either way the
  underlying body is the function in `stages/`.
- Durable execution end-to-end? `pipeline.ts:Pipeline.run()` opens
  the store + acquires lease + scans `step:completed` events for
  the replay skip set; `buildContext` constructs an `EffectRuntime`
  per step, with the per-repo `effectFilter` for fanout cases.
- New effect site in step body? Wrap in `ctx.effect('<name>', fn,
  opts?)` with stage-prefixed name (e.g. `requirements:spawn-agent`).
  For per-repo, include `repoName` token: `<stage>:spawn-<repo>`.
  Use `idempotencyKey` for external effects that must be exactly-once
  (PR creation, deploy). The D5 lint rule + the `lint:stages` npm
  script catch direct side-effect calls.
- Replay equivalence proof? Pattern: pass-1 captures the durable
  log live; pass-2 seeds an InMemoryDurableStore from the log + uses
  `throwingSpy()` in the spawn closures; assert zero invocations.
  See `__tests__/effect-replay-equivalence.test.ts` for fixtures.

## Browser + web tool surface (Phase H0)

`tools/web-types.ts` + `tools/web-tool-registry.ts` declare the type
surface and per-stage permission classes for the three-tier
browser/web tool plan (`docs/browser-web-tools-plan.md`):

- **WebToolClass**: `network` (web.*) | `browse-headless` (browser.*
  excl. evaluate) | `browse-eval` (browser.evaluate) | `browse-pixel`
  (computer.*).
- **`STAGE_WEB_PERMISSIONS`** layers on top of `STAGE_TOOL_PERMISSIONS`.
  `build` and `ship` are network-blocked; `validate` gets the most
  (network + headless + eval + pixel); analysis stages get `network`
  only.
- **`allowedToolsForStage(stage)`** now merges the FS surface
  (read/write/exec) with the web tool surface — callers see one
  unified list.
- **`stage-policy.yaml`** ships two routing stages: `web-summarizer`
  (used by `web.fetch`) and `browser-extractor` (used by
  `browser.extract`). Both `prefer: [local, cheap]` — Haiku/Flash/8B
  class. The dashboard-side summarizer falls back to `research` when
  these stages aren't in the user's `stage-policy.yaml`.
- **`tools/effect-wrapping.ts`** — `wrapWebEffect(ctx, name, key, fn)`
  + canonical idempotency-key builders for search / fetch / navigate
  / extract. Effect names follow the §J convention: `web:search:<hash>`,
  `web:fetch:<urlHash>`, `browser:navigate:<urlHash>`, etc. The dashboard
  registers the active step context via agent-core's
  `setCurrentStepContext` so the WebToolExecutor wraps tool calls
  automatically.

Implementation lives in agent-core (executor + composite + domain
matcher) and dashboard (backends + bridge + browser session
manager).

## Sandbox isolation contract (Phases S0–S13)

Phase S0 introduced the `SandboxRunner` / `SandboxHandle` contract;
Phase S6 wired it into the durable execution log; Phase S12 flipped
the default mode for `build` / `test` / `validate` / `ship` / `fix` /
`fix-loop` from `'none'` to `'container'`.

- **`src/sandbox/types.ts`** — full TS surface for runners and handles
  (`SandboxRunner`, `SandboxHandle`, `AcquireSandboxOpts`,
  `SandboxLimits`, `NetworkPolicy`, `SandboxExecArgs`,
  `SandboxExecResult`, `SandboxSnapshot`, `SandboxSyncResult`,
  `StageSandboxPolicyEntry`, `SandboxDeterminismViolationError`).
- **`src/sandbox/none-runner.ts`** — `NoneSandboxRunner` /
  `NoneSandboxHandle`. Passthrough — runs `sh -c` on the host. Default
  for read-only stages.
- **`src/sandbox/runner-registry.ts`** — process-wide factory
  (`registerSandboxRunner` / `getSandboxRunner`). Concrete Mode 1/2
  runners (Docker, Firecracker, gVisor) live in dashboard + register
  at boot.
- **`src/sandbox/state-hash.ts`** — `hashWorkdir()` content-addressed
  Merkle digest of the workdir for replay determinism. Skip-globs for
  `node_modules` / `.git` / `dist` / `target` / `.cargo`. `StatHashCache`
  keyed on `(path, size, mtimeMs)` for ~free re-hashing between turns.
- **`src/sandbox/durable-wrap.ts`** — wrappers that record each
  acquire/exec/write/edit/sync/close as a `ctx.effect()`. Idempotency
  keys per §I.2:
  - `exec` keyed on `contentHash(command + sandboxStateHash)` — replay
    determinism is bounded by input state.
  - `acquire` keyed on `(runId, stage, image, limitsHash)`.
  - `write` keyed on `(runId, stage, path, contentHash(content))`.
  - `edit` keyed on `(runId, stage, path, contentHash(old + new))`.
- **`src/routing/sandbox-policy.ts`** — `STAGE_SANDBOX_POLICY` table +
  `sandboxPolicyForStage` + `mergeStageSandboxPolicy`. Read-only
  stages default to `mode='none'`; execute stages default to
  `mode='container'` (post-S12). Policy is overridable via the
  dashboard's `pipeline-policy.overlay.json: sandbox.*` block.

**User guide** — `docs/sandbox-isolation-guide.md`. Plan reference:
`docs/sandbox-isolation-plan.md`.

## Related ADRs

- `CORE-PIPELINE-EXTRACT-ADR.md` — original extraction (P1–P10).
  Status: shipped through Phase 9.
- `CORE-PIPELINE-CONSOLIDATION-ADR.md` — cli's strangler-fig migration
  off the legacy if-tree (D1–D11). Status: in-flight; dashboard
  already on `core-pipeline`.

## Architecture + flow docs

- `README.md` — user-facing walkthrough, quick-start, hook table,
  custom-stages shim, env vars.
- `ARCHITECTURE.md` — module map, layering, file layout.
