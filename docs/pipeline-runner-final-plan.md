# Pipeline-Runner Final Slim — Executable Plan

**Goal:** `packages/dashboard/server/pipeline-runner.ts` from **2647 LOC → ≤600 LOC**, behavior-identical, tests at baseline (511/518), cli + dashboard build clean.

**Branch:** `feat/harness-improvment` (current head: `4afa857`).

**Non-negotiables:**
- Every commit compiles + passes the test contract: `npm -w @esankhan3/anvil-core-pipeline test`, `npx tsc -p packages/dashboard/server/tsconfig.json`, `node --test packages/dashboard/server/out/__tests__/*.test.js` ≥ 511 pass / 7 fail (baseline preserved), `npm -w @esankhan3/anvil-cli run build`.
- Every commit is one phase. No half-phases.
- WS event vocabulary stays byte-identical (the rollup hook + stream hook drive `state-change` broadcasts).
- No new tests added past those that already pin extracted helpers — the file split is structurally pure.

---

## Honest accounting of what's in the 2647 LOC today

Verified counts from the live file:

| Block | LOC | What | Where it goes |
|---|---:|---|---|
| Imports + module-level fns (`checkClaudeAuth`, `refreshClaudeAuth`) | ~205 | Top-of-file scaffolding | Stays + extracted to `claude-auth.ts` |
| Class fields | ~45 | private state slots | Stays |
| **A — Manifest helpers** | **~340** | `populateManifestFromPlan`, `renderPlanDerivedArtifact`, `extractAndUpdateManifest`, `clearManifestFieldsForStages`, `getTouchedFiles`, `getPlanRisk` | **`manifest-bridge.ts` (extracted)** |
| Reviewer state mutations | ~70 | `applyArtifactEdit`, `resetStagesForRerun` | Stays (touch state + checkpoint) |
| **B — Model resolution** | **~175** | `resolveModelForStage`, `pickModelForStage`, `allowedToolsForCurrentStage`, `recordResolvedStageState`, `prefetchProviderLiveness` | **`model-resolution.ts` (extracted)** |
| `getPromptContext` | ~32 | Bundles cache deps for prompt-builders | Stays |
| Constructor + small public API | ~155 | `constructor`, `getState`, `getStageAgentId`, `getCurrentAgentId`, `provideInput`, `cancel`, `setAfterStageHook`, `checkpoint`/`clearCheckpoint` thin wrappers | Stays |
| **C — Auth + telemetry** | **~200** | `ensureAuth`, `handleOutputTruncation`, `aggregateRunTokens`, `logCacheTelemetry`, `writePerRepoTelemetry` | **`runner-telemetry.ts` + `claude-auth.ts` (extracted)** |
| **D — Bootstrap + I/O** | **~270** | `setupWorkspace`, `getBaseBranch`, `pullLatestMain`, `loadPriorArtifacts`, `loadStageArtifact`, `detectRepos`, `loadRepoArtifacts`, `loadHighLevelRequirements`, `writeStageArtifact`, `writeRepoArtifact` | **`pipeline-bootstrap.ts` + `artifact-io.ts` (extracted)** |
| **E — Per-stage methods + runOneStage** | **~930** | `runOneStage`, `runClarifyStage`, `runPerRepoStage`, `runBuildForRepo`, `runSingleStage`, `runTestGenStage`, `runFixLoop` | **Collapsed** to factory wiring on `buildStandardStepRegistry` + canonical step factories |
| `run()` main loop | ~325 | The for-loop + hook attachments + completion branches | **Rewritten** to ≤80 LOC: build registry, attach hooks, call `Pipeline.run()`, listen for completion |
| `makeAgentSession`, `makeAgentRunner` | ~75 | Constructs canonical runners | Stays (small) |
| Trailing helpers (`broadcastState`, etc.) | ~25 | One-liners | Stays |

**Sum that EXITS the file:** ~340 + ~175 + ~200 + ~270 + ~930 = **~1915 LOC moved or collapsed**.
**Sum that STAYS:** ~205 (imports) + ~45 (fields) + ~70 (reviewer mut) + ~32 (getPromptContext) + ~155 (constructor + API) + ~75 (runner factories) + ~25 (helpers) + ~80 (rewritten run) = **~687 LOC**.

