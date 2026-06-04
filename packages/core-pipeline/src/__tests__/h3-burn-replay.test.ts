/**
 * H3 sessions Tier 1 — burn-then-continue-then-crash determinism regression.
 *
 * Exercises the REAL EffectRuntime + TurnRecorder through the exact loop the
 * openrouter adapter runs, so the positional (name, idx) replay invariant is
 * tested faithfully (name-keyed fakes in agent-core can't catch idx drift).
 *
 * Scenario (one logical adapter operation, single-stage scope []):
 *   LIVE: model A startTurn(0) → 1 tool → BURN. The adapter records a
 *     `stopReason:'burned'` SENTINEL assistant-end (Tier 1 #3) + flushes a
 *     partial. Chain-fallback → model B reuses the SAME recorder → startTurn(1)
 *     → endTurn complete.
 *   CRASH. Resume re-runs the stage from the top: ONE fresh adapter run, fresh
 *     EffectRuntime seeded from the store.
 *
 * Pins:
 *   - seed 0 (within-run replay) replays clean: burned turn 0 replay-skips via
 *     the sentinel (re-issues recorded tools, exec NEVER re-runs), re-throws to
 *     re-burn, chain-fallback re-derives B for turn 1 → zero determinism error.
 *   - the TRANSIENT-CLEARED case: even if model A "would succeed" on replay,
 *     the sentinel forces the re-burn so replay reproduces B's turn 1 (no
 *     divergence, no collision).
 *   - the OLD wiring (seed = nextTurnSeed) still throws — proving seed 0 is
 *     load-bearing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TurnRecorder } from '@esankhan3/anvil-agent-core';
import type { AssistantPartial, NeutralToolResult } from '@esankhan3/anvil-agent-core';
import { InMemoryDurableStore } from '../durable/in-memory-store.js';
import { createScopedEffectRuntime } from '../durable/effect-runtime.js';
import { nextTurnSeed, readCompletedTurns } from '../durable/turn-resume.js';
import type { DurableStore } from '../durable/store.js';

const RUN = 'run-burn-replay';
const STEP = 'single';

async function mkStore(): Promise<DurableStore> {
  const store = new InMemoryDurableStore();
  await store.createRun({ runId: RUN, project: 'p', feature: 'f', featureSlug: 'f' });
  return store;
}

function mkRecorder(store: DurableStore, runtime: unknown, initialTurn: number): TurnRecorder {
  let n = 0;
  return new TurnRecorder({
    runtime: runtime as never,
    partialSink: (p: AssistantPartial) => {
      void store.appendAssistantPartial({ runId: p.runId, stepId: p.stepId, turnUuid: p.turnUuid, payload: p }).catch(() => {});
    },
    runId: RUN,
    stepId: STEP,
    initialTurn,
    uuid: () => `uuid-${n++}`,
  });
}

/** A scripted turn: how many tools it runs live, and whether it burns. */
interface TurnSpec { tools: number; burn?: boolean }

/**
 * Mimic ONE adapter.run() turn loop, faithful to the openrouter adapter's
 * Tier-1 branches: burn writes a `stopReason:'burned'` sentinel end; on replay
 * a burned sentinel re-issues recorded tools (throwing exec), re-records the
 * end, and re-throws. Returns live exec count + whether it burned.
 */
async function adapterRun(recorder: TurnRecorder, turns: TurnSpec[]): Promise<{ execRuns: number; burned: boolean }> {
  let execRuns = 0;
  for (let t = 0; t < turns.length; t += 1) {
    const spec = turns[t];
    const { turn, replayed } = await recorder.startTurn({
      model: 'm', provider: 'openrouter', messages: [{ role: 'user', content: 'x' }],
    });

    if (replayed) {
      if (replayed.stopReason === 'burned') {
        // §H3 burned-turn replay: re-issue recorded tools (exec must NOT fire),
        // re-record the sentinel, re-throw to re-burn (deterministic chain).
        for (const tu of replayed.toolUses) {
          await recorder.runTool(turn, tu.name, tu.arguments, tu.idempotencyKey, async () => {
            throw new Error('replay invariant: exec ran for a recorded burned-turn tool');
          });
        }
        await recorder.endTurn(turn, replayed.text, 'burned', replayed.usage, replayed.provenance, replayed.historyDelta);
        return { execRuns, burned: true };
      }
      for (const tu of replayed.toolUses) {
        await recorder.runTool(turn, tu.name, tu.arguments, tu.idempotencyKey, async () => {
          throw new Error('replay invariant: exec ran for a recorded tool');
        });
      }
      await recorder.endTurn(turn, replayed.text, replayed.stopReason, replayed.usage, replayed.provenance, replayed.historyDelta);
      continue;
    }

    // Live branch.
    for (let m = 0; m < spec.tools; m += 1) {
      await recorder.runTool(turn, 'write', { i: m }, `k${turn}-${m}`, async (): Promise<NeutralToolResult> => {
        execRuns += 1;
        return { toolUseId: `tc${turn}-${m}`, toolName: 'write', ok: true, content: 'ok' };
      });
    }
    if (spec.burn) {
      // §H3 #3: flush partial + record a 'burned' sentinel assistant-end.
      recorder.flushPartial(turn, 'partial', spec.tools, 'upstream');
      await recorder.endTurn(turn, 'partial', 'burned', { inputTokens: 0, outputTokens: 0 }, { segments: [] }, []);
      return { execRuns, burned: true };
    }
    await recorder.endTurn(turn, `text-${turn}`, 'end_turn', { inputTokens: 5, outputTokens: 5 }, { segments: [] }, [{ role: 'assistant', content: `text-${turn}` }]);
  }
  return { execRuns, burned: false };
}

