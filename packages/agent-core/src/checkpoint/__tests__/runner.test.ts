/**
 * Tests for runWithCheckpoint — verifies cache-miss → fresh run, cache-hit
 * → skip, and SIGTERM → interrupted transition.
 *
 * We avoid actually sending signals to the test process by passing a
 * `__signalHook` into the wrapper options. The hook captures the handler
 * the wrapper registers, and the test invokes it directly to simulate a
 * SIGTERM. This matches real signal semantics (handler is called with the
 * signal name) without polluting global `process` listeners.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BlobStore } from '../blob-store.js';
import { CheckpointStore } from '../store.js';
import { runWithCheckpoint } from '../runner.js';
import { computeKey } from '../key.js';
import type { CheckpointInputs } from '../types.js';

interface Payload { greeting: string }

function makeInputs(payload: unknown, over: Partial<CheckpointInputs> = {}): CheckpointInputs & { inputs: unknown } {
  return {
    stage: 'plan',
    taskId: 'plan:root',
    promptVersion: 'v1',
    model: 'claude',
    inputs: payload,
    ...over,
  };
}

function makeSignalHook(): {
  on: (sig: NodeJS.Signals, fn: (s: NodeJS.Signals) => void) => void;
  off: (sig: NodeJS.Signals, fn: (s: NodeJS.Signals) => void) => void;
  fire: (sig: NodeJS.Signals) => void;
  handlerCount: () => number;
} {
  const handlers: Array<{ sig: NodeJS.Signals; fn: (s: NodeJS.Signals) => void }> = [];
  return {
    on(sig, fn) { handlers.push({ sig, fn }); },
    off(sig, fn) {
      const idx = handlers.findIndex((h) => h.sig === sig && h.fn === fn);
      if (idx >= 0) handlers.splice(idx, 1);
    },
    fire(sig) {
      for (const h of [...handlers]) {
        if (h.sig === sig) h.fn(sig);
      }
    },
    handlerCount: () => handlers.length,
  };
}

describe('runWithCheckpoint', () => {
  let home: string;
  let blobs: BlobStore;
  let store: CheckpointStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'anvil-wrapper-'));
    blobs = new BlobStore(home);
    store = new CheckpointStore({ anvilHome: home, blobStore: blobs });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('cache miss: runs the agent, persists output, returns it', async () => {
    let ran = 0;
    const onMiss = (): void => { /* no-op */ };
    const result = await runWithCheckpoint<unknown, Payload>(store, blobs, {
      project: 'demo',
      runFamily: 'run-1',
      inputs: makeInputs({ feature: 'x' }),
      run: async () => { ran += 1; return { greeting: 'hi' }; },
      serialize: (o) => JSON.stringify(o),
      deserialize: (b) => JSON.parse(b.toString('utf-8')) as Payload,
      onMiss,
    });
    assert.equal(ran, 1);
    assert.deepEqual(result, { greeting: 'hi' });

    const key = computeKey('run-1', makeInputs({ feature: 'x' }));
    const record = store.get('demo', 'run-1', key);
    assert.ok(record);
    assert.equal(record!.status, 'completed');
  });

  it('cache hit: skips the agent and returns deserialized output', async () => {
    const inputs = makeInputs({ feature: 'x' });
    let runs = 0;
    const runFn = async (): Promise<Payload> => { runs += 1; return { greeting: 'hi' }; };

    // First call: miss.
    await runWithCheckpoint<unknown, Payload>(store, blobs, {
      project: 'demo',
      runFamily: 'run-1',
      inputs,
      run: runFn,
      serialize: (o) => JSON.stringify(o),
      deserialize: (b) => JSON.parse(b.toString('utf-8')) as Payload,
    });

    // Second call: hit — run should NOT be invoked.
    let hitFired = false;
    const result = await runWithCheckpoint<unknown, Payload>(store, blobs, {
      project: 'demo',
      runFamily: 'run-1',
      inputs,
      run: runFn,
      serialize: (o) => JSON.stringify(o),
      deserialize: (b) => JSON.parse(b.toString('utf-8')) as Payload,
      onHit: () => { hitFired = true; },
    });
    assert.equal(runs, 1, 'run() must not fire on cache hit');
    assert.equal(hitFired, true);
    assert.deepEqual(result, { greeting: 'hi' });
  });

  it('drifted inputs → different hash → cache miss', async () => {
    let runs = 0;
    const runFn = async (): Promise<Payload> => { runs += 1; return { greeting: 'hi' }; };
    await runWithCheckpoint<unknown, Payload>(store, blobs, {
      project: 'demo', runFamily: 'run-1', inputs: makeInputs({ feature: 'x' }),
      run: runFn, serialize: (o) => JSON.stringify(o), deserialize: (b) => JSON.parse(b.toString('utf-8')) as Payload,
    });
    await runWithCheckpoint<unknown, Payload>(store, blobs, {
      project: 'demo', runFamily: 'run-1', inputs: makeInputs({ feature: 'y' }),
      run: runFn, serialize: (o) => JSON.stringify(o), deserialize: (b) => JSON.parse(b.toString('utf-8')) as Payload,
    });
    assert.equal(runs, 2);
  });

  it('SIGTERM during run → record transitions to interrupted', async () => {
    const hook = makeSignalHook();
    let onInterruptCalled: NodeJS.Signals | null = null;

    // Agent that waits a tick — gives us time to fire the signal.
    const slowRun = (): Promise<Payload> => new Promise((resolve) => {
      setTimeout(() => resolve({ greeting: 'late' }), 20);
    });

    const promise = runWithCheckpoint<unknown, Payload>(store, blobs, {
      project: 'demo',
      runFamily: 'run-1',
      inputs: makeInputs({ feature: 'slow' }),
      run: slowRun,
      serialize: (o) => JSON.stringify(o),
      deserialize: (b) => JSON.parse(b.toString('utf-8')) as Payload,
      onInterrupt: (sig) => { onInterruptCalled = sig; },
      __signalHook: hook,
    });

    // Fire SIGTERM while the run is in-flight.
    await new Promise((r) => setTimeout(r, 5));
    hook.fire('SIGTERM');

    await promise;

    assert.equal(onInterruptCalled, 'SIGTERM');
    const key = computeKey('run-1', makeInputs({ feature: 'slow' }));
    const record = store.get('demo', 'run-1', key);
    assert.ok(record);
    assert.equal(record!.status, 'interrupted');
    assert.match(record!.errorMessage ?? '', /SIGTERM/);

    // All handlers must be removed in finally.
    assert.equal(hook.handlerCount(), 0, 'signal handlers must be cleaned up');
  });

  it('agent throws → record transitions to failed and error is rethrown', async () => {
    await assert.rejects(
      runWithCheckpoint<unknown, Payload>(store, blobs, {
        project: 'demo',
        runFamily: 'run-1',
        inputs: makeInputs({ feature: 'bad' }),
        run: async () => { throw new Error('agent exploded'); },
        serialize: (o) => JSON.stringify(o),
        deserialize: (b) => JSON.parse(b.toString('utf-8')) as Payload,
      }),
      /agent exploded/,
    );

    const key = computeKey('run-1', makeInputs({ feature: 'bad' }));
    const record = store.get('demo', 'run-1', key);
    assert.ok(record);
    assert.equal(record!.status, 'failed');
    assert.match(record!.errorMessage ?? '', /agent exploded/);
  });

  it('signal handlers are cleaned up after a successful run', async () => {
    const hook = makeSignalHook();
    await runWithCheckpoint<unknown, Payload>(store, blobs, {
      project: 'demo',
      runFamily: 'run-1',
      inputs: makeInputs({ feature: 'ok' }),
      run: async () => ({ greeting: 'hi' }),
      serialize: (o) => JSON.stringify(o),
      deserialize: (b) => JSON.parse(b.toString('utf-8')) as Payload,
      __signalHook: hook,
    });
    assert.equal(hook.handlerCount(), 0);
  });

  it('concurrent wrappers do not cross-contaminate signal handlers', async () => {
    const hook = makeSignalHook();
    const p1 = runWithCheckpoint<unknown, Payload>(store, blobs, {
      project: 'demo', runFamily: 'run-1', inputs: makeInputs({ n: 1 }),
      run: () => new Promise((r) => setTimeout(() => r({ greeting: '1' }), 20)),
      serialize: (o) => JSON.stringify(o),
      deserialize: (b) => JSON.parse(b.toString('utf-8')) as Payload,
      __signalHook: hook,
    });
    const p2 = runWithCheckpoint<unknown, Payload>(store, blobs, {
      project: 'demo', runFamily: 'run-1', inputs: makeInputs({ n: 2 }),
      run: () => new Promise((r) => setTimeout(() => r({ greeting: '2' }), 20)),
      serialize: (o) => JSON.stringify(o),
      deserialize: (b) => JSON.parse(b.toString('utf-8')) as Payload,
      __signalHook: hook,
    });
    // Both wrappers install their own SIGTERM + SIGINT handlers → 4 total.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(hook.handlerCount(), 4);
    await Promise.all([p1, p2]);
    assert.equal(hook.handlerCount(), 0);
  });
});
