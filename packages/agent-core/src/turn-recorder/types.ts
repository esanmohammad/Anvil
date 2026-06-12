/**
 * TurnRecorder types — public shapes consumed by adapters that drive a
 * multi-turn LLM tool loop and want their turns split into sub-effects
 * so chain-fallback can resume mid-stream.
 *
 * Design notes:
 *   - agent-core does NOT depend on `@anvil/core-pipeline`. The
 *     `EffectRuntimeLike` interface here is the structural shape an
 *     adapter needs — core-pipeline's concrete `EffectRuntime` satisfies
 *     it, but agent-core never imports the class. This avoids a
 *     circular dep direction.
 *   - The recorder is constructed per `adapter.run()` call. It holds a
 *     monotonic `turn` counter scoped to the (stepId, sessionId) pair.
 *   - `flushPartial` is intentionally non-async and not routed through
 *     `effect()` — it MUST be safe to fire from a `catch` block that is
 *     about to re-throw an `UpstreamError`. The sink may queue the
 *     write durably under the hood; the recorder doesn't wait.
 */

import type { ProviderName } from '../types.js';

// ─────────────────────────────────────────────────────────────────────
// Effect-runtime structural interface
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimal effect-runtime shape the recorder relies on. Mirrors the
 * `effect(name, fn, opts?)` method on core-pipeline's `EffectRuntime`.
 * Anything else on the real class (now/uuid/random/sleep/waitForSignal)
 * is irrelevant to the recorder.
 *
 * Replay semantics: when an effect with `(name, idx)` is already in the
 * durable log, `fn` is NOT invoked — the recorded payload is returned.
 * Recording side effects (`record*` methods) thus become no-ops on
 * replay, which is exactly what we want.
 */
export interface EffectRuntimeLike {
  effect<T>(name: string, fn: () => Promise<T>, opts?: EffectInvokeOptions): Promise<T>;
  /**
   * H3 replay-skip seam: peek the recorded payload of a COMPLETED effect
   * by name WITHOUT advancing the replay cursor or the per-step idx
   * counter. Returns the recorded `effect:completed` payload if one
   * exists in this step's log, else undefined. Lets `startTurn` detect
   * that a turn was already fully recorded (its `assistant-end` exists)
   * so the adapter can skip the upstream call entirely on crash-resume.
   *
   * Optional: the NullEffectRuntime omits it, so non-durable callers
   * (single-shot / no DurableStore) always run live (peek → undefined →
   * no replay). The concrete core-pipeline `EffectRuntime` implements it
   * as a pure read over the pre-loaded recorded-effect set.
   */
  peekRecorded?<T = unknown>(name: string): T | undefined;
}

export interface EffectInvokeOptions {
  /** Stable input hash; mismatches on replay throw a determinism error. */
  idempotencyKey?: string;
  /** Hint that the payload is small enough to inline; runtime may skip blobs. */
  smallResult?: boolean;
  /**
   * Transform applied to the result before it is persisted to the durable
   * log; the live caller still gets the full result. Used to cap large
   * tool-result payloads so a turn doesn't block the loop serialising them.
   * Mirrors `EffectOptions.persistTransform` in core-pipeline.
   */
  persistTransform?: (result: unknown) => unknown;
}

// ─────────────────────────────────────────────────────────────────────
// Tool-use + tool-result (neutral shapes — vendor translation in §2.3.2)
// ─────────────────────────────────────────────────────────────────────

export interface RecordedToolUse {
  /** Provider-supplied tool_use id (e.g. OpenAI's `tool_call_id`). */
  id: string;
  name: string;
  /** Parsed JSON arguments. UNPARSED args MUST NOT be recorded (§2.1.1). */
  arguments: Record<string, unknown>;
  /** sha256(name || JSON.stringify(arguments)). */
  idempotencyKey: string;
}

export interface NeutralToolResult {
  toolUseId: string;
  toolName: string;
  ok: boolean;
  content: string | unknown;
  durationMs?: number;
}

// ─────────────────────────────────────────────────────────────────────
// Provenance (§2.7)
// ─────────────────────────────────────────────────────────────────────

export interface ProvenanceSegment {
  model: string;
  provider: ProviderName;
  range: [number, number];
  source: 'live' | 'prefill';
}

export interface Provenance {
  segments: ProvenanceSegment[];
}

// ─────────────────────────────────────────────────────────────────────
// Token usage (extends agent-core's existing CostInfo shape with
// prefill-reinjection accounting from §2.6)
// ─────────────────────────────────────────────────────────────────────

export interface TurnTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Subset of inputTokens carved out for §2.6 prefill-reinjection. */
  prefilledInputTokens?: number;
}

// ─────────────────────────────────────────────────────────────────────
// Prefill (§2.3) — handed from chain-walker to next attempt
// ─────────────────────────────────────────────────────────────────────

export interface PrefillToolUse {
  id: string;
  name: string;
  input: unknown;
  result: NeutralToolResult;
  producedBy: ProviderName;
}

export interface Prefill {
  turnUuid: string;
  text: string;
  toolUses: PrefillToolUse[];
  sourceProvider: ProviderName;
  /** Model id that authored the partial — drives §2.7 provenance
   *  segment[0].model on the resuming turn. Optional: omitted by
   *  pre-H3 callers / when the source model is unknown. */
  sourceModel?: string;
  /** Tokens (as billed by sourceProvider) for `text`; H3 cost accounting. */
  sourceTokens: number;
}

