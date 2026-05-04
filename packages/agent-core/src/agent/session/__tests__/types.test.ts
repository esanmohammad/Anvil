/**
 * Type-shape lock for agent-core's canonical agent-lifecycle surface.
 *
 * Asserts (compile time + a thin runtime shim) that the public types match
 * the dashboard's pre-Phase-4 shapes — every legacy field has a destination
 * — so dashboard's call sites compile after dropping their re-export shims.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  AgentManager,
  AgentNotFoundError,
  AgentProcess,
  SessionResumeNotSupportedError,
  emptyCost,
  type AgentActivity,
  type AgentAdapter,
  type AgentCheckpointHook,
  type AgentCostHook,
  type AgentManagerEvents,
  type AgentProcessEvents,
  type AgentState,
  type AgentStatus,
  type CostInfo,
  type SpawnConfig,
} from '../index.js';

// Minimal fake adapter for the type-shape locks. Not exercised; only
// satisfies the `adapterFactory` constructor argument.
class NoopAdapter extends EventEmitter implements AgentAdapter {
  start(): void { /* no-op */ }
  kill(): void { /* no-op */ }
}
const noopFactory = () => new NoopAdapter();

// ── 1. SpawnConfig parity ───────────────────────────────────────────────

describe('SpawnConfig — dashboard parity', () => {
  it('accepts every field dashboard sets today', () => {
    const spec: SpawnConfig = {
      name: 'engineer-build-backend',
      persona: 'engineer',
      project: 'demo',
      stage: 'build',
      prompt: 'Implement the new auth flow',
      model: 'claude-3-5-sonnet',
      cwd: '/tmp/workspace',
      projectPrompt: 'You are working on Anvil.',
      permissionMode: 'auto',
      disallowedTools: ['Write', 'Edit'],
      allowedTools: ['Read', 'Grep'],
      maxOutputTokens: 16000,
      runId: 'run-123',
      runFamily: 'run-123',
    };
    assert.equal(spec.name, 'engineer-build-backend');
    assert.equal(spec.cwd, '/tmp/workspace');
    assert.equal(spec.maxOutputTokens, 16000);
  });

  it('accepts cli-shape options (restart + timeout + binaryPath)', () => {
    const spec: SpawnConfig = {
      name: 'cli-stage',
      persona: 'cli',
      project: '',
      stage: 'build',
      prompt: '...',
      model: 'gpt-4',
      cwd: '/tmp',
      restart: { maxAttempts: 2 },
      timeoutMs: 600_000,
      binaryPath: '/usr/local/bin/claude',
      args: ['-p', 'extra'],
    };
    assert.equal(spec.restart?.maxAttempts, 2);
    assert.equal(spec.timeoutMs, 600_000);
  });
});

// ── 2. AgentState parity ────────────────────────────────────────────────

