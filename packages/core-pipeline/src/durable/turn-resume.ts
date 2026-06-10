/**
 * Turn-level durable resume helpers (v2 ADR §2.4 / §2.5.1 / §2.3.3).
 *
 * Bridges the durable log to the chain walker + turn recorder:
 *   - `readCompletedTurns` / `nextTurnSeed` — scan `turn:N:assistant-end`
 *     effects so a resumed adapter's recorder continues past the prior
 *     adapter's turns (§2.5.1 `initialTurn`).
 *   - `buildPrefillFromPartial` — read the most-recent non-invalidated
 *     assistant-partial for a step + the completed tool history of its
 *     turn, assemble the neutral `Prefill`, and run it through the
 *     §2.3.3 truncation gate. Returns undefined when no servable partial
 *     exists (the walker then retries the next model with no prefill).
 *
 * Implemented over the existing `DurableStore.readEffectEvents` +
 * `readAssistantPartials` — no new driver methods, so SQLite + in-memory
 * stay bit-identical for free.
 */

import { truncatePrefillForBudget } from '@esankhan3/anvil-agent-core';
import type {
  AssistantPartial,
  NeutralToolResult,
  Prefill,
  PrefillToolUse,
  PrefillTurn,
  ProviderName,
} from '@esankhan3/anvil-agent-core';

import type { DurableStore } from './store.js';
import type { EffectEventPair } from './types.js';

/**
 * Match `<prefix>turn:N:<suffix>` and return N, or null. `prefix` is the
 * per-repo scope (e.g. `service-a:`) or '' for single-stage paths.
 */
function matchTurn(key: string | null | undefined, prefix: string, suffix: string): number | null {
  if (!key) return null;
  if (prefix && !key.startsWith(prefix)) return null;
  const rest = prefix ? key.slice(prefix.length) : key;
  const m = new RegExp(`^turn:(\\d+):${suffix}$`).exec(rest);
  return m ? Number(m[1]) : null;
}

/**
 * Turn numbers (ascending) that have a recorded `turn:N:assistant-end`
 * for (runId, stepId), scoped to `effectPrefix` (per-repo). A fresh step
 * returns []. Gaps are preserved (a turn whose end never recorded is
 * simply absent).
 */
export async function readCompletedTurns(
  store: DurableStore,
  runId: string,
  stepId: string,
  effectPrefix = '',
): Promise<number[]> {
  const pairs = await store.readEffectEvents(runId, stepId);
  const turns = new Set<number>();
  for (const pair of pairs) {
    if (!pair.completed) continue;
    const n = matchTurn(pair.started.effectKey, effectPrefix, 'assistant-end');
    if (n !== null) turns.add(n);
  }
  return Array.from(turns).sort((a, b) => a - b);
}

/**
 * Seed value for a recorder spawned on (runId, stepId): one past the
 * highest completed turn, or 0 for a fresh step. Keeps `(stepId,
 * turnUuid)` unique across `sendInput` resume boundaries (§2.5.1).
 */
export async function nextTurnSeed(
  store: DurableStore,
  runId: string,
  stepId: string,
  effectPrefix = '',
): Promise<number> {
  const turns = await readCompletedTurns(store, runId, stepId, effectPrefix);
  return turns.length === 0 ? 0 : turns[turns.length - 1] + 1;
}

/** ~chars/4 token estimate — matches the truncation default. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

interface BuildPrefillArgs {
  store: DurableStore;
  runId: string;
  /** stepId the partials were written under (recorder `deps.stepId`). For
   *  per-repo this is the repo-scoped id (e.g. `build:service-a`). */
  stepId: string;
  /** stepId the turn EFFECTS live under (the Pipeline step.id). Defaults
   *  to `stepId`. Diverges from `stepId` only for per-repo, where effects
   *  share the parent step id but partials are repo-scoped. */
  eventStepId?: string;
  /** Per-repo effect-name prefix (e.g. `service-a:`); '' for single. */
  effectPrefix?: string;
  /** The model that just burned — provenance source + cost attribution. */
  burnedModel: string;
  /** Provider of the burned model — drives §2.3.1 strip / §2.3.2 translate. */
  sourceProvider: ProviderName;
  /** Model the prefill is about to be served to — §2.3.3 truncation budget.
   *  When omitted, truncation is skipped (the adapter still works; it just
   *  isn't pre-sized). */
  targetModel?: string;
  /** Tokens already committed to the next request (system + user). */
  baseTokens?: number;
}

