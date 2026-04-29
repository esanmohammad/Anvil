/**
 * Phase 4f.1 tests — `spawnAndWait` + `waitForAgent` are drop-in
 * replacements for `pipeline-runner.ts:waitForAgent()`.
 *
 * Tests use a fake AgentManager so we exercise the polling + cancellation
 * + truncation paths without spinning up a real subprocess.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  spawnAndWait,
  waitForAgent,
} from '../steps/agent-spawner.js';
import type { AgentManager, AgentState, SpawnConfig } from '../agent-manager.js';

interface FakeOpts {
  /** Status sequence the next getAgent() calls return. */
  statuses?: AgentState['status'][];
  /** Final cost / output to surface when status hits 'done'. */
  result?: Partial<AgentState>;
  /** When set, getAgent returns undefined ("disappeared") after this many calls. */
  disappearAfter?: number;
}

function fakeAgentManager(opts: FakeOpts = {}): {
  manager: AgentManager;
  spawned: SpawnConfig[];
  /** Force the next getAgent call to return a specific status. */
  setStatus: (s: AgentState['status']) => void;
  /** Replace the cost block — useful for max_tokens truncation tests. */
  setCost: (cost: Partial<AgentState['cost']>) => void;
} {
  const spawned: SpawnConfig[] = [];
  let i = 0;
  let currentStatus: AgentState['status'] = opts.statuses?.[0] ?? 'running';
  let cost: AgentState['cost'] = {
    inputTokens: 0,
    outputTokens: 100,
    totalUsd: 0.001,
    stopReason: 'end_turn',
  } as AgentState['cost'];

  const manager = {
    spawn: (config: SpawnConfig): AgentState => {
      spawned.push(config);
      return {
        id: 'agent-1', name: config.name, persona: config.persona,
        sessionId: 's1', model: config.model,
        status: 'pending', cost, output: '', activities: [],
        startedAt: Date.now(), finishedAt: null, error: null,
      };
    },
    getAgent: (id: string): AgentState | undefined => {
      if (opts.disappearAfter !== undefined && i >= opts.disappearAfter) return undefined;
      const status = opts.statuses ? (opts.statuses[i] ?? currentStatus) : currentStatus;
      i += 1;
      const finalOutput = status === 'done' ? (opts.result?.output ?? 'final-art') : '';
      return {
        id,
        name: 'agent', persona: 'planner', sessionId: 's', model: 'claude',
        status,
        cost: status === 'done' ? { ...cost, ...(opts.result?.cost ?? {}) } : cost,
        output: finalOutput, activities: [],
        startedAt: 0, finishedAt: status === 'done' ? Date.now() : null, error: status === 'error' ? 'boom' : null,
      };
    },
  } as unknown as AgentManager;

  return {
    manager,
    spawned,
    setStatus: (s) => { currentStatus = s; },
    setCost: (c) => { cost = { ...cost, ...c } as AgentState['cost']; },
  };
}

const NO_SLEEP = async (_: number) => undefined;

describe('agent-spawner', () => {
  it('spawnAndWait returns artifact + cost when agent completes', async () => {
    const f = fakeAgentManager({
      statuses: ['running', 'running', 'done'],
      result: { output: 'hello world', cost: { totalUsd: 0.5, outputTokens: 50, stopReason: 'end_turn' } as AgentState['cost'] },
    });
    const onSpawn: string[] = [];
    const result = await spawnAndWait({
      agentManager: f.manager,
      spec: { name: 'a', persona: 'planner', project: 'demo', stage: 'plan', prompt: '', model: 'claude', cwd: '/tmp' },
      isCancelled: () => false,
      onSpawn: (id) => onSpawn.push(id),
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
    });
    assert.equal(result.agentId, 'agent-1');
    assert.equal(result.artifact, 'hello world');
    assert.equal(result.cost, 0.5);
    assert.deepEqual(onSpawn, ['agent-1']);
    assert.equal(f.spawned.length, 1);
  });

  it('rejects when cancellation flips mid-poll', async () => {
    const f = fakeAgentManager({ statuses: ['running', 'running', 'running'] });
    let cancelled = false;
    let pollsBeforeCancel = 0;
    await assert.rejects(
      spawnAndWait({
        agentManager: f.manager,
        spec: { name: 'a', persona: 'planner', project: 'demo', stage: 'plan', prompt: '', model: 'claude', cwd: '/tmp' },
        isCancelled: () => cancelled,
        pollIntervalMs: 1,
        sleep: async () => {
          pollsBeforeCancel += 1;
          if (pollsBeforeCancel === 2) cancelled = true;
        },
      }),
      /Pipeline cancelled/,
    );
  });

  it('rejects when the agent transitions to error', async () => {
    const f = fakeAgentManager({ statuses: ['running', 'error'] });
    await assert.rejects(
      spawnAndWait({
        agentManager: f.manager,
        spec: { name: 'a', persona: 'planner', project: 'demo', stage: 'plan', prompt: '', model: 'claude', cwd: '/tmp' },
        isCancelled: () => false,
        pollIntervalMs: 1,
        sleep: NO_SLEEP,
      }),
      /Agent failed|boom/,
    );
  });

  it('rejects when the agent disappears between polls', async () => {
    const f = fakeAgentManager({ statuses: ['running', 'running'], disappearAfter: 1 });
    await assert.rejects(
      spawnAndWait({
        agentManager: f.manager,
        spec: { name: 'a', persona: 'planner', project: 'demo', stage: 'plan', prompt: '', model: 'claude', cwd: '/tmp' },
        isCancelled: () => false,
        pollIntervalMs: 1,
        sleep: NO_SLEEP,
      }),
      /Agent disappeared/,
    );
  });

  it('fires onTruncation when stop_reason is max_tokens', async () => {
    const f = fakeAgentManager({
      statuses: ['running', 'done'],
      result: {
        output: 'cut off',
        cost: { totalUsd: 0.2, outputTokens: 1024, stopReason: 'max_tokens' } as AgentState['cost'],
      },
    });
    const truncations: Array<{ name: string; tokens: number }> = [];
    await spawnAndWait({
      agentManager: f.manager,
      spec: { name: 'planner-demo', persona: 'planner', project: 'demo', stage: 'plan', prompt: '', model: 'claude', cwd: '/tmp' },
      isCancelled: () => false,
      onTruncation: (name, tokens) => truncations.push({ name, tokens }),
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
    });
    assert.equal(truncations.length, 1);
    assert.equal(truncations[0].tokens, 1024);
  });

  it('waitForAgent works on an already-spawned agent', async () => {
    const f = fakeAgentManager({
      statuses: ['done'],
      result: { output: 'pre-spawned', cost: { totalUsd: 0.1, outputTokens: 10, stopReason: 'end_turn' } as AgentState['cost'] },
    });
    const result = await waitForAgent({
      agentId: 'agent-1',
      agentManager: f.manager,
      isCancelled: () => false,
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
    });
    assert.equal(result.artifact, 'pre-spawned');
    assert.equal(result.cost, 0.1);
    // No spawn call happened — the helper just polls.
    assert.equal(f.spawned.length, 0);
  });
});