The 600 LOC target is achievable with one more disciplined squeeze: hoist constructor initialization (~80 LOC of `new ProjectLoader()` / `new MemoryStore()` etc.) into a `runner-deps.ts` factory, drop dead exports, inline tiny field-init blocks. Realistic landing: **~580 LOC**.

---

## The 7-phase execution plan (commit-by-commit)

Each phase is one commit. All preserve behavior. Test contract green at every commit.

### Phase X1 — Extract manifest bridge (`manifest-bridge.ts`)

**Why first:** Self-contained; no agent calls, no state mutations beyond what's already isolated. Lowest risk.

**Move:**
- `getTouchedFiles()` → `manifestGetTouchedFiles(deps)`
- `getPlanRisk()` → `manifestGetPlanRisk(state, riskCache)` (the cache becomes a `{ tier, confidence } | null` field on a small `RiskCache` class)
- `populateManifestFromPlan(plan)` → `populateManifestFromPlan({ project, slug, feature, manifestStore }, plan)`
- `renderPlanDerivedArtifact(stageName, stageIndex)` → `renderPlanDerivedArtifact({ state, config, manifestStore, featureStore, broadcast, checkpoint }, stageName, stageIndex)`
- `extractAndUpdateManifest(stage, artifact)` → `extractAndUpdateManifest({ project, slug, manifestStore, invalidateCache, emitEvent }, stage, artifact)`
- `clearManifestFieldsForStages(fromIndex, toIndex)` → `clearManifestFieldsForStages({ project, slug, manifestStore }, fromIndex, toIndex)`

**Runner changes:** delete the 6 method bodies; `this.X(...)` → `manifestX(this.depsForManifest(), ...)`. Add a private `depsForManifest()` getter that bundles the relevant `this.*` refs (one-time construction, ~12 LOC).

**LOC delta:** -340 LOC (runner) → ~580 LOC in new sibling file. **Runner: 2647 → 2307.**

**Test contract:** clean. New file has 0 tests; canonical test surface untouched.

---

### Phase X2 — Extract model resolution (`model-resolution.ts`)

**Move:**
- `resolveModelForStage` → `resolveModelForStage({ config, walkerConfig, state, modelRegistry, runtimeBurnedModels })`
- `pickModelForStage` → same opts bag
- `allowedToolsForCurrentStage` → `allowedToolsForCurrentStage({ config, projectLoader }, stageName)`
- `recordResolvedStageState` → `recordResolvedStageState({ state, broadcast }, stageName, model)`
- `prefetchProviderLiveness` → `prefetchProviderLiveness({ walkerConfig, modelRegistry, state, emitEvent })`

**Runner changes:** delete 5 method bodies; call sites pass `this.depsForResolution()`.

**LOC delta:** -175 LOC. **Runner: 2307 → 2132.**

---

### Phase X3 — Extract auth + telemetry (`claude-auth.ts` + `runner-telemetry.ts`)

**Two siblings, one commit:**

`claude-auth.ts` (already top-level functions `checkClaudeAuth` + `refreshClaudeAuth` — 50 LOC moves out cleanly).

`runner-telemetry.ts`:
- `ensureAuth` → `ensureAuth({ state, broadcast, checkpoint, emit, resolveModel }, stageName)` (95 LOC)
- `handleOutputTruncation` → free function (25 LOC)
- `aggregateRunTokens` → free function (28 LOC)
- `logCacheTelemetry` → free function (22 LOC)
- `writePerRepoTelemetry` → free function over `writePerRepoTelemetryShared` (28 LOC — already a delegating wrapper)

**LOC delta:** -200 LOC + -50 LOC = -250 LOC (some of which is module-level, not method body). **Runner: 2132 → 1882.**

---

### Phase X4 — Extract bootstrap + artifact I/O (`pipeline-bootstrap.ts` + `artifact-io.ts`)

**Two siblings, one commit:**

`pipeline-bootstrap.ts`:
- `setupWorkspace` → `setupWorkspace({ config, projectLoader, state, emit, setProjectInfo, setRepoPaths, broadcast, checkpoint, pullLatest })`
- `getBaseBranch` → free function
- `pullLatestMain` → free function (already delegates to `pullBaseBranchForRepos`)
- `detectRepos` → `detectRepos({ workspaceDir, repoPaths, state, broadcast })`

