/**
 * H3 turn-level durable resume — production wiring (v2 ADR §2.4/§2.5/§2.6/§2.7).
 *
 * Builds the `{ turnRecorder, resolvePrefill }` pair a stage's agent run
 * needs to record per-turn sub-effects + continue a burned model from its
 * partial. Centralises the scoping rules so every cutover site (single,
 * per-repo, per-task, session) wires it the same way:
 *
 *   - single-stage  → scopeTokens [], runtime = the stage ctx itself.
 *   - per-repo       → scopeTokens [repo], runtime = a per-repo scoped
 *                      EffectRuntime (own idx sequence; survives the
 *                      concurrent Promise.all fan-out).
 *   - per-task build → scopeTokens [repo, taskId] (tasks race within a
 *                      repo under maxConcurrent).
 *
 * Returns `{}` when durable mode is off (no ctx or no store) → adapters
 * fall back to NullTurnRecorder + no prefill (byte-identical to pre-H3).
 */

import { TurnRecorder } from '@esankhan3/anvil-agent-core';
import type { Prefill, PrefillTurn, AssistantPartial, EffectRuntimeLike } from '@esankhan3/anvil-agent-core';
import {
  buildPrefillFromPartial,
  reconstructSessionHistory,
  createScopedEffectRuntime,
  type DurableStore,
  type StepContext,
} from '@esankhan3/anvil-core-pipeline';
import { getDurableStore } from './durable-store-singleton.js';
import { providerOfModelId } from './pipeline-runner-types.js';

export interface TurnWiring {
  turnRecorder?: TurnRecorder;
  resolvePrefill?: (info: {
    burnedModel: string;
    attemptIndex: number;
    nextModel?: string;
  }) => Promise<Prefill | undefined>;
  /**
   * §Tier 2 stateful resume — reconstruct the session's COMPLETED prior
   * turns from the durable log so a non-claude resume re-presents the full
   * conversation. Returns [] when there are no prior turns (START phase).
   */
  resolvePriorMessages?: () => Promise<PrefillTurn[]>;
}

const EMPTY: TurnWiring = {};

/**
 * Wrap a StepContext as the minimal `EffectRuntimeLike` the recorder
 * needs (effect + peekRecorded), so single-stage paths record turn
 * sub-effects through the stage's own runtime.
 */
function ctxRuntime(ctx: StepContext<string>): EffectRuntimeLike {
  return {
    effect: <T>(name: string, fn: () => Promise<T>, opts?: { idempotencyKey?: string; smallResult?: boolean }) =>
      ctx.effect<T>(name, fn, opts),
    peekRecorded: <T>(name: string) => ctx.peekRecorded?.<T>(name),
  };
}

/**
 * Build the turn-recorder + prefill resolver for one agent run.
 *
 * @param ctx   the stage StepContext (undefined → non-durable → returns {}).
 * @param eventStepId  the Pipeline step.id the turn effects live under.
 * @param scopeTokens  per-repo / per-task isolation tokens; [] for single.
 */
