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

## Things that don't exist in this package (intentionally)

- No durable execution. We're at "Pattern 1" (audit-log + state-file
  granularity). Step-level cross-process replay (Pattern 2) is
  deferred until step boundaries stabilize. See P7 in
  `CORE-PIPELINE-EXTRACT-ADR.md`.
- No cross-process pub/sub. `EventBus` is in-process only. Distant
  consumers (other CLI invocations, dashboards) read via the audit
  log + state file. P10.
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
