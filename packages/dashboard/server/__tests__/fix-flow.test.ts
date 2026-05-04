/**
 * fix-flow tests — fix → validate → fix-loop orchestration.
 *
 * Uses a programmable fake AgentManager so each spawned agent can
 * return a scripted artifact + cost. Validates three paths:
 *   - Happy path: fix → validate(PASS) → done.
 *   - Retry path: fix → validate(FAIL) → fix-loop attempt 1 →
 *     validate(PASS) → done.
 *   - Exhaustion: fix → validate(FAIL) → fix-loop × 3 attempts all
 *     producing FAIL → throws.
 *
 * Stage events fired via `onStage` are asserted to confirm the WS
 * broadcast contract the dashboard depends on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runFixFlow, type FixFlowStageEvent } from '../fix-flow.js';
import type { AgentManager, AgentState, SpawnConfig } from '@anvil/agent-core';

interface ScriptedSpawn {
  /** Substring matched against the spawn's `stage` so the script can route
   *  by phase: 'fix', 'validate', or `fix-${attempt}`. */
  stageMatch: string | RegExp;
  /** Output the agent emits when it completes. */
  output: string;
  /** Total cost USD reported on completion. */
  cost?: number;
  /** When set, the agent transitions to error instead of done. */
  fail?: boolean;
}

function fakeAgentManager(script: ScriptedSpawn[]): AgentManager {
  const queue: ScriptedSpawn[] = [...script];
  const live: Map<string, { spec: SpawnConfig; planned: ScriptedSpawn }> = new Map();
  let nextId = 1;
  return {
    spawn: (spec: SpawnConfig): AgentState => {
      const idx = queue.findIndex((s) =>
        typeof s.stageMatch === 'string'
          ? spec.stage.includes(s.stageMatch)
          : s.stageMatch.test(spec.stage),
      );
      if (idx === -1) {
        throw new Error(`fakeAgentManager: no scripted entry for stage "${spec.stage}"`);
      }
      const planned = queue.splice(idx, 1)[0];
      const id = `agent-${nextId++}`;
      live.set(id, { spec, planned });
      return {
        id,
        name: spec.name,
        persona: spec.persona,
        sessionId: 's',
        model: spec.model,
        status: 'pending',
        cost: {
          inputTokens: 0,
          outputTokens: 0,
          totalUsd: 0,
          stopReason: 'end_turn',
        } as AgentState['cost'],
        output: '',
        activities: [],
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
      };
    },
    getAgent: (id: string): AgentState | undefined => {
      const entry = live.get(id);
      if (!entry) return undefined;
      // Resolve immediately on first poll — keep tests fast.
      return {
        id,
        name: entry.spec.name,
        persona: entry.spec.persona,
        sessionId: 's',
        model: entry.spec.model,
        status: entry.planned.fail ? 'error' : 'done',
        cost: {
          inputTokens: 0,
          outputTokens: 100,
          totalUsd: entry.planned.cost ?? 0.001,
          stopReason: 'end_turn',
        } as AgentState['cost'],
        output: entry.planned.output,
        activities: [],
        startedAt: 0,
        finishedAt: Date.now(),
        error: entry.planned.fail ? entry.planned.output : null,
      };
    },
    sendInput: () => undefined,
  } as unknown as AgentManager;
}

const NO_SLEEP = async () => undefined;

const VALIDATE_PASS = '## demo\n- Build: PASS\n- Lint: PASS\n- Tests: PASS\n\nVERDICT: PASS';
const VALIDATE_FAIL = '## demo\n- Build: PASS\n- Lint: PASS\n- Tests: FAIL: 2 failing\n\nVERDICT: FAIL';

const baseOpts = (manager: AgentManager, onStage: (e: FixFlowStageEvent) => void) => ({
  agentManager: manager,
  project: 'demo',
  description: 'fix the bug',
  model: 'claude',
  workspaceDir: '/tmp/demo',
  repoNames: [],
  repoPaths: {},
  buildProjectPrompt: () => 'system prompt',
  buildRepoProjectPrompt: () => 'repo prompt',
  isCancelled: () => false,
  allowedToolsForStage: () => ['read', 'write', 'exec'],
  onStage,
  pollIntervalMs: 1,
  sleep: NO_SLEEP,
});

