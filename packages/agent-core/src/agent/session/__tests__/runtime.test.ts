/**
 * Phase 2 of the agent-manager consolidation — parity tests for the
 * `AgentSession` + `AgentSessionRegistry` runtime against dashboard's
 * `AgentManager` + `AgentProcess` behavior.
 *
 * Drives the registry with a fake `AgentAdapter` (EventEmitter) so the
 * tests don't require a real subprocess.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  AgentSession,
  AgentSessionNotFoundError,
  AgentSessionRegistry,
  emptyCost,
  type AgentActivity,
  type AgentAdapter,
  type AgentSessionState,
  type CostInfo,
  type SessionSpec,
} from '../index.js';

// ── Test adapter ────────────────────────────────────────────────────────

class FakeAdapter extends EventEmitter implements AgentAdapter {
  started = false;
  killed = false;
  maxOutputTokens?: number;
  lastSignal?: string;

  start(): void { this.started = true; }
  kill(signal?: string): void {
    this.killed = true;
    this.lastSignal = signal;
    this.emit('exit', null);
  }
  setMaxOutputTokens(n: number): void { this.maxOutputTokens = n; }

  // ── Test conveniences ────────────────────────────────────────────
  sendContent(text: string): void { this.emit('content', text); }
  sendActivity(a: AgentActivity): void { this.emit('activity', a); }
  finish(result: string, cost: Partial<CostInfo> = {}, sessionId = 'sess-1'): void {
    this.emit('result', {
      result,
      cost: { ...emptyCost(), ...cost },
      sessionId,
    });
  }
  exit(code: number | null): void { this.emit('exit', code); }
}

function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    name: 'test',
    persona: 'engineer',
    project: 'demo',
    stage: 'build',
    prompt: 'hello',
    model: 'claude-3-5-sonnet',
    cwd: '/tmp',
    ...overrides,
  };
}

// Captures the freshly-spawned adapter so each test can drive it.
function harness() {
  const adapters: FakeAdapter[] = [];
  const factory = () => {
    const a = new FakeAdapter();
    adapters.push(a);
    return a;
  };
  return { adapters, factory };
}

// ── Spawn happy path ────────────────────────────────────────────────────

describe('AgentSessionRegistry — spawn happy path', () => {
  it('spawns adapter, pipes content, completes on result', async () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    const outputs: { agentId: string; chunk: string }[] = [];
    const dones: AgentSessionState[] = [];
    reg.on('agent-output', (data) => outputs.push(data));
    reg.on('agent-done', (data) => dones.push(data.agent));

    const state = reg.spawn(spec());
    assert.equal(state.status, 'running');
    assert.equal(adapters.length, 1);
    assert.equal(adapters[0].started, true);

    adapters[0].sendContent('hello ');
    adapters[0].sendContent('world');
    adapters[0].finish('hello world', { totalUsd: 0.05, inputTokens: 100, outputTokens: 50 });

    // Allow the synchronous result handler to flush
    await new Promise((r) => setImmediate(r));

    assert.equal(outputs.length, 2);
    assert.equal(outputs[0].chunk, 'hello ');
    assert.equal(outputs[1].chunk, 'world');
    assert.equal(dones.length, 1);
    assert.equal(dones[0].status, 'done');
    assert.equal(dones[0].cost.totalUsd, 0.05);
    assert.match(dones[0].output, /hello world/);
  });

  it('honors maxOutputTokens — passes it to the adapter', () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    reg.spawn(spec({ maxOutputTokens: 4000 }));
    assert.equal(adapters[0].maxOutputTokens, 4000);
  });

  it('emits activity events through the registry', () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    const activities: { agentId: string; activity: AgentActivity }[] = [];
    reg.on('agent-activity', (data) => activities.push(data));
    reg.spawn(spec());
    adapters[0].sendActivity({ id: '1', kind: 'tool_use', tool: 'Read', summary: 'r', timestamp: 0 });
    assert.equal(activities.length, 1);
    assert.equal(activities[0].activity.tool, 'Read');
  });
});

// ── Checkpoint cache ────────────────────────────────────────────────────

describe('AgentSessionRegistry — checkpoint cache', () => {
  it('hit: synthesizes done without spawning an adapter', async () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    reg.setCheckpointHook({
      lookup: () => ({
        hit: true,
        output: 'cached output',
        cost: { ...emptyCost(), totalUsd: 0.01, inputTokens: 50, outputTokens: 25 },
      }),
    });
    const dones: AgentSessionState[] = [];
    reg.on('agent-done', (data) => dones.push(data.agent));

    const state = reg.spawn(spec());
    assert.equal(state.status, 'done');
    assert.match(state.output, /cached output/);
    assert.equal(state.cost.totalUsd, 0.01);
    assert.equal(adapters.length, 0, 'no adapter constructed on cache hit');

    await new Promise((r) => process.nextTick(r));
    assert.equal(dones.length, 1, 'agent-done fired on next tick');
  });

  it('miss: spawns the adapter normally', () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    reg.setCheckpointHook({ lookup: () => ({ hit: false }) });
    reg.spawn(spec());
    assert.equal(adapters.length, 1);
    assert.equal(adapters[0].started, true);
  });

  it('cache lookup throw is non-fatal — falls through to spawn', () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    reg.setCheckpointHook({ lookup: () => { throw new Error('boom'); } });
    reg.spawn(spec());
    assert.equal(adapters.length, 1, 'spawned despite lookup throw');
  });

  it('record is fired on completion', async () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    const records: unknown[] = [];
    reg.setCheckpointHook({
      lookup: () => ({ hit: false }),
      record: (r) => records.push(r),
    });
    reg.spawn(spec());
    adapters[0].finish('result text', { totalUsd: 0.05 });
    await new Promise((r) => setImmediate(r));
    assert.equal(records.length, 1);
    const rec = records[0] as { project: string; output: string; cost: CostInfo };
    assert.equal(rec.project, 'demo');
    assert.equal(rec.output, 'result text');
    assert.equal(rec.cost.totalUsd, 0.05);
  });
});

// ── sendInput / resume ──────────────────────────────────────────────────

describe('AgentSessionRegistry — sendInput / resume', () => {
  it('throws when agent unknown', () => {
    const { factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    assert.throws(
      () => reg.sendInput('missing', 'hi'),
      AgentSessionNotFoundError,
    );
  });

  it('spawns a NEW adapter with the same sessionId on sendInput', () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    const state = reg.spawn(spec());
    const id = state.id;

    reg.sendInput(id, 'follow-up');
    assert.equal(adapters.length, 2, 'second adapter spawned');
    assert.equal(adapters[1].started, true);
  });

  it('appends user-marker chunk to the output stream + registry emit', () => {
    const { factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    const outputs: string[] = [];
    reg.on('agent-output', (data) => outputs.push(data.chunk));
    const state = reg.spawn(spec());
    reg.sendInput(state.id, 'follow-up');
    const userMarker = outputs.find((c) => c.includes('> User: follow-up'));
    assert.ok(userMarker, `expected user marker chunk, got: ${JSON.stringify(outputs)}`);
  });

  it('cost accumulates across resume calls', async () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    const state = reg.spawn(spec());
    adapters[0].finish('first', { totalUsd: 0.10, inputTokens: 100, outputTokens: 50 });
    await new Promise((r) => setImmediate(r));

    reg.sendInput(state.id, 'more');
    adapters[1].finish('second', { totalUsd: 0.05, inputTokens: 30, outputTokens: 20 });
    await new Promise((r) => setImmediate(r));

    const final = reg.getAgent(state.id)!;
    // Float precision — 0.10 + 0.05 = 0.15000000000000002.
    assert.ok(Math.abs(final.cost.totalUsd - 0.15) < 1e-9);
    assert.equal(final.cost.inputTokens, 130);
    assert.equal(final.cost.outputTokens, 70);
  });
});

// ── Kill / killAll ──────────────────────────────────────────────────────

describe('AgentSessionRegistry — kill / killAll', () => {
  it('kill returns true and marks state killed', () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    const state = reg.spawn(spec());
    const ok = reg.kill(state.id);
    assert.equal(ok, true);
    assert.equal(adapters[0].killed, true);
    assert.equal(reg.getAgent(state.id)!.status, 'killed');
  });

  it('kill on unknown agent returns false', () => {
    const { factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    assert.equal(reg.kill('missing'), false);
  });

  it('killAll kills every running session and reports the count', () => {
    const { factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    reg.spawn(spec({ name: 'a' }));
    reg.spawn(spec({ name: 'b' }));
    reg.spawn(spec({ name: 'c' }));
    const killed = reg.killAll();
    assert.equal(killed, 3);
  });

  it('killAll skips already-done sessions', async () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    reg.spawn(spec({ name: 'a' }));
    adapters[0].finish('done', { totalUsd: 0.01 });
    await new Promise((r) => setImmediate(r));

    reg.spawn(spec({ name: 'b' }));
    const killed = reg.killAll();
    assert.equal(killed, 1, 'only the running session counted');
  });
});

// ── Cost hook ───────────────────────────────────────────────────────────

describe('AgentSessionRegistry — cost hook', () => {
  it('fires once per result with full payload', async () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    const calls: unknown[] = [];
    reg.setCostHook((info) => { calls.push(info); });
    reg.spawn(spec({ runId: 'r1' }));
    adapters[0].finish('done', {
      totalUsd: 0.07,
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    const info = calls[0] as { runId?: string; usd: number; tokensIn: number };
    assert.equal(info.runId, 'r1');
    assert.equal(info.usd, 0.07);
    assert.equal(info.tokensIn, 100);
  });

  it('cost hook throws are non-fatal', async () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    reg.setCostHook(() => { throw new Error('boom'); });
    reg.spawn(spec());
    assert.doesNotThrow(() => {
      adapters[0].finish('done', { totalUsd: 0.01 });
    });
    await new Promise((r) => setImmediate(r));
  });
});

// ── Error / exit paths ──────────────────────────────────────────────────

describe('AgentSession — error + exit semantics', () => {
  it('non-zero exit transitions state to error', () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    const errors: unknown[] = [];
    reg.on('agent-error', (data) => errors.push(data));
    const state = reg.spawn(spec());
    adapters[0].exit(1);
    const after = reg.getAgent(state.id)!;
    assert.equal(after.status, 'error');
    assert.match(after.error ?? '', /exited with code 1/);
    assert.equal(errors.length, 1);
  });

  it('error-output stream appends to state.error', () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    const errors: { agentId: string; error: string }[] = [];
    reg.on('agent-error', (data) => errors.push(data));
    const state = reg.spawn(spec());
    adapters[0].emit('error-output', 'something broke');
    const after = reg.getAgent(state.id)!;
    assert.match(after.error ?? '', /something broke/);
    assert.equal(errors.length, 1);
  });

  it('clean exit with empty output marks session as error', async () => {
    const calls: { fn: () => void; ms: number }[] = [];
    const fakeSetTimeout = (fn: () => void, ms: number) => { calls.push({ fn, ms }); };
    const fakeNow = (() => {
      let t = 0;
      return () => { t += 1; return t; };
    })();
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({
      adapterFactory: factory,
      setTimeoutImpl: fakeSetTimeout,
      now: fakeNow,
    });
    const state = reg.spawn(spec());
    adapters[0].exit(0);
    // Trigger the deferred callback synchronously.
    assert.equal(calls.length, 1);
    calls[0].fn();
    const after = reg.getAgent(state.id)!;
    assert.equal(after.status, 'error');
    assert.match(after.error ?? '', /no output/);
  });
});

// ── Output truncation ───────────────────────────────────────────────────

describe('AgentSession — output buffering', () => {
  it('caps in-memory output at 500KB tail', () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    const state = reg.spawn(spec());
    const big = 'x'.repeat(600 * 1024);
    adapters[0].sendContent(big);
    const after = reg.getAgent(state.id)!;
    // 500 * 1024 = 512000
    assert.equal(after.output.length, 500 * 1024);
  });

  it('caps in-memory activities at 500 entries', () => {
    const { adapters, factory } = harness();
    const reg = new AgentSessionRegistry({ adapterFactory: factory });
    const state = reg.spawn(spec());
    for (let i = 0; i < 600; i++) {
      adapters[0].sendActivity({
        id: `a${i}`,
        kind: 'tool_use',
        tool: 'Read',
        summary: 'r',
        timestamp: i,
      });
    }
    const after = reg.getAgent(state.id)!;
    assert.equal(after.activities.length, 500);
    // Tail should be the LAST 500 activities (a100..a599).
    assert.equal(after.activities[0].id, 'a100');
    assert.equal(after.activities[499].id, 'a599');
  });
});

// ── Direct AgentSession access ──────────────────────────────────────────

describe('AgentSession — direct usage (without registry)', () => {
  it('can be driven directly with an injected adapter', async () => {
    const { adapters, factory } = harness();
    const session = new AgentSession(spec(), { adapterFactory: factory });
    const results: unknown[] = [];
    session.on('result', (r) => results.push(r));
    session.start();
    adapters[0].finish('hi', { totalUsd: 0.02 });
    await new Promise((r) => setImmediate(r));
    assert.equal(results.length, 1);
    assert.equal(session.status, 'done');
    assert.equal(session.cost.totalUsd, 0.02);
  });
});
