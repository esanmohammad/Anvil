/**
 * Phase P1 — real overlay tmpfs upper layer tests.
 *
 * Two layers:
 *   1. Stub-spawn argv shape: verifies acquire passes the
 *      lower/upper/work triple + --device /dev/fuse + apparmor.
 *   2. State cleanup: handle.upperDir + handle.workDir are populated
 *      under sandbox-state/<runId>/.../{upper,work}, and close()
 *      removes the parent dir.
 *
 * Real-docker fixture (opt-in) lives in the existing
 * docker-runner.test.ts pattern; this file is pure stub-spawn.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { DockerSandboxRunner } from '../sandbox/docker-runner.js';

class FakeChild extends EventEmitter {
  stdin = { end: () => {} };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  pid = 1;
  constructor(opts: { exitCode: number | null; stdout?: string }) {
    super();
    setTimeout(() => {
      if (opts.stdout) this.stdout.emit('data', Buffer.from(opts.stdout));
      this.emit('exit', opts.exitCode, null);
    }, 1);
  }
  kill(): boolean { this.killed = true; return true; }
}

function makeStub(handler: (cmd: string, argv: string[]) => { exitCode: number | null; stdout?: string }) {
  const calls: Array<{ cmd: string; argv: string[] }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn: any = (cmd: string, argv: string[]) => {
    calls.push({ cmd, argv });
    return new FakeChild(handler(cmd, argv));
  };
  return { fn, calls };
}

describe('DockerSandboxRunner overlay mode — Phase P1', () => {
  it('overlay fsMode mounts the lower/upper/work triple + fuse device', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-p1-'));
    const stateRoot = path.join(tempRoot, 'sandbox-state');
    process.env.ANVIL_SANDBOX_STATE_ROOT = stateRoot;
    try {
      const { fn: spawnFn, calls } = makeStub((_cmd, argv) => ({
        exitCode: 0, stdout: argv[0] === 'run' ? 'cid' : '',
      }));
      const runner = new DockerSandboxRunner({ spawnFn });
      const handle = await runner.acquire({
        project: 'p', runId: 'r1', stage: 'build',
        hostWorkdir: tempRoot,
        fsMode: 'overlay',
      });
      const runCall = calls.find((c) => c.argv[0] === 'run');
      assert.ok(runCall, 'expected docker run');

      // Three mount triples present.
      const mountFlags = runCall!.argv
        .map((a, i) => (a === '--mount' ? runCall!.argv[i + 1] ?? '' : ''))
        .filter(Boolean);
      assert.ok(mountFlags.some((m) => m.includes('dst=/workspace.lower') && m.includes(',readonly')),
        'expected /workspace.lower readonly bind');
      assert.ok(mountFlags.some((m) => m.includes('dst=/workspace.upper') && !m.includes(',readonly')),
        'expected /workspace.upper writable bind');
      assert.ok(mountFlags.some((m) => m.includes('dst=/workspace.work')),
        'expected /workspace.work writable bind');

      // FUSE device + apparmor present.
      assert.ok(runCall!.argv.includes('--device'));
      assert.equal(runCall!.argv[runCall!.argv.indexOf('--device') + 1], '/dev/fuse');
      assert.ok(runCall!.argv.includes('--security-opt'));
      assert.equal(runCall!.argv[runCall!.argv.indexOf('--security-opt') + 1], 'apparmor=unconfined');

      // upperDir + workDir populated on the handle.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h = handle as any;
      assert.ok(h.upperDir);
      assert.ok(h.workDir);
      assert.ok(h.upperDir.startsWith(stateRoot));
      assert.ok(h.workDir.startsWith(stateRoot));
      assert.equal(await fsp.access(h.upperDir).then(() => true).catch(() => false), true);
      assert.equal(await fsp.access(h.workDir).then(() => true).catch(() => false), true);
    } finally {
      delete process.env.ANVIL_SANDBOX_STATE_ROOT;
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('bind fsMode falls back to single /workspace bind (no overlay flags)', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-p1-bind-'));
    try {
      const { fn: spawnFn, calls } = makeStub((_cmd, argv) => ({
        exitCode: 0, stdout: argv[0] === 'run' ? 'cid' : '',
      }));
      const runner = new DockerSandboxRunner({ spawnFn });
      await runner.acquire({
        project: 'p', runId: 'r2', stage: 'build',
        hostWorkdir: tempRoot,
        fsMode: 'bind',
      });
      const runCall = calls.find((c) => c.argv[0] === 'run');
      assert.ok(runCall);
      const mountFlags = runCall!.argv
        .map((a, i) => (a === '--mount' ? runCall!.argv[i + 1] ?? '' : ''))
        .filter(Boolean);
      assert.ok(!mountFlags.some((m) => m.includes('/workspace.lower')));
      assert.ok(!mountFlags.some((m) => m.includes('/workspace.upper')));
      assert.ok(mountFlags.some((m) => m.includes('dst=/workspace') && !m.includes('.lower')));
      assert.ok(!runCall!.argv.includes('/dev/fuse'));
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('ANVIL_SANDBOX_REAL_OVERLAY=0 disables the overlay triple even with fsMode=overlay', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-p1-disabled-'));
    process.env.ANVIL_SANDBOX_REAL_OVERLAY = '0';
    try {
      const { fn: spawnFn, calls } = makeStub((_cmd, argv) => ({
        exitCode: 0, stdout: argv[0] === 'run' ? 'cid' : '',
      }));
      const runner = new DockerSandboxRunner({ spawnFn });
      const handle = await runner.acquire({
        project: 'p', runId: 'r3', stage: 'build',
        hostWorkdir: tempRoot,
        fsMode: 'overlay',
      });
      const runCall = calls.find((c) => c.argv[0] === 'run');
      const mountFlags = runCall!.argv
        .map((a, i) => (a === '--mount' ? runCall!.argv[i + 1] ?? '' : ''))
        .filter(Boolean);
      assert.ok(!mountFlags.some((m) => m.includes('/workspace.lower')));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h = handle as any;
      assert.equal(h.upperDir, null);
    } finally {
      delete process.env.ANVIL_SANDBOX_REAL_OVERLAY;
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('close() removes the host-side upper/work parent', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-p1-close-'));
    process.env.ANVIL_SANDBOX_STATE_ROOT = path.join(tempRoot, 'sandbox-state');
    try {
      const { fn: spawnFn } = makeStub((_cmd, argv) => ({
        exitCode: 0, stdout: argv[0] === 'run' ? 'cid' : '',
      }));
      const runner = new DockerSandboxRunner({ spawnFn });
      const handle = await runner.acquire({
        project: 'p', runId: 'r4', stage: 'build',
        hostWorkdir: tempRoot,
        fsMode: 'overlay',
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const upperParent = path.dirname((handle as any).upperDir);
      assert.equal(await fsp.access(upperParent).then(() => true).catch(() => false), true);
      await handle.close();
      assert.equal(await fsp.access(upperParent).then(() => true).catch(() => false), false);
    } finally {
      delete process.env.ANVIL_SANDBOX_STATE_ROOT;
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('ANVIL_SANDBOX_KEEP_UPPER=1 preserves upper after close', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-p1-keep-'));
    process.env.ANVIL_SANDBOX_STATE_ROOT = path.join(tempRoot, 'sandbox-state');
    process.env.ANVIL_SANDBOX_KEEP_UPPER = '1';
    try {
      const { fn: spawnFn } = makeStub((_cmd, argv) => ({
        exitCode: 0, stdout: argv[0] === 'run' ? 'cid' : '',
      }));
      const runner = new DockerSandboxRunner({ spawnFn });
      const handle = await runner.acquire({
        project: 'p', runId: 'r5', stage: 'build',
        hostWorkdir: tempRoot,
        fsMode: 'overlay',
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const upperParent = path.dirname((handle as any).upperDir);
      await handle.close();
      assert.equal(await fsp.access(upperParent).then(() => true).catch(() => false), true);
    } finally {
      delete process.env.ANVIL_SANDBOX_STATE_ROOT;
      delete process.env.ANVIL_SANDBOX_KEEP_UPPER;
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