export async function buildTurnWiring(opts: {
  ctx?: StepContext<string>;
  eventStepId: string;
  scopeTokens?: readonly string[];
  /**
   * Turn the recorder's counter starts at. DEFAULT 0 — the within-run
   * crash-replay contract: one logical adapter operation (single-stage,
   * per-repo, per-task, a session phase) ALWAYS re-issues its turns from
   * 0 so the EffectRuntime replays the recorded `turn:N:*` sub-effects
   * positionally. `nextTurnSeed` (one past the highest recorded turn) is
   * the WRONG seed here: on a burn-then-crash it skips the burned turn's
   * start-only effects and the first replay `startTurn` asks for a turn
   * index that no recorded effect matches → DeterminismViolationError.
   * Only a `sendInput`-RESUME run (a NEW recorder continuing a PRIOR
   * completed run's turns — fix-loop's per-attempt sessions) passes a
   * non-zero seed; it computes `nextTurnSeed` at its own call site.
   */
  initialTurn?: number;
  /**
   * Force a DEDICATED `EffectRuntime` instance (own idx counter) even at
   * scope []. Single-stage (default false) shares the stage `ctx` runtime
   * so its turn sub-effects interleave correctly with any sibling
   * `ctx.effect`/`__anvil_*` under the SAME stepId. Sessions set this true
   * because their turn effects live under a DEDICATED `${stage}:session`
   * substep that nothing else writes — sharing the main `ctx` runtime
   * would instead put them on the main stepId, colliding with the coarse
   * `ctx.effect`/`ctx.waitForSignal` replay cursor (the §D1 isolation rule).
   */
  ownRuntime?: boolean;
}): Promise<TurnWiring> {
  const { ctx, eventStepId } = opts;
  const store: DurableStore | null = getDurableStore();
  if (!ctx || !store) return EMPTY;

  const runId = ctx.runId;
  const scopeTokens = opts.scopeTokens ?? [];
  const effectPrefix = scopeTokens.length ? `${scopeTokens.join(':')}:` : '';
  const partialStepId = scopeTokens.length ? `${eventStepId}:${scopeTokens.join(':')}` : eventStepId;

  // Single-stage (scope [], no ownRuntime) shares the stage ctx runtime so
  // turn sub-effects interleave with sibling effects on the main stepId.
  // Per-repo/per-task (scoped) and sessions (ownRuntime, dedicated substep)
  // each get an isolated idx sequence.
  const runtime: EffectRuntimeLike = (scopeTokens.length === 0 && !opts.ownRuntime)
    ? ctxRuntime(ctx)
    : await createScopedEffectRuntime({ store, runId, stepId: eventStepId, scopeTokens, signal: ctx.signal });

  // Within-run replay re-issues from turn 0 (see initialTurn doc above).
  const initialTurn = opts.initialTurn ?? 0;

  const turnRecorder = new TurnRecorder({
    runtime,
    partialSink: (p: AssistantPartial) => {
      // Fire-and-forget durable write; must never block the catch path
      // that flushes it. Rejections are swallowed (the next attempt just
      // gets no prefill — a clean retry, per §2.4).
      void store
        .appendAssistantPartial({ runId: p.runId, stepId: p.stepId, turnUuid: p.turnUuid, payload: p })
        .catch(() => {});
    },
    runId,
    stepId: partialStepId,
    effectPrefix,
    initialTurn,
  });

  const resolvePrefill = (info: { burnedModel: string; attemptIndex: number; nextModel?: string }) =>
    buildPrefillFromPartial({
      store,
      runId,
      stepId: partialStepId,
      eventStepId,
      effectPrefix,
      burnedModel: info.burnedModel,
      sourceProvider: providerOfModelId(info.burnedModel),
      targetModel: info.nextModel,
    });

  // §Tier 2: reconstruct prior COMPLETED turns from the session substep.
  // Reads the same (eventStepId, effectPrefix) the recorder writes under.
  const resolvePriorMessages = () =>
    reconstructSessionHistory(store, runId, eventStepId, effectPrefix);

  return { turnRecorder, resolvePrefill, resolvePriorMessages };
}

/**
 * Session-scoped turn wiring (clarify / QA — burn-aware `AgentManagerSession`).
 *
 * One recorder spans a session's phases (explore→synthesize / start→resume),
 * under a DEDICATED `${stage}:session` substep stepId so its `turn:N:*`
 * effects never collide with the main runtime's coarse `ctx.effect` /
 * `ctx.waitForSignal` (§D1). `ownRuntime` forces an isolated idx counter even
 * at root scope. fix-loop is PER-repo → pass `repoName` (strict-prefix
 * isolation across the racing repos).
 *
 * Returns a closure so the session builds the recorder lazily on its first
 * `start()` (the recorder must outlive the call, threaded into every spawn).
 */
export function buildSessionTurnWiring(
  ctx: StepContext<string> | undefined,
): (info: { stage: string; repoName?: string }) => Promise<TurnWiring> {
  return (info) => buildTurnWiring({
    ctx,
    eventStepId: `${info.stage}:session`,
    scopeTokens: info.repoName ? [info.repoName] : [],
    ownRuntime: true,
  });
}
