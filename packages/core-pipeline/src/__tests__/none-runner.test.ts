/**
 * Phase S1 — `none` runtime tests.
 *
 * Covers acquire/exec/read/write/edit/syncToHost/snapshot/close on the
 * passthrough runner, plus the runner-registry's factory + override
 * semantics.
 *
 * `none` is the default runtime until S12 — these tests guarantee
 * existing harness code keeps working when stages start routing
 * through `acquire(...)` instead of spawning directly.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  NoneSandboxRunner,
  __resetSandboxRegistryForTests,
  getSandboxRunner,
  isSandboxRunnerRegistered,
  registerSandboxRunner,
} from '../sandbox/index.js';

let tempRoot: string;

before(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-sandbox-s1-'));
});

after(async () => {
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

describe('NoneSandboxRunner — Phase S1', () => {
  it('acquire/exec produces a SandboxExecResult with stdout + exit code', async () => {
    const runner = new NoneSandboxRunner();
    const handle = await runner.acquire({
      project: 'test', runId: 'r1', stage: 'validate', hostWorkdir: tempRoot,
    });
    assert.equal(handle.runtime, 'none');
    assert.equal(handle.workdir, tempRoot);

    const r = await handle.exec({ command: 'echo hello-from-none' });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /hello-from-none/);
    assert.ok(r.durationMs >= 0);
    await runner.shutdown();
  });

  it('exec respects the AbortSignal for cancellation', async () => {
    const runner = new NoneSandboxRunner();
    const handle = await runner.acquire({
      project: 'test', runId: 'r2', stage: 'validate', hostWorkdir: tempRoot,
    });
    const ac = new AbortController();
    const promise = handle.exec({ command: 'sleep 5', signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    const r = await promise;
    // killed before natural exit; exitCode null OR signal-killed
    assert.ok(r.exitCode !== 0 || r.killedByLimit !== undefined);
    await runner.shutdown();
  });

  it('exec enforces timeout via SandboxLimits.timeoutSeconds', async () => {
    const runner = new NoneSandboxRunner();
    const handle = await runner.acquire({
      project: 'test', runId: 'r3', stage: 'validate', hostWorkdir: tempRoot,
      limits: { timeoutSeconds: 1 },
    });
    const r = await handle.exec({ command: 'sleep 5' });
    assert.equal(r.killedByLimit, 'timeout');
    await runner.shutdown();
  });

  it('write + read round-trip works against the host filesystem', async () => {
    const runner = new NoneSandboxRunner();
    const handle = await runner.acquire({
      project: 'test', runId: 'r4', stage: 'build', hostWorkdir: tempRoot,
    });
    await handle.write('subdir/hello.txt', 'world');
    const read = await handle.read('subdir/hello.txt');
    assert.equal(read, 'world');
    await runner.shutdown();
  });

  it('edit replaces a unique oldString', async () => {
    const runner = new NoneSandboxRunner();
    const handle = await runner.acquire({
      project: 'test', runId: 'r5', stage: 'build', hostWorkdir: tempRoot,
    });
    await handle.write('edit.txt', 'foo bar baz');
    await handle.edit('edit.txt', 'bar', 'qux');
    const after = await handle.read('edit.txt');
    assert.equal(after, 'foo qux baz');
    await runner.shutdown();
  });

  it('edit refuses non-unique oldString unless replaceAll is true', async () => {
    const runner = new NoneSandboxRunner();
    const handle = await runner.acquire({
      project: 'test', runId: 'r6', stage: 'build', hostWorkdir: tempRoot,
    });
    await handle.write('dup.txt', 'aa aa aa');
    await assert.rejects(() => handle.edit('dup.txt', 'aa', 'XX'));
    await handle.edit('dup.txt', 'aa', 'XX', true);
    assert.equal(await handle.read('dup.txt'), 'XX XX XX');
    await runner.shutdown();
  });

  it('write/read refuse path-escape attempts', async () => {
    const runner = new NoneSandboxRunner();
    const handle = await runner.acquire({
      project: 'test', runId: 'r7', stage: 'build', hostWorkdir: tempRoot,
    });
    await assert.rejects(() => handle.read('../etc/passwd'));
    await assert.rejects(() => handle.write('../escape.txt', 'no'));
    await runner.shutdown();
  });

  it('syncToHost is a no-op for the `none` runner', async () => {
    const runner = new NoneSandboxRunner();
    const handle = await runner.acquire({
      project: 'test', runId: 'r8', stage: 'build', hostWorkdir: tempRoot,
    });
    const r = await handle.syncToHost();
    assert.equal(r.added.length, 0);
    assert.equal(r.modified.length, 0);
    assert.equal(r.removed.length, 0);
    assert.equal(r.conflictResolution, 'merged');
    await runner.shutdown();
  });

  it('snapshot returns deterministic placeholder + counts files', async () => {
    const runner = new NoneSandboxRunner();
    const handle = await runner.acquire({
      project: 'test', runId: 'r9', stage: 'build', hostWorkdir: tempRoot,
    });
    await handle.write('count1.txt', 'a');
    await handle.write('count2.txt', 'bb');
    const snap = await handle.snapshot();
    assert.match(snap.contentHash, /^sha256:/);
    assert.ok(snap.fileCount >= 2);
    assert.ok(snap.sizeBytes >= 3);
    await runner.shutdown();
  });

  it('list/sweep tracks live + idle handles', async () => {
    const runner = new NoneSandboxRunner({ idleTtlMs: 1 });
    const handle = await runner.acquire({
      project: 'test', runId: 'r10', stage: 'build', hostWorkdir: tempRoot,
    });
    let entries = await runner.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.runtime, 'none');
    assert.equal(entries[0]?.busy, false);

    // Wait long enough for the sweep TTL to fire.
    await new Promise((res) => setTimeout(res, 5));
    const swept = await runner.sweep();
    assert.equal(swept.closed, 1);
    entries = await runner.list();
    assert.equal(entries.length, 0);
    void handle;
  });

  it('close is idempotent', async () => {
    const runner = new NoneSandboxRunner();
    const handle = await runner.acquire({
      project: 'test', runId: 'r11', stage: 'build', hostWorkdir: tempRoot,
    });
    await handle.close();
    await handle.close();
    await runner.shutdown();
  });
});

describe('runner-registry — Phase S1', () => {
  it('the `none` runtime is auto-registered', () => {
    __resetSandboxRegistryForTests();
    assert.equal(isSandboxRunnerRegistered('none'), true);
    const runner = getSandboxRunner('none');
    assert.ok(runner);
  });

  it('throws an actionable error for an unregistered runtime', () => {
    __resetSandboxRegistryForTests();
    assert.equal(isSandboxRunnerRegistered('docker'), false);
    assert.throws(() => getSandboxRunner('docker'), /not registered/);
  });

  it('registerSandboxRunner installs a factory + caches the instance', () => {
    __resetSandboxRegistryForTests();
    let calls = 0;
    registerSandboxRunner('docker', () => {
      calls += 1;
      return new NoneSandboxRunner(); // stand-in
    });
    const a = getSandboxRunner('docker');
    const b = getSandboxRunner('docker');
    assert.equal(a, b); // singleton
    assert.equal(calls, 1);
  });

  it('re-registering replaces the prior factory + drops the cache', () => {
    __resetSandboxRegistryForTests();
    registerSandboxRunner('docker', () => new NoneSandboxRunner());
    const first = getSandboxRunner('docker');
    registerSandboxRunner('docker', () => new NoneSandboxRunner());
    const second = getSandboxRunner('docker');
    assert.notEqual(first, second);
  });
});
