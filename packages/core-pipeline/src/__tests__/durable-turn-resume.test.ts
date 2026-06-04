/**
 * H3a — turn-resume helpers + per-model cost rollup (ADR §2.4 / §2.5.1 / §2.6).
 *
 * Runs against both drivers so the bit-identical contract holds. Covers:
 *   - readCompletedTurns / nextTurnSeed scan turn:N:assistant-end effects
 *   - buildPrefillFromPartial assembles the neutral prefill from the
 *     latest partial + the turn's completed tool history
 *   - rollupStepCostByModel buckets by model + carves the reinjection
 *     bucket, with the totalCostUsd consistency invariant
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryDurableStore } from '../durable/in-memory-store.js';
import { SQLiteDurableStore } from '../durable/sqlite-store.js';
import type { DurableStore } from '../durable/store.js';
import {
  readCompletedTurns,
  nextTurnSeed,
  buildPrefillFromPartial,
  reconstructSessionHistory,
} from '../durable/turn-resume.js';
import { rollupStepCostByModel, rollupStepCostAcrossSubsteps } from '../durable/cost-rollup.js';
import { createScopedEffectRuntime } from '../durable/effect-runtime.js';

const newRun = (runId = 'run-1') => ({ runId, project: 'p', feature: 'f', featureSlug: 'f' });

interface Driver { name: string; make: () => DurableStore; cleanup?: () => void; }
const drivers: Driver[] = [{ name: 'in-memory', make: () => new InMemoryDurableStore() }];

let sqliteDir: string | null = null;
try {
  sqliteDir = mkdtempSync(join(tmpdir(), 'anvil-turn-resume-sqlite-'));
  let n = 0;
  drivers.push({
    name: 'sqlite',
    make: () => new SQLiteDurableStore({ path: join(sqliteDir!, `db-${n++}.sqlite`) }),
    cleanup: () => { if (sqliteDir) rmSync(sqliteDir, { recursive: true, force: true }); },
  });
} catch { /* better-sqlite3 unavailable */ }

after(() => { for (const d of drivers) d.cleanup?.(); });

/** Append a (started, completed) effect pair so readEffectEvents pairs it. */
let idx = 0;
async function completedEffect(
  store: DurableStore, runId: string, stepId: string, effectKey: string, payload: unknown,
): Promise<void> {
  const effectIdx = idx++;
  await store.appendEvent({ runId, kind: 'effect:started', stepId, effectKey, effectIdx, payload: {} });
  await store.appendEvent({ runId, kind: 'effect:completed', stepId, effectKey, effectIdx, payload });
}