`artifact-io.ts`:
- `loadPriorArtifacts` → `loadPriorArtifacts({ config, state, featureStore }, upToStage)`
- `loadStageArtifact` → `loadStageArtifact({ config, state, featureStore }, stage)`
- `loadRepoArtifacts` → `loadRepoArtifacts({ config, state, featureStore }, repoName)`
- `loadHighLevelRequirements` → `loadHighLevelRequirements({ config, state, featureStore })`
- `writeStageArtifact` → `writeStageArtifact({ config, state, featureStore, emit }, stage, artifact)`
- `writeRepoArtifact` → `writeRepoArtifact({ config, state, featureStore, emit }, stage, repoName, artifact)`

**LOC delta:** -270 LOC. **Runner: 1882 → 1612.**

---

### Phase X5 — Build a `dashboardStepRegistry` factory

**The pivot.** This phase doesn't touch the runner — it lands a `dashboard-step-registry.ts` that, given the runner's deps, builds an `InMemoryStepRegistry` with all 9 stages registered. Each registered Step is a thin wrapper around the canonical step factory in core-pipeline (which all already exist from Phases H1-H13).

```ts
export function buildDashboardStepRegistry(deps: DashboardStepDeps): InMemoryStepRegistry {
  const registry = buildStandardStepRegistry({
    skipIfByStage: { /* unchanged from D1 */ },
  });
  registry.replace('clarify', createClarifyStageStep({
    agentManager: deps.agentManager,
    project: deps.project,
    workspaceDir: deps.workspaceDir,
    model: deps.resolveModel('clarify'),
    buildExplorePrompt: () => buildClarifyExplorePromptHelper(deps.promptCtx()),
    buildProjectPrompt: () => buildProjectPromptHelper(deps.promptCtx(), STAGES[0]),
    inputResolver: (q, i, n) => deps.resolveUserInput(q, i, n),
    onAgentSpawned: (id) => deps.recordStageAgent('clarify', id),
    onTruncation: deps.handleTruncation,
    onClarifyQuestion: deps.broadcastClarifyQuestion,
    onWaitingForInput: deps.broadcastWaiting,
    onAnswerReceived: deps.broadcastAnswer,
    onClarifyAck: deps.broadcastClarifyAck,
    onSynthesizeStart: deps.broadcastSynthesizeStart,
  }));
  registry.replace('repo-requirements', createPerRepoStageStep({ runner: deps.makeAgentRunner('repo-requirements'), project: deps.project, stageName: 'repo-requirements', persona: 'analyst', model: deps.resolveModel('repo-requirements'), maxOutputTokens: maxOutputTokensForStage('repo-requirements'), buildProjectPrompt: (r) => buildRepoProjectPromptHelper(deps.promptCtx(), STAGES[2], r), buildStagePrompt: (r, prev) => buildRepoStagePromptHelper(deps.promptCtx(), STAGES[2], r, prev), onAgentSpawned: deps.recordRepoAgent('repo-requirements'), writeRepoArtifact: deps.writeRepoArtifact('repo-requirements') }));
  // … same shape for specs, tasks, validate ...
  registry.replace('build', createPerRepoBuildStep({ runner: deps.makeAgentRunner('build'), project: deps.project, stageName: 'build', persona: 'engineer', model: deps.resolveModel('build'), buildProjectPrompt: (r) => buildRepoProjectPromptHelper(deps.promptCtx(), STAGES[5], r), loadTasksMarkdown: (r) => deps.loadRepoArtifacts(r).tasks, buildPerTaskPrompt: (r, p, t) => buildPerTaskPromptHelper(deps.promptCtx(), r, p, t, deps.loadRepoArtifacts(r).specs), buildFallbackPrompt: (r) => buildRepoStagePromptHelper(deps.promptCtx(), STAGES[5], r, ''), onProjectEvent: deps.emitProjectEvent, writeRepoArtifact: deps.writeRepoArtifact('build') }));
  registry.replace('test', createTestGenStageStep({ planSeed: deps.config.planSeed, project: deps.project, model: deps.config.model, workspaceDir: deps.workspaceDir, repoLocalPaths: deps.repoPaths, deps: deps.testGenDeps, onConventionsDetected: (label) => deps.markStageArtifact('test', label), onArtifactWritten: deps.broadcastArtifactWritten }));
  registry.replace('ship', /* single-stage ship via canonical runner.run with buildShipUserPrompt */);
  return registry;
}
```

