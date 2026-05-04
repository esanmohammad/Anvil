/**
 * Tests for `runWithAgent` — single-shot helper for cli commands.
 *
 * Drives the helper with a fake adapter so the test doesn't require a
 * real subprocess.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  emptyCost,
  runWithAgent,
  type AgentAdapter,
  type SpawnConfig,
} from '../index.js';

class FakeAdapter extends EventEmitter implements AgentAdapter {
  start(): void {
    // Emit content + result + exit on next tick so listeners are wired.
    queueMicrotask(() => {
      this.emit('content', 'hello world');
      this.emit('result', {
        result: 'hello world',
        cost: { ...emptyCost(), totalUsd: 0.05, inputTokens: 10, outputTokens: 5 },
        sessionId: 'sess-1',
      });
      this.emit('exit', 0);
    });
  }
  kill(): void {
    this.emit('exit', null);
  }
}

class FailingAdapter extends EventEmitter implements AgentAdapter {
  start(): void {
    queueMicrotask(() => {
      this.emit('error-output', 'something broke');
      this.emit('exit', 1);
    });
  }
  kill(): void { /* noop */ }
}

class HangingAdapter extends EventEmitter implements AgentAdapter {
  killed = false;
  start(): void { /* never resolves */ }
  kill(): void {
    this.killed = true;
    this.emit('exit', null);
  }
}

function spec(overrides: Partial<SpawnConfig> = {}): SpawnConfig {
  return {
    name: 'test',
    persona: 'cli',
    project: 'demo',
    stage: 'review',
    prompt: 'hi',
    model: 'claude-3-5-sonnet',
    cwd: '/tmp',
    ...overrides,
  };
}

describe('runWithAgent — happy path', () => {
  it('resolves with output + cost when agent finishes', async () => {
    const result = await runWithAgent(spec(), {
      adapterFactory: () => new FakeAdapter(),
    });
    assert.match(result.output, /hello world/);
    assert.equal(result.cost.totalUsd, 0.05);
    assert.equal(result.state.status, 'done');
  });
});

describe('runWithAgent — error path', () => {
  it('rejects when the agent emits error + non-zero exit', async () => {
    await assert.rejects(
      () => runWithAgent(spec(), { adapterFactory: () => new FailingAdapter() }),
      /something broke/,
    );
  });
});

describe('runWithAgent — cancellation', () => {
  it('kills the agent and rejects with AbortError when signal fires', async () => {
    const adapter = new HangingAdapter();
    const controller = new AbortController();
    const promise = runWithAgent(spec(), {
      adapterFactory: () => adapter,
      signal: controller.signal,
    });

    // Let the adapter spawn complete first, then abort.
    await new Promise((r) => setImmediate(r));
    controller.abort();

    await assert.rejects(promise, (err: unknown) => {
      const e = err as { name?: string };
      return e.name === 'AbortError';
    });
    assert.equal(adapter.killed, true);
  });

  it('rejects immediately if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => runWithAgent(spec(), {
        adapterFactory: () => new FakeAdapter(),
        signal: controller.signal,
      }),
      (err: unknown) => (err as { name?: string }).name === 'AbortError',
    );
  });
});