/** LIVE operation: A (turn 0, 1 tool, burn) → B (turn 1, complete), ONE recorder. */
async function liveOperation(store: DurableStore): Promise<void> {
  const runtime = await createScopedEffectRuntime({ store, runId: RUN, stepId: STEP, scopeTokens: [] });
  const recorder = mkRecorder(store, runtime, 0);
  const a = await adapterRun(recorder, [{ tools: 1, burn: true }]);
  assert.equal(a.burned, true);
  assert.equal(a.execRuns, 1, 'A ran its 1 tool live before burning');
  const b = await adapterRun(recorder, [{ tools: 0 }]);
  assert.equal(b.burned, false, 'B completes turn 1');
}

/**
 * REPLAY: chain-fallback re-runs A (re-burns via sentinel) → B (turn 1).
 * `aWouldRecover` models the transient error clearing: A's script no longer
 * burns, yet the sentinel must STILL force the re-burn. Returns live exec count.
 */
async function replayOperation(store: DurableStore, seed: number, aWouldRecover: boolean): Promise<number> {
  const runtime = await createScopedEffectRuntime({ store, runId: RUN, stepId: STEP, scopeTokens: [] });
  const recorder = mkRecorder(store, runtime, seed);
  let exec = 0;
  const a = await adapterRun(recorder, [{ tools: 1, burn: !aWouldRecover }]);
  exec += a.execRuns;
  assert.equal(a.burned, true, 'A must re-burn on replay (sentinel forces it even if the transient error cleared)');
  const b = await adapterRun(recorder, [{ tools: 0 }]);
  exec += b.execRuns;
  return exec;
}

describe('H3 Tier 1 — burn-then-continue-then-crash determinism', () => {
  it('LIVE records turn 0 as a burned sentinel + turn 1 complete', async () => {
    const store = await mkStore();
    await liveOperation(store);
    const completed = await readCompletedTurns(store, RUN, STEP);
    // Sentinel gives the burned turn an assistant-end, so both turns count.
    assert.deepEqual(completed, [0, 1], 'burned sentinel + completed continuation both have assistant-end');
  });

  it('REPLAY (seed 0) replays clean — no exec re-run, no determinism error', async () => {
    const store = await mkStore();
    await liveOperation(store);
    const exec = await replayOperation(store, 0, /* aWouldRecover */ false);
    assert.equal(exec, 0, 'no tool exec re-runs on replay (recorded tool_results replayed verbatim)');
  });

  it('REPLAY (seed 0) is correct even when the transient burn has CLEARED', async () => {
    const store = await mkStore();
    await liveOperation(store);
    // A "recovers" — its script would NOT burn now. The sentinel must still
    // force the re-burn so replay reproduces B's turn 1 (no live divergence).
    const exec = await replayOperation(store, 0, /* aWouldRecover */ true);
    assert.equal(exec, 0, 'sentinel short-circuits A before any live tool exec');
  });

  it('REPLAY with seed = nextTurnSeed (the OLD wiring) THROWS — proves seed 0 is load-bearing', async () => {
    const store = await mkStore();
    await liveOperation(store);
    const seed = await nextTurnSeed(store, RUN, STEP);
    assert.ok(seed > 0, 'nextTurnSeed is one past the highest recorded turn');
    await assert.rejects(
      () => replayOperation(store, seed, false),
      (err: Error) => err.name === 'DeterminismViolationError',
      'a non-zero within-run seed skips the burned turn and mismatches the replay cursor',
    );
  });
});
