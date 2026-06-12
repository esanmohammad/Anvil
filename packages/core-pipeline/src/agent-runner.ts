/**
 * `AgentRunner` — the canonical agent invocation surface used by
 * stage logic in this package.
 *
 * Both consumers (cli's lightweight runner backed by `single-shot.ts`
 * and dashboard's heavyweight runner backed by `AgentManager.spawn`)
 * implement this same shape, so a single `runXxxStage` function works
 * unchanged for both. The result type is widened from the previous
 * cli-only `{output, tokenEstimate}` to expose what dashboard needs
 * (cost, cache, stop reason, agentId for live updates).
 *
 * Lives in core-pipeline because stage logic is owned here; the cli
 * and dashboard packages re-export this for back-compat with their
 * existing imports.
 */

import type { TurnRecorder, Prefill } from '@esankhan3/anvil-agent-core';

export interface AgentRunRequest {
  /** Persona name (clarifier, analyst, architect, lead, engineer, …). */
  persona: string;
  /** System prompt — persona + project + KB context. */
  projectPrompt: string;
  /** Stage-specific user prompt. */
  userPrompt: string;
  /** Working directory the agent runs in (per-repo or workspace root). */
  workingDir: string;
  /** Stage label for telemetry (clarify, repo-requirements, build, …). */
  stage: string;
  /**
   * Stage key for burn-fallback MODEL resolution, when it must differ from
   * `stage`. fix-loop spawns under `stage='validate'` (so its turns roll up
   * under the enclosing validate step's cost), but its post-burn fallback must
   * follow the `fix-loop` chain — `routingStage='fix-loop'`. Defaults to
   * `stage` (clarify/QA/per-repo: routing == recording stage).
   */
  routingStage?: string;
  /** Optional model override; resolver picks one when omitted. */
  model?: string;
  /** Optional provider override (claude, openrouter, opencode, …). */
  provider?: string;
  /** Stage-scoped tool permissions; respected by non-Claude agentic adapters. */
  allowedTools?: readonly string[];
  /** Tools the agent must NOT call this stage. */
  disallowedTools?: readonly string[];
  /** Cap on output tokens; honored where the adapter exposes a flag. */
  maxOutputTokens?: number;
  /** Optional fan-out hint — repo name when this run is per-repo. */
  repoName?: string;
  /**
   * Turn-level durable recorder (v2 ADR §2.5). When a step body builds
   * one (from its `ctx.effect` runtime + a DurableStore-backed partial
   * sink) and threads it here, the runner forwards it down to
   * `ModelAdapterConfig.turnRecorder`, splitting the agent's LLM
   * invocation into per-turn sub-effects. Omitted → adapters use a
   * NullTurnRecorder (no persistence; identical observable behavior).
   */
  turnRecorder?: TurnRecorder;
  /**
   * Prefill from a prior chain entry that burned mid-stream (v2 ADR
   * §2.3). Threaded from `LlmRouter.runAgent`'s `resolvePrefill` into
   * the next attempt's request, then down to
   * `ModelAdapterConfig.prefill` so the adapter continues from the
   * exact character the prior model stopped at.
   */
  prefill?: Prefill;
  /**
   * Prefill resolver (v2 ADR §2.4). When a step body wires turn-level
   * resume, it builds this closure (capturing the DurableStore + the
   * recorder's scope) and threads it here; the runner forwards it into
   * `LlmRouter.runAgent`'s `resolvePrefill` so that after a burn the
   * NEXT attempt continues from the burned model's recorded partial.
   * Omitted → every attempt runs prefill-less.
   *
   * Returns the prefill for the next attempt, or undefined for a clean
   * (prefill-less) retry — e.g. when no servable partial exists or the
   * §2.3.3 truncation gate rejects it for the target window.
   */
  resolvePrefill?: (info: {
    burnedModel: string;
    attemptIndex: number;
    nextModel?: string;
  }) => Promise<Prefill | undefined>;
}

export interface AgentRunResult {
  /**
   * Canonical artifact text — comes from the adapter's terminal `result`
   * frame (claude-cli stream-json) or the final assistant text (HTTP
   * adapters). Empty string when the adapter never reached its result
   * frame; Step 1 / Step 7 / Step B's empty-throws turn that case into
   * a retryable upstream error before reaching here.
   */
  output: string;
  /**
   * Streaming transcript — every text chunk the agent emitted across
   * tool turns. Used by the Activity tab. Optional: cli's lightweight
   * runner doesn't track this and leaves it as `output`.
   */
  transcript?: string;
  /** Legacy field — total tokens (input + output). Kept for back-compat. */
  tokenEstimate: number;
  /**
   * Detailed token + cost fields. Optional so cli's lightweight runner
   * (which only tracks `tokenEstimate`) stays compatible. Dashboard's
   * AgentManager-backed runner populates the full set.
   */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** USD cost for this run, computed from adapter pricing. */
  costUsd?: number;
  /** Wall-clock ms. */
  durationMs?: number;
  /** Adapter-reported stop reason (end_turn, max_tokens, aborted, …). */
  stopReason?: string;
  /** Resolved model id. */
  model?: string;
  /** Live agent id — only the dashboard runner exposes this. */
  agentId?: string;
}

export interface AgentRunner {
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}
