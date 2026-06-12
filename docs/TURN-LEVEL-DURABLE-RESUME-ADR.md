# ADR — Turn-level durable resume for LLM effects

> **Superseded (reliability rewrite):** the chain walker this ADR builds on
> (`runWithChainFallback` / `routing/with-fallback.ts`) was removed. The
> agentic chain walk + per-error-class backoff + circuit breaker is now
> `LlmRouter.runAgent` (`@esankhan3/anvil-agent-core`); error classification
> is the unified `classifyError`. The turn-level prefill resume this ADR
> describes is preserved and flows through `runAgent`'s `resolvePrefill`.
> Read the body for the durable-resume design; ignore the `runWithChainFallback`
> references.

**Status:** Proposed (v2 — folds in the gap review of v1).

**Authors:** agent-core / core-pipeline maintainers.

**Companion docs:**
- `packages/core-pipeline/CLAUDE.md` §"Durable execution module" — Pattern-2
  effect runtime (D1–D6 / E0–E10 / F1–F9 / G1–G4) this ADR extends.
- `packages/agent-core/CLAUDE.md` — adapter contract, `UpstreamError`,
  per-call `AbortController`, buffered `emitContent`, chain-fallback.
- `packages/core-pipeline/src/routing/with-fallback.ts` —
  `runWithChainFallback` (the current chain walker this ADR makes
  resumption-aware).

This ADR amends the `EffectRuntime` contract in
`packages/core-pipeline/src/durable/effect-runtime.ts` to record an
LLM invocation as a **sequence of sub-effects per assistant turn**
instead of one opaque effect, and adds a partial-assistant-prefill
protocol so a model swap mid-stream resumes from the last persisted
character of the prior model's output.

v2 deltas (vs the original draft): adds mid-`tool_use` truncation
rules (§2.1.1), an abort latch + replay precedence (§2.1.2), an
explicit cross-provider-strip policy for reasoning blocks and
tool-result shapes (§2.3.1), context-window truncation policy
(§2.3.3), turn-scoping via `turnUuid` + invalidation on cancel
(§2.2.1), `sendInput` semantics (§2.5.1), cost accounting protocol
(§2.6), provenance attribution (§2.7), degradation matrix (§2.8),
same-provider continuation fast-path (§5.1), and a fault-injection
test harness (§4.5).

---

## §1. Context

### §1.1 What we have today

`EffectRuntime` (Phase D1–G4) is Temporal-class at the
`ctx.effect(name, fn)` boundary:

- An LLM invocation that drives the agent loop (e.g.
  `build:spawn-task-<repo>-<taskId>`) is wrapped as a **single
  effect**. The runtime logs `effect:started` before `fn()`, the body
  drives the whole multi-turn tool-loop to completion, and
  `effect:completed` lands on success (`effect-runtime.ts:235`).
- Chain-fallback (`routing/with-fallback.ts:42`) sits **outside** the
  effect. When the inner effect throws a retryable `UpstreamError`,
  the walker burns the model, picks the next entry, and re-invokes
  `attempt(nextModel)` with the **original** input. The new model
  starts from a blank assistant turn.
- `AgentProcess` (`agent-core/src/agent/session/session.ts:41`) keeps a
  500 KB rolling output buffer in process memory. It is never written
  to the durable log; on resume it is lost.
- Built-in tool calls (`read_file`, `bash`, `write_file`, …) executed
  inside model A's loop run again on model B because there is no
  per-turn tool-call dedupe key. `BuiltinToolExecutor` has no
  recall path.

### §1.2 Symptom

When a chain entry burns mid-output (zombie socket, 503 partway
through SSE, premium-model timeout), the user pays for everything
streamed so far AND every tool call already executed. Worse, the
re-running tool calls can re-trigger non-idempotent side effects
(`write_file` over a file the prior model already wrote, `bash`
that runs migrations a second time).

### §1.3 What the user actually wants

> Start from the exact line/character where I stopped when a model
> fails and switches.

Two distinct requirements hide in that sentence:

1. **Tool-result reuse.** Tool calls already completed on model A
   must NOT re-execute on model B; the durable log should replay
   their results.
2. **Assistant-prefix continuation.** The last partial assistant
   message from model A must be prefilled into model B's request so
   the new model continues mid-sentence instead of regenerating
   from the start of the turn.

Both are achievable with provider primitives that already exist
(`messages[]` with a trailing `assistant` role for Anthropic +
OpenAI; tool-result message blocks for both). Neither requires
provider cooperation beyond what their public chat APIs accept.

---

## §2. Decision

Split today's single `effect:invoke-agent` effect into a
**typed sequence of sub-effects per assistant turn**, owned by a
new `TurnRecorder` that lives inside the adapter loop. Add a
`prefill` field to `AdapterRequest` so the chain walker can hand a
partial assistant message to the next model.

### §2.1 New sub-effect vocabulary

For one LLM invocation `invoke-agent:<stepId>:<runUuid>`, the
recorded effect sequence becomes:

```
turn:0:assistant-start    payload: { turnUuid, model, system, messages, prefill? }
turn:0:tool_use:0          payload: { tool, args, idempotencyKey }
turn:0:tool_result:0       payload: { ok, output, durationMs }
turn:0:tool_use:1          payload: { tool, args, idempotencyKey }
turn:0:tool_result:1       payload: { ok, output, durationMs }
turn:0:assistant-end       payload: { text, stop_reason, usage, provenance }
turn:1:assistant-start     payload: { turnUuid, model, system, messages }
...
```

The effect names are stable strings; `idx` advances as today; the
existing `(name, idx)` mismatch detector still catches drift.
`turnUuid` is a v4 minted at `assistant-start` and threaded through
every sub-event in the same turn — see §2.2.1 for why we need it
separately from `(stepId, turn)`.

**Turn definition.** One turn = one assistant generation request
→ one assistant response (possibly carrying tool_use blocks). When
the loop feeds tool_result back to the model, that opens a new
turn at `turn:N+1`. This matches the Anthropic/OpenAI chat APIs'
unit of work and is the smallest atom at which prefill makes
sense.

#### `assistant-start`

Records *what we asked the model*. On replay this effect is a
no-op that returns its recorded payload — used purely so the
runtime can detect determinism violations if a step rebuilds the
prompt from drifted inputs. The `messages[]` payload is hashed
via `effect-helpers.ts:contentHash` and stored as
`idempotencyKey`; the existing `effect-input-hash-mismatch` check
(`effect-runtime.ts:200`) catches re-runs that supply different
prompts under the same `(name, idx)`.

#### `tool_use:N`

Records the **request** to invoke a tool, BEFORE the executor
runs. The `idempotencyKey` is the `sha256(tool, JSON.stringify(args))`
computed by `effect-helpers.ts:artifactIdempotencyKey`.

#### `tool_result:N`

Records the executor's response. On replay this is the standard
"recorded result wins" path — the tool body is NOT re-executed.
The tool's side effects on the filesystem stay as model A left
them.

#### `assistant-end`

Records the **completed** assistant message. Two cases:

- **Normal completion**: stop_reason ∈ {`end_turn`, `tool_use`,
  `max_tokens`}. The full assistant text + provenance (§2.7) are
  in the payload; on replay we hand it back verbatim.
- **Mid-stream failure**: the adapter throws before
  `assistant-end` is recorded. The runtime sees `assistant-start`
  with no matching `assistant-end`; this is the **partial-turn
  signal**. The accumulated assistant text up to the throw is
  flushed via an `assistant-partial` event written by the adapter
  in its `catch` block (see §2.2).

#### §2.1.1 Mid-`tool_use` truncation rule

OpenAI-compat SSE streams assemble `tool_calls[].function.arguments`
across N deltas. If model A dies mid-args, the recorder's
in-memory buffer for that tool_call holds unparseable JSON (e.g.
`{"path": "src/foo`). The contract:

- Adapters MUST validate each in-flight `tool_call` with
  `JSON.parse` BEFORE emitting `tool_use:N`. A `tool_use:N` row
  is only recorded after `arguments` parses cleanly.
- On burn with an in-flight, unfinished `tool_call`, the recorder
  drops it: no `tool_use:N` is emitted, no `tool_result:N` is
  recorded, the partial assistant text is flushed with
  `toolUsesEmitted` = count of *parsed* tool_uses, and model B
  re-decides whether to call that tool with a fresh args
  generation.
- Anthropic's `input_json_delta` has the same shape; the rule
  applies identically.

#### §2.1.2 Abort latch + replay precedence

A race exists between `flushPartial` (fired from the adapter's
catch block) and a final SSE delta that lands AFTER the per-call
`AbortController` aborted but BEFORE the stream socket actually
closes. If that delta carries `stop_reason: 'end_turn'`, we would
record both `assistant-partial` AND `assistant-end` for the same
turn.

- **Abort latch**: every adapter sets `this.aborted = true`
  synchronously inside the catch (before `flushPartial`). The
  SSE consumer's per-chunk handler checks the latch and drops
  any post-abort delta. This is in addition to — not a
  replacement for — the existing `AbortSignal` check, which only
  prevents new fetches.
- **Replay precedence**: if both `assistant-end` and
  `assistant-partial` exist for the same `turnUuid`,
  `assistant-end` wins. `EffectRuntime` on replay treats the
  presence of `assistant-end` as the canonical turn output and
  IGNORES `assistant-partial` rows for the same `turnUuid`.

### §2.2 `assistant-partial`

A new event kind (not subject to the effect counter — like
`signal:received`). Carries:

```ts
{
  runId, stepId,
  turnUuid: string,         // matches the parent assistant-start
  turn: number,
  text: string,             // every character streamed before the throw
  toolUsesEmitted: number,  // count of FULLY-PARSED tool_use blocks
  reason: 'upstream' | 'abort' | 'timeout',
  recordedAt: ISO,
}
```

Written by every agentic adapter (`claude`, `openrouter`, `opencode`,
`openai`, `ollama`, `adk`) in its outer `catch` BEFORE re-throwing
the `UpstreamError`. The recorder lives in `agent-core` as a small
helper `recordAssistantPartial(store, runId, stepId, turnUuid, turn,
text, reason)` so adapters don't reach into `core-pipeline` types
directly — they take a `partialSink: (p) => void` injected via
`ModelAdapterConfig`.

#### §2.2.1 Turn-scoped uniqueness + cancellation invalidation

`(stepId, turn)` alone is NOT a stable key — a re-run after
cancel can produce a fresh turn 0 that collides with a stale
turn 0 from the prior run. Two-part fix:

- **`turnUuid`** is the durable scoping key. `readAssistantPartial`
  always reads via `turnUuid`, never `(stepId, turn)`. The current
  in-flight `turnUuid` is held in the EffectRuntime; the chain
  walker passes it through `attempt(model, prefill, turnUuid)`.
- **Cancellation invalidation**: when a run transitions to
  `cancelled` / `failed` / `compensating`, the store's
  `invalidatePartials(runId)` marks every outstanding
  `assistant-partial` row tombstoned (a new event kind
  `assistant-partial-tombstoned`). `readAssistantPartial` skips
  tombstoned rows. This is cheap and durable; we don't need to
  hard-delete.

### §2.3 `AdapterRequest.prefill`

Add an optional field to `AdapterRequest`
(`agent-core/src/agent/session/adapter.ts`):

```ts
interface AdapterRequest {
  // …existing fields…
  /** Continue this assistant message instead of starting fresh.
   *  When present, adapters MUST send `{ role: 'assistant',
   *  content: prefill.text }` as the last message in the request,
   *  along with the recorded tool_use blocks listed in
   *  prefill.toolUses (so the new model sees the conversation
   *  state model A left behind). */
  prefill?: {
    turnUuid: string;
    text: string;
    toolUses: Array<{
      id: string;
      name: string;
      input: unknown;
      result: unknown;
      /** Vendor that produced this tool_use. Used to decide
       *  whether to strip vendor-specific blocks. */
      producedBy: ProviderId;
    }>;
    /** Vendor of the prior model — drives §2.3.1 stripping. */
    sourceProvider: ProviderId;
    /** Token count of `text` as billed by sourceProvider. Used by
     *  §2.6 to avoid double-counting on the cost-tracker side. */
    sourceTokens: number;
  };
}
```

#### §2.3.1 Cross-provider strip policy

Most chain swaps go cross-vendor (OpenRouter → OpenAI on a quota
burn; OpenAI → Anthropic on a 503). Vendor-specific message
blocks DO NOT survive the swap:

| Block / field            | Provider that produces it | What to do on cross-vendor prefill |
|--------------------------|---------------------------|-------------------------------------|
| `reasoning_details[]`    | OpenRouter reasoning models | Strip when `sourceProvider !== targetProvider` |
| `reasoning` (text)       | OpenRouter reasoning models | Strip when `sourceProvider !== targetProvider` (Anthropic + OpenAI reject) |
| `cache_control` marker   | Anthropic                 | Strip when targeting non-Anthropic |
| `image` / `tool_result` shape | Mixed                | Translate to target shape (§2.3.2) |
| `prompt_cache_key`       | OpenAI                    | Strip when targeting non-OpenAI |

A small `stripForTarget(messages, sourceProvider, targetProvider)`
helper lives in `agent-core/src/prefill/strip.ts` and is invoked
by every adapter before sending the prefill request. Same-vendor
swaps (Anthropic A → Anthropic B) skip stripping AND get the
§5.1 prefix-cache fast-path.

#### §2.3.2 Tool-result shape translation

Tool results stored in the durable log are in a **neutral shape**:

```ts
type NeutralToolResult = {
  toolUseId: string;
  toolName: string;
  ok: boolean;
  content: string | unknown; // text or structured
};
```

Adapters translate at prefill emission time:

- **Anthropic**: serialize as
  `{ role: 'user', content: [{ type: 'tool_result', tool_use_id, content, is_error: !ok }] }`.
- **OpenAI / OpenRouter / OpenCode / Ollama**: serialize as
  `{ role: 'tool', tool_call_id, content: stringify(content) }`.
- **ADK**: ADK wraps tool calls in `FunctionCall` / `FunctionResponse`
  events; the adk-adapter materializes prefill state via
  `Session.appendEvent` before invoking the runner.

Translation lives next to the strip helper as
`agent-core/src/prefill/translate.ts`.

#### §2.3.3 Context-window truncation policy

`prefill.text` plus the recorded tool results may push the request
over the **target model's** input window even though it fit on the
source model. The truncation contract:

1. Compute `tokenBudget = targetModel.maxInputTokens − margin (8K)
   − sourceTokens − sum(toolUseTokens)`.
2. If `tokenBudget < 0`, drop messages from the **start** of
   `messages[]` (preserving the system prompt and the most recent
   tool_result / user message) until the budget fits.
3. If even after dropping every non-system message the budget is
   still negative, the prefill cannot be served on this target —
   the chain-walker burns the target and tries the next one
   WITHOUT a prefill (`attempt(nextModel, undefined, turnUuid)`).
   Falling back to a clean re-run on a different target is better
   than failing the run.
4. Token counts use `agent-core/src/cost.ts` model-prices table
   to derive `maxInputTokens` per model id; missing entries
   conservatively assume 32K.

### §2.4 Chain-fallback handoff

`runWithChainFallback` becomes prefix-aware:

```ts
let prefill: AdapterRequest['prefill'] | undefined;
let turnUuid: string | undefined;
for (let i = 0; i < maxAttempts; i += 1) {
  const model = opts.resolveModel(burned);
  try {
    return await attempt(model, prefill, turnUuid);
  } catch (err) {
    if (!isRetryableUpstreamError(err)) throw err;
    burned.add(model);
    const partial = await readAssistantPartial(store, runId, stepId, turnUuid);
    if (partial && !partial.tombstoned) {
      prefill = buildPrefillFromPartial(partial, /* sourceProvider */ providerOf(model));
      turnUuid = partial.turnUuid;
    }
    opts.onBurn?.({ stageName, model, status, message });
  }
}
```

`readAssistantPartial` queries the durable log for the most recent
`assistant-partial` event for `turnUuid` AND the
`tool_use`/`tool_result` pairs already recorded at lower idx in
that turn. The next attempt enters the loop with model B AND the
prefix model A produced.

### §2.5 `TurnRecorder`

Lives in `agent-core/src/turn-recorder/` (a directory: `index.ts`,
`types.ts`, `hash.ts`). Owned by the agentic loop in each adapter.

**Structural-typing note (agent-core ⇏ core-pipeline).** agent-core
does NOT depend on core-pipeline. The recorder takes a structural
`EffectRuntimeLike { effect<T>(name, fn, opts?): Promise<T> }`, which
core-pipeline's concrete `EffectRuntime` satisfies, and a
`partialSink: (AssistantPartial) => void` the caller backs with a
`DurableStore` write. This keeps the dependency arrow one-way.

Surface (as built in H1 — supersedes the original draft):

```ts
class TurnRecorder {
  constructor(deps: {
    runtime: EffectRuntimeLike;          // structural, not core-pipeline's class
    partialSink: (p: AssistantPartial) => void;
    runId: string;
    stepId: string;
    uuid?: () => string;                 // test seam
    nowIso?: () => string;               // test seam
  });

  async startTurn(req: AssistantStartRequest): Promise<{
    turn: number;
    turnUuid: string;
    replayed?: AssistantTurn;            // present iff assistant-end already logged
  }>;

  // ── runTool: collapsed from the original recordToolUse + recordToolResult ──
  async runTool(
    turn: number,
    name: string,
    args: Record<string, unknown>,
    idempotencyKey: string,
    exec: () => Promise<NeutralToolResult>,
  ): Promise<NeutralToolResult>;

  async endTurn(
    turn: number, text: string, stopReason: string,
    usage: TurnTokenUsage, provenance: Provenance,
  ): Promise<void>;

  flushPartial(
    turn: number, text: string, toolUsesEmitted: number,
    reason: 'upstream' | 'abort' | 'timeout',
  ): void;
}
```

**Why `runTool` replaces the drafted `recordToolUse` +
`recordToolResult` pair.** The original two-call split had no clean
replay-vs-execute boundary through the `effect(name, fn)` interface:
once the runtime accepts a `fn` for `tool_result:N`, that `fn` has
either already run (live) or been skipped (replay), and the caller
cannot tell which from outside without leaking the runtime's
internal cursor. `runTool` owns the whole
intent-record → execute-or-replay → result-record sequence
atomically: it emits `tool_use:N` (intent), then runs `exec` inside
a `tool_result:N` effect (so replay short-circuits the executor and
the recorded `NeutralToolResult` is returned without re-running the
side effect). The on-disk effect order is identical to the draft
(`tool_use:N` then `tool_result:N`); only the in-process API
collapsed. `turnUuid` is minted inside `startTurn` and held by the
recorder, so `flushPartial` doesn't take it as a parameter (the
recorder echoes the right one) — another delta from the draft
signature.

Adapters call into the recorder at four points (`startTurn`,
`runTool` per tool call, `endTurn`, and `flushPartial` from the
catch block). The recorder translates each into an `effect()` call
on the underlying runtime, which gives deterministic replay for
free. `flushPartial` is the only non-effect path — fire-and-forget
so the catch block doesn't await before re-throwing. Documented
loss condition: SIGKILL between `flushPartial` invocation and disk
fsync drops the partial. Acceptable trade-off; the alternative is
adding latency to the critical-path catch.

**`createNullTurnRecorder()`** — a recorder backed by a no-op
runtime + no-op sink. Adapters default to it when the caller hasn't
injected a real recorder (`config.turnRecorder ?? createNullTurnRecorder(...)`).
Structural calls still happen so the code path is identical; nothing
persists. This is the cutover bridge: un-ported call sites observe
byte-identical behavior to pre-H1, and wiring a real recorder later
needs no adapter change.

#### §2.5.1 `sendInput` resume semantics

`AgentProcess.sendInput()` spawns a new adapter under the same
`sessionId` (§1.1, `session.ts:143`). The TurnRecorder's `turn`
counter is **session-scoped, not adapter-scoped**: a new adapter
spawned via `sendInput` continues at `turn:N+1` where N was the
last completed turn in the prior adapter. This keeps
`(stepId, turnUuid)` globally unique across resume boundaries.

**Implementation seam (H2).** The recorder holds only a structural
`EffectRuntimeLike` — it cannot itself read the durable log. So the
seeding is split: `TurnRecorderDeps.initialTurn?: number` seeds
`turnCounter = initialTurn ?? 0`, and the CALLER (the step body, in
the H3 cutover) computes the highest completed turn for
`(runId, stepId)` — by reading `turn:*:assistant-end` events out of
the `DurableStore` — and passes it in. Until a production stage is
ported to a real recorder (H3), every recorder is a
`NullTurnRecorder` starting at 0, so the collision this guards
against cannot occur yet; the seam exists so H3 can close it without
touching the recorder. The H1 default of `initialTurn = 0` was an
adversarial-review finding (a resumed real recorder would otherwise
reuse turn numbers and trip `effect-idx-mismatch` on replay).

### §2.6 Cost accounting protocol

The cost-tracker hook (`core-pipeline/src/hooks/cost-tracker.hook.ts`)
sums `costUsd` from `step:completed`. With turn-level sub-effects,
cost is reported across multiple effect rows in one turn and
across multiple turns in one step. Contract:

- **Per-effect cost**: each `assistant-end` payload carries
  `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
  costUsd, model, provider }` for the segment that effect produced.
- **Prefill input token attribution**: when `prefill.text` is sent
  to model B, B will report N input tokens for it. The
  `assistant-end` of B's turn MUST tag those tokens as
  `prefilledInputTokens` (carved out of `inputTokens`). The
  cost-tracker hook subtracts `prefilledInputTokens × B.inputRate`
  from the "new spend" rollup, attributing that cost to a
  separate `prefillReinjectionUsd` bucket. Users see "you paid X
  for the re-injection so model B could continue" as a distinct
  line, not silently double-billed.