**LOC delta:** runner unchanged this commit; new file ~250 LOC. Lands the substrate Phase X6 needs.

**Test contract:** clean.

---

### Phase X6 — Replace `runOneStage` + per-stage methods with `Pipeline.run()`

**The collapse.** Delete `runOneStage` (~310 LOC), `runClarifyStage` (~100 LOC), `runPerRepoStage` (~310 LOC), `runBuildForRepo` (~70 LOC), `runSingleStage` (~50 LOC), `runFixLoop` (~65 LOC), `runTestGenStage` (~25 LOC). Total: ~930 LOC out.

Rewrite `run()`:

```ts
async run(): Promise<PipelineRunState> {
  if (this.config.resumeFromStage !== undefined) {
    this.state.status = 'running';
    this.state.currentStage = this.config.resumeFromStage;
  }
  await setupWorkspace(this.depsForBootstrap());
  await this.promptCache.warmConventions();
  if (this.config.planSeed) {
    populateManifestFromPlan(this.depsForManifest(), this.config.planSeed.plan);
  }

  // Hooks already wired (lines 956-1100 of current run() — that block stays).
  // ...

  const registry = buildDashboardStepRegistry(this.depsForRegistry());
  const pipeline = new Pipeline({
    bus: this.pipelineBus,
    artifactStore: new InMemoryArtifactStore(),
  });

  let pipelineEarlyReturn = false;
  let rewindToStep: string | undefined;

  do {
    const result = await pipeline.run({
      registry,
      shared: { /* feature, project, planSeed, repoNames, repoPaths */ },
      resumeFromStep: rewindToStep ?? STAGES[this.state.currentStage]?.name,
      completedSteps: STAGES.slice(0, this.state.currentStage).map((s) => s.name),
      signal: this.cancelSignal,
    });
    rewindToStep = undefined;

    // After each stage's completion the bus emits step:completed.
    // Reviewer pause is handled by the bus's afterStageHook subscriber:
    const pauseDecision = await this.invokeAfterStageHook(/* ... */);
    if (pauseDecision === 'rewind') {
      rewindToStep = STAGES[this.consumedRerunRequest.targetIndex].name;
      continue;
    }
    if (pauseDecision === 'cancel') { pipelineEarlyReturn = true; break; }

    if (result.status === 'failed') break;
  } while (rewindToStep);

  this.unsubscribeAllHooks();
  if (this.cancelled) { this.state.status = 'cancelled'; return this.state; }
  if (pipelineEarlyReturn) return this.state;
  this.state.status = 'completed';
  this.broadcastState();
  this.clearCheckpoint();
  return this.state;
}
```

**LOC delta:** -930 LOC stage methods + -250 LOC of run() body ≈ -1180 LOC. Replacement run() body: ~80 LOC. Net: **-1100 LOC.** Runner: 1612 → ~512.

**Risk surface (and how each is closed):**
1. **Per-stage state mutations** (`state.stages[i].status = 'running'` etc.) — handled by `attachDashboardStateRollupHook` (already wired commit `7b90998`). The canonical step factories emit the new bus events; rollup hook applies them to `this.state`.
2. **Cost ledger** — `attachCostTrackerHook` accumulates; rollup hook + cost-tracker both emit through the same totals path.
3. **Per-repo agent ids** — already passed via canonical step `onAgentSpawned` callbacks; mapped to `state.stages[i].repos[r].agentId` by the dashboard's callback closure.
4. **Validate→fix loop** — `createPerRepoStageStep('validate')` runs the validate; the rollup hook emits `stage:fix-attempt` events; a small inline fix-loop driver in `run()` (15 LOC) checks `hasValidationFailures(result.artifact)` and re-invokes the fix step until pass or max attempts.
5. **planSeed-derived stage skipping** — already handled by `skipIfByStage` in `buildStandardStepRegistry` (Phase B) + the `step:skipped` listener in `run()` (Phase D1).
6. **Reviewer rewind** — handled by `Pipeline.run({ rewindTo })` (Phase A1). The `do { ... } while (rewindToStep)` loop above re-runs from the rewind target.
7. **WS event vocabulary parity** — verified by capturing the WS message stream from a known-good run on `main`, then diffing against the rewritten run on a deterministic fixture. Captured below as Phase X7.

