/**
 * §2.6 per-model cost rollup.
 *
 * With turn-level sub-effects, one step's spend is spread across many
 * `turn:N:assistant-end` rows (one per turn, each tagged with its
 * authoring model) plus `assistant-partial` rows (a turn a model burned
 * mid-stream). This rollup reads them back and buckets cost by model,
 * carving the prefill-reinjection portion into its own bucket so a
 * resuming model isn't silently double-billed for the prior model's text.
 *
 * Contract (ADR §2.6):
 *   - costByModel[m].costUsd = m's NEW spend = (inputTokens −
 *     prefilledInputTokens) × inRate + outputTokens × outRate. The
 *     re-injected portion is NOT billed here.
 *   - prefillReinjectionUsd = Σ prefilledInputTokens × inRate — the
 *     itemised cost of re-presenting a burned model's text to its
 *     successor. Surfaced as a distinct line, not folded into a model.
 *   - totalCostUsd = Σ costByModel.costUsd + prefillReinjectionUsd.
 *   - Partial-turn cost (a burn) is attributed to the model that authored
 *     it (read from that turn's `assistant-start`), output-priced from an
 *     estimate when no usage frame survived the burn.
 *
 * Returns an EMPTY rollup for a step with no turn effects (e.g. a stage
 * still on the legacy single-effect path) so callers fall back to the
 * existing scalar cost untouched.
 */

import { getModelPricing } from '@esankhan3/anvil-agent-core';
import type { AssistantPartial } from '@esankhan3/anvil-agent-core';

import type { DurableStore } from './store.js';

export interface ModelCost {
  model: string;
  provider?: string;
  /** New spend billed to this model (excludes re-injected prefill input). */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Subset of inputTokens that was re-injected prefill (billed to the bucket). */
  prefilledInputTokens: number;
}

/**
 * §H3 cross-model continuation summary for one step — the model handoff a
 * burn produced, surfaced so the UI can render a "↪ continued by X" marker.
 *
 * Deliberately derived from the BURNED-vs-COMPLETED model sets, NOT from
 * `prefilledInputTokens`/`prefillReinjectionUsd`: a model that 429s before
 * its first SSE delta streams empty text → zero re-injected tokens → zero
 * reinjection cost, yet the handoff is real. And an unpriced successor (e.g.
 * an OpenCode id absent from the price table) has zero reinjection cost too.
 * The `stopReason:'burned'` sentinel records the predecessor model reliably
 * in BOTH cases, so this signal fires whenever a real handoff happened.
 */
export interface StepContinuation {
  /** Models that completed work and were never burned — the successor(s). */
  successors: string[];
  /** Models whose turn burned and was re-issued to a successor. */
  predecessors: string[];
}

export interface StepCostRollup {
  costByModel: Record<string, ModelCost>;
  /** Itemised cost of re-injecting burned models' text into successors. */
  prefillReinjectionUsd: number;
  /** Σ per-model new spend + reinjection bucket. */
  totalCostUsd: number;
  /** Cross-model handoff in this step, or null if none. */
  continuation: StepContinuation | null;
}

// Prefix-tolerant: a per-repo recorder writes `service-a:turn:N:...`, a
// single-stage recorder writes bare `turn:N:...`. Capture the prefix so
// turn-keys from different repos under the same step id don't collide.
const ASSISTANT_START_RE = /^(.*)turn:(\d+):assistant-start$/;
const ASSISTANT_END_RE = /^(.*)turn:(\d+):assistant-end$/;

interface EndUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  prefilledInputTokens?: number;
}

function emptyModelCost(model: string, provider?: string): ModelCost {
  return {
    model,
    provider,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    prefilledInputTokens: 0,
  };
}

