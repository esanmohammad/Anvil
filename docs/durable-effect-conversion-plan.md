# Effect-Site Conversion Plan — `pipeline-stages.ts` → `ctx.effect`

**Scope:** the long-tail follow-up to durable execution Phase D3.
The engine is solid (D1–D6 shipped); this plan converts every direct
external touch in `dashboard/server/pipeline-stages.ts` (and its
two callers `pipeline-runner.ts` + `pipeline-loop.ts`) into a
checkpointed `ctx.effect(name, fn)` call so a process crash mid-stage
resumes from the last completed effect rather than re-spawning agents.

**Goal:** make every Anvil run idempotent at the agent-spawn /
artifact-write / git-op granularity — re-runs after a crash skip
work the previous process completed instead of re-doing it.

**Branch:** continue on `feat/harness-improvment` (where D1–D6
landed) until conversion completes. Merge to main as one PR per
phase (E1–E10) so each stage's conversion can be reviewed,
benchmarked, and reverted independently.

**Non-negotiables:**
- Test contract green at every commit. Dashboard
  baseline 536/543 (7 pre-existing failures, unchanged); core-pipeline
  414/414. New replay-equivalence tests added per phase.
- Behaviour parity. A run that succeeded before the conversion
  must still succeed with byte-identical artifacts; the only
  visible change is the durable log row count.
- No new prompts shipped to LLMs. Effect names are caller-side
  identifiers; agent prompts stay unchanged.

---

## §A. Why this matters

Today, after D3, the engine has the durable record of step:* events
+ run lifecycle + lease — but step bodies in `pipeline-stages.ts`
still call `runner.run({...})` / `session.start({...})` / `writeFile`
directly. A crash mid-stage 5/9 means:
- The agent that already finished re-spawns on the next process
  (LLM bill fires twice).
- Artifacts that already wrote to disk are re-written.
- The dashboard's run-history shows the run as "in progress" but
  the durable log can't tell the user "we already did stages 1-4
  and the requirements agent already produced its artifact for
  stage 5."

Wrapping each external call in `ctx.effect('stage:thing', () =>
runner.run(...))` lifts every one of those into the durable log.
On resume, the runtime returns the recorded result without
invoking `fn()`. The recorded result is bit-identical to the
previous run, so no surprise diffs.

This is the smallest cohesive change that makes Pattern-2 useful
in production for Anvil's actual workload (long agent runs with
expensive spawns).

---

## §B. Honest site inventory (re-surveyed against the code)

The original durable plan §O listed 38 sites. After surveying the
post-D6 code, the actual checkpoint-worthy sites are **24**.
Telemetry / cost-ledger / state-broadcast calls stay outside the
durable log (they're observable side effects, not workflow effects;
re-emitting them on replay is fine).

### Site categories

| Category | Count | Notes |
|---|---:|---|
| Agent runner spawns (`runner.run({...})`) | 9 | The dominant cost. Each re-run charges the LLM. |
| Agent session start / sendInput | 5 | Multi-turn (clarify, Q&A, fix-loop). Each turn is an independent effect. |
| Artifact writes (`writeStageArtifact*`, `writeRepoArtifact*`) | 4 | Re-writing a file is harmless but wasteful + creates spurious mtime drift. |
| Git ops inside step bodies | 3 | Branch checkout, commit, push. Idempotency keys are critical here. |
| Reviewer pause + Q&A signal consumption | 3 | Already prepared for `ctx.waitForSignal` in D2; this phase wires the producers. |

**Total checkpoint sites: 24.** Telemetry and cost-ledger writes
stay direct (per durable plan §O decision); they're idempotent
appenders on the dashboard's own JSONL files.

### Sites by stage (file: `packages/dashboard/server/pipeline-stages.ts`)