**Test contract:** core-pipeline tests untouched. Dashboard tests must stay at 511/518 baseline. Build clean. Behavior verified by parity probe.

---

### Phase X7 — Parity probe + final squeeze to ≤600 LOC

**Parity probe:**
1. Check out `main` (pre-Phase-X). Run a deterministic synthetic feature through the dashboard. Capture:
   - `~/.anvil/runs/<runId>/audit.jsonl` (canonical bus log)
   - WS message stream (recorded via a WebSocket test client)
   - All written artifacts under `~/.anvil/features/<project>/<feature>/`
2. Apply Phases X1-X6. Re-run the same fixture. Capture the same artifacts.
3. Diff with `--ignore-matching-lines='ts:|runId:|agentId:|costUsd:[0-9]'`. Expected: zero non-timestamp/non-runId/non-cost diffs.

**Final squeeze:**
- Hoist constructor's `new ProjectLoader()` / `new MemoryStore()` / `new FeatureStore()` / `new FeatureManifestStore()` / `new KnowledgeBaseManager()` initialization (~50 LOC) into `runner-deps.ts:buildPipelineRunnerDeps(config)`.
- Drop unused `livenessFallbackNotified` field if telemetry-only.
- Inline 1-2 trivial getters that are now called once.

**LOC target:** runner ≤600. Headroom for follow-up if real-world gotchas surface during parity diff.

---

## What this plan does NOT do (and why)

- **No architectural changes to the WS event vocabulary.** D10 invariant — 133 messages stay byte-stable. The rollup hook publishes the same `state-change` shape.
- **No FS layout changes.** `~/.anvil/features/<project>/<slug>/` stays as the dashboard's source of truth; `~/.anvil/runs/<runId>/checkpoint.json` is the additional canonical write from `attachCheckpointHook`.
- **No cli changes.** The cli adopts `buildDashboardStepRegistry`'s sibling pattern in a separate ADR (`CORE-PIPELINE-CONSOLIDATION-ADR.md`); this plan keeps its surface unchanged.
- **No new tests beyond the parity probe.** All canonical step factories already have tests in core-pipeline. The runner is now thin-enough that integration tests cover it through `run()`.

---

## Pre-flight before each commit

```sh
# Standard contract (must pass at every commit):
npm -w @esankhan3/anvil-core-pipeline test                    # 340 ≥ pass = 340, fail = 0
npx tsc -p packages/dashboard/server/tsconfig.json            # clean
node --test packages/dashboard/server/out/__tests__/*.test.js # 511 ≥ pass, 7 ≥ fail (baseline)
npm -w @esankhan3/anvil-cli run build                          # clean
wc -l packages/dashboard/server/pipeline-runner.ts            # monotonically decreasing
```

---

## Final check

| Phase | Runner LOC after | Cumulative −LOC |
|---|---:|---:|
| Today (`4afa857`) | 2647 | 0 |
| X1 — manifest extract | 2307 | −340 |
| X2 — model resolution | 2132 | −515 |
| X3 — auth + telemetry | 1882 | −765 |
| X4 — bootstrap + I/O | 1612 | −1035 |
| X5 — registry factory (no runner change) | 1612 | −1035 |
| X6 — collapse runOneStage + per-stage | 512 | −2135 |
| X7 — parity probe + squeeze | ≤600 | −2047+ |

**That's the plan.** Seven commits, each independently green. The 400 floor is achievable with one more squeeze pass after parity is locked.

Outstanding risk after this plan: the constructor's deps wiring + the `do { } while (rewindTo)` rewind loop. Both are exercised by the parity fixture; any divergence is a tractable bug, not an architectural surprise.