/** Read all turn ends + partials for a step and bucket cost by model. */
export async function rollupStepCostByModel(
  store: DurableStore,
  runId: string,
  stepId: string,
): Promise<StepCostRollup> {
  const pairs = await store.readEffectEvents(runId, stepId);

  // (prefix+turn) → authoring model/provider (from assistant-start, the
  // source of truth even for a burned turn that never reached
  // assistant-end). Keyed by the full `${prefix}${turn}` so two repos'
  // turn 0 under the same step id don't overwrite each other. We also
  // collect the distinct effect-key prefixes ('' for single-stage,
  // 'service-a:' for per-repo) so we know which scoped step ids hold the
  // partials (per-repo partials live under `${stepId}:${repo}`).
  const turnModel = new Map<string, { model: string; provider?: string }>();
  const prefixes = new Set<string>();
  for (const pair of pairs) {
    const m = ASSISTANT_START_RE.exec(pair.started.effectKey ?? '');
    if (!m || !pair.completed) continue;
    prefixes.add(m[1]);
    const p = pair.completed.payload as { model?: string; provider?: string } | null;
    if (p?.model) turnModel.set(`${m[1]}${m[2]}`, { model: p.model, provider: p.provider });
  }

  const costByModel: Record<string, ModelCost> = {};
  let prefillReinjectionUsd = 0;
  let totalCostUsd = 0;
  // §H3 burn accounting: a burned turn records BOTH a fire-and-forget partial
  // AND an awaited `stopReason:'burned'` sentinel end (carrying the streamed
  // text). Normally the partial prices it; but if the partial write was lost
  // (best-effort + may race a crash) while the sentinel persisted, fall back
  // to pricing from the sentinel so the burned model's spend is never dropped.
  const burnedSentinels = new Map<string, { text: string; model?: string; provider?: string }>();
  const pricedBurnedTurns = new Set<string>();
  // §H3 continuation tracking — token/price-independent. A model in
  // `burnedModels` had a turn burned (sentinel or partial); a model in
  // `completedModels` finished a non-burned turn. The successor of a handoff
  // is a completed model that never burned.
  const burnedModels = new Set<string>();
  const completedModels = new Set<string>();

  const bucket = (model: string, provider?: string): ModelCost => {
    const existing = costByModel[model];
    if (existing) return existing;
    const created = emptyModelCost(model, provider);
    costByModel[model] = created;
    return created;
  };

  // ── Completed turns ─────────────────────────────────────────────────
  for (const pair of pairs) {
    const m = ASSISTANT_END_RE.exec(pair.started.effectKey ?? '');
    if (!m || !pair.completed) continue;
    const turnKey = `${m[1]}${m[2]}`;
    const payload = pair.completed.payload as {
      usage?: EndUsage;
      model?: string;
      provider?: string;
      stopReason?: string;
      text?: string;
    } | null;
    if (!payload) continue;
    // §H3 burn sentinel: a `stopReason:'burned'` assistant-end is a replay
    // marker for an interrupted turn, NOT a completed generation. Its cost is
    // normally priced from the partial (output estimate) in the burned-turns
    // loop below; pricing it here too would double-count. Stash it for the
    // fallback-pricing pass (in case the partial was lost) and skip.
    if (payload.stopReason === 'burned') {
      const meta = turnModel.get(turnKey);
      const burnedModel = payload.model ?? meta?.model;
      burnedSentinels.set(turnKey, {
        text: typeof payload.text === 'string' ? payload.text : '',
        model: burnedModel,
        provider: payload.provider ?? meta?.provider,
      });
      if (burnedModel) burnedModels.add(burnedModel);
      continue;
    }

    const meta = turnModel.get(turnKey);
    const model = payload.model ?? meta?.model ?? 'unknown';
    const provider = payload.provider ?? meta?.provider;
    completedModels.add(model);
    const usage = payload.usage ?? {};

    const inTok = usage.inputTokens ?? 0;
    const outTok = usage.outputTokens ?? 0;
    const prefilled = usage.prefilledInputTokens ?? 0;
    const [inRate, outRate] = getModelPricing(model) ?? [0, 0];

    const newInput = Math.max(0, inTok - prefilled);
    const newSpend = (newInput / 1_000_000) * inRate + (outTok / 1_000_000) * outRate;
    const reinjection = (prefilled / 1_000_000) * inRate;

    const b = bucket(model, provider);
    b.costUsd += newSpend;
    b.inputTokens += inTok;
    b.outputTokens += outTok;
    b.cacheReadTokens += usage.cacheReadTokens ?? 0;
    b.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    b.prefilledInputTokens += prefilled;

    prefillReinjectionUsd += reinjection;
    totalCostUsd += newSpend + reinjection;
  }

  // ── Burned (partial) turns ──────────────────────────────────────────
  // Partials are keyed by the recorder's stepId: bare `stepId` for
  // single-stage (prefix ''), repo-scoped `${stepId}:${repo}` for per-repo
  // (prefix `${repo}:`). Read each scope so per-repo burn costs aren't
  // silently dropped from the rollup.
  for (const prefix of prefixes) {
    const repoName = prefix ? prefix.slice(0, -1) : ''; // drop trailing ':'
    const partialStepId = repoName ? `${stepId}:${repoName}` : stepId;
    const partials = await store.readAssistantPartials(runId, partialStepId);
    for (const rec of partials) {
      if (rec.invalidated) continue;
      const payload = rec.payload as AssistantPartial | null;
      if (!payload || typeof payload.text !== 'string') continue;
      const turnKey = `${prefix}${payload.turn}`;
      const meta = turnModel.get(turnKey);
      if (!meta) continue; // can't price without the authoring model
      const [, outRate] = getModelPricing(meta.model) ?? [0, 0];
      // No usage frame survives most burns — estimate output tokens (~chars/4).
      const estOut = Math.ceil(payload.text.length / 4);
      const partialSpend = (estOut / 1_000_000) * outRate;
      const b = bucket(meta.model, meta.provider);
      b.costUsd += partialSpend;
      b.outputTokens += estOut;
      totalCostUsd += partialSpend;
      pricedBurnedTurns.add(turnKey); // this burned turn is now accounted for
      burnedModels.add(meta.model); // a partial means this model's turn burned
    }
  }

  // ── Burned sentinels with NO surviving partial ──────────────────────
  // Fallback so a lost partial write never drops the burned model's spend.
  for (const [turnKey, sentinel] of burnedSentinels) {
    if (pricedBurnedTurns.has(turnKey) || !sentinel.model) continue;
    const [, outRate] = getModelPricing(sentinel.model) ?? [0, 0];
    const estOut = Math.ceil(sentinel.text.length / 4);
    const spend = (estOut / 1_000_000) * outRate;
    const b = bucket(sentinel.model, sentinel.provider);
    b.costUsd += spend;
    b.outputTokens += estOut;
    totalCostUsd += spend;
  }

  // §H3 continuation: a successor is a model that completed work without ever
  // burning; predecessors are the burned models. Non-null only when both sides
  // are present (a genuine cross-model handoff, not a same-model retry).
  const successors = [...completedModels].filter((m) => !burnedModels.has(m));
  const continuation: StepContinuation | null =
    burnedModels.size > 0 && successors.length > 0
      ? { successors, predecessors: [...burnedModels] }
      : null;

  return { costByModel, prefillReinjectionUsd, totalCostUsd, continuation };
}