| Stage | Site | Line (approx) | Effect name | Idempotency key |
|---|---|---:|---|---|
| clarify | runClarifyForProject (chain-fallback wrap) | 256 | `clarify:run-for-project` | none (replay-only) |
| clarify | per-question wait | (signal) | `__signal:clarify-q<idx>` | (signal) |
| requirements | session.start (Q&A header) | 590 | `requirements:session-start` | none |
| requirements | session.sendInput (answers) | 663 | `requirements:session-resume` | none |
| requirements | wait for answers | (signal) | `__signal:stage-answer-<idx>` | (signal) |
| repo-requirements | per-repo runner.run | 397 | `repo-requirements:spawn-<repo>` | none |
| repo-requirements | per-repo writeRepoArtifact | 444 | `repo-requirements:write-<repo>` | content-hash |
| specs | per-repo runner.run | 397 | `specs:spawn-<repo>` | none |
| specs | per-repo writeRepoArtifact | 444 | `specs:write-<repo>` | content-hash |
| tasks | runner.run | 692 | `tasks:spawn-agent` | none |
| tasks | writeStageArtifact | 1027 | `tasks:write-artifact` | content-hash |
| build | per-task runner.run | (build.ts) | `build:spawn-task-<repo>-<taskId>` | `<runId>:<repo>:<taskId>` |
| build | per-task writeRepoArtifact | (build.ts) | `build:write-<repo>-<taskId>` | content-hash |
| build | git commit (inside agent prompt — *not* checkpointed) | n/a | n/a | n/a |
| validate | per-repo runner.run | (validate.ts) | `validate:spawn-<repo>` | none |
| validate | writeStageArtifact | 1112 | `validate:write-artifact` | content-hash |
| validate→fix loop | runFixLoop | 758 | `validate:fix-attempt-<n>` | none |
| validate→fix loop | per-attempt session resume | (fix-loop.step.ts) | `validate:fix-resume-<n>` | none |
| test | runTestGenForProject | 729 | `test:spawn-testgen` | none |
| ship | runner.run (PR create + nexus) | (ship-stage path) | `ship:agent-run` | `<runId>:ship` |
| pipeline | reviewer pause | (after-stage hook) | `__signal:reviewer-decision-<i>` | (signal) |
| pipeline | provideStageAnswer Q&A consumption | runner.ts | `__signal:stage-answer-<i>` | (signal) |

**System primitives** (`Date.now()`, `randomUUID()`) inside step
bodies — only converted when they're load-bearing for replay. The
canonical example: `currentStageReviewNote.armedAt = await
ctx.now()` so reviewer-rewind notes time-stamp deterministically.
Surveyed count: 6 sites.

---

## §C. Conversion template

The canonical wrap pattern. Every site looks like one of these
three shapes:

### Shape 1: agent runner spawn (live + replay-aware)

```ts
// before
const result = await runner.run({
  persona, projectPrompt, userPrompt: prompt, workingDir: repoPath,
  stage: stage.name, allowedTools: deps.allowedToolsForCurrentStage(stage.name),
  maxOutputTokens: maxOutputTokensForStage(stage.name),
  repoName,
});

// after
const result = await ctx.effect(
  `${stage.name}:spawn-${repoName ?? 'serial'}`,
  () => runner.run({
    persona, projectPrompt, userPrompt: prompt, workingDir: repoPath,
    stage: stage.name, allowedTools: deps.allowedToolsForCurrentStage(stage.name),
    maxOutputTokens: maxOutputTokensForStage(stage.name),
    repoName,
  }),
);
```

`result` shape is preserved (output / costUsd / tokens / etc.) —
the runtime JSON-round-trips it through the durable log.
**Caveat:** agent results often contain `Set<string>` (PR URLs)
and `Buffer` shapes that don't round-trip cleanly. Step E0 ships a
`serializeAgentRunResult(r)` helper that the wrapper calls before
returning to keep the round-trip tight.

### Shape 2: artifact write (idempotency-keyed by content)

```ts
// before
writeRepoArtifactFn(deps.depsForArtifactIO(), stage, repoName, result.output);

// after
await ctx.effect(
  `${stage.name}:write-${repoName ?? 'stage'}`,
  () => Promise.resolve(writeRepoArtifactFn(deps.depsForArtifactIO(), stage, repoName, result.output)),
  { idempotencyKey: `${stage.name}|${repoName ?? 'stage'}|${sha256(result.output).slice(0, 16)}` },
);
```

`writeRepoArtifactFn` is sync; we wrap it in `Promise.resolve` so the
runtime contract holds. The idempotency key includes the content hash
so a re-run with the same output writes once + idempotency-key check
catches mid-flight content drift (the file lands once; replay is a
no-op).

