/**
 * H3 — durable-wrap helpers for the web/browser tool surface.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  wrapWebEffect,
  searchIdempotencyKey,
  fetchIdempotencyKey,
  navigateIdempotencyKey,
  extractIdempotencyKey,
} from '../tools/effect-wrapping.js';
import type { StepContext } from '../types.js';

function makeStubCtx(): { ctx: StepContext<string>; calls: Array<{ name: string; opts?: unknown }> } {
  const calls: Array<{ name: string; opts?: unknown }> = [];
  const ctx = {
    runId: 'r1',
    workspaceDir: '/tmp',
    input: '',
    artifacts: { get: () => undefined, has: () => false } as never,
    emit: () => {},
    bus: undefined as never,
    signal: new AbortController().signal,
    shared: {},
    effect<T>(name: string, fn: () => Promise<T>, opts?: unknown): Promise<T> {
      calls.push({ name, opts });
      return fn();
    },
    now: async () => Date.now(),
    uuid: async () => 'u',
    random: async () => 0,
    sleep: async () => undefined,
    waitForSignal: async () => undefined as never,
  } as unknown as StepContext<string>;
  return { ctx, calls };
}

describe('wrapWebEffect', () => {
  it('passes through when ctx is undefined', async () => {
    const result = await wrapWebEffect(undefined, 'web:search', 'k', async () => 42);
    assert.equal(result, 42);
  });

  it('records via ctx.effect with stage-prefixed name + idempotency key', async () => {
    const { ctx, calls } = makeStubCtx();
    const result = await wrapWebEffect(ctx, 'web:search', 'k', async () => 'ok');
    assert.equal(result, 'ok');
    assert.equal(calls.length, 1);
    assert.match(calls[0].name, /^web:search:[a-f0-9]+$/);
    const opts = calls[0].opts as { idempotencyKey: string };
    assert.ok(opts.idempotencyKey.length > 0);
  });

  it('honors caller-supplied idempotency key', async () => {
    const { ctx, calls } = makeStubCtx();
    await wrapWebEffect(ctx, 'web:fetch', 'k', async () => 1, { idempotencyKey: 'fixed-key' });
    const opts = calls[0].opts as { idempotencyKey: string };
    assert.equal(opts.idempotencyKey, 'fixed-key');
    assert.match(calls[0].name, /:fixed-key$/);
  });

  it('forwards timeoutMs', async () => {
    const { ctx, calls } = makeStubCtx();
    await wrapWebEffect(ctx, 'web:search', 'k', async () => 1, { timeoutMs: 5000 });
    assert.equal((calls[0].opts as { timeoutMs?: number }).timeoutMs, 5000);
  });
});

describe('idempotency key builders', () => {
  it('searchIdempotencyKey is stable across arg-order differences', () => {
    const a = searchIdempotencyKey({ query: 'q', allowedDomains: ['*.x'], blockedDomains: ['*.y'], limit: 5 });
    const b = searchIdempotencyKey({ query: 'q', allowedDomains: ['*.x'], blockedDomains: ['*.y'], limit: 5 });
    assert.equal(a, b);
  });

  it('searchIdempotencyKey changes with query', () => {
    const a = searchIdempotencyKey({ query: 'q1' });
    const b = searchIdempotencyKey({ query: 'q2' });
    assert.notEqual(a, b);
  });

  it('fetchIdempotencyKey distinguishes (url, prompt)', () => {
    const a = fetchIdempotencyKey({ url: 'https://x', prompt: 'p1' });
    const b = fetchIdempotencyKey({ url: 'https://x', prompt: 'p2' });
    assert.notEqual(a, b);
  });

  it('navigateIdempotencyKey scopes by runId+sessionId+url', () => {
    const a = navigateIdempotencyKey({ runId: 'r1', sessionId: 's1', url: 'https://x' });
    const b = navigateIdempotencyKey({ runId: 'r1', sessionId: 's1', url: 'https://x' });
    const c = navigateIdempotencyKey({ runId: 'r2', sessionId: 's1', url: 'https://x' });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it('extractIdempotencyKey distinguishes (query, schemaHash, alreadyCollectedHash)', () => {
    const a = extractIdempotencyKey({ query: 'q', schemaHash: 'h1' });
    const b = extractIdempotencyKey({ query: 'q', schemaHash: 'h2' });
    assert.notEqual(a, b);
  });
});
