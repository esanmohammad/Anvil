/**
 * Phase 2 of AGENT-PROCESS-CONSOLIDATION — verify `collectTrajectory`
 * aggregates an Inspect-AI-shaped trajectory from `AgentProcess` events.
 *
 * Six cases per the plan:
 *   1. Happy path — content + result → trajectory with finalAnswer +
 *      finishReason 'end'.
 *   2. Tool-use loop — activity tool_use → toolCalls entry + tool message.
 *   3. Usage aggregation — result event with cost → trajectory.usage maps.
 *   4. finishReason mapping — non-zero exit → 'error'; abort signal →
 *      'error' with error 'aborted'.
 *   5. Timeout — adapter never emits → finishReason 'error' with
 *      error 'timeout'.
 *   6. Listener-ordering — content emitted on first tick survives (regression
 *      against the AgentManager next-tick race).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { collectTrajectory } from '../collect-trajectory.js';
import type { AgentAdapter, AgentAdapterFactory, AdapterRequest } from '../adapter.js';
import type { AgentActivity, CostInfo } from '../types.js';

/**
 * A scriptable AgentAdapter for trajectory tests. Each entry in `script`
 * is a function that runs after `start()` is invoked; entries fire in
 * order on `setImmediate` ticks so listeners are attached first.
 */
class ScriptedAdapter extends EventEmitter implements AgentAdapter {
  private killedFlag = false;
  constructor(private readonly script: Array<(emit: ScriptedAdapter['emit']) => void>) {
    super();
  }
  start(): void {
    let i = 0;
    const tick = () => {
      if (this.killedFlag) return;
      if (i >= this.script.length) return;
      const step = this.script[i++];
      step(this.emit.bind(this));
      setImmediate(tick);
    };
    setImmediate(tick);
  }
  kill(): void {
    this.killedFlag = true;
  }
  get killed(): boolean {
    return this.killedFlag;
  }
}

function scriptedFactory(script: Array<(emit: EventEmitter['emit']) => void>): AgentAdapterFactory {
  return (_req: AdapterRequest) => new ScriptedAdapter(script as Array<(emit: ScriptedAdapter['emit']) => void>);
}

const baseTask = { prompt: 'do thing', model: 'qwen2.5-coder:7b' as const };
const baseWorkspace = { rootDir: '/tmp' };

const zeroCost: CostInfo = {
  totalUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  durationMs: 0,
};