describe('runFixFlow', () => {
  it('happy path: fix → validate passes → done', async () => {
    const manager = fakeAgentManager([
      { stageMatch: 'fix', output: 'fix-output', cost: 0.01 },
      { stageMatch: 'validate', output: VALIDATE_PASS, cost: 0.005 },
    ]);
    const events: FixFlowStageEvent[] = [];
    const result = await runFixFlow(baseOpts(manager, (e) => events.push(e)));

    assert.equal(result.resolved, true);
    assert.equal(result.attempts, 0);
    assert.ok(result.totalCost > 0);
    assert.equal(result.validate.failed, false);

    const stageNames = events.map((e) => `${e.name}:${e.status}`);
    assert.deepEqual(stageNames, [
      'fix:running', 'fix:completed',
      'validate:running', 'validate:completed',
    ]);
  });

  it('retry path: validate fails once, fix-loop attempt 1 fixes it', async () => {
    const manager = fakeAgentManager([
      { stageMatch: 'fix', output: 'first fix', cost: 0.01 },
      { stageMatch: 'validate', output: VALIDATE_FAIL, cost: 0.005 },
      { stageMatch: /^fix-1/, output: 'corrected', cost: 0.02 },
      { stageMatch: 'validate', output: VALIDATE_PASS, cost: 0.005 },
    ]);
    const events: FixFlowStageEvent[] = [];
    const result = await runFixFlow(baseOpts(manager, (e) => events.push(e)));

    assert.equal(result.resolved, true);
    assert.equal(result.attempts, 1);
    assert.equal(result.validate.failed, false);

    const fixLoopRunning = events.find((e) => e.name === 'fix-loop' && e.status === 'running');
    const fixLoopCompleted = events.find((e) => e.name === 'fix-loop' && e.status === 'completed');
    assert.ok(fixLoopRunning, 'fix-loop:running event fired');
    assert.equal(fixLoopRunning?.attempt, 1);
    assert.ok(fixLoopCompleted, 'fix-loop:completed event fired');
  });

  it('exhaustion: fix-loop fails after maxAttempts and throws', async () => {
    const manager = fakeAgentManager([
      { stageMatch: 'fix', output: 'first fix', cost: 0.01 },
      // Validate fails; fix-loop runs twice; both re-validates fail.
      { stageMatch: 'validate', output: VALIDATE_FAIL, cost: 0.005 },
      { stageMatch: /^fix-1/, output: 'attempt 1', cost: 0.02 },
      { stageMatch: 'validate', output: VALIDATE_FAIL, cost: 0.005 },
      { stageMatch: /^fix-2/, output: 'attempt 2', cost: 0.02 },
      { stageMatch: 'validate', output: VALIDATE_FAIL, cost: 0.005 },
    ]);
    const events: FixFlowStageEvent[] = [];
    await assert.rejects(
      runFixFlow({ ...baseOpts(manager, (e) => events.push(e)), maxAttempts: 2 }),
      /fix-loop exhausted after 2 attempts/,
    );

    const failedEvents = events.filter((e) => e.name === 'fix-loop' && e.status === 'failed');
    assert.equal(failedEvents.length, 2);
    assert.equal(failedEvents[0].attempt, 1);
    assert.equal(failedEvents[1].attempt, 2);
  });

  it('fix stage failure surfaces as fix:failed and rethrows', async () => {
    const manager = fakeAgentManager([
      { stageMatch: 'fix', output: 'spawn died', fail: true },
    ]);
    const events: FixFlowStageEvent[] = [];
    await assert.rejects(
      runFixFlow(baseOpts(manager, (e) => events.push(e))),
      /spawn died|Agent failed/,
    );

    const failed = events.find((e) => e.name === 'fix' && e.status === 'failed');
    assert.ok(failed, 'fix:failed event fired');
    // No validate or fix-loop should have fired.
    assert.equal(events.some((e) => e.name === 'validate'), false);
    assert.equal(events.some((e) => e.name === 'fix-loop'), false);
  });
});
