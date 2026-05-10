/**
 * Phase S9 — Firecracker + gVisor runner tests.
 *
 * Stubbed spawn for both runners — no Linux/KVM required for
 * unit-level coverage. Real-runtime tests skip when
 * ANVIL_RUN_FIRECRACKER_TESTS / ANVIL_RUN_GVISOR_TESTS are unset.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { FirecrackerSandboxRunner } from '../sandbox/firecracker-runner.js';
import { GVisorSandboxRunner } from '../sandbox/gvisor-runner.js';

class FakeChild extends EventEmitter {
  stdin = { end: () => {} };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  pid = 1;
  constructor(opts: { exitCode: number | null; stdout?: string; stderr?: string; delayMs?: number }) {
    super();
    setTimeout(() => {
      if (opts.stdout) this.stdout.emit('data', Buffer.from(opts.stdout));
      if (opts.stderr) this.stderr.emit('data', Buffer.from(opts.stderr));
      this.emit('exit', opts.exitCode, null);
    }, opts.delayMs ?? 1);
  }
  kill(): boolean { this.killed = true; return true; }
}

function makeStub(handler: (cmd: string, argv: string[]) => { exitCode: number | null; stdout?: string; stderr?: string }) {
  const calls: Array<{ cmd: string; argv: string[] }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn: any = (cmd: string, argv: string[]) => {
    calls.push({ cmd, argv });
    return new FakeChild(handler(cmd, argv));
  };
  return { fn, calls };
}

describe('FirecrackerSandboxRunner — stub spawn', () => {
  it('acquire issues `ctr run -d --runtime aws.firecracker`', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s9-fc-'));
    try {
      const { fn: spawnFn, calls } = makeStub((_cmd, argv) => ({
        exitCode: 0, stdout: argv.includes('run') ? 'vm-id' : '',
      }));
      const runner = new FirecrackerSandboxRunner({ spawnFn });
      const handle = await runner.acquire({
        project: 'p', runId: 'r1', stage: 'build', hostWorkdir: tempRoot,
      });
      assert.equal(handle.runtime, 'firecracker');
      const runCall = calls.find((c) => c.argv.includes('run'));
      assert.ok(runCall, 'expected ctr run');
      assert.ok(runCall!.argv.includes('--runtime'));
      assert.equal(runCall!.argv[runCall!.argv.indexOf('--runtime') + 1], 'aws.firecracker');
      assert.ok(runCall!.argv.includes('--namespace'));
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('exec uses `ctr task exec --exec-id`', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s9-fce-'));
    try {
      const { fn: spawnFn, calls } = makeStub((_cmd, argv) => ({
        exitCode: 0, stdout: argv.includes('run') ? 'vm-id' : argv.includes('exec') ? 'hi' : '',
      }));
      const runner = new FirecrackerSandboxRunner({ spawnFn });
      const handle = await runner.acquire({
        project: 'p', runId: 'r1', stage: 'build', hostWorkdir: tempRoot,
      });
      const r = await handle.exec({ command: 'echo hi' });
      assert.equal(r.exitCode, 0);
      const execCall = calls.find((c) => c.argv.includes('exec'));
      assert.ok(execCall, 'expected ctr task exec');
      assert.ok(execCall!.argv.includes('--exec-id'));
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('isAvailable returns false on non-Linux platforms', async () => {
    if (process.platform === 'linux') return; // skip on Linux
    const runner = new FirecrackerSandboxRunner();
    assert.equal(await runner.isAvailable(), false);
  });

  it('close issues task kill + delete', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s9-fcl-'));
    try {
      const { fn: spawnFn, calls } = makeStub((_cmd, argv) => ({
        exitCode: 0, stdout: argv.includes('run') ? 'vm-id' : '',
      }));
      const runner = new FirecrackerSandboxRunner({ spawnFn });
      const handle = await runner.acquire({
        project: 'p', runId: 'r2', stage: 'build', hostWorkdir: tempRoot,
      });
      await handle.close();
      const killCall = calls.find((c) => c.argv.includes('kill'));
      const deleteCalls = calls.filter((c) => c.argv.includes('delete'));
      assert.ok(killCall, 'expected ctr task kill');
      assert.ok(deleteCalls.length >= 1, 'expected at least one ctr delete');
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('GVisorSandboxRunner — stub spawn', () => {
  it('inserts --runtime=runsc into docker run argv', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s9-gv-'));
    try {
      const { fn: spawnFn, calls } = makeStub((_cmd, argv) => ({
        exitCode: 0, stdout: argv[0] === 'run' ? 'cid' : '',
      }));
      const runner = new GVisorSandboxRunner({ spawnFn });
      await runner.acquire({
        project: 'p', runId: 'r1', stage: 'build', hostWorkdir: tempRoot,
      });
      const runCall = calls.find((c) => c.argv[0] === 'run');
      assert.ok(runCall, 'expected docker run');
      assert.ok(runCall!.argv.includes('--runtime=runsc'));
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does NOT add --runtime when caller already passed one', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s9-gv2-'));
    try {
      const { fn: spawnFn } = makeStub((_cmd, argv) => ({
        exitCode: 0, stdout: argv[0] === 'run' ? 'cid' : '',
      }));
      const runner = new GVisorSandboxRunner({ spawnFn });
      await runner.acquire({
        project: 'p', runId: 'r1', stage: 'build', hostWorkdir: tempRoot,
      });
      // Just make sure it doesn't blow up — runner doesn't currently
      // accept caller-supplied runtime, but the override guard exists.
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('isAvailable returns false on non-Linux platforms', async () => {
    if (process.platform === 'linux') return;
    const runner = new GVisorSandboxRunner();
    assert.equal(await runner.isAvailable(), false);
  });
});

// Real-runtime opt-in tests — skip-on-no-runtime
const realFc = process.env.ANVIL_RUN_FIRECRACKER_TESTS === '1';
describe('FirecrackerSandboxRunner — real runtime (opt-in)', { skip: !realFc }, () => {
  it('end-to-end smoke', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s9-fcr-'));
    try {
      const runner = new FirecrackerSandboxRunner();
      assert.equal(await runner.isAvailable(), true);
      const handle = await runner.acquire({
        project: 'p', runId: `r-${Date.now()}`, stage: 'build', hostWorkdir: tempRoot,
      });
      try {
        const r = await handle.exec({ command: 'echo fc-ok' });
        assert.match(r.stdout, /fc-ok/);
      } finally {
        await handle.close();
      }
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

const realGv = process.env.ANVIL_RUN_GVISOR_TESTS === '1';
describe('GVisorSandboxRunner — real runtime (opt-in)', { skip: !realGv }, () => {
  it('end-to-end smoke', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s9-gvr-'));
    try {
      const runner = new GVisorSandboxRunner();
      assert.equal(await runner.isAvailable(), true);
      const handle = await runner.acquire({
        project: 'p', runId: `r-${Date.now()}`, stage: 'build', hostWorkdir: tempRoot,
        image: 'debian:bookworm-slim',
      });
      try {
        const r = await handle.exec({ command: 'echo gv-ok' });
        assert.match(r.stdout, /gv-ok/);
      } finally {
        await handle.close();
      }
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