/**
 * Assemble the next attempt's prefill from the latest non-invalidated
 * assistant-partial recorded for (runId, stepId), or undefined if none
 * is servable. The partial's completed tool history (tool_result:M with
 * its tool_use:M) is re-presented; tools without a recorded result
 * (cut off mid-execution) are dropped per §2.1.1.
 */
export async function buildPrefillFromPartial(args: BuildPrefillArgs): Promise<Prefill | undefined> {
  const { store, runId, stepId, burnedModel, sourceProvider } = args;
  const eventStepId = args.eventStepId ?? stepId;
  const effectPrefix = args.effectPrefix ?? '';

  // Latest non-invalidated partial for the step (newest seq last).
  const partials = await store.readAssistantPartials(runId, stepId);
  const latest = partials.at(-1);
  if (!latest) return undefined;

  const payload = latest.payload as AssistantPartial | null;
  if (!payload || typeof payload.text !== 'string') return undefined;

  const toolUses = await reconstructTurnToolUses(
    store, runId, eventStepId, effectPrefix, payload.turn, sourceProvider,
  );

  const prefill: Prefill = {
    turnUuid: payload.turnUuid,
    text: payload.text,
    toolUses,
    sourceProvider,
    sourceModel: burnedModel,
    // The partial sink does not (yet) carry a token count; estimate from
    // the streamed text. Drives both reinjection cost (§2.6) and the
    // truncation budget (§2.3.3); the 8K margin absorbs the estimate slack.
    sourceTokens: estimateTokens(payload.text),
  };

  if (!args.targetModel) return prefill;

  return truncatePrefillForBudget({
    prefill,
    targetModel: args.targetModel,
    baseTokens: args.baseTokens,
    estimateTokens,
  });
}

/**
 * Walk a turn's recorded tool sub-effects and pair each completed
 * `tool_result:M` with its `tool_use:M` payload into a `PrefillToolUse`.
 * Ordered by M. Tools whose result never recorded are omitted (§2.1.1).
 */
async function reconstructTurnToolUses(
  store: DurableStore,
  runId: string,
  eventStepId: string,
  effectPrefix: string,
  turn: number,
  producedBy: ProviderName,
): Promise<PrefillToolUse[]> {
  const pairs = await store.readEffectEvents(runId, eventStepId);
  const uses = new Map<number, { name: string; input: unknown }>();
  const results = new Map<number, NeutralToolResult>();
  const usePrefix = `${effectPrefix}turn:${turn}:tool_use:`;
  const resPrefix = `${effectPrefix}turn:${turn}:tool_result:`;

  for (const pair of pairs) {
    if (!pair.completed) continue;
    const key = pair.started.effectKey ?? '';
    if (key.startsWith(usePrefix)) {
      const m = Number(key.slice(usePrefix.length));
      const p = pair.completed.payload as { name?: string; arguments?: unknown } | null;
      uses.set(m, { name: p?.name ?? '', input: p?.arguments ?? {} });
      continue;
    }
    if (key.startsWith(resPrefix)) {
      const m = Number(key.slice(resPrefix.length));
      results.set(m, pair.completed.payload as NeutralToolResult);
    }
  }

  const out: PrefillToolUse[] = [];
  for (const idx of [...results.keys()].sort((a, b) => a - b)) {
    const result = results.get(idx)!;
    const use = uses.get(idx);
    out.push({
      id: result.toolUseId,
      name: use?.name ?? result.toolName,
      input: use?.input ?? {},
      result,
      producedBy,
    });
  }
  return out;
}

/**
 * §Tier 2 — reconstruct a stateful session's COMPLETED prior turns from the
 * durable log so a non-claude resume can re-present the full conversation
 * (openrouter-family carries no native history; see ADR §4.3.2 Tier 2).
 *
 * Reads every `turn:N:assistant-end` under (runId, stepId, effectPrefix) in
 * ascending N — the session recorder is monotonic across phases, so one
 * stepId (`${stage}:session`) holds all phases' turns. Per turn it pairs the
 * `assistant-start` (for the recorded `userPrompt`) with the `assistant-end`
 * (text + provider) and the completed tool history (`reconstructTurnToolUses`).
 *
 * Two correctness rules:
 *   - `stopReason:'burned'` sentinels are SKIPPED — a burned turn was re-issued
 *     to a successor whose completion is the real turn; including both would
 *     double-present it.
 *   - The phase-opening `userPrompt` is emitted only at a PHASE BOUNDARY
 *     (when it differs from the prior turn's prompt). One adapter.run() = one
 *     phase = possibly several tool-loop turns all stamped with the same
 *     prompt; emitting it per turn would inject duplicate user messages.
 *
 * A turn with no recorded `userPrompt` (pre-Tier-2 log) degrades gracefully:
 * its assistant output is kept, the user message is simply absent.
 *
 * NB (dashboard): the session recorder writes turn effects to the
 * module-singleton store via its own scoped runtime — NOT through `ctx.effect`
 * (a passthrough in the dashboard, BUG-1). This reads them back from that same
 * store; if turn effects ever move onto `ctx.effect` in the dashboard, this
 * would read nothing there.
 */
