/**
 * Phase 4 — local executor: single-slot FIFO + same-id no-evict + error
 * recovery.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LocalExecutor } from '../router/local-executor.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('LocalExecutor — single call', () => {
  it('runs fn and updates loaded on a single call', async () => {
    const evictions: string[] = [];
    const exec = new LocalExecutor({ evict: async (id) => { evictions.push(id); } });
    const result = await exec.withModel('qwen', async () => 'ok');
    assert.equal(result, 'ok');
    assert.equal(exec.inspect().loaded, 'qwen');
    assert.deepEqual(evictions, []);
  });

  it('does not evict on first load (no previous model)', async () => {
    const evictions: string[] = [];
    const exec = new LocalExecutor({ evict: async (id) => { evictions.push(id); } });
    await exec.withModel('first', async () => undefined);
    assert.deepEqual(evictions, []);
  });
});

describe('LocalExecutor — eviction', () => {
  it('evicts the previous model when switching ids', async () => {
    const evictions: string[] = [];
    const exec = new LocalExecutor({ evict: async (id) => { evictions.push(id); } });
    await exec.withModel('qwen', async () => undefined);
    await exec.withModel('gemma', async () => undefined);
    assert.deepEqual(evictions, ['qwen']);
    assert.equal(exec.inspect().loaded, 'gemma');
  });

  it('does NOT evict when the same id is reused consecutively', async () => {
    const evictions: string[] = [];
    const exec = new LocalExecutor({ evict: async (id) => { evictions.push(id); } });
    await exec.withModel('qwen', async () => undefined);
    await exec.withModel('qwen', async () => undefined);
    await exec.withModel('qwen', async () => undefined);
    assert.deepEqual(evictions, []);
    assert.equal(exec.inspect().loaded, 'qwen');
  });

  it('chains evictions across multiple distinct ids', async () => {
    const evictions: string[] = [];
    const exec = new LocalExecutor({ evict: async (id) => { evictions.push(id); } });
    await exec.withModel('a', async () => undefined);
    await exec.withModel('b', async () => undefined);
    await exec.withModel('c', async () => undefined);
    await exec.withModel('a', async () => undefined);
    assert.deepEqual(evictions, ['a', 'b', 'c']);
    assert.equal(exec.inspect().loaded, 'a');
  });
});

describe('LocalExecutor — FIFO + concurrency', () => {
  it('serializes parallel calls to the same id (no overlap)', async () => {
    const exec = new LocalExecutor();
    const order: string[] = [];
    const d1 = deferred<void>();
    const d2 = deferred<void>();

    const p1 = exec.withModel('qwen', async () => {
      order.push('start1');
      await d1.promise;
      order.push('end1');
    });
    const p2 = exec.withModel('qwen', async () => {
      order.push('start2');
      await d2.promise;
      order.push('end2');
    });

    // Yield twice so the queue's microtask plumbing can run.
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(order, ['start1'], 'second call must wait for the slot');

    d1.resolve();
    await p1;
    // After p1 settles, the executor pumps p2 (same id → no evict).
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(order, ['start1', 'end1', 'start2']);

    d2.resolve();
    await p2;
    assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2']);
  });

  it('preserves enqueue order even with cross-id swaps', async () => {
    const evictions: string[] = [];
    const exec = new LocalExecutor({ evict: async (id) => { evictions.push(id); } });
    const callOrder: string[] = [];

    const ps = ['a', 'b', 'a', 'c', 'a'].map((id, i) =>
      exec.withModel(id, async () => {
        callOrder.push(`${id}#${i}`);
      }),
    );
    await Promise.all(ps);
    assert.deepEqual(callOrder, ['a#0', 'b#1', 'a#2', 'c#3', 'a#4']);
    assert.deepEqual(evictions, ['a', 'b', 'a', 'c']);
  });

  it('releases the slot when fn throws and keeps draining the queue', async () => {
    const exec = new LocalExecutor();
    const log: string[] = [];

    const p1 = exec.withModel('a', async () => {
      log.push('a-start');
      throw new Error('boom');
    });
    const p2 = exec.withModel('b', async () => {
      log.push('b-start');
      return 'b-done';
    });

    await assert.rejects(p1, /boom/);
    const r = await p2;
    assert.equal(r, 'b-done');
    assert.deepEqual(log, ['a-start', 'b-start']);
    assert.equal(exec.inspect().loaded, 'b');
  });
});

describe('LocalExecutor — inspect', () => {
  it('reports queueDepth while items wait', async () => {
    const exec = new LocalExecutor();
    const block = deferred<void>();
    const p1 = exec.withModel('a', async () => { await block.promise; });
    // Two more enqueued behind it.
    const p2 = exec.withModel('a', async () => undefined);
    const p3 = exec.withModel('b', async () => undefined);

    // The executor's pump runs synchronously up to the first await, so
    // by the time we observe, item 1 is in-flight and 2 are still queued.
    await Promise.resolve();
    const snap = exec.inspect();
    assert.equal(snap.loaded, 'a');
    assert.equal(snap.queueDepth, 2);

    block.resolve();
    await Promise.all([p1, p2, p3]);
    assert.equal(exec.inspect().queueDepth, 0);
  });
});

describe('LocalExecutor — intruder detection (Phase 4.7)', () => {
  it('evicts an out-of-band exclusive model resident in Ollama before loading', async () => {
    const evictions: string[] = [];
    let probed = false;
    const exec = new LocalExecutor({
      evict: async (id) => { evictions.push(id); },
      // Ollama already has gemma4:e4b loaded out-of-band when our queue runs.
      probeResident: async () => {
        probed = true;
        return ['gemma4:e4b'];
      },
      isExclusive: () => true,
    });

    await exec.withModel('qwen3:14b', async () => undefined);

    assert.ok(probed, 'probe must run before loading');
    assert.deepEqual(evictions, ['gemma4:e4b'], 'intruder evicted before our load');
    assert.equal(exec.inspect().loaded, 'qwen3:14b');
  });

  it('skips eviction when an intruder is co-resident-eligible (e.g. embed model)', async () => {
    const evictions: string[] = [];
    const exec = new LocalExecutor({
      evict: async (id) => { evictions.push(id); },
      probeResident: async () => ['bge-m3'],
      // Embed model — flagged as non-exclusive.
      isExclusive: (id) => id !== 'bge-m3',
    });

    await exec.withModel('qwen3:14b', async () => undefined);

    assert.deepEqual(evictions, [], 'co-resident utility must NOT be evicted');
  });

  it('does not double-evict our own tracked model when probe also returns it', async () => {
    const evictions: string[] = [];
    const exec = new LocalExecutor({
      evict: async (id) => { evictions.push(id); },
      probeResident: async () => ['qwen3:14b'],
      isExclusive: () => true,
    });

    // First load — no previous, no eviction.
    await exec.withModel('qwen3:14b', async () => undefined);
    // Second load same id — probe sees the same id we already track,
    // intruder filter must NOT count it as an intruder.
    await exec.withModel('qwen3:14b', async () => undefined);

    assert.deepEqual(evictions, [], 'same-id probe match is not an intruder');
  });

  it('survives a probeResident failure by treating residents as []', async () => {
    const exec = new LocalExecutor({
      evict: async () => undefined,
      probeResident: async () => { throw new Error('Ollama unreachable'); },
    });
    // Should not throw — probe failure is non-fatal.
    await exec.withModel('qwen3:14b', async () => undefined);
    assert.equal(exec.inspect().loaded, 'qwen3:14b');
  });
});