/**
 * §Tier 2 — one COMPLETED prior turn of a stateful session, reconstructed
 * from the durable log so a cross-model (or merely non-claude) resume can
 * re-present the full conversation in the target provider's wire format.
 * Unlike `Prefill` (the in-progress burned turn), these are finished turns.
 *
 * `userPrompt` is present on the FIRST turn of each phase (the new user
 * message that opened that phase); it's undefined on tool-loop continuation
 * turns within a phase, and on pre-Tier-2 logs that never recorded it.
 */
export interface PrefillTurn {
  userPrompt?: string;
  text: string;
  toolUses: PrefillToolUse[];
  /**
   * Authoring provider of this completed turn — informational / provenance.
   * `materializePriorTurns` flattens all turns to the resuming target's wire
   * format and does NOT run per-turn `stripForTarget`: completed turns are
   * rebuilt from neutral fields (text + `NeutralToolResult`) that carry no
   * vendor keys (no `reasoning_details` / `cache_control` / `prompt_cache_key`),
   * so there is nothing to strip. (Contrast the `prefill` path, which does
   * `stripForTarget` because it can re-present source-shaped messages.)
   */
  producedBy: ProviderName;
}

// ─────────────────────────────────────────────────────────────────────
// Partial-turn signaling (§2.2)
// ─────────────────────────────────────────────────────────────────────

export type PartialReason = 'upstream' | 'abort' | 'timeout';

export interface AssistantPartial {
  runId: string;
  stepId: string;
  turnUuid: string;
  turn: number;
  text: string;
  /** Count of FULLY-PARSED tool_use blocks emitted before the throw. */
  toolUsesEmitted: number;
  reason: PartialReason;
  recordedAt: string;
}

export type PartialSink = (partial: AssistantPartial) => void;

// ─────────────────────────────────────────────────────────────────────
// startTurn / endTurn shapes
// ─────────────────────────────────────────────────────────────────────

export interface AssistantStartRequest {
  model: string;
  provider: ProviderName;
  system?: string;
  /** Raw conversation messages sent to the upstream. Recorded for provenance. */
  messages: unknown;
  prefill?: Prefill;
  /**
   * §Tier 2 — the new user message that opened this phase. Recorded in the
   * assistant-start payload so `reconstructSessionHistory` can re-present
   * prior turns with their prompts on a stateful (non-claude) session resume.
   */
  userPrompt?: string;
}

export interface AssistantTurn {
  turnUuid: string;
  turn: number;
  text: string;
  stopReason: string;
  usage: TurnTokenUsage;
  provenance: Provenance;
  toolUses: RecordedToolUse[];
  toolResults: NeutralToolResult[];
  /**
   * H3 replay determinism: the EXACT provider-native messages the
   * adapter appended to its conversation history during this turn
   * (assistant message + tool-result messages), as opaque objects. On
   * crash-resume the adapter re-appends these verbatim instead of
   * reconstructing them from the neutral `toolUses`/`text` — raw vs
   * canonical `tool_calls` arguments and vendor `reasoning_details` echoes
   * would otherwise drift, leaving the FIRST live turn past the replay
   * frontier with a malformed upstream request (e.g. unpaired tool_calls,
   * or "reasoning_content is missing"). Empty for a terminal (no-tool)
   * turn that appended nothing before breaking.
   */
  historyDelta: unknown[];
}

export interface TurnRecorderDeps {
  /** EffectRuntime to record sub-effects against. */
  runtime: EffectRuntimeLike;
  /** Fire-and-forget partial sink; called from adapter catch blocks. */
  partialSink: PartialSink;
  /** Stable runId — propagated into AssistantPartial rows. */
  runId: string;
  /** Stable stepId — scopes the recorder to one pipeline Step. */
  stepId: string;
  /** v4 uuid factory — overridable for tests. Defaults to crypto.randomUUID. */
  uuid?: () => string;
  /** Wall-clock helper — overridable for tests. Defaults to () => new Date().toISOString(). */
  nowIso?: () => string;
  /**
   * Effect-name prefix (v2 ADR §2.4 per-repo scoping). When a step fans
   * out across repos in parallel, every repo's recorder writes effects
   * under the SAME durable step id, so a bare `turn:0:assistant-start`
   * from two repos would collide. The caller passes a per-repo prefix
   * (e.g. `service-a:`) so the recorded keys become
   * `service-a:turn:0:assistant-start` — unique per repo AND matched by
   * the durable engine's per-repo effect filter (which keys on delimited
   * scope tokens). Empty ('') for single-stage paths. Applied uniformly
   * to every effect name AND to the `peekRecorded` replay lookup.
   */
  effectPrefix?: string;
  /**
   * Seed for the per-recorder turn counter (v2 ADR §2.5.1). When an
   * `AgentProcess.sendInput()` resume spawns a NEW adapter (hence a new
   * recorder) for a session whose prior adapter already recorded turns
   * 0..N, the new recorder MUST continue at N+1 so `(stepId, turnUuid)`
   * stays globally unique and replay's effect-idx matching doesn't
   * collide. The recorder itself cannot read the durable log (it only
   * holds a structural `EffectRuntimeLike`), so the CALLER computes the
   * highest completed turn for (runId, stepId) and passes it here; the
   * recorder seeds `turnCounter = initialTurn`. Defaults to 0 (fresh
   * session / no prior turns).
   */
  initialTurn?: number;
}