### Shape 3: signal consumption

```ts
// before (Q&A flow)
const answers = await new Promise<string>((resolve) => {
  deps.setStageInputResolver(index, repoName ?? null, resolve);
});

// after
const answers = await ctx.waitForSignal<string>(`stage-answer-${index}`);
```

Producer side (the dashboard `provide-stage-answer` WS handler):
```ts
// before
runner.provideStageAnswer(stageIndex, repoName, questionIndex, text);

// after — same shape, but underneath it does:
//   await durableStore.enqueueSignal(runId, `stage-answer-${stageIndex}`, formatStageAnswers(pairs));
```

The signal channel name MUST be stable across replays. Using the
stage-index alone for `stage-answer-<idx>` is fine; including
repoName is a regression risk because `repoName` may differ in
case (`Repo` vs `repo`) across runs.

---

## §D. Per-phase delivery

Each phase is one commit. Test contract: green at every commit.
After every phase we add a **replay-equivalence integration test**
that:
1. Runs the converted stage once with all effects firing; captures
   the durable log.
2. Re-runs with a fresh `InMemoryDurableStore` seeded from the
   captured log and a fake runner that throws on call.
3. Asserts: zero new outbound calls; stage output identical.

### Phase E0 — Conversion infrastructure (~250 LOC, +6 tests)

Lands the helpers every later phase consumes.
1. `core-pipeline/src/durable/effect-helpers.ts` —
   `serializeAgentRunResult(r)` (drops non-round-trippable fields,
   converts `Set<string>` → `string[]`, etc.); `contentHash(s)`
   utility.
2. `core-pipeline/src/durable/replay-equivalence.ts` — test seam:
   `seedStoreFromLog(store, events)` + `assertNoOutboundCalls(spy)`.
3. New tests: `effect-helpers.test.ts` covers serialisation
   round-trips for the canonical agent-result shape (Set, Map,
   Buffer, undefined values).

**Why first:** without a stable serialisation contract, every later
phase will re-discover the round-trip edge cases and ship subtly
different fixes. Fix once.

### Phase E1 — clarify stage (1 commit, ~80 LOC, +3 tests)

Sites: `clarify:run-for-project` (line 256, the chain-fallback wrap)
+ Q&A signal consumption.

The clarify stage is the canonical first conversion because it's
already structured as a single `runWithChainFallback` call —
wrapping it in `ctx.effect` is a localised change with no fan-out.

Test: replay-equivalence on a 2-question Q&A loop. Pass 1 records
the spawn + the two `__signal:clarify-q<n>` waits. Pass 2 with the
log seeded asserts no spawns + identical output.

### Phase E2 — requirements stage (1 commit, ~120 LOC, +4 tests)

Sites: `requirements:session-start` (line 590), `requirements:
session-resume` (line 663), `__signal:stage-answer-1`.

The Q&A flow makes this the most complex non-fanout conversion.
The test must cover three replay paths:
- Agent confident → no questions → first response IS the artifact.
- Agent asks N questions → user answers → resume produces artifact.
- Mid-Q&A crash (some answers in, not all): replay returns the
  recorded answers without re-prompting.

### Phase E3 — repo-requirements + specs (1 commit, ~150 LOC, +6 tests)

Sites: per-repo spawn (line 397) + per-repo write (line 444),
fanned out across `ctx.repoPaths`. Both stages share the
`runPerRepoStage` body so converting one converts both.

**Edge case: per-repo failure** — today, if any repo's spawn
rejects, `runPerRepoStage` throws and the parent step rejects.
The wrap MUST preserve this: `ctx.effect` re-throws the recorded
failure on replay (`ReplayedEffectError`), so a previously-failed
repo stays failed on re-run instead of silently retrying.

### Phase E4 — tasks stage (1 commit, ~50 LOC, +2 tests)

Sites: `tasks:spawn-agent` (line 692) + `tasks:write-artifact`
(line 1027).

Smallest phase. Smoke test only — the tasks stage rarely fails
mid-stage and its output is small.

### Phase E5 — build stage (1 commit, ~200 LOC, +5 tests)

