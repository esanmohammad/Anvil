/**
 * Phase 1 type-shape lock for the unified agent-lifecycle surface.
 *
 * These tests prove (at compile time + a thin runtime shim) that:
 *
 *   1. `SessionSpec` is structurally compatible with dashboard's existing
 *      `SpawnConfig` shape (every legacy field has a destination).
 *   2. `SessionSpec` is structurally compatible with agent-core's existing
 *      `AgentProcessConfig` shape (cli single-shot caller).
 *   3. `AgentSessionState` exposes the same fields dashboard's `AgentState`
 *      does, with the same status union.
 *   4. The skeleton classes throw a clear "Phase 2" error when their
 *      runtime methods are called — Phase 2 will replace these.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentSession,
  AgentSessionNotFoundError,
  AgentSessionRegistry,
  SessionResumeNotSupportedError,
  emptyCost,
  type AgentActivity,
  type AgentCheckpointHook,
  type AgentCostHook,
  type AgentSessionEvents,
  type AgentSessionRegistryEvents,
  type AgentSessionState,
  type AgentSessionStatus,
  type CostInfo,
  type SessionSpec,
} from '../index.js';

// ── 1. SessionSpec accepts dashboard's SpawnConfig shape ────────────────

describe('SessionSpec — dashboard SpawnConfig parity', () => {
  it('accepts every field dashboard sets today', () => {
    const spec: SessionSpec = {
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

  it('accepts agent-core AgentProcessConfig fields (cli flow)', () => {
    const spec: SessionSpec = {
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

// ── 2. AgentSessionState parity with dashboard's AgentState ─────────────

describe('AgentSessionState — dashboard AgentState parity', () => {
  it('exposes the same 5-state status union', () => {
    const states: AgentSessionStatus[] = [
      'pending',
      'running',
      'done',
      'error',
      'killed',
    ];
    assert.equal(states.length, 5);
  });

  it('shape matches dashboard AgentState field-for-field', () => {
    const state: AgentSessionState = {
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
  it('AgentSessionEvents has the 5 dashboard AgentProcessEvents', () => {
    const events: (keyof AgentSessionEvents)[] = [
      'content',
      'activity',
      'result',
      'error-output',
      'exit',
    ];
    assert.equal(events.length, 5);
  });

  it('AgentSessionRegistryEvents has the 4 dashboard AgentManagerEvents', () => {
    const events: (keyof AgentSessionRegistryEvents)[] = [
      'agent-output',
      'agent-activity',
      'agent-done',
      'agent-error',
    ];
    assert.equal(events.length, 4);
  });
});

// ── 6. Skeleton classes throw a clear "Phase 2" error ───────────────────

describe('AgentSession skeleton', () => {
  const spec: SessionSpec = {
    name: 't',
    persona: 'p',
    project: 'pr',
    stage: 's',
    prompt: '',
    model: 'm',
    cwd: '/tmp',
  };

  it('constructs with a pending state', () => {
    const session = new AgentSession(spec);
    assert.equal(session.status, 'pending');
    assert.equal(session.output, '');
  });

  it('throws Phase 2 placeholder on start()', () => {
    const session = new AgentSession(spec);
    assert.throws(() => session.start(), /Phase 2/);
  });

  it('throws Phase 2 placeholder on sendInput()', () => {
    const session = new AgentSession(spec);
    assert.throws(() => session.sendInput('hello'), /Phase 2/);
  });

  it('throws Phase 2 placeholder on kill()', () => {
    const session = new AgentSession(spec);
    assert.throws(() => session.kill(), /Phase 2/);
  });
});

describe('AgentSessionRegistry skeleton', () => {
  it('constructs and accepts hook setters', () => {
    const reg = new AgentSessionRegistry();
    reg.setCostHook(() => {});
    reg.setCheckpointHook({ lookup: () => ({ hit: false }) });
    assert.equal(reg.getAgent('missing'), undefined);
  });

  it('throws Phase 2 placeholder on spawn()', () => {
    const reg = new AgentSessionRegistry();
    const spec: SessionSpec = {
      name: 't',
      persona: 'p',
      project: 'pr',
      stage: 's',
      prompt: '',
      model: 'm',
      cwd: '/tmp',
    };
    assert.throws(() => reg.spawn(spec), /Phase 2/);
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

  it('AgentSessionNotFoundError carries the agentId', () => {
    const err = new AgentSessionNotFoundError('agent-xyz');
    assert.equal(err.agentId, 'agent-xyz');
    assert.match(err.message, /agent-xyz/);
  });
});