/** True when the rollup found any turn-level cost (i.e. a ported stage). */
export function rollupIsEmpty(r: StepCostRollup): boolean {
  return Object.keys(r.costByModel).length === 0;
}

/** Sum two per-model buckets into a fresh one. */
function mergeModelCost(a: ModelCost, b: ModelCost): ModelCost {
  return {
    model: a.model,
    provider: a.provider ?? b.provider,
    costUsd: a.costUsd + b.costUsd,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    prefilledInputTokens: a.prefilledInputTokens + b.prefilledInputTokens,
  };
}

/** Merge two continuation summaries (union both sides, deduped). */
function mergeContinuation(
  a: StepContinuation | null,
  b: StepContinuation | null,
): StepContinuation | null {
  if (!a) return b;
  if (!b) return a;
  return {
    successors: [...new Set([...a.successors, ...b.successors])],
    predecessors: [...new Set([...a.predecessors, ...b.predecessors])],
  };
}

/** Merge two step rollups (per-model buckets summed, scalars added). */
export function mergeRollups(a: StepCostRollup, b: StepCostRollup): StepCostRollup {
  const costByModel: Record<string, ModelCost> = { ...a.costByModel };
  for (const [model, bucket] of Object.entries(b.costByModel)) {
    costByModel[model] = costByModel[model] ? mergeModelCost(costByModel[model], bucket) : bucket;
  }
  return {
    costByModel,
    prefillReinjectionUsd: a.prefillReinjectionUsd + b.prefillReinjectionUsd,
    totalCostUsd: a.totalCostUsd + b.totalCostUsd,
    continuation: mergeContinuation(a.continuation, b.continuation),
  };
}

/**
 * Roll up a step's per-model cost across BOTH its main stepId AND its
 * `${stepId}:session` substep (clarify / QA / fix-loop record turn effects
 * under the dedicated session substep so they don't collide with the main
 * runtime's coarse `ctx.effect`/`ctx.waitForSignal`; §D1). Each substep is
 * processed with the same per-repo-prefix logic, then merged. A step with no
 * session turns just merges in an empty rollup (no-op).
 */
export async function rollupStepCostAcrossSubsteps(
  store: DurableStore,
  runId: string,
  stepId: string,
): Promise<StepCostRollup> {
  const [main, session] = await Promise.all([
    rollupStepCostByModel(store, runId, stepId),
    rollupStepCostByModel(store, runId, `${stepId}:session`),
  ]);
  return mergeRollups(main, session);
}