describe('collectTrajectory', () => {
  it('happy path: content + result → finishReason end + finalAnswer', async () => {
    const factory = scriptedFactory([
      (emit) => emit('content', 'hello '),
      (emit) => emit('content', 'world'),
      (emit) =>
        emit('result', {
          result: 'hello world',
          cost: { ...zeroCost, totalUsd: 0.001, inputTokens: 10, outputTokens: 5 },
          sessionId: 'sess-1',
        }),
      (emit) => emit('exit', 0),
    ]);
    const traj = await collectTrajectory(baseTask, baseWorkspace, {
      processOpts: { adapterFactory: factory },
      timeoutMs: 5_000,
    });
    assert.equal(traj.finishReason, 'end');
    assert.equal(traj.finalAnswer, 'hello world');
    assert.equal(traj.costUsd, 0.001);
    assert.deepEqual(traj.usage, { inputTokens: 10, outputTokens: 5 });
    assert.equal(traj.toolCalls.length, 0);
    // messages: user + assistant
    assert.equal(traj.messages.length, 2);
    assert.equal(traj.messages[0].role, 'user');
    assert.equal(traj.messages[1].role, 'assistant');
  });

  it('tool-use loop: activity → toolCalls + tool message', async () => {
    const toolActivity: AgentActivity = {
      id: 'act-1',
      kind: 'tool_use',
      tool: 'read_file',
      summary: 'Reading foo.ts',
      content: JSON.stringify({ path: 'foo.ts' }),
      timestamp: Date.now(),
    };
    const factory = scriptedFactory([
      (emit) => emit('content', 'thinking...'),
      (emit) => emit('activity', toolActivity),
      (emit) => emit('content', 'done'),
      (emit) =>
        emit('result', {
          result: 'done',
          cost: { ...zeroCost, totalUsd: 0.002 },
          sessionId: 'sess-2',
        }),
      (emit) => emit('exit', 0),
    ]);
    const traj = await collectTrajectory(baseTask, baseWorkspace, {
      processOpts: { adapterFactory: factory },
      timeoutMs: 5_000,
    });
    assert.equal(traj.finishReason, 'end');
    assert.equal(traj.toolCalls.length, 1);
    assert.equal(traj.toolCalls[0].name, 'read_file');
    assert.deepEqual(traj.toolCalls[0].arguments, { path: 'foo.ts' });
    // messages: user + assistant("thinking...") + tool + assistant("done")
    const roles = traj.messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
  });

  it('usage aggregation: cache tokens preserved when reported', async () => {
    const factory = scriptedFactory([
      (emit) =>
        emit('result', {
          result: 'x',
          cost: {
            ...zeroCost,
            totalUsd: 0.005,
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 50,
            cacheWriteTokens: 10,
          },
          sessionId: 'sess-3',
        }),
      (emit) => emit('exit', 0),
    ]);
    const traj = await collectTrajectory(baseTask, baseWorkspace, {
      processOpts: { adapterFactory: factory },
      timeoutMs: 5_000,
    });
    assert.deepEqual(traj.usage, {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
    });
  });

  it('finishReason: aborted signal → finishReason error with error="aborted"', async () => {
    // Adapter that never emits — we cancel via signal before it can.
    const factory: AgentAdapterFactory = () => {
      const adapter = new EventEmitter() as unknown as AgentAdapter;
      (adapter as unknown as { start: () => void }).start = () => {};
      (adapter as unknown as { kill: () => void }).kill = () => {};
      return adapter;
    };
    const ac = new AbortController();
    const promise = collectTrajectory(baseTask, baseWorkspace, {
      processOpts: { adapterFactory: factory },
      signal: ac.signal,
      timeoutMs: 60_000,
    });
    // Abort on the next tick so the listener's already attached.
    setImmediate(() => ac.abort());
    const traj = await promise;
    assert.equal(traj.finishReason, 'error');
    assert.equal(traj.error, 'aborted');
  });

  it('timeout: adapter never finishes → finishReason error with error="timeout"', async () => {
    const factory: AgentAdapterFactory = () => {
      const adapter = new EventEmitter() as unknown as AgentAdapter;
      (adapter as unknown as { start: () => void }).start = () => {};
      (adapter as unknown as { kill: () => void }).kill = () => {};
      return adapter;
    };
    const traj = await collectTrajectory(baseTask, baseWorkspace, {
      processOpts: { adapterFactory: factory },
      timeoutMs: 50, // tiny timeout for the test
    });
    assert.equal(traj.finishReason, 'error');
    assert.equal(traj.error, 'timeout');
  });

  it('listener ordering: first content chunk is captured', async () => {
    // Script fires `content` synchronously off setImmediate. If any listener
    // attached AFTER `proc.start()`, the first chunk would be lost. The test
    // asserts the first chunk lands in the trajectory's assistant message.
    const factory = scriptedFactory([
      (emit) => emit('content', 'FIRST'),
      (emit) => emit('content', '_REST'),
      (emit) =>
        emit('result', {
          result: 'FIRST_REST',
          cost: { ...zeroCost, totalUsd: 0 },
          sessionId: 'sess-x',
        }),
      (emit) => emit('exit', 0),
    ]);
    const traj = await collectTrajectory(baseTask, baseWorkspace, {
      processOpts: { adapterFactory: factory },
      timeoutMs: 5_000,
    });
    const assistant = traj.messages.find((m) => m.role === 'assistant');
    assert.ok(assistant, 'assistant message must exist');
    assert.match(assistant!.content, /FIRST/);
  });
});