export async function reconstructSessionHistory(
  store: DurableStore,
  runId: string,
  stepId: string,
  effectPrefix = '',
  upToTurn?: number,
): Promise<PrefillTurn[]> {
  const pairs = await store.readEffectEvents(runId, stepId);

  const starts = new Map<number, { userPrompt?: string }>();
  const ends = new Map<number, { text: string; stopReason?: string; provider?: ProviderName }>();
  for (const pair of pairs) {
    if (!pair.completed) continue;
    const key = pair.started.effectKey ?? '';
    const sN = matchTurn(key, effectPrefix, 'assistant-start');
    if (sN !== null) {
      const p = pair.completed.payload as { userPrompt?: string | null } | null;
      starts.set(sN, { userPrompt: typeof p?.userPrompt === 'string' ? p.userPrompt : undefined });
      continue;
    }
    const eN = matchTurn(key, effectPrefix, 'assistant-end');
    if (eN !== null) {
      const p = pair.completed.payload as { text?: string; stopReason?: string; provider?: ProviderName } | null;
      ends.set(eN, { text: typeof p?.text === 'string' ? p.text : '', stopReason: p?.stopReason, provider: p?.provider });
    }
  }

  const turnNums = [...ends.keys()]
    .filter((n) => upToTurn === undefined || n < upToTurn)
    .sort((a, b) => a - b);

  const out: PrefillTurn[] = [];
  let prevStopReason: string | undefined;
  let sawTurn = false;
  for (const n of turnNums) {
    const end = ends.get(n)!;
    if (end.stopReason === 'burned') continue; // re-issued to a successor; skip
    const provider = (end.provider ?? 'openrouter') as ProviderName;
    const toolUses = (await reconstructTurnToolUses(store, runId, stepId, effectPrefix, n, provider))
      .map(elidePriorToolResult);
    const thisPrompt = starts.get(n)?.userPrompt;
    // Emit the phase-opening prompt at a PHASE BOUNDARY: the first turn, or a
    // turn whose predecessor ENDED a phase (terminal stopReason). A same-phase
    // tool-loop continuation always follows a `tool_use` turn, so keying on the
    // prior turn's stopReason — NOT prompt text — is robust even when two
    // phases happen to share an identical prompt (would otherwise drop the
    // second phase's user message → invalid consecutive assistant messages).
    const isPhaseStart = !sawTurn || prevStopReason !== 'tool_use';
    const userPrompt = thisPrompt && isPhaseStart ? thisPrompt : undefined;
    out.push({ userPrompt, text: end.text, toolUses, producedBy: provider });
    prevStopReason = end.stopReason;
    sawTurn = true;
  }
  return out;
}

/**
 * Cap a re-presented prior-turn tool result's content. The clarify EXPLORE
 * phase is an agentic read-loop — a single `read_file` can return ~256 KB.
 * Re-presenting every result verbatim across N turns can overflow the
 * resuming model's context (a non-retryable 400). Eliding the bulk to a head
 * + marker keeps the wire well-formed and the gist intact; the model can
 * re-read if it needs more. (The burned-turn `prefill` has its own
 * `truncatePrefillForBudget`; this is the analogous bound for `priorMessages`.
 * A precise per-target-model token budget is a documented follow-up.)
 */
const MAX_PRIOR_RESULT_CHARS = 4096;
function elidePriorToolResult(use: PrefillToolUse): PrefillToolUse {
  const content = use.result.content;
  if (typeof content !== 'string' || content.length <= MAX_PRIOR_RESULT_CHARS) return use;
  const elided =
    `${content.slice(0, MAX_PRIOR_RESULT_CHARS)}\n…[truncated ${content.length - MAX_PRIOR_RESULT_CHARS} chars — re-read if needed]`;
  return { ...use, result: { ...use.result, content: elided } };
}

// Re-exported for callers that want the same estimator the resume path uses.
export { estimateTokens as estimatePrefillTokens };
export type { EffectEventPair };