describe('AgentState — dashboard parity', () => {
  it('exposes the same 5-state status union', () => {
    const states: AgentStatus[] = [
      'pending',
      'running',
      'done',
      'error',
      'killed',
    ];
    assert.equal(states.length, 5);
  });

  it('shape matches dashboard AgentState field-for-field', () => {
    const state: AgentState = {
      id: 'a',
      name: 'b',
      persona: 'c',
      sessionId: 'd',
      model: 'e',
      status: 'pending',
      cost: emptyCost(),
      output: '',
      activities: [],
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    assert.equal(state.status, 'pending');
    assert.equal(state.cost.totalUsd, 0);
  });
});

// ── 3. Hooks accept the dashboard's existing hook shapes ────────────────

describe('AgentCostHook + AgentCheckpointHook — dashboard parity', () => {
  it('accepts dashboard-shaped cost hook', () => {
    const hook: AgentCostHook = (info) => {
      assert.ok(typeof info.usd === 'number');
    };
    hook({
      runId: 'r',
      project: 'p',
      stage: 's',
      agent: 'a',
      persona: 'pe',
      model: 'm',
      tokensIn: 1,
      tokensOut: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usd: 0.01,
    });
  });

  it('accepts dashboard-shaped checkpoint hook', () => {
    const hook: AgentCheckpointHook = {
      lookup() {
        return { hit: false };
      },
    };
    const result = hook.lookup({
      project: 'p',
      stage: 's',
      persona: 'pe',
      model: 'm',
      prompt: 'hi',
    });
    assert.equal(result.hit, false);
  });
});

// ── 4. Activity + cost types ────────────────────────────────────────────

describe('AgentActivity + CostInfo', () => {
  it('AgentActivity matches the dashboard shape', () => {
    const activity: AgentActivity = {
      id: 'x',
      kind: 'tool_use',
      tool: 'Read',
      summary: 'Read foo.ts',
      timestamp: Date.now(),
    };
    assert.equal(activity.kind, 'tool_use');
  });

  it('emptyCost() returns zeroed CostInfo', () => {
    const c: CostInfo = emptyCost();
    assert.equal(c.totalUsd, 0);
    assert.equal(c.inputTokens, 0);
    assert.equal(c.outputTokens, 0);
    assert.equal(c.cacheReadTokens, 0);
    assert.equal(c.cacheWriteTokens, 0);
    assert.equal(c.durationMs, 0);
  });
});

// ── 5. Event shapes ─────────────────────────────────────────────────────

describe('Event shapes', () => {
  it('AgentProcessEvents has the 5 dashboard AgentProcessEvents', () => {
    const events: (keyof AgentProcessEvents)[] = [
      'content',
      'activity',
      'result',
      'error-output',
      'exit',
    ];
    assert.equal(events.length, 5);
  });

  it('AgentManagerEvents has the 4 dashboard AgentManagerEvents', () => {
    const events: (keyof AgentManagerEvents)[] = [
      'agent-output',
      'agent-activity',
      'agent-done',
      'agent-error',
    ];
    assert.equal(events.length, 4);
  });
});

// ── 6. Class construction ───────────────────────────────────────────────

describe('AgentProcess construction', () => {
  const spec: SpawnConfig = {
    name: 't',
    persona: 'p',
    project: 'pr',
    stage: 's',
    prompt: '',
    model: 'm',
    cwd: '/tmp',
  };

  it('constructs with a pending state', () => {
    const proc = new AgentProcess(spec, { adapterFactory: noopFactory });
    assert.equal(proc.status, 'pending');
    assert.equal(proc.output, '');
  });

  it('honors id override', () => {
    const proc = new AgentProcess(spec, { adapterFactory: noopFactory, id: 'custom-id' });
    assert.equal(proc.id, 'custom-id');
    assert.equal(proc.sessionId, 'custom-id');
  });

  it('id defaults to a UUID v4', () => {
    const proc = new AgentProcess(spec, { adapterFactory: noopFactory });
    assert.match(proc.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('AgentManager construction', () => {
  it('constructs and accepts hook setters', () => {
    const mgr = new AgentManager({ adapterFactory: noopFactory });
    mgr.setCostHook(() => {});
    mgr.setCheckpointHook({ lookup: () => ({ hit: false }) });
    assert.equal(mgr.getAgent('missing'), undefined);
  });
});

// ── 7. Errors carry the right metadata ──────────────────────────────────

describe('Errors', () => {
  it('SessionResumeNotSupportedError carries provider + model', () => {
    const err = new SessionResumeNotSupportedError('openai', 'gpt-4');
    assert.equal(err.provider, 'openai');
    assert.equal(err.model, 'gpt-4');
    assert.match(err.message, /openai/);
    assert.match(err.message, /gpt-4/);
  });

  it('AgentNotFoundError carries the agentId', () => {
    const err = new AgentNotFoundError('agent-xyz');
    assert.equal(err.agentId, 'agent-xyz');
    assert.match(err.message, /agent-xyz/);
  });
});