- **Partial cost on burn**: when an `assistant-partial` is
  recorded, the adapter SHOULD include the best-known partial
  token counts in the partial payload (most providers send a
  final SSE `usage` frame even on early termination; when absent,
  count output tokens via the model's tokenizer). The
  cost-tracker rolls partial-A cost into the turn's total
  attributed to model A.
- **Step total**: `accumulateCost` in `session.ts:459` is
  extended to read all `assistant-end` + `assistant-partial`
  events for the step's effects and sum their costs by model.
  Per-model breakdown surfaces in the `step:completed` payload
  as `costByModel: Record<string, CostInfo>`.

### §2.7 Provenance attribution

`assistant-end.provenance` is the audit trail of which model
authored which characters of the final assistant text:

```ts
type Provenance = {
  segments: Array<{
    model: string;
    provider: ProviderId;
    range: [number, number]; // [startCharOffset, endCharOffsetExclusive)
    source: 'live' | 'prefill';
  }>;
};
```

For a turn that completed without chain-fallback, `segments`
has one entry covering the full text. For a turn that resumed
once, `segments` has two: the first marked
`source: 'prefill', model: <A>` for `[0, A.text.length)`, the
second marked `source: 'live', model: <B>` for
`[A.text.length, end)`.

The dashboard's transcript panel renders provenance as inline
attribution markers ("↪ continued by model B at char 1842");
implementation is downstream of this ADR and not gated by it.

### §2.8 Degradation matrix

Not every chain configuration can serve a prefill. The
matrix below is normative — adapters MUST implement the row
that matches their (sourceProvider, targetProvider) pair:

| Source         | Target         | Behavior                                                |
|----------------|----------------|---------------------------------------------------------|
| Anthropic API  | Anthropic API  | Native prefill + cache-control prefix hit (§5.1). Cache benefit gated on the prefix clearing the target model's minimum-cacheable floor (§5.1.1) — Haiku-tier floor is >~4K tokens; below it, prefill still works but is billed full-price. |
| Anthropic API  | OpenAI-compat  | Translate tool_results (§2.3.2) + strip cache_control   |
| Anthropic API  | Claude CLI     | Re-prompt with `<previous>…</previous>` quoted; new turn |
| OpenAI-compat  | OpenAI-compat  | Native prefill + strip vendor reasoning blocks (§2.3.1) |
| OpenAI-compat  | Anthropic API  | Translate tool_results + strip reasoning_details        |
| OpenAI-compat  | Claude CLI     | Re-prompt with quoted previous; new turn                 |
| Claude CLI     | *anywhere*     | Tool_use/tool_result are recorded from CLI's stream-json frames; prefill text not available; downgrade to "tool-result reuse only, no character-level prefill" |
| ADK (any LLM)  | ADK (any LLM)  | Native via `Session.appendEvent` — full tool-reuse + character prefill. **Empirically validated** against `gemini-2.5-flash` 2026-05-25: pre-populated `FunctionCall` + `FunctionResponse` events skip re-execution; trailing `model` partial-text event is continued mid-sentence on the next `runAsync`. |
| ADK            | non-ADK        | Translate events to neutral; prefill via target's path  |

**"All-CLI chain" case**: if every entry in the user's chain is
`claude` (subprocess), tool-result reuse works but character-level
prefill does not. The chain walker degrades cleanly: next attempt
gets `prefill: { text: '', toolUses: [...] }` and the adapter
re-prompts model B with the recorded tool history but a fresh
generation. User-visible behavior: tools don't double-fire, but
the assistant text is regenerated from scratch.

---

## §3. Consequences

- **True character-level resume on model swap.** When a chain entry
  burns mid-stream, the next model receives the partial assistant
  text + already-completed tool results and continues from the
  exact character. The user pays for one extra "complete this turn"
  request, not the full re-generation, less the §2.6 reinjection
  cost which is itemized separately.
- **Tool calls become idempotent across model swaps.** A `bash`
  run by model A is NOT re-run by model B; the recorded
  `tool_result` is replayed. Migrations stop double-firing. Mid-
  args tool_use is dropped per §2.1.1 — never replayed against
  partial JSON.
- **Replay log grows roughly 4× per LLM call** (start + N tool_use
  + N tool_result + end + optional partial). At our typical
  turn count this is fine for SQLite WAL; the blob store stays
  content-addressed so identical tool outputs dedupe. Tombstones
  (§2.2.1) add O(cancellations) rows.
- **`DeterminismViolationError` catches prompt drift.** If a step
  body re-enters with mutated `messages[]` (e.g. a stage that
  appends to its system prompt unconditionally), the
  `assistant-start` effect's recorded input hash will mismatch
  and the runtime will refuse to replay, surfacing the bug.
- **Claude CLI adapter degrades by policy, not by silent
  regression.** Documented in the §2.8 matrix; the user can move
  that stage to the API-shaped Claude path (`adk-anthropic-llm.ts`)
  if mid-turn resume matters.
- **Cost transparency improves.** Per-model spend per turn,
  prefill-reinjection cost as a separate bucket, partial-A cost
  attributed to A even when the turn was finished by B. Replaces
  the current single-USD-blob on `step:completed`.
- **MCP tool calls work for free.** `MergedToolExecutor` routes
  both builtins and MCP tools through the same executor; both
  surface in `tool_use:N` / `tool_result:N` rows without adapter
  changes. MCP server failures recorded today as
  `mcp-server-failed` activity events flow through the
  `flushPartial`-equivalent path on burn.
- **`ANVIL_OTEL_RECORD_CONTENT` privacy posture preserved.**
  `assistant-partial` payloads go to the durable log, NOT to
  spans; the OTel privacy switch governs spans only. Partial
  assistant text on disk is part of the durable log's posture
  (same as any other recorded effect payload) — operators who
  want it scrubbed do so at the store level, not via a per-feature
  toggle.
- **Compensation walk seeing partial turns.** When `Step.compensate`
  runs for a failed step, `output` is `undefined` (the step never
  produced a final result). Compensation hooks that need to
  inspect the partial transcript read it via
  `store.listEvents(runId, stepId, 'assistant-partial')`. The
  ADR does NOT auto-pass partial text to `compensate(ctx, output)`
  — it stays opt-in via the store API.

---

## §4. Migration

**Cutover posture.** No feature flag gates this work. Each phase
is a full cutover: the old single-effect `invoke-agent` path is
deleted in the same PR that introduces its replacement. Parity
is enforced by branch-diff review and the test matrix in §4.5,
not by a runtime toggle. Rollback is `git revert`, not flag flip.

### §4.1 Phase H1 — `TurnRecorder` plumbing + openrouter cutover

1. Add `TurnRecorder` + `AssistantTurn` types in
   `agent-core/src/turn-recorder.ts`.
2. Add `prefill/strip.ts` + `prefill/translate.ts`.
3. Replace `openrouter-adapter.ts`'s single-effect path with the
   four recorder calls (`startTurn` / `recordToolUse` /
   `recordToolResult` / `endTurn`). The old code path is deleted,
   not parked behind a conditional.
4. Other adapters (`opencode`, `openai`, `ollama`, `claude`, `adk`)
   continue on the legacy single-effect path until their own
   phase lands — they are NOT gated; they simply haven't been
   ported yet. Chain-fallback across mixed-version adapters keeps
   working because the legacy path emits an `assistant-end`-shaped
   final event the new chain walker can read.

### §4.2 Phase H2 — partial-sink + chain-fallback prefill cutover

1. Wire `flushPartial` in `openrouter`'s catch block, with the
   abort latch from §2.1.2.
2. Implement mid-`tool_use` truncation rule from §2.1.1 with
   a unit test that injects an unparseable args buffer.
3. Add `readAssistantPartial` + `invalidatePartials` to
   `core-pipeline/durable/store.ts` (both drivers).
4. Replace `runWithChainFallback`'s implementation with the
   prefix-aware version. No conditional. Adapters that don't
   yet emit `assistant-partial` simply hand `prefill: undefined`
   to the next attempt — same observable behavior as today for
   un-ported adapters.
5. Cross-provider strip/translate code from §2.3.1–§2.3.2.
6. Integration test: kill `openrouter` mid-SSE at a configurable
   byte offset with the §4.5 `MockUpstream`, assert next attempt
   sees `prefill.text` === the bytes already streamed AND the
   target model's request payload doesn't contain stripped fields.

### §4.3 Phase H3 — cost + provenance + truncation cutover

1. Replace `accumulateCost` (`session.ts:459`) with the per-model
   variant from §2.6. The single-USD-blob shape on `step:completed`
   becomes `costByModel`; consumers (dashboard cost panel, cli
   summary) update in the same PR.
2. Materialize §2.7 provenance into `assistant-end` payloads.
   Dashboard transcript renders attribution markers in the same PR.
3. Implement §2.3.3 truncation policy with a test that forces a
   budget overflow and asserts the walker tries the next model
   without a prefill instead of failing.

#### §4.3.1 H3 landing notes (as built, 2026-06-02)

Implementation surfaced two facts not visible from the plan, which
reshaped the cutover:

- **The dashboard never forwarded `ctx` into its stage bodies.**
  `pipeline-loop.ts`'s `runStage` callback dropped the walker's
  `StepContext`, so every `ctx ? ctx.effect(...) : …` site in
  `pipeline-stages.ts` took the non-durable branch — the dashboard's
  durable resume was **stage-granular**, and the per-stage effect
  wraps (Phase E) were inert. H3's real enablement is *forwarding*
  `ctx`, not "removing the outer wrap". To avoid activating ~12
  never-durably-run sites (incl. the durable Q&A `waitForSignal`,
  nested build `repo`+`task` wraps) all at once, `ctx` is forwarded as
  a **separate `turnCtx` (7th) arg**; the legacy `ctx` (6th) stays
  `undefined`, preserving every body site's pre-H3 behavior.
- **Per-repo / build fan out in parallel under one step id.** The
  dashboard's manual `Promise.all` fan-out shares one `EffectRuntime`
  (one monotonic `idx`); the engine matches effects by strict
  `(idx, name)`. Concurrent turn sub-effects on a shared `idx` are
  non-deterministic. Resolved with a **per-unit scoped runtime**
  (`createScopedEffectRuntime({scopeTokens})` + repo-prefixed effect
  names + `effectKeyMatchesScope`), mirroring the walker's own per-repo
  fanout.

**Cut over (durable turn-level recording live):**
- Single-stage path (`runSingleStage`, non-QA) — `scopeTokens []`.
- Per-repo generic path (`runPerRepoStage` repo loop) — `scopeTokens
  [repo]`, isolated per repo.
- **Build per-task** (`runBuildForRepo` → `runBuildForOneRepo`) —
  `scopeTokens [repo, taskId]` per concurrent task (`[repo]` for the
  no-task fallback) via a `makeTurnWiring(taskId)` factory on
  `RunBuildForRepoOptions`, injected into each task's `runner.run`.
  The old nested `build:repo-*` + dead `build:spawn-task-*` wraps were
  removed (they would have nested per-task effects).

**Review fixes (post-cutover, 2026-06-02):** `createScopedEffectRuntime`
now matches by STRICT joined prefix (not boundary-substring) so
prefix-related repo names (`api` vs `api-gateway`) don't cross-contaminate
idx counters; `rollupStepCostByModel` now reads per-repo/per-task burn
partials under their scoped step ids (was undercounting).

**Cut over (2026-06-02):** sessions (§4.3.2) + React UI (§4.3.3).

All H3a machinery (§2.5/§2.6/§2.7/§2.3.3) + the scoped-runtime
primitive ship green and back the above; the remaining sites reuse the
same `buildTurnWiring` helper once their isolation lands.

#### §4.3.2 Sessions cutover (FULL: per-phase burn continuation, 2026-06-02)

Chosen depth: **Full** (per-phase burn continuation for clarify/QA),
landed in three tiers behind a 38-agent adversarial design review + a
5-dimension code review.

- **Tier 1 — core determinism for burn-then-continue** (also fixes a
  LATENT bug in the already-shipped single/per-repo/build paths):
  - `buildTurnWiring` seeds the recorder at **`0`** for within-run
    replay (was `nextTurnSeed`). A burned turn records `assistant-start`
    but no `assistant-end`, so `nextTurnSeed` (highest-end+1) SKIPS it on
    replay → the first replay `startTurn` asks a turn index no recorded
    effect matches → `DeterminismViolationError`. Seed 0 re-issues from
    the start and replay-skips through. (`nextTurnSeed` is for the
    `sendInput`-resume boundary only.)
  - **Burn sentinel:** the openrouter adapter records a
    `stopReason:'burned'` `assistant-end` in its catch on a mid-SSE burn,
    so the burned turn replay-skips deterministically; the replayed
    burned turn **re-throws** a retryable `UpstreamError` so chain-fallback
    re-derives the SAME model→turn map regardless of whether the transient
    error cleared (makes "which model on replay" free). `usage:{}` so the
    per-model cost rollup prices the burn ONCE via the partial.
  - Probe: `core-pipeline/__tests__/h3-burn-replay.test.ts` (real
    `EffectRuntime`, incl. the transient-cleared case) + 2 adapter tests
    via `MockUpstream`.
- **Tier 2 — DONE (2026-06-03): stateful openrouter-family sessions.**
  Originally deferred as "multi-turn Prefill," but investigation found the
  real gap is upstream of the prefill: openrouter-family carries NO
  structured prior-turn history even in the NON-burn resume case
  (`ModelAdapterConfig` has only `userPrompt`; `sendInput` rebuilds
  prompt-only; only claude has native `--resume`). So the user chose the
  ROOT fix over speculative prefill machinery (which would have given a
  burned resume MORE context than a clean one). Mechanism: the recorder
  persists each phase's `userPrompt` in the assistant-start payload
  (determinism-additive — NOT in the idempotency hash, which is over `req`
  fields; replay reads assistant-end); `reconstructSessionHistory`
  (core-pipeline) rebuilds completed prior turns from the durable log
  (skipping burned sentinels, deduping the phase-opening prompt across a
  phase's tool-loop turns); they ride to the adapter as
  `ModelAdapterConfig.priorMessages`, materialized (`materializePriorTurns`
  — each completed turn as ONE assistant(text+tool_calls) + tool results,
  so a tool loop doesn't emit invalid consecutive-assistant messages) and
  spliced `[system, ...priorMessages, user(newPrompt), ...prefill]`. The
  phase-aware degrade gate is REMOVED; a non-claude same-model resume now
  spawns fresh with `priorMessages` (native resume gated to claude, which
  carries history itself). `priorMessages` + `prefill` compose (completed
  prior phases + the current burned partial). Threaded session-side via a
  `resolvePriorMessages` closure on `buildTurnWiring` (mirrors
  `resolvePrefill`); computed ONCE per resume phase (not per chain attempt).
  Phase-opening prompt de-dup keys on a PHASE BOUNDARY (prior turn's
  `stopReason !== 'tool_use'`), NOT prompt text, so two phases sharing a prompt
  can't drop a user message (→ invalid consecutive-assistant messages). Prior
  tool-result content is ELIDED to a cap (`MAX_PRIOR_RESULT_CHARS`) so a
  read-heavy clarify explore can't overflow the resuming model's window
  (a non-retryable 400); a precise per-target-model token budget is a
  follow-up. **Known gap → H4:** a prior phase authored by a NON-recording
  adapter (claude/ollama/gemini/adk) writes no `turn:N` effects, so if that
  model burns on a RESUME and falls to openrouter, its history can't be
  reconstructed (the successor is spawned with empty `priorMessages`). This
  does NOT regress vs pre-Tier-2 (claude→claude resume still uses native
  `--resume`; openrouter-authored history IS now carried), and is now
  NON-SILENT (a warn fires); the full fix is recording turns for those
  adapters (Phase H4 "port remaining adapters"). **RESOLVED by FO2/H4
  (2026-06-03): all four adapters now record turns (claude/gemini/ollama/adk)
  — see §4.4; the warn now fires only for a genuinely unrecorded prior phase.**
  Green: agent-core 449 (+2
  splice tests), core-pipeline 545 (+5 reconstruction tests), dashboard
  545/541. Landed behind a 4-dimension adversarial review (5 confirmed
  findings — 2 majors fixed: elision + non-silent gap warn; 1 latent
  phase-boundary landmine fixed; 2 doc fixes).
- **Tier 3 — burn-aware `AgentManagerSession`** (clarify + QA): per-phase
  `runWithChainFallback` + a session-spanning recorder under a DEDICATED
  `${stage}:session` substep (so its `turn:N:*` never collide with the
  main runtime's coarse `ctx.effect`/`ctx.waitForSignal`; `ownRuntime`
  forces an isolated idx even at root scope) + coarse `${stage}:session:pN`
  `ctx.effect` wraps. The interface stays unchanged — all burn config is
  constructor-injected (`makeAgentSession(deps, turnCtx)`). Cost rollup reads
  the `:session` substep via `rollupStepCostAcrossSubsteps`.
- **`fix-loop` — DONE (2026-06-03): per-repo step-body fallback refactor.**
  Was the last path on `NullTurnRecorder`; its OLD step-level
  `runWithChainFallback` (one model for all repos, re-running the whole step
  on any repo's burn) couldn't carry a per-repo prefill/recorder. The fallback
  moved INTO the per-repo loop: each repo (and the single-repo path) gets its
  OWN burn-aware `AgentManagerSession` — per-phase chain-fallback + a per-repo
  `ownRuntime` turn recorder + cross-attempt resume — created via
  `makeAgentSession(deps, ctx, {coarseWrap:false})` and CACHED across attempts
  (`fixSessions` Map owned by the validate while-loop) so each recorder is
  monotonic over `sendInput` resumes. `coarseWrap:false` because N per-repo
  sessions run in parallel over one shared `ctx` (a coarse `ctx.effect` per
  repo would race the idx counter; the per-repo recorder is the isolation
  boundary — crash-resume stays stage-granular via the validate re-run).
  `sessionStage='validate'` (the ENCLOSING step) so fix-loop turns record under
  `validate:session` and roll up under the validate `step:completed`
  (alongside the revalidate turns under `validate`). Canonical contract:
  `RunFixLoopOptions.agentSession` → `sessionForRepo(repoName|null)`. A burn in
  one repo no longer re-runs the others (the burned-model set stays SHARED). A
  side win: fix-loop resumes (attempt N) now carry the prior attempt's
  conversation via Tier 2 `priorMessages` for non-claude models.
  The 4-dimension adversarial review confirmed 5 findings, all fixed:
  (1, major) the spawn `stage='validate'` was driving BOTH the recorder
  substep AND the burn-fallback model chain → fix-loop burns re-resolved the
  `validate` chain not `fix-loop`; decoupled via a new
  `AgentRunRequest.routingStage` (='fix-loop') used only for `fb.resolveModel`,
  `stage` stays 'validate' for recording. (2, BLOCKER — pre-existing from the
  H3b validate cutover) the initial validate AND the revalidate both recorded
  per-repo turns under stepId `validate` with the same `repo:turn:0:*` keys →
  the revalidate's fresh scoped runtime read the initial's turns back →
  idempotency-hash mismatch → `DeterminismViolationError` crashed the validate
  stage (durable + non-claude); fixed by giving the revalidate a distinct
  effect prefix (`runPerRepoStage` `scopeSuffix='revalidate-N'` → scope
  `[repo, revalidate-N]`), which the prefix-tolerant `validate` rollup still
  sums. (3, minor) single-repo fix-loop `start()` omitted `allowedTools`
  (read-only fallback for non-claude) — now threaded. Green: core-pipeline 550
  (+6 contract tests incl. routingStage + allowedTools), dashboard 545/541.

**BUG-1 (pre-existing, surfaced by the code review): the dashboard
`Pipeline` runs WITHOUT a `durableStore`.** `pipeline-loop.ts`'s
`PipelineLoopOpts` does not declare `durableStore`/`durableHolder` and
`new Pipeline({...})` never passes them (the spread in
`pipeline-runner.ts` is silently dropped at the call boundary). So in the
dashboard `ctx.effect` is `passthroughEffect` and `ctx.waitForSignal`
THROWS — i.e. ALL effect-level durable machinery is inert there and the
dashboard's crash-resume is **stage-granularity** (durable event log +
resume queue). Consequences + the cutover's stance:
  - Turn recording (cost/provenance) + same-process burn continuation
    still WORK in the dashboard because they go through the module-singleton
    `getDurableStore()` (`createScopedEffectRuntime`) + the live per-phase
    fallback — NOT via `ctx.effect`. clarify/QA use `ownRuntime` so they
    record. (Single-stage uses `ctxRuntime(ctx)` → passthrough → does NOT
    record in the dashboard: a pre-existing H3b gap; per-repo/build DO via
    the scoped runtime.)
  - The coarse `${stage}:session:pN` `ctx.effect` wraps are passthrough
    no-ops in the dashboard (harmless); effect-granularity crash-resume of
    a phase is active only when a store IS threaded into `Pipeline`
    (cli/tests). The `AgentManagerSession` header documents this.
  - QA's `ctx.waitForSignal` race now `.catch`es the passthrough rejection
    and defers to the in-process resolver (the live answer path), so
    passing `turnCtx` into the QA stage does not break Q&A.
  - **Fix A — DONE (2026-06-03): `durableStore` threaded into the dashboard
    `Pipeline`.** `pipeline-loop.ts` `PipelineLoopOpts` now declares
    `durableStore?`/`durableHolder?` and `new Pipeline({...})` passes them, so
    `ctx.effect` records+replays (effect-granularity crash-resume) and
    `ctx.waitForSignal` waits on the durable signal queue (durable Q&A /
    reviewer-pause across restarts) — dashboard-wide. The pre-existing
    `ctx.effect`/`waitForSignal` SITES (H3b per-repo + sessions cutovers) are
    unchanged; Fix A just makes them LIVE. **Rewind guard:** the store is
    passed only on the FORWARD pass (`!rewindToStep`) — a reviewer rewind
    re-runs steps whose effects are already recorded under the same stepId, and
    the store has no effect-invalidation primitive, so replaying them would
    return stale results / trip `DeterminismViolationError`; rewind re-invokes
    run in PASSTHROUGH (rewound steps re-run fresh = pre-Fix-A behavior; the
    `rewindTo` skip-logic skips pre-rewind steps on its own, verified at
    pipeline.ts:232-239). The rewind guard was COMPLETED post-review: the
    Pipeline store alone wasn't enough — the per-repo/clarify/QA turn recorders
    bind to the module-SINGLETON store independently, so the loop also passes
    `turnCtx=undefined` on a rewind pass to make those recorders inert (else
    rewound stages stale-replay / `DeterminismViolation`). The QA
    `ctx.waitForSignal` `.catch` was scoped to swallow ONLY the passthrough
    throw (durable-disabled) and re-throw real durable rejections (fail loud,
    not hang). Durable semantics are covered by core-pipeline `crash-recovery`/
    `resume`/`rewind-to`/`durable-versioning` tests; the full dashboard scenario
    suite is green WITH durable active (545/541, no regression). Landed behind
    a 5-dimension adversarial review (10 findings; 2 majors).
    **RESOLVED by FO1 (Fix A resume-model follow-on, 2026-06-03):** the dashboard
    RESUME now REUSES the original `runId` (1a), so the durable replay-completed
    skip-set + EffectRuntime replay engage across restart, and durable Q&A
    survives a restart (finding 10). `StartPipelineOptions.resumeRunId?` →
    mint-site `options?.resumeRunId ?? build-<ts>`; `doResume` recovers it from
    `checkpoint?.runId || prevRun?.id || input.runId` (checkpoint.runId pairs
    with the stages driving resumeFrom); the auto-resume queue reuses the
    orphan's own id. Reconciliation (1b) is CONSERVATIVE: `computeSkipSetDivergence`
    (durable/skip-reconcile.ts) detects disk-vs-durable disagreement + warns,
    durable still wins — NO rewrite of the load-bearing skipReason map. QA
    hardening (1c): cancellable `waitForSignal` (cancel() drains stageInputResolvers
    + aborts a runner AbortController threaded into the Pipeline on every pass,
    finding 4) + atomic `consumeSignalAndRecord` store method (finding 5).
    finding-3 dedup is subsumed (idempotent set()); finding-8 per-repo done/undone
    was REJECTED (already derived per-pass from `hasValidationFailures` +
    validate-stage replay-completed; a persisted flag would diverge). Landed behind
    3 adversarial reviews. **STILL OPEN**: multi-process lease-status validation in
    `acquireLease` (pre-existing; resume currently WARNS when the lease is held);
    the reconciliation WARNS only (no automated divergence-resolution policy —
    that needs replay-equivalence validation).

#### §4.3.3 React UI cutover (per-model CostMeter + continuation marker, 2026-06-02)

The §2.6/§2.7 surfaces reach the dashboard UI through **one** new typed
event, `pipeline.step-cost` — the continuation marker is *derived* from the
rollup rather than carried by a second event.

**Continuation signal (post-review correction).** The marker MUST fire on a
model *handoff*, not on re-injected token volume. An adversarial review caught
that an initial gate on `prefilledInputTokens > 0` / `prefillReinjectionUsd > 0`
silently suppressed the marker in the two MOST common real cases: (a) a model
that 429s before its first SSE delta streams empty text → the successor's
prefill is zero-token → `prefilledInputTokens === 0`; (b) an unpriced successor
(e.g. an OpenCode id absent from the LiteLLM table) → `inRate === 0` →
`prefillReinjectionUsd === 0`. The fix moves the signal into the rollup as a
token/price-independent `StepContinuation { successors, predecessors }`,
derived from the **burned-vs-completed model sets**: the `stopReason:'burned'`
sentinel records the predecessor model reliably in BOTH cases (it's written in
the adapter catch before any text streams), and a successor is a model that
completed a turn without ever burning. `start-pipeline` gates the marker on
`continuation` and only appends the `(+$… re-injected)` suffix when there was a
priced re-injection. Regression tests in `durable-turn-resume.test.ts` pin the
empty-text-burn case, the unpriced-successor case, the same-model-retry
negative (no marker), and the `:session`-substep merge.

**Data path (server → client):**
- **Runner** (`pipeline-runner.ts`) subscribes to its own `pipelineBus`
  `step:completed`. On each completed step it rolls up cost with
  `rollupStepCostAcrossSubsteps(getDurableStore(), runId, stepId)` and, when
  the rollup is non-empty, emits a `step-cost` event on its `EventEmitter`.
  **Critical: the rollup reads the module-singleton store, NOT the Pipeline's
  `durableStore`** — the dashboard Pipeline runs without one (the loop drops
  it; see §4.3.2 BUG-1), so `pipeline.ts`'s own step:completed cost enrichment
  never fires in the dashboard. The turn recorder still writes its effects to
  the singleton via scoped/own runtimes, so reading it back in the runner is
  the cost path that actually works here. Stages with no turn effects
  (single-stage, inert in the dashboard) roll up EMPTY and are skipped —
  their scalar cost is left untouched.
- **Translation** (`start-pipeline.ts`) `runner.on('step-cost', …)` →
  `services.pipeline.emit('pipeline.step-cost', …)`; AND, when the step was
  continued across models (a successor bucket + `prefillReinjectionUsd > 0`),
  pushes a `kind:'provenance'` `ActivityEntry` ("↪ Continued by <successor>
  after <predecessor> exhausted …") into the activity stream via the existing
  `agent.output` channel.
- **Typed-event recipe** wired through `events/types.ts`
  (`PipelineStepCostEvent` + local `StepModelCost` to keep core-pipeline out
  of the browser bundle), `events/topics.ts` (`global`/`cost`/`run:<id>`),
  `events/wire-translate.ts` (legacy `pipeline-step-cost`), and
  `services/index.ts` (`PipelineEventMap`).
- **Client**: `reducer.ts` carries the new kind as a pass-through (the
  exhaustive `never` check forces it) + a `WIRE_TO_KIND` entry; the
  load-bearing render path is the legacy `handleServerMessage`
  (`pipeline-step-cost` → `runStepCosts[runId][stepId]`), mirroring how
  `cost.snapshot` drives `runCost` — because **the reducer state is not yet
  consumed by components** (the Phase 5–6 migration is incomplete; legacy
  `useState` still drives the UI). `main.tsx` aggregates per-run with
  `aggregateRunModelCost` and renders a non-compact `<CostMeter>` (per-model
  breakdown + "prefill re-injection" line, "↪" tag on the successor) in the
  RunDetail header beside `StageSpendPanel`.
- **`ActivityLine.tsx`** gains a `kind:'provenance'` branch (accent strip +
  `GitBranch` icon).

**v1 boundary (deliberate):** the fine-grained per-span `Provenance.segments`
recorded on `assistant-end` is NOT surfaced inline (the activity stream isn't
turn-indexed, so precise per-line placement would be false precision). The
user-visible deliverable is the stage-level cross-model handoff marker +
per-model spend, both derived from the §2.6 rollup. Inline span highlighting
is a future enhancement that can read `segments` directly.

Green: core-pipeline 535/535 (incl. 3 new continuation cases), dashboard
545/541 (0 fail, 4 pre-existing skips; incl. two new `events-replay.test.ts`
cases pinning `pipeline.step-cost` topic routing + the cross-boundary legacy
wire string `pipeline-step-cost` the client keys on untyped). Landed behind a
9-agent adversarial review (2 confirmed-minor false-negatives in the marker
gate, both fixed by the burned-vs-completed continuation signal above).

### §4.4 Phase H4 — port remaining adapters

Each adapter ports in its own PR; the PR deletes the legacy
single-effect path for that adapter and adds the recorder calls.

The bridge already forwards `config.turnRecorder` to EVERY adapter
(language-model-bridge.ts:243, no provider gate) and `buildTurnWiring`
creates it provider-agnostically — so H4 per adapter is purely making
that adapter CONSUME the recorder (no bridge change).

- `opencode` / `openai` — already record (extend openrouter).
- **`gemini` — DONE (FO2, 2026-06-03)**: single-shot HTTP. startTurn
  (with userPrompt) before fetch; honors `replayed` → skips the fetch +
  re-emits the recorded text (safe: text-only, re-emit is complete);
  endTurn after the empty-output throw-check. Tests:
  gemini-adapter-recording.test.ts.
- **`claude` — DONE (FO2, 2026-06-03)**: CLI subprocess. startTurn
  before spawn; endTurn before the final return. Deliberately NO
  replay-skip — claude pipes rich stream-json (tool_result PR URLs);
  re-running on resume preserves full output, and the single
  assistant-start key is the deterministic prompt hash (no
  DeterminismViolation). Tools opaque (run in CLI) → no runTool.
- **`ollama` — DONE (FO2b, 2026-06-03)**: FULL openrouter-parity port.
  Per-iter startTurn; replay-skip branch (burned-sentinel re-issues
  recorded toolUses with a throwing exec + re-throws a retryable
  UpstreamError for deterministic chain re-derivation; normal replay
  re-pushes historyDelta + re-issues runTool to advance the cursor +
  endTurn); live tool-loop wraps each exec in `recorder.runTool`
  (idempotencyKey = contentHashFromArgs) + builds historyDelta; catch
  records a `'burned'` sentinel gated on a mid-`runOneTurn` burn only.
  Determinism under `trimHistoryIfNeeded` holds because the replay branch
  re-pushes historyDelta verbatim BEFORE the next trim → `messages`
  converges to the same trimmed state → next assistant-start hash matches.
  Validated by a record→replay-equivalence test (0 fetches + 0 tool execs
  + identical output on replay).
- **`adk` — DONE (FO2b, 2026-06-03)**: SINGLE-SHOT treatment, not the
  tool-loop port — ADK runs its whole agentic loop incl. tool execution
  inside `runEphemeral` (opaque to agent-core), so it records ONE coarse
  turn (startTurn before loadAdk; endTurn success-only) and HONORS
  `replayed` by SKIPPING runEphemeral entirely (avoids re-executing the
  loop + tool side-effects). No runTool, no burn sentinel (single turn
  from our view — same minor multi-model caveat as gemini).

After H4 lands, `invoke-agent` as a single effect no longer
exists in the codebase. The lint rule in `core-pipeline/durable/lint.ts`
gains a new check forbidding any new single-effect LLM wrapper —
the pattern is `TurnRecorder` everywhere or nowhere.

### §4.5 Test harnesses (cross-phase)

- **`MockUpstream` fault-injection harness** (new helper in
  `agent-core/src/__tests__/util/mock-upstream.ts`): an HTTP
  server that streams a recorded SSE transcript and can be told
  to abort at a configurable byte offset or message index. Used
  by every adapter's burn-test, including the mid-`tool_use`
  truncation test from H2.
- **`replay-equivalence.ts` spy whitelist**: extend the
  `throwingSpy` in
  `core-pipeline/src/durable/replay-equivalence.ts` to whitelist
  `flushPartial` and `invalidatePartials` (both are durable
  writes, not outbound side effects). Without this every replay
  test fails the moment a partial is recorded.
- **Cross-vendor swap matrix tests**: for each row of §2.8, an
  integration test asserts the target model's request body
  matches the expected shape (stripped fields absent, tool_results
  translated, prefill present).
- **Cancel-mid-prefill tombstone test**: kill model A mid-stream,
  cancel the run before chain-walker retries, assert a fresh
  run with the same stepId+turn does NOT pick up the stale
  partial.

---

## §5. Out of scope (named, not skipped)

This ADR carves the resume problem at the chain-fallback boundary.
The following adjacent problems are explicitly out of scope:

- **Mid-stream resume on the SAME model.** The recorder lets the
  next chain entry continue, but if model A's network hiccup
  resolves on its own, we still abandon model A's connection.
  Continuing on the same model requires per-provider continuation
  endpoints (e.g. Anthropic's `messages.continue` if/when it
  exists); out of scope here.
- **Cross-run resumption.** This ADR persists partial state
  within one run's durable log. Continuing a partial turn from
  yesterday's run into today's run is a separate ADR (involves
  context staleness questions the user has not asked for).
- **Streaming-aware activity rows in the dashboard.** The
  dashboard already shows the buffered transcript; this ADR does
  not change that surface beyond exposing §2.7 provenance.

### §5.1 Anthropic same-vendor continuation fast-path

When `sourceProvider === 'anthropic'` AND
`targetProvider === 'anthropic'` (e.g. claude-opus-4-7 burns →
chain falls to claude-sonnet-4-6), Anthropic's `messages` API
accepts a trailing `{ role: 'assistant', content: prefill.text }`
AND honors prompt-caching on the prefix. The cost of re-injecting
A's output as B's input is dominated by **cache reads**, not
fresh input tokens.

Implementation note: when this fast-path applies, the
adapter should set `cache_control: { type: 'ephemeral' }` on the
final system message of the prefill request so subsequent tool-
loop turns within the same session also hit the cache. This
materially reduces the cost of long-running fix-loop sessions
where one stage burns multiple chain entries.

This is an optimization layered on top of the §2.3 prefill
protocol — same-vendor swaps just happen to be cheaper. The
correctness contract is unchanged.

#### §5.1.1 Minimum-cacheable-prefix floor (CRITICAL)

`cache_control` is **silently ignored** when the marked prefix is
below the target model's minimum cacheable size. This is a no-op,
NOT an error: `cache_creation_input_tokens` comes back `0` and the
full prefix is billed at the normal input rate. The floor is
**model-specific** and, for the Haiku tier, materially higher than
Anthropic's historically-documented 1024-token figure.

Empirical matrix, 2026-05-25 (`/tmp/spike-anthropic-cache-matrix.mjs`,
identical request fired twice per cell):

| model            | prefix  | cache_creation (A) | cache_read (B) | cached? |
|------------------|---------|--------------------|----------------|---------|
| claude-haiku-4-5 | ~2.3K   | 0                  | 0              | NO      |
| claude-haiku-4-5 | ~2.3K (beta hdr) | 0         | 0              | NO      |
| claude-haiku-4-5 | ~6K     | 6382               | 6382           | YES     |
| claude-sonnet-4-6| ~2.3K   | 2323               | 2323           | YES     |
| claude-sonnet-4-6| ~6K     | 6383               | 6383           | YES     |

Findings:
- **The `anthropic-beta: prompt-caching-*` header is irrelevant** —
  both Haiku ~2.3K cells failed identically. Caching is GA under
  `anthropic-version: 2023-06-01`; no beta header needed.
- **Sonnet caches at ~2.3K; Haiku-4-5 does not** — Haiku's floor
  sits between ~2.3K and ~6K tokens. The exact value isn't pinned
  (the matrix didn't bisect), but the H4 implementation MUST treat
  Haiku-class minimums as ">~4K, verify per-model" rather than the
  stale 1024 figure.

Design consequence: §5.1's win comes from caching the **large
stable system+history prefix**, NOT the small partial-assistant
continuation. In real Anvil stages the system prompt (project
prompt + composed skills + KB context) is large and clears the
Sonnet/Opus floor comfortably. When the target is a Haiku-tier
model AND the prefix is short, the adapter MUST NOT assume a cache
benefit — it should still send the prefill (correctness), but the
cost-tracker (§2.6) MUST attribute full input cost, not a
cache-read discount, until `cache_read_input_tokens > 0` is
observed in the response. Never assume the discount; read it back.

**Validation status (2026-05-25):** VALIDATED WITH CAVEAT.
- Trailing-`assistant` continuation: ✅ confirmed against
  `claude-haiku-4-5` (clean mid-sentence continuation on the
  cache-read request).
- Prompt-cache round-trip: ✅ confirmed (`cache_read_input_tokens`
  matched `cache_creation_input_tokens` on the 2nd request) for
  every cell at/above the model's floor.
- Caveat: gated on §5.1.1. The H4 regression test
  (`cache-hit-detected.integration.test.ts`) MUST assert the floor
  behavior per model, not just "a hit happened", so a future model
  with a different floor doesn't silently degrade the fast-path to
  full-price re-injection.

The OpenAI-compat half of §2.3 (trailing `assistant` message
continuation) WAS validated 2026-05-25 against `qwen3.6-plus` via
OpenCode: the model returned a clean leading-space continuation
with no preamble or restart. That covers the openrouter /
opencode / openai / ollama paths.

---

## §6. Where to look first

- Sub-effect emission: future `agent-core/src/turn-recorder.ts`.
- Replay path: existing `effect-runtime.ts:171` (`runEffect`) —
  no changes needed, the sub-effects flow through the standard
  path.
- Partial-sink storage: extend `DurableStore` with
  `appendAssistantPartial` / `readAssistantPartial` /
  `invalidatePartials` —
  `core-pipeline/src/durable/store.ts` interface + both drivers.
- Chain-fallback prefix handoff:
  `core-pipeline/src/routing/with-fallback.ts:42`.
- Adapter wiring contract: each adapter's `run()` method;
  reference impl in `openrouter-adapter.ts`.
- Strip + translate helpers: `agent-core/src/prefill/strip.ts`
  + `agent-core/src/prefill/translate.ts`.
- Cost accounting changes: `core-pipeline/src/hooks/cost-tracker.hook.ts`
  + `agent-core/src/agent/session/session.ts:459` (`accumulateCost`).
- Test harness: `agent-core/src/__tests__/util/mock-upstream.ts`
  (new); whitelist edits in `core-pipeline/src/durable/replay-equivalence.ts`.
