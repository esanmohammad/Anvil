/**
 * Phase S7 — sandbox pool reuse + eviction tests.
 *
 * Stub runner — no Docker required. Verifies acquire reuse, idle TTL
 * eviction, hard cap blocking + eviction, sweep timing, key
 * partitioning by (project, image, fsMode, limits).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SandboxPool, poolKey } from '../sandbox/pool.js';
import type {
  AcquireSandboxOpts,
  SandboxHandle,
  SandboxRunner,
  SandboxRunnerListEntry,
} from '@esankhan3/anvil-core-pipeline/sandbox/types.js';

class StubHandle implements SandboxHandle {
  readonly runtime = 'docker' as const;
  readonly workdir = '/workspace';
  readonly limits = {};
  closed = false;
  constructor(readonly id: string) {}
  async exec(): Promise<never> { throw new Error('not used'); }
  async read(): Promise<string> { return ''; }
  async write(): Promise<void> {}
  async edit(): Promise<void> {}
  async syncToHost() {
    return { added: [], modified: [], removed: [], conflictResolution: 'merged' as const };
  }
  async snapshot() {
    return { contentHash: 'sha256:stub', sizeBytes: 0, fileCount: 0, capturedAt: new Date().toISOString() };
  }
  async close(): Promise<void> { this.closed = true; }
}

class StubRunner implements SandboxRunner {
  acquired: SandboxHandle[] = [];
  shutdownCalled = 0;
  async acquire(_opts: AcquireSandboxOpts): Promise<SandboxHandle> {
    void _opts;
    const h = new StubHandle(`stub-${this.acquired.length}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    this.acquired.push(h);
    return h;
  }
  async list(): Promise<readonly SandboxRunnerListEntry[]> { return []; }
  async sweep() { return { closed: 0 }; }
  async shutdown(): Promise<void> { this.shutdownCalled += 1; }
}

const baseOpts: AcquireSandboxOpts = {
  project: 'p', runId: 'r1', stage: 'build', hostWorkdir: '/tmp', image: 'i:1', fsMode: 'overlay',
};

describe('SandboxPool', () => {
  it('reuses an idle handle that matches the request key', async () => {
    const runner = new StubRunner();
    const pool = new SandboxPool(runner, { idleTtlMs: 60_000 });
    const a = await pool.acquire(baseOpts);
    await pool.release(a);
    const b = await pool.acquire(baseOpts);
    assert.equal(a, b, 'expected reuse');
    assert.equal(runner.acquired.length, 1);
  });

  it('partitions by image — same project + different image = no reuse', async () => {
    const runner = new StubRunner();
    const pool = new SandboxPool(runner, { idleTtlMs: 60_000 });
    const a = await pool.acquire({ ...baseOpts, image: 'i:1' });
    await pool.release(a);
    const b = await pool.acquire({ ...baseOpts, image: 'i:2' });
    assert.notEqual(a, b);
    assert.equal(runner.acquired.length, 2);
  });

  it('sweep evicts entries past idleTtlMs', async () => {
    const runner = new StubRunner();
    let now = 1000;
    const pool = new SandboxPool(runner, { idleTtlMs: 100, now: () => now });
    const a = await pool.acquire(baseOpts);
    await pool.release(a);
    now += 200;
    const r = await pool.sweep();
    assert.equal(r.closed, 1);
    assert.equal((a as StubHandle).closed, true);
  });

  it('does not evict busy handles even past TTL', async () => {
    const runner = new StubRunner();
    let now = 1000;
    const pool = new SandboxPool(runner, { idleTtlMs: 100, now: () => now });
    const a = await pool.acquire(baseOpts);
    now += 200;
    const r = await pool.sweep();
    assert.equal(r.closed, 0);
    assert.equal((a as StubHandle).closed, false);
  });

  it('honors maxIdle by evicting the oldest idle to make room', async () => {
    const runner = new StubRunner();
    const pool = new SandboxPool(runner, { idleTtlMs: 60_000, maxIdle: 1, maxTotal: 8 });
    const a = await pool.acquire({ ...baseOpts, image: 'i:1' });
    await pool.release(a);
    const b = await pool.acquire({ ...baseOpts, image: 'i:2' });
    assert.equal((a as StubHandle).closed, true, 'oldest idle should evict');
    void b;
  });

  it('honors maxTotal by waiting when every handle is busy', async () => {
    const runner = new StubRunner();
    const pool = new SandboxPool(runner, { idleTtlMs: 60_000, maxTotal: 2, acquireTimeoutMs: 50 });
    const a = await pool.acquire({ ...baseOpts, image: 'i:1' });
    const b = await pool.acquire({ ...baseOpts, image: 'i:2' });
    void a; void b;
    await assert.rejects(
      () => pool.acquire({ ...baseOpts, image: 'i:3' }),
      /sandbox pool acquire timed out/,
    );
  });

  it('release wakes waiters that timed-out-of-room', async () => {
    const runner = new StubRunner();
    const pool = new SandboxPool(runner, { maxTotal: 1, acquireTimeoutMs: 5000 });
    const a = await pool.acquire(baseOpts);
    let resolved = false;
    const pending = pool.acquire({ ...baseOpts, image: 'i:2' }).then((h) => { resolved = true; return h; });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(resolved, false);
    await pool.release(a);
    const b = await pending;
    assert.ok(b);
  });

  it('shutdown closes every handle and the underlying runner', async () => {
    const runner = new StubRunner();
    const pool = new SandboxPool(runner);
    const a = await pool.acquire(baseOpts);
    const b = await pool.acquire({ ...baseOpts, image: 'i:2' });
    await pool.shutdown();
    assert.equal((a as StubHandle).closed, true);
    assert.equal((b as StubHandle).closed, true);
    assert.equal(runner.shutdownCalled, 1);
  });
});

describe('poolKey', () => {
  it('partitions by project + image + fsMode + limits hash', () => {
    const k1 = poolKey({ ...baseOpts });
    const k2 = poolKey({ ...baseOpts, image: 'other' });
    const k3 = poolKey({ ...baseOpts, fsMode: 'bind' });
    const k4 = poolKey({ ...baseOpts, limits: { memoryMiB: 1024 } });
    const k5 = poolKey({ ...baseOpts });
    assert.equal(k1, k5);
    assert.notEqual(k1, k2);
    assert.notEqual(k1, k3);
    assert.notEqual(k1, k4);
  });

  it('does NOT partition by runId or stage', () => {
    const k1 = poolKey({ ...baseOpts, runId: 'r1', stage: 'build' });
    const k2 = poolKey({ ...baseOpts, runId: 'r2', stage: 'validate' });
    assert.equal(k1, k2);
  });
});
