/**
 * Phase 1 — bus.request/respond primitive.
 *
 * Coverage:
 *   - request → respond happy path returns the response
 *   - timeout rejects with BusRequestTimeoutError
 *   - AbortSignal cancels the request
 *   - signal already aborted rejects synchronously-async
 *   - parallel requests on same channel resolve independently
 *   - cross-channel ID collision is ignored
 *   - late respond() with no pending entry is a silent no-op
 *   - request without responder times out (no-listener path)
 *   - onRequest unsubscribe removes the listener
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventBus } from '../event-bus.js';
import { BusRequestTimeoutError, BusRequestAbortedError } from '../bus-request.js';

describe('bus.request/respond — happy path', () => {
  it('responder resolves the awaiting request', async () => {
    const bus = new InMemoryEventBus();
    bus.onRequest<{ stage: number }>('approval:gate', (req) => {
      bus.respond('approval:gate', req.requestId, 'approved');
    });
    const result = await bus.request<{ stage: number }, string>('approval:gate', { stage: 0 });
    assert.equal(result, 'approved');
    assert.equal(bus.pendingRequestCount(), 0);
  });

  it('payload is delivered to the responder', async () => {
    const bus = new InMemoryEventBus();
    bus.onRequest<{ stage: number }>('approval:gate', (req) => {
      bus.respond('approval:gate', req.requestId, req.payload.stage);
    });
    const result = await bus.request<{ stage: number }, number>('approval:gate', { stage: 5 });
    assert.equal(result, 5);
  });

  it('async responder resolves after async work', async () => {
    const bus = new InMemoryEventBus();
    bus.onRequest<unknown>('clarify:answers', async (req) => {
      await new Promise((r) => setTimeout(r, 5));
      bus.respond('clarify:answers', req.requestId, 'yes');
    });
    const result = await bus.request<unknown, string>('clarify:answers', null);
    assert.equal(result, 'yes');
  });
});

describe('bus.request — timeout', () => {
  it('rejects with BusRequestTimeoutError when no responder + timeout fires', async () => {
    const bus = new InMemoryEventBus();
    await assert.rejects(
      () => bus.request<unknown, unknown>('approval:gate', null, { timeoutMs: 20 }),
      (err: unknown) => {
        assert.ok(err instanceof BusRequestTimeoutError);
        return true;
      },
    );
    assert.equal(bus.pendingRequestCount(), 0);
  });

  it('rejects with timeout when responder is attached but never responds', async () => {
    const bus = new InMemoryEventBus();
    bus.onRequest<unknown>('approval:gate', () => {
      /* responder receives the request but never calls respond() */
    });
    await assert.rejects(
      () => bus.request<unknown, unknown>('approval:gate', null, { timeoutMs: 20 }),
      (err: unknown) => err instanceof BusRequestTimeoutError,
    );
  });
});

describe('bus.request — AbortSignal', () => {
  it('rejects with BusRequestAbortedError when signal aborts', async () => {
    const bus = new InMemoryEventBus();
    const controller = new AbortController();
    const promise = bus.request<unknown, unknown>('approval:gate', null, {
      signal: controller.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(promise, (err: unknown) => err instanceof BusRequestAbortedError);
    assert.equal(bus.pendingRequestCount(), 0);
  });

  it('rejects synchronously when signal is already aborted', async () => {
    const bus = new InMemoryEventBus();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => bus.request<unknown, unknown>('approval:gate', null, { signal: controller.signal }),
      (err: unknown) => err instanceof BusRequestAbortedError,
    );
  });
});

describe('bus.request — parallel + isolation', () => {
  it('two parallel requests on same channel resolve independently', async () => {
    const bus = new InMemoryEventBus();
    bus.onRequest<{ id: number }>('q', (req) => {
      // Echo the id back as the response.
      bus.respond('q', req.requestId, req.payload.id);
    });
    const [a, b] = await Promise.all([
      bus.request<{ id: number }, number>('q', { id: 1 }),
      bus.request<{ id: number }, number>('q', { id: 2 }),
    ]);
    assert.equal(a, 1);
    assert.equal(b, 2);
  });

  it('respond() with channel mismatch is dropped silently', async () => {
    const bus = new InMemoryEventBus();
    let receivedId: string | undefined;
    bus.onRequest<unknown>('a', (req) => {
      receivedId = req.requestId;
      // Wrong channel: should NOT resolve the pending request.
      bus.respond('b', req.requestId, 'cross-channel');
    });
    await assert.rejects(
      () => bus.request<unknown, unknown>('a', null, { timeoutMs: 30 }),
      (err: unknown) => err instanceof BusRequestTimeoutError,
    );
    assert.ok(receivedId, 'responder should have run');
  });

  it('late respond() with unknown id is a silent no-op', () => {
    const bus = new InMemoryEventBus();
    // No pending request exists.
    bus.respond('a', 'never-issued', 'whatever');
    assert.equal(bus.pendingRequestCount(), 0);
  });
});

describe('bus.onRequest — unsubscribe', () => {
  it('returned handle removes the listener', async () => {
    const bus = new InMemoryEventBus();
    const off = bus.onRequest<unknown>('approval:gate', (req) => {
      bus.respond('approval:gate', req.requestId, 'approved');
    });
    off();
    // No responder remains — request should time out.
    await assert.rejects(
      () => bus.request<unknown, unknown>('approval:gate', null, { timeoutMs: 20 }),
      (err: unknown) => err instanceof BusRequestTimeoutError,
    );
  });

  it('multiple listeners on same channel: any can respond', async () => {
    const bus = new InMemoryEventBus();
    bus.onRequest<unknown>('q', () => {
      /* first listener does nothing */
    });
    bus.onRequest<unknown>('q', (req) => {
      bus.respond('q', req.requestId, 'second-responder-wins');
    });
    const result = await bus.request<unknown, string>('q', null);
    assert.equal(result, 'second-responder-wins');
  });
});