for (const driver of drivers) {
  describe(`turn-resume — ${driver.name}`, () => {
    const mk = async (): Promise<DurableStore> => {
      const store = driver.make();
      await store.createRun(newRun());
      return store;
    };

    it('readCompletedTurns / nextTurnSeed scan assistant-end effects (gaps preserved)', async () => {
      const store = await mk();
      assert.deepEqual(await readCompletedTurns(store, 'run-1', 'build'), [], 'fresh step → none');
      assert.equal(await nextTurnSeed(store, 'run-1', 'build'), 0, 'fresh → seed 0');

      await completedEffect(store, 'run-1', 'build', 'turn:0:assistant-end', { text: 'a', model: 'm' });
      await completedEffect(store, 'run-1', 'build', 'turn:2:assistant-end', { text: 'c', model: 'm' });
      // a different step must not bleed in
      await completedEffect(store, 'run-1', 'specs', 'turn:5:assistant-end', { text: 'x', model: 'm' });

      assert.deepEqual(await readCompletedTurns(store, 'run-1', 'build'), [0, 2], 'gap at 1 preserved');
      assert.equal(await nextTurnSeed(store, 'run-1', 'build'), 3, 'one past the highest completed turn');
    });

    it('buildPrefillFromPartial assembles text + completed tool history', async () => {
      const store = await mk();
      // turn 0 ran one tool then burned mid-stream → partial recorded.
      await completedEffect(store, 'run-1', 'build', 'turn:0:tool_use:0', {
        name: 'bash', arguments: { cmd: 'ls' }, idempotencyKey: 'k0',
      });
      await completedEffect(store, 'run-1', 'build', 'turn:0:tool_result:0', {
        toolUseId: 'tc0', toolName: 'bash', ok: true, content: 'files',
      });
      await store.appendAssistantPartial({
        runId: 'run-1', stepId: 'build', turnUuid: 'turn-A',
        payload: { runId: 'run-1', stepId: 'build', turnUuid: 'turn-A', turn: 0, text: 'partial answer', toolUsesEmitted: 1, reason: 'upstream', recordedAt: '2026-06-02T00:00:00Z' },
      });

      const prefill = await buildPrefillFromPartial({
        store, runId: 'run-1', stepId: 'build',
        burnedModel: 'kimi/k2', sourceProvider: 'openrouter',
      });

      assert.ok(prefill, 'a servable prefill is built');
      assert.equal(prefill!.text, 'partial answer');
      assert.equal(prefill!.turnUuid, 'turn-A');
      assert.equal(prefill!.sourceProvider, 'openrouter');
      assert.equal(prefill!.sourceModel, 'kimi/k2');
      assert.equal(prefill!.toolUses.length, 1);
      assert.deepEqual(prefill!.toolUses[0], {
        id: 'tc0', name: 'bash', input: { cmd: 'ls' },
        result: { toolUseId: 'tc0', toolName: 'bash', ok: true, content: 'files' },
        producedBy: 'openrouter',
      });
    });

    it('reconstructSessionHistory rebuilds prior phases with prompts + tools, phase-boundary deduped', async () => {
      const store = await mk();
      const step = 'clarify:session';
      // Phase 0 (explore) = a 2-turn tool loop, both stamped userPrompt 'explore'.
      await completedEffect(store, 'run-1', step, 'turn:0:assistant-start', { model: 'gpt-4o', provider: 'openai', userPrompt: 'explore' });
      await completedEffect(store, 'run-1', step, 'turn:0:tool_use:0', { name: 'grep', arguments: { q: 'x' }, idempotencyKey: 'k' });
      await completedEffect(store, 'run-1', step, 'turn:0:tool_result:0', { toolUseId: 'tc0', toolName: 'grep', ok: true, content: 'hit' });
      await completedEffect(store, 'run-1', step, 'turn:0:assistant-end', { text: 'looking', stopReason: 'tool_use', model: 'gpt-4o', provider: 'openai' });
      await completedEffect(store, 'run-1', step, 'turn:1:assistant-start', { model: 'gpt-4o', provider: 'openai', userPrompt: 'explore' });
      await completedEffect(store, 'run-1', step, 'turn:1:assistant-end', { text: 'explore done', stopReason: 'end_turn', model: 'gpt-4o', provider: 'openai' });
      // Phase 1 (synthesize) = one turn, userPrompt 'synthesize'.
      await completedEffect(store, 'run-1', step, 'turn:2:assistant-start', { model: 'gpt-4o', provider: 'openai', userPrompt: 'synthesize' });
      await completedEffect(store, 'run-1', step, 'turn:2:assistant-end', { text: 'synth done', stopReason: 'end_turn', model: 'gpt-4o', provider: 'openai' });

      const turns = await reconstructSessionHistory(store, 'run-1', step);
      assert.equal(turns.length, 3);
      // The phase-opening prompt is emitted ONCE per phase (turn 0 + turn 2).
      assert.equal(turns[0].userPrompt, 'explore');
      assert.equal(turns[1].userPrompt, undefined, 'tool-loop continuation turn carries no duplicate user message');
      assert.equal(turns[2].userPrompt, 'synthesize');
      assert.equal(turns[0].toolUses.length, 1);
      assert.equal(turns[0].toolUses[0].id, 'tc0');
      assert.deepEqual(turns.map((t) => t.text), ['looking', 'explore done', 'synth done']);
    });

    it('reconstructSessionHistory SKIPS burned sentinels + honors upToTurn', async () => {
      const store = await mk();
      const step = 'clarify:session';
      await completedEffect(store, 'run-1', step, 'turn:0:assistant-start', { model: 'kimi/k2', provider: 'openrouter', userPrompt: 'q' });
      await completedEffect(store, 'run-1', step, 'turn:0:assistant-end', { text: '', stopReason: 'burned', model: 'kimi/k2', provider: 'openrouter' });
      await completedEffect(store, 'run-1', step, 'turn:1:assistant-start', { model: 'gpt-4o', provider: 'openai', userPrompt: 'q' });
      await completedEffect(store, 'run-1', step, 'turn:1:assistant-end', { text: 'recovered', stopReason: 'end_turn', model: 'gpt-4o', provider: 'openai' });
      await completedEffect(store, 'run-1', step, 'turn:2:assistant-start', { model: 'gpt-4o', provider: 'openai', userPrompt: 'next' });
      await completedEffect(store, 'run-1', step, 'turn:2:assistant-end', { text: 'two', stopReason: 'end_turn', model: 'gpt-4o', provider: 'openai' });

      const all = await reconstructSessionHistory(store, 'run-1', step);
      assert.deepEqual(all.map((t) => t.text), ['recovered', 'two'], 'burned sentinel turn 0 is skipped');
      // The successor (turn 1) becomes the phase-opening turn → carries the prompt.
      assert.equal(all[0].userPrompt, 'q');

      const upTo2 = await reconstructSessionHistory(store, 'run-1', step, '', 2);
      assert.deepEqual(upTo2.map((t) => t.text), ['recovered'], 'upToTurn excludes turn >= 2');
    });

    it('reconstructSessionHistory emits the user message for a NEW phase even when it reuses the prior prompt (phase boundary via stopReason)', async () => {
      const store = await mk();
      const step = 'clarify:session';
      // Phase 0 = a tool-loop: turn 0 (tool_use) → turn 1 (end_turn). Both 'same'.
      await completedEffect(store, 'run-1', step, 'turn:0:assistant-start', { model: 'gpt-4o', provider: 'openai', userPrompt: 'same' });
      await completedEffect(store, 'run-1', step, 'turn:0:assistant-end', { text: 't0', stopReason: 'tool_use', model: 'gpt-4o', provider: 'openai' });
      await completedEffect(store, 'run-1', step, 'turn:1:assistant-start', { model: 'gpt-4o', provider: 'openai', userPrompt: 'same' });
      await completedEffect(store, 'run-1', step, 'turn:1:assistant-end', { text: 't1', stopReason: 'end_turn', model: 'gpt-4o', provider: 'openai' });
      // Phase 1 = one turn, SAME prompt 'same' (the landmine case).
      await completedEffect(store, 'run-1', step, 'turn:2:assistant-start', { model: 'gpt-4o', provider: 'openai', userPrompt: 'same' });
      await completedEffect(store, 'run-1', step, 'turn:2:assistant-end', { text: 't2', stopReason: 'end_turn', model: 'gpt-4o', provider: 'openai' });

      const turns = await reconstructSessionHistory(store, 'run-1', step);
      assert.equal(turns[0].userPrompt, 'same', 'first turn opens phase 0');
      assert.equal(turns[1].userPrompt, undefined, 'tool-loop continuation (prev was tool_use) — no duplicate');
      assert.equal(turns[2].userPrompt, 'same', 'phase 1 re-emits its prompt despite matching phase 0 (no consecutive-assistant)');
    });

    it('reconstructSessionHistory elides an oversized tool-result so priorMessages cannot overflow context', async () => {
      const store = await mk();
      const step = 'clarify:session';
      const huge = 'x'.repeat(50_000); // a ~256KB-style file read
      await completedEffect(store, 'run-1', step, 'turn:0:assistant-start', { model: 'gpt-4o', provider: 'openai', userPrompt: 'explore' });
      await completedEffect(store, 'run-1', step, 'turn:0:tool_use:0', { name: 'read_file', arguments: { path: 'big.ts' }, idempotencyKey: 'k' });
      await completedEffect(store, 'run-1', step, 'turn:0:tool_result:0', { toolUseId: 'tc0', toolName: 'read_file', ok: true, content: huge });
      await completedEffect(store, 'run-1', step, 'turn:0:assistant-end', { text: 'read it', stopReason: 'end_turn', model: 'gpt-4o', provider: 'openai' });

      const turns = await reconstructSessionHistory(store, 'run-1', step);
      const content = turns[0].toolUses[0].result.content as string;
      assert.ok(content.length < huge.length, 'oversized result is elided');
      assert.ok(content.length <= 4096 + 80, 'elided to the cap + a short marker');
      assert.match(content, /truncated 45904 chars/, 'marker reports the omitted byte count');
    });

    it('reconstructSessionHistory degrades gracefully when userPrompt was never recorded (pre-Tier-2 log)', async () => {
      const store = await mk();
      const step = 'clarify:session';
      // No userPrompt field on the start payload (old log shape).
      await completedEffect(store, 'run-1', step, 'turn:0:assistant-start', { model: 'gpt-4o', provider: 'openai' });
      await completedEffect(store, 'run-1', step, 'turn:0:assistant-end', { text: 'legacy', stopReason: 'end_turn', model: 'gpt-4o', provider: 'openai' });

      const turns = await reconstructSessionHistory(store, 'run-1', step);
      assert.equal(turns.length, 1);
      assert.equal(turns[0].userPrompt, undefined, 'no prompt recorded → no user message, no throw');
      assert.equal(turns[0].text, 'legacy');
    });

    it('buildPrefillFromPartial returns undefined when no partial exists', async () => {
      const store = await mk();
      const prefill = await buildPrefillFromPartial({
        store, runId: 'run-1', stepId: 'build', burnedModel: 'm', sourceProvider: 'openrouter',
      });
      assert.equal(prefill, undefined);
    });

    it('buildPrefillFromPartial skips an invalidated partial (cancel tombstone)', async () => {
      const store = await mk();
      await store.appendAssistantPartial({
        runId: 'run-1', stepId: 'build', turnUuid: 'turn-A',
        payload: { runId: 'run-1', stepId: 'build', turnUuid: 'turn-A', turn: 0, text: 'stale', toolUsesEmitted: 0, reason: 'abort', recordedAt: '2026-06-02T00:00:00Z' },
      });
      await store.invalidatePartials('run-1');
      const prefill = await buildPrefillFromPartial({
        store, runId: 'run-1', stepId: 'build', burnedModel: 'm', sourceProvider: 'openrouter',
      });
      assert.equal(prefill, undefined, 'tombstoned partial is not resurrected');
    });

    it('rollupStepCostByModel buckets by model + carves the reinjection bucket', async () => {
      const store = await mk();
      // Two turns, two models; turn 1 (model B) re-injected 50 prefill tokens.
      await completedEffect(store, 'run-1', 'build', 'turn:0:assistant-start', { model: 'gpt-4o-mini', provider: 'openai' });
      await completedEffect(store, 'run-1', 'build', 'turn:0:assistant-end', {
        usage: { inputTokens: 100, outputTokens: 50, prefilledInputTokens: 0 }, model: 'gpt-4o-mini', provider: 'openai',
      });
      await completedEffect(store, 'run-1', 'build', 'turn:1:assistant-start', { model: 'gpt-4o', provider: 'openai' });
      await completedEffect(store, 'run-1', 'build', 'turn:1:assistant-end', {
        usage: { inputTokens: 150, outputTokens: 75, prefilledInputTokens: 50 }, model: 'gpt-4o', provider: 'openai',
      });

      const r = await rollupStepCostByModel(store, 'run-1', 'build');

      assert.ok(r.costByModel['gpt-4o-mini'], 'model A bucket present');
      assert.ok(r.costByModel['gpt-4o'], 'model B bucket present');
      assert.equal(r.costByModel['gpt-4o-mini'].inputTokens, 100);
      assert.equal(r.costByModel['gpt-4o'].inputTokens, 150);
      assert.equal(r.costByModel['gpt-4o'].prefilledInputTokens, 50, 'reinjected tokens recorded on the model');
      // Internal consistency holds regardless of the exact price table:
      const sumModels = Object.values(r.costByModel).reduce((a, m) => a + m.costUsd, 0);
      assert.ok(Math.abs(r.totalCostUsd - (sumModels + r.prefillReinjectionUsd)) < 1e-9,
        'totalCostUsd == Σ per-model new-spend + reinjection bucket');
      assert.ok(r.prefillReinjectionUsd >= 0);
    });

    it('prices a burned-sentinel turn ONCE when a partial exists (no double-count)', async () => {
      const store = await mk();
      // Burned turn 0 (model A): assistant-start + a 'burned' sentinel end +
      // a partial. The completed-turns loop must SKIP the sentinel; the
      // partial loop prices it. Net: exactly one charge for the burn.
      await completedEffect(store, 'run-1', 'build', 'turn:0:assistant-start', { model: 'kimi/k2', provider: 'openrouter' });
      await completedEffect(store, 'run-1', 'build', 'turn:0:assistant-end', {
        text: 'partial', stopReason: 'burned', usage: { inputTokens: 0, outputTokens: 0 }, model: 'kimi/k2', provider: 'openrouter',
      });
      await store.appendAssistantPartial({
        runId: 'run-1', stepId: 'build', turnUuid: 'tu0',
        payload: { runId: 'run-1', stepId: 'build', turnUuid: 'tu0', turn: 0, text: '0123456789', toolUsesEmitted: 0, reason: 'upstream', recordedAt: '2026-06-02T00:00:00Z' },
      });

      const r = await rollupStepCostByModel(store, 'run-1', 'build');
      // ceil(10/4)=3 output tokens, priced once (partial), NOT twice (sentinel skipped).
      assert.ok(r.costByModel['kimi/k2'], 'burned model bucket present');
      assert.equal(r.costByModel['kimi/k2'].outputTokens, 3, 'burn priced exactly once (partial), sentinel skipped');
    });

    it('falls back to the burned SENTINEL text when the partial was lost (no silent under-count)', async () => {
      const store = await mk();
      // Burned turn 0 with a sentinel carrying text, but NO partial (the
      // fire-and-forget write was lost). The fallback pass must price it.
      await completedEffect(store, 'run-1', 'build', 'turn:0:assistant-start', { model: 'kimi/k2', provider: 'openrouter' });
      await completedEffect(store, 'run-1', 'build', 'turn:0:assistant-end', {
        text: '01234567', stopReason: 'burned', usage: { inputTokens: 0, outputTokens: 0 }, model: 'kimi/k2', provider: 'openrouter',
      });

      const r = await rollupStepCostByModel(store, 'run-1', 'build');
      // ceil(8/4)=2 output tokens priced from the sentinel.
      assert.ok(r.costByModel['kimi/k2'], 'burned model bucket present via sentinel fallback');
      assert.equal(r.costByModel['kimi/k2'].outputTokens, 2, 'burn priced from the sentinel when no partial survived');
    });

    it('continuation: fires on the COMMON empty-text burn (sentinel A, completion B, zero re-injected tokens)', async () => {
      const store = await mk();
      // The 429-before-first-delta case: model A burns having streamed
      // nothing → empty-text sentinel + empty partial; successor B completes
      // the re-issued turn with prefilledInputTokens=0. The marker MUST still
      // fire — this is the regression the UI review caught (finding 1).
      await completedEffect(store, 'run-1', 'build', 'turn:0:assistant-start', { model: 'kimi/k2', provider: 'openrouter' });
      await completedEffect(store, 'run-1', 'build', 'turn:0:assistant-end', {
        text: '', stopReason: 'burned', usage: { inputTokens: 0, outputTokens: 0 }, model: 'kimi/k2', provider: 'openrouter',
      });
      await completedEffect(store, 'run-1', 'build', 'turn:1:assistant-start', { model: 'opencode/kimi-k2.6', provider: 'opencode' });
      await completedEffect(store, 'run-1', 'build', 'turn:1:assistant-end', {
        text: 'done', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50, prefilledInputTokens: 0 }, model: 'opencode/kimi-k2.6', provider: 'opencode',
      });

      const r = await rollupStepCostByModel(store, 'run-1', 'build');
      assert.ok(r.continuation, 'continuation present despite zero re-injected tokens');
      assert.deepEqual(r.continuation!.predecessors, ['kimi/k2']);
      assert.deepEqual(r.continuation!.successors, ['opencode/kimi-k2.6'],
        'unpriced successor (finding 2) still surfaces — derivation is token/price-independent');
      assert.equal(r.prefillReinjectionUsd, 0, 'no re-injection cost, yet the handoff is real');
    });

    it('continuation: NULL on a same-model retry (A burns then A completes — not a cross-model handoff)', async () => {
      const store = await mk();
      await completedEffect(store, 'run-1', 'build', 'turn:0:assistant-start', { model: 'kimi/k2', provider: 'openrouter' });
      await completedEffect(store, 'run-1', 'build', 'turn:0:assistant-end', {
        text: '', stopReason: 'burned', usage: { inputTokens: 0, outputTokens: 0 }, model: 'kimi/k2', provider: 'openrouter',
      });
      await completedEffect(store, 'run-1', 'build', 'turn:1:assistant-start', { model: 'kimi/k2', provider: 'openrouter' });
      await completedEffect(store, 'run-1', 'build', 'turn:1:assistant-end', {
        text: 'recovered', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 }, model: 'kimi/k2', provider: 'openrouter',
      });

      const r = await rollupStepCostByModel(store, 'run-1', 'build');
      assert.equal(r.continuation, null, 'same model on both sides — no handoff marker');
    });

    it('continuation: merges across the ${stage}:session substep', async () => {
      const store = await mk();
      // Burn+continue happened inside a clarify/QA session (recorded under
      // the `:session` substep). The across-substeps rollup must surface it.
      await completedEffect(store, 'run-1', 'clarify:session', 'turn:0:assistant-start', { model: 'gpt-4o', provider: 'openai' });
      await completedEffect(store, 'run-1', 'clarify:session', 'turn:0:assistant-end', {
        text: '', stopReason: 'burned', usage: { inputTokens: 0, outputTokens: 0 }, model: 'gpt-4o', provider: 'openai',
      });
      await completedEffect(store, 'run-1', 'clarify:session', 'turn:1:assistant-start', { model: 'sonnet', provider: 'anthropic' });
      await completedEffect(store, 'run-1', 'clarify:session', 'turn:1:assistant-end', {
        text: 'ok', stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 25 }, model: 'sonnet', provider: 'anthropic',
      });

      const merged = await rollupStepCostAcrossSubsteps(store, 'run-1', 'clarify');
      assert.ok(merged.continuation, 'session-substep continuation surfaces through the merge');
      assert.deepEqual(merged.continuation!.predecessors, ['gpt-4o']);
      assert.deepEqual(merged.continuation!.successors, ['sonnet']);
    });

    it('rollupStepCostAcrossSubsteps merges the ${stage}:session substep (sessions)', async () => {
      const store = await mk();
      // A session stage records its turn under `clarify:session` (NOT `clarify`).
      await completedEffect(store, 'run-1', 'clarify:session', 'turn:0:assistant-start', { model: 'gpt-4o', provider: 'openai' });
      await completedEffect(store, 'run-1', 'clarify:session', 'turn:0:assistant-end', {
        usage: { inputTokens: 80, outputTokens: 40 }, model: 'gpt-4o', provider: 'openai',
      });
      // The bare `clarify` step has no turn effects.
      const bare = await rollupStepCostByModel(store, 'run-1', 'clarify');
      assert.deepEqual(bare.costByModel, {}, 'bare step id sees nothing — session turns live under the substep');

      const merged = await rollupStepCostAcrossSubsteps(store, 'run-1', 'clarify');
      assert.ok(merged.costByModel['gpt-4o'], 'across-substeps rollup surfaces the session turn');
      assert.equal(merged.costByModel['gpt-4o'].inputTokens, 80);
      const sum = Object.values(merged.costByModel).reduce((a, m) => a + m.costUsd, 0);
      assert.ok(Math.abs(merged.totalCostUsd - (sum + merged.prefillReinjectionUsd)) < 1e-9, 'merge keeps the totalCostUsd invariant');
    });

    it('rollupStepCostByModel is empty for a step with no turn effects (legacy path)', async () => {
      const store = await mk();
      await completedEffect(store, 'run-1', 'build', 'build:spawn-agent', { artifact: 'x' });
      const r = await rollupStepCostByModel(store, 'run-1', 'build');
      assert.deepEqual(r.costByModel, {});
      assert.equal(r.totalCostUsd, 0);
    });

    it('createScopedEffectRuntime isolates parallel repos by scope token (§2.4)', async () => {
      const store = await mk();
      // Two repos recorded their own turn under the SAME step id. Each
      // repo's scoped runtime assigns idx independently, so BOTH first
      // effects carry effectIdx=0 (different keys) — exactly what a real
      // per-repo runtime would record. Seed that shape explicitly.
      const seed = async (key: string, payload: unknown) => {
        await store.appendEvent({ runId: 'run-1', kind: 'effect:started', stepId: 'build', effectKey: key, effectIdx: 0, payload: {} });
        await store.appendEvent({ runId: 'run-1', kind: 'effect:completed', stepId: 'build', effectKey: key, effectIdx: 0, payload });
      };
      await seed('repoA:turn:0:assistant-end', { text: 'A', model: 'm' });
      await seed('repoB:turn:0:assistant-end', { text: 'B', model: 'm' });

      const rtA = await createScopedEffectRuntime({ store, runId: 'run-1', stepId: 'build', scopeTokens: ['repoA'] });
      const rtB = await createScopedEffectRuntime({ store, runId: 'run-1', stepId: 'build', scopeTokens: ['repoB'] });

      // Each scoped runtime peeks ONLY its own repo's effect.
      assert.deepEqual(rtA.peekRecorded('repoA:turn:0:assistant-end'), { text: 'A', model: 'm' });
      assert.equal(rtA.peekRecorded('repoB:turn:0:assistant-end'), undefined, 'repoA runtime cannot see repoB');
      assert.deepEqual(rtB.peekRecorded('repoB:turn:0:assistant-end'), { text: 'B', model: 'm' });

      // And each replays its own effect at idx 0 (independent idx sequence).
      const a = await rtA.effect('repoA:turn:0:assistant-end', async () => ({ text: 'LIVE', model: 'm' }));
      assert.deepEqual(a, { text: 'A', model: 'm' }, 'replayed from log, not re-run');
    });

    it('scoped runtime uses STRICT prefix — no substring collision for prefix-related repos (review #2)', async () => {
      const store = await mk();
      const seed = async (key: string, payload: unknown) => {
        await store.appendEvent({ runId: 'run-1', kind: 'effect:started', stepId: 'build', effectKey: key, effectIdx: 0, payload: {} });
        await store.appendEvent({ runId: 'run-1', kind: 'effect:completed', stepId: 'build', effectKey: key, effectIdx: 0, payload });
      };
      // 'api' and 'api-gateway' — the boundary-substring matcher would
      // wrongly admit 'api-gateway:...' into the 'api' scope.
      await seed('api:turn:0:assistant-end', { text: 'api', model: 'm' });
      await seed('api-gateway:turn:0:assistant-end', { text: 'gw', model: 'm' });

      const rtApi = await createScopedEffectRuntime({ store, runId: 'run-1', stepId: 'build', scopeTokens: ['api'] });
      assert.deepEqual(rtApi.peekRecorded('api:turn:0:assistant-end'), { text: 'api', model: 'm' });
      assert.equal(rtApi.peekRecorded('api-gateway:turn:0:assistant-end'), undefined,
        "'api' scope must NOT admit 'api-gateway:' (strict prefix, not boundary-substring)");
      // 'api' runtime replays its OWN effect at idx 0 (not the gateway's).
      const v = await rtApi.effect('api:turn:0:assistant-end', async () => ({ text: 'LIVE', model: 'm' }));
      assert.deepEqual(v, { text: 'api', model: 'm' });
    });

    it('rollupStepCostByModel includes per-repo BURN partials under scoped step ids (review #6)', async () => {
      const store = await mk();
      // repoA ran a (priced) turn then burned mid-stream → partial under
      // the repo-scoped step id 'build:repoA'; assistant-start under 'build'
      // with the repo prefix.
      await completedEffect(store, 'run-1', 'build', 'repoA:turn:0:assistant-start', { model: 'gpt-4o', provider: 'openai' });
      await store.appendAssistantPartial({
        runId: 'run-1', stepId: 'build:repoA', turnUuid: 'tA',
        payload: { runId: 'run-1', stepId: 'build:repoA', turnUuid: 'tA', turn: 0, text: 'x'.repeat(400), toolUsesEmitted: 0, reason: 'upstream', recordedAt: '2026-06-02T00:00:00Z' },
      });

      const r = await rollupStepCostByModel(store, 'run-1', 'build');
      assert.ok(r.costByModel['gpt-4o'], 'per-repo burn partial attributed to its model');
      assert.ok(r.costByModel['gpt-4o'].outputTokens > 0, 'estimated partial output tokens counted');
      assert.ok(r.totalCostUsd >= 0);
    });

    it('buildPrefillFromPartial honors per-repo scope (effectPrefix + repo-scoped partial stepId)', async () => {
      const store = await mk();
      // repoA burned mid-turn 0: tool history under effect prefix `repoA:`,
      // partial under the repo-scoped step id `specs:repoA`.
      await completedEffect(store, 'run-1', 'specs', 'repoA:turn:0:tool_use:0', {
        name: 'grep', arguments: { q: 'x' }, idempotencyKey: 'k',
      });
      await completedEffect(store, 'run-1', 'specs', 'repoA:turn:0:tool_result:0', {
        toolUseId: 'tc0', toolName: 'grep', ok: true, content: 'hit',
      });
      await store.appendAssistantPartial({
        runId: 'run-1', stepId: 'specs:repoA', turnUuid: 'tA',
        payload: { runId: 'run-1', stepId: 'specs:repoA', turnUuid: 'tA', turn: 0, text: 'partial A', toolUsesEmitted: 1, reason: 'upstream', recordedAt: '2026-06-02T00:00:00Z' },
      });

      const prefill = await buildPrefillFromPartial({
        store, runId: 'run-1',
        stepId: 'specs:repoA', eventStepId: 'specs', effectPrefix: 'repoA:',
        burnedModel: 'kimi/k2', sourceProvider: 'openrouter',
      });
      assert.ok(prefill);
      assert.equal(prefill!.text, 'partial A');
      assert.equal(prefill!.toolUses.length, 1);
      assert.equal(prefill!.toolUses[0].result.content, 'hit');
    });
  });
}