Sites: per-task spawns (~5-15 per repo per run, depending on plan
size), per-task writes, per-task git commit (the agent's commit
runs inside the agent — we checkpoint the spawn, not the commit
itself).

**Edge case: dependency-graph scheduler** — `runTasksWithDependencyGraph`
already iterates per-task. Each task spawn becomes its own
`ctx.effect('build:spawn-task-${repo}-${taskId}', ...)`. The
scheduler MUST be deterministic-by-input — `orderTasksForDispatch`
uses task IDs that are stable across runs, so this is already
satisfied.

**Idempotency keys are critical here.** Re-running build after a
crash should NOT re-write a file the previous task already wrote,
even if the agent is non-deterministic. The fix is to include
`${runId}:${repo}:${taskId}` in the idempotency key so the
durable log catches replay drift before the file system does.

### Phase E6 — validate + fix-loop (1 commit, ~150 LOC, +5 tests)

Sites: `validate:spawn-<repo>`, `validate:fix-attempt-<n>`,
`validate:fix-resume-<n>`. The fix-loop is sequential — one
attempt at a time; each attempt is its own effect.

**Edge case: the fix-loop's `attempt` counter** — today the
counter is a JS local variable. Replay must see the same counter
on re-entry; the log already has effect:completed events for
attempts 1..N-1, and the loop body advances the counter after each
effect. On replay the counter advances through the recorded
attempts identically; it only goes "live" when it hits the first
un-recorded effect. This is already the contract; no code change
needed.

### Phase E7 — test stage (1 commit, ~80 LOC, +3 tests)

Sites: `test:spawn-testgen` (line 729) + the test-execution agent
spawn (inside `runTestGenForProject`).

### Phase E8 — ship stage (1 commit, ~120 LOC, +4 tests)

Sites: `ship:agent-run` (the agent that runs `gh pr create` +
nexus deploy).

**Idempotency key is crucial.** A re-run after a crash must NOT
create a duplicate PR. The ship agent's prompt already includes
`<runId>` and `<branch>` in the title/body; the idempotency key
is `${runId}:${repo}:ship`. The agent's `gh pr create` call is
inside the agent — *we cannot directly idempotency-key the gh
call from outside*. The mitigation: the wrapping effect's
idempotency key catches replay drift before the agent re-runs,
which is what matters for our durability guarantee.

### Phase E9 — reviewer pause as durable signal (1 commit, ~150 LOC, +4 tests)

Replaces the dashboard's `pauseStore`-driven polling loop with a
`ctx.waitForSignal('reviewer-decision-<stageIndex>')` call. The
producer side (the WS handler that reacts to "Approve / Reject"
clicks) becomes
`durableStore.enqueueSignal(runId, channel, decision)`.

**Edge case: pauseStore stays alive** — the pauseStore renders the
modal in the UI (it's a derived state projection). Removing it
ships in a later commit; this phase keeps it but makes it
non-authoritative.

### Phase E10 — system primitives (1 commit, ~50 LOC, +3 tests)

Convert the 6 surveyed `Date.now()` / `randomUUID()` sites in
step bodies to `ctx.now()` / `ctx.uuid()`. Most are in
state-mutation paths (e.g. `armedAt` timestamps); a couple are in
ID generation for transient state.

**Why last:** these are the lowest-risk conversions and the
hardest to test in isolation. Doing them after the rest of the
codebase has been converted means the linter (D5) catches any
regressions during code review of E1–E9.

---

## §E. Edge cases discovered while surveying

1. **Agent result `Set<string>` round-trip.** `AgentRunResult.prUrls`
   is a `Set<string>` in the runtime but JSON serialises to `{}`.
   Effect helpers in E0 convert to `Array.from(set)` before
   recording.

2. **`maxOutputTokensForStage(stage.name)`** is read inside the
   spawn closure. It's a pure function of stage name — stable
   across replays. No conversion needed.

3. **`zeroTokenStats()`** is constructed for failed-repo fallback
   paths. Small object literal, no replay risk. No conversion.

4. **Per-repo fanout's `Promise.all(promises)`** — the walker
   already runs per-repo iterations in parallel. Per-repo effect
   `idx` counters are independent (each runs in its own
   `EffectRuntime` because `repoName` is part of the context).
   No interaction.

5. **Telemetry writes (`writePerRepoTelemetry`)** appear
   immediately after the spawn. They're best-effort JSONL appenders;
   re-running them is harmless. NOT converted to `ctx.effect`.

6. **Cost ledger writes** stay outside per durable plan §O.

7. **Empty-artifact retry** (`if (!r.output || r.output.trim().length
   < 50)`) — currently throws a synthetic `UpstreamError(retryable=true)`.
   The wrap MUST preserve this so the chain-fallback path still
   triggers on tiny outputs. Implementation: throw inside the `fn`
   passed to `ctx.effect`; the runtime records `effect:failed` and
   re-throws on replay with the same `retryable` flag preserved
   (we'll need to plumb the flag through `ReplayedEffectError`).

8. **`runWithChainFallback` wraps `ctx.effect`, not the other way
   around.** Each model-attempt of the chain is its own effect;
   the chain controller is part of step body logic. This means
   E1-E2's effect names include the model identifier:
   `clarify:run-for-project:<model>`. Mismatch on replay
   (different chain order) → `DeterminismViolationError`, which
   the user resolves by re-running from the affected stage with
   the same chain. Acceptable v1 semantic.

9. **Build-stage per-task scheduler.** Task IDs come from the plan
   manifest. Plan changes between runs would break determinism;
   we already detect this via the manifest version field.

10. **Reviewer pause races with cancel.** Today's pause loop
    polls `cancelled` flag. After E9, `ctx.waitForSignal` honors
    `ctx.signal` (AbortSignal); cancel path stays correct.

11. **Q&A `repoName` case sensitivity.** The signal channel key
    is `stage-answer-${stageIndex}` — repoName is not in the key.
    The dashboard's resolver Map IS keyed by repoName, but signal
    consumption is FIFO per channel, so the agent-side ordering
    of `<answers>` blocks is what matters. A test must verify
    multi-repo Q&A doesn't cross-pollinate answers.

12. **Phase D2's `passthrough*` helpers** stay in place: cli's
    legacy path uses non-durable mode. After E0–E10, the
    dashboard's runs go fully durable; the cli still uses
    passthroughs until its own conversion phase.

---

## §F. Test strategy per phase

Three test categories per converted site:

### F.1 Live recording test (1 per site)

Run the stage once with effects firing. Assert:
- The exact set of effect events appears in the durable log.
- The order matches the step body's effect call sequence.
- Effect payloads round-trip JSON cleanly.

### F.2 Replay equivalence test (1 per site)

Seed an `InMemoryDurableStore` with the captured log. Re-run the
stage with a spy runner that throws on every call. Assert:
- Zero spy invocations.
- Output identical to live run.
- No new effect events written (only `step:started` /
  `step:completed`).

### F.3 Mid-effect crash test (1 per site that has multiple effects)

Crash after recording `effect:started` but before
`effect:completed`. On re-run, assert the effect re-runs (`fn`
invoked once) and produces a fresh `effect:completed`.

The catch-all `crash-recovery.test.ts` from D2 already exercises
this for the toy 3-step workflow; per-stage tests use the same
shape.

---

## §G. Risks + mitigations

| Risk | Probability | Mitigation |
|---|---|---|
| Effect result not JSON-serialisable | High | E0 ships `serializeAgentRunResult`; per-phase test catches new shapes. |
| Effect name not stable across replays (e.g. uses `Date.now()`) | Medium | The D5 linter flags these; code review enforces. |
| Idempotency key collision across runs | Low | Keys include `runId`; `runId` is per-run. |
| Per-repo fanout determinism (repo iteration order) | Medium | `Object.keys(repoPaths)` is deterministic in V8; we sort explicitly in E3 to be safe. |
| chain-fallback model rotation | Medium | E1's effect names include the model identifier; on replay mismatch the user reruns. Documented in §E.8 above. |
| Build-stage task ordering | Medium | Task IDs are from the plan manifest; we record the manifest version + assert match on replay. |
| Reviewer pause + cancel race | Low | `ctx.waitForSignal` honors `ctx.signal`. |
| Telemetry duplication on replay | None — telemetry is intentionally outside the durable log | n/a |
| Dashboard UI shows stale state on resume | Low | Dashboard reads from durable timeline endpoint (D5); state file remains as fallback. |
| Performance regression from extra writes | Low | SQLite WAL handles ~1k writes/sec; ~30 effects per run is far under budget. |

---

## §H. LOC estimate + done criteria

| Phase | New LOC | Modified LOC | Tests added |
|---|---:|---:|---:|
| E0 — infra | ~250 | 0 | +6 |
| E1 — clarify | ~80 | ~30 | +3 |
| E2 — requirements | ~120 | ~50 | +4 |
| E3 — repo-requirements + specs | ~150 | ~80 | +6 |
| E4 — tasks | ~50 | ~20 | +2 |
| E5 — build | ~200 | ~150 | +5 |
| E6 — validate + fix-loop | ~150 | ~100 | +5 |
| E7 — test | ~80 | ~40 | +3 |
| E8 — ship | ~120 | ~50 | +4 |
| E9 — reviewer-pause-as-signal | ~150 | ~120 | +4 |
| E10 — system primitives | ~50 | ~50 | +3 |
| **Total** | **~1400** | **~690** | **+45** |

### Done criteria

A run that:
1. Starts at stage 0, gets to stage 5 (build).
2. Process killed with `kill -9`.
3. User clicks "Resume" in the dashboard (or runs `anvil resume
   <runId>`).
4. Resumes at stage 5 — sees previously-completed agents skip
   without re-spawning.
5. Build stage's first 3-of-6 tasks skip (recorded); tasks 4-6
   run live.
6. Run completes successfully.
7. Total LLM cost on second pass = cost of (tasks 4-6 + validate +
   test + ship) — NOT (everything from stage 5 onward).

…is the bar. Ship after that round-trips end-to-end on a real run.

---

## §I. Pre-flight checklist

- [ ] D5 linter wired into CI for `**/stages/**` files (catches
      regressions in step bodies).
- [ ] `serializeAgentRunResult` test fixtures cover every shape
      the runner can return.
- [ ] Replay-equivalence helper (`seedStoreFromLog`) lands in E0
      with bundled tests.
- [ ] Confirm dashboard's `pauseStore` can stay non-authoritative
      after E9 (the modal already reads from `pause-state`
      broadcasts, which become durable-log projections).
- [ ] Confirm cli's path stays on non-durable mode through E0–E10
      (cli conversion is a separate plan).
- [ ] Per-phase: capture before/after timing on a real workload
      (e.g. clarify → ship on a 5-task feature) so the team
      sees the regression budget hold.

---

## §J. Out of scope (intentional)

- **CLI path conversion.** The cli's legacy if-tree still calls
  `runner.run` directly; durable mode is dashboard-only until cli
  consolidation ships its own conversion phase (see
  CORE-PIPELINE-CONSOLIDATION-ADR.md D11+).
- **Cross-feature effect deduplication.** If two features run the
  same `gh pr create` (different branches, same template), they
  stay in independent durable rows. Cross-feature dedup is a
  later optimisation only relevant for single-tenant teams running
  many parallel features.
- **Schema migration tooling.** The D1 schema ships at v1; future
  migrations are forward-only via a `meta.schema_version` row
  bump + a startup migration runner. Conversion phases don't
  touch the schema.
- **Multi-process test harness.** D6 tests cover the lease
  manager unit-level. End-to-end multi-process tests (two real
  Node processes contending for a run) are a v2 deliverable;
  v1 ships single-process replay only.

---

## §K. Why this is the right next step

D1–D6 made durable execution *possible*. This conversion makes it
*useful*. Without it, a crash mid-build re-spawns the build agent
and re-bills the LLM; with it, the engine returns the recorded
result and the user pays nothing on resume.

The conversion is mechanical in shape but careful in detail
(idempotency keys, serialisation, per-stage edge cases). Phasing
it stage-by-stage means each commit is small, reviewable, and
revertable. After E10 lands, the headline scenario from §A of the
durable execution plan ("kill -9 mid-stage, resume in 5s, no
rework") works end-to-end on Anvil's actual workload.

Ready to execute when approved.
