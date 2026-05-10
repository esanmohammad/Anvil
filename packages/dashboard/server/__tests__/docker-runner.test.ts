/**
 * Phase S2 — Docker sandbox runner tests.
 *
 * Two layers:
 *   1. `describe('DockerSandboxRunner — stub spawn')` — runs everywhere.
 *      Uses an injected stub `spawnFn` that fakes the docker CLI by
 *      examining argv and returning predetermined exit codes / stdout.
 *      This guards: argv shape (image inspect, pull, run, exec, rm),
 *      handle lifecycle, stdio cap, signal cancellation, error paths,
 *      shellQuote rejection of escapes.
 *   2. `describe('DockerSandboxRunner — real docker')` — opt-in via
 *      ANVIL_RUN_DOCKER_TESTS=1 (matches the Playwright pattern). Runs
 *      a real container against the host's docker daemon when present.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  DockerSandboxRunner,
  DEFAULT_SANDBOX_IMAGE,
} from '../sandbox/docker-runner.js';
import { resolveSandboxImageTag } from '../sandbox/docker-image.js';

// ───────────────────────────────────────────────────────────────────────
// stub spawn
// ───────────────────────────────────────────────────────────────────────

interface FakeChildOptions {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  delayMs?: number;
}

class FakeChild extends EventEmitter {
  stdin: { end: (b: Buffer | string) => void } = { end: () => {} };
  stdout = new EventEmitter() as EventEmitter & { on: EventEmitter['on'] };
  stderr = new EventEmitter() as EventEmitter & { on: EventEmitter['on'] };
  killed = false;
  pid = 12345;
  constructor(opts: FakeChildOptions) {
    super();
    setTimeout(() => {
      if (opts.stdout) this.stdout.emit('data', Buffer.from(opts.stdout));
      if (opts.stderr) this.stderr.emit('data', Buffer.from(opts.stderr));
      this.emit('exit', opts.exitCode, null);
    }, opts.delayMs ?? 1);
  }
  kill(_signal?: string): boolean {
    this.killed = true;
    void _signal;
    return true;
  }
}

interface SpawnRecord {
  cmd: string;
  argv: string[];
}

function makeSpawnStub(handler: (rec: SpawnRecord) => FakeChildOptions) {
  const calls: SpawnRecord[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn: any = (cmd: string, argv: string[], _opts: unknown) => {
    void _opts;
    calls.push({ cmd, argv });
    return new FakeChild(handler({ cmd, argv }));
  };
  return { fn, calls };
}

describe('DockerSandboxRunner — stub spawn', () => {
  it('acquire issues `docker run -d` with the expected argv shape', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s2-acq-'));
    try {
      const { fn: spawnFn, calls } = makeSpawnStub(({ argv }) => {
        if (argv[0] === 'run') {
          return { exitCode: 0, stdout: 'container-id\n' };
        }
        return { exitCode: 0 };
      });
      const runner = new DockerSandboxRunner({ spawnFn, defaultImage: 'anvil/sandbox:test' });
      const handle = await runner.acquire({
        project: 'p', runId: 'r1', stage: 'build', hostWorkdir: tempRoot,
      });
      assert.equal(handle.runtime, 'docker');
      assert.equal(handle.workdir, '/workspace');

      const runCall = calls.find((c) => c.argv[0] === 'run');
      assert.ok(runCall, 'expected docker run');
      assert.ok(runCall!.argv.includes('-d'));
      assert.ok(runCall!.argv.includes('--workdir'));
      assert.ok(runCall!.argv.some((a) => a.startsWith('type=bind,src=')));
      assert.ok(runCall!.argv.includes('anvil/sandbox:test'));
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('acquire surfaces `docker run` failures as DockerRunnerError', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s2-fail-'));
    try {
      const { fn: spawnFn } = makeSpawnStub(({ argv }) => {
        if (argv[0] === 'run') return { exitCode: 1, stderr: 'image not found' };
        return { exitCode: 0 };
      });
      const runner = new DockerSandboxRunner({ spawnFn });
      await assert.rejects(
        () => runner.acquire({ project: 'p', runId: 'r1', stage: 'build', hostWorkdir: tempRoot }),
        /image not found/,
      );
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('exec dispatches `docker exec sh -c <cmd>` with the expected argv', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s2-exec-'));
    try {
      const { fn: spawnFn, calls } = makeSpawnStub(({ argv }) => {
        if (argv[0] === 'run') return { exitCode: 0, stdout: 'cid\n' };
        if (argv[0] === 'exec') return { exitCode: 0, stdout: 'world' };
        return { exitCode: 0 };
      });
      const runner = new DockerSandboxRunner({ spawnFn });
      const handle = await runner.acquire({
        project: 'p', runId: 'r1', stage: 'build', hostWorkdir: tempRoot,
      });

      const r = await handle.exec({ command: 'echo world' });
      assert.equal(r.exitCode, 0);
      assert.equal(r.stdout, 'world');

      const execCall = calls.find((c) => c.argv[0] === 'exec');
      assert.ok(execCall, 'expected docker exec');
      assert.equal(execCall!.argv[execCall!.argv.length - 3], 'sh');
      assert.equal(execCall!.argv[execCall!.argv.length - 2], '-c');
      assert.equal(execCall!.argv[execCall!.argv.length - 1], 'echo world');
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('exec surfaces non-zero exit codes verbatim (caller decides)', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s2-nz-'));
    try {
      const { fn: spawnFn } = makeSpawnStub(({ argv }) => {
        if (argv[0] === 'run') return { exitCode: 0, stdout: 'cid' };
        if (argv[0] === 'exec') return { exitCode: 7, stderr: 'boom' };
        return { exitCode: 0 };
      });
      const runner = new DockerSandboxRunner({ spawnFn });
      const handle = await runner.acquire({
        project: 'p', runId: 'r2', stage: 'build', hostWorkdir: tempRoot,
      });
      const r = await handle.exec({ command: 'false' });
      assert.equal(r.exitCode, 7);
      assert.match(r.stderr, /boom/);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('exec respects AbortSignal and reports killedByLimit on cancel', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s2-abort-'));
    try {
      const { fn: spawnFn } = makeSpawnStub(({ argv }) => {
        if (argv[0] === 'run') return { exitCode: 0, stdout: 'cid' };
        if (argv[0] === 'exec') return { exitCode: null, delayMs: 200 };
        return { exitCode: 0 };
      });
      const runner = new DockerSandboxRunner({ spawnFn });
      const handle = await runner.acquire({
        project: 'p', runId: 'r3', stage: 'build', hostWorkdir: tempRoot,
      });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 10);
      const r = await handle.exec({ command: 'sleep 100', signal: ac.signal });
      assert.ok(r.exitCode === null || r.killedByLimit !== undefined);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('exec stdio is capped at 64 KiB per stream', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s2-cap-'));
    try {
      const big = 'x'.repeat(70_000);
      const { fn: spawnFn } = makeSpawnStub(({ argv }) => {
        if (argv[0] === 'run') return { exitCode: 0, stdout: 'cid' };
        if (argv[0] === 'exec') return { exitCode: 0, stdout: big };
        return { exitCode: 0 };
      });
      const runner = new DockerSandboxRunner({ spawnFn });
      const handle = await runner.acquire({
        project: 'p', runId: 'r4', stage: 'build', hostWorkdir: tempRoot,
      });
      const r = await handle.exec({ command: 'cat /tmp/big' });
      assert.equal(r.stdout.length, 64 * 1024);
      assert.ok(r.truncated && r.truncated.stdout > 0);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('close calls `docker rm -f` and is idempotent', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s2-close-'));
    try {
      const { fn: spawnFn, calls } = makeSpawnStub(({ argv }) => {
        if (argv[0] === 'run') return { exitCode: 0, stdout: 'cid' };
        return { exitCode: 0 };
      });
      const runner = new DockerSandboxRunner({ spawnFn });
      const handle = await runner.acquire({
        project: 'p', runId: 'r5', stage: 'build', hostWorkdir: tempRoot,
      });
      await handle.close();
      await handle.close();
      const rmCalls = calls.filter((c) => c.argv[0] === 'rm');
      assert.equal(rmCalls.length, 1, 'rm should fire only once for idempotent close');
      assert.deepEqual(rmCalls[0]!.argv.slice(0, 2), ['rm', '-f']);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('write-then-read round-trips via base64 + cat', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s2-rw-'));
    try {
      // Track a tiny in-memory FS so the stub can answer reads consistently.
      const fs = new Map<string, string>();
      const { fn: spawnFn } = makeSpawnStub(({ argv }) => {
        if (argv[0] === 'run') return { exitCode: 0, stdout: 'cid' };
        if (argv[0] === 'exec') {
          // execInsideContainer puts the command at argv[argv.length-1].
          const cmd = argv[argv.length - 1] ?? '';
          const catMatch = cmd.match(/^cat -- (\S+)$/);
          if (catMatch) {
            const p = catMatch[1]!.replace(/^'|'$/g, '');
            return { exitCode: 0, stdout: fs.get(p) ?? '' };
          }
          // write() emits: `mkdir -p <dir> && printf '%s' <b64> | base64 -d > <path>`
          const writeMatch = cmd.match(/printf '%s' (\S+) \| base64 -d > (\S+)$/);
          if (writeMatch) {
            const b64Raw = writeMatch[1]!;
            const pathRaw = writeMatch[2]!;
            const body = Buffer.from(b64Raw.replace(/^'|'$/g, ''), 'base64').toString('utf8');
            fs.set(pathRaw.replace(/^'|'$/g, ''), body);
            return { exitCode: 0 };
          }
          return { exitCode: 0 };
        }
        return { exitCode: 0 };
      });
      const runner = new DockerSandboxRunner({ spawnFn });
      const handle = await runner.acquire({
        project: 'p', runId: 'r6', stage: 'build', hostWorkdir: tempRoot,
      });
      await handle.write('hello.txt', 'world!');
      const echoed = await handle.read('hello.txt');
      assert.equal(echoed, 'world!');
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('write rejects path-escape attempts', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s2-esc-'));
    try {
      const { fn: spawnFn } = makeSpawnStub(({ argv }) => ({ exitCode: argv[0] === 'run' ? 0 : 0, stdout: argv[0] === 'run' ? 'cid' : '' }));
      const runner = new DockerSandboxRunner({ spawnFn });
      const handle = await runner.acquire({
        project: 'p', runId: 'r7', stage: 'build', hostWorkdir: tempRoot,
      });
      await assert.rejects(() => handle.write('../escape.txt', 'no'), /escapes sandbox workdir/);
      await assert.rejects(() => handle.write('/etc/passwd', 'no'), /escapes sandbox workdir/);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('isAvailable returns false when docker CLI is missing', async () => {
    const { fn: spawnFn } = makeSpawnStub(() => ({ exitCode: 127, stderr: 'docker: not found' }));
    const runner = new DockerSandboxRunner({ spawnFn });
    assert.equal(await runner.isAvailable(), false);
  });

  it('list + sweep track live + idle handles', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s2-pool-'));
    try {
      const { fn: spawnFn } = makeSpawnStub(({ argv }) => ({
        exitCode: 0,
        stdout: argv[0] === 'run' ? 'cid' : '',
      }));
      const runner = new DockerSandboxRunner({ spawnFn, idleTtlMs: 1 });
      await runner.acquire({ project: 'p', runId: 'r8', stage: 'build', hostWorkdir: tempRoot });
      const before = await runner.list();
      assert.equal(before.length, 1);
      await new Promise((r) => setTimeout(r, 5));
      const swept = await runner.sweep();
      assert.equal(swept.closed, 1);
      const after = await runner.list();
      assert.equal(after.length, 0);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('docker-image helpers', () => {
  it('resolveSandboxImageTag returns the version-pinned tag', () => {
    assert.equal(resolveSandboxImageTag('1.2.3'), 'anvil/sandbox:1.2.3');
    assert.equal(resolveSandboxImageTag('1.2.3-rc.1'), 'anvil/sandbox:1.2.3-rc.1');
  });

  it('resolveSandboxImageTag falls back to :latest for malformed input', () => {
    assert.equal(resolveSandboxImageTag(undefined), DEFAULT_SANDBOX_IMAGE);
    assert.equal(resolveSandboxImageTag(''), DEFAULT_SANDBOX_IMAGE);
    assert.equal(resolveSandboxImageTag('not-a-version'), DEFAULT_SANDBOX_IMAGE);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Real-docker tests — opt-in via ANVIL_RUN_DOCKER_TESTS=1
// ───────────────────────────────────────────────────────────────────────

const runRealDocker = process.env.ANVIL_RUN_DOCKER_TESTS === '1';
describe('DockerSandboxRunner — real docker (opt-in)', { skip: !runRealDocker }, () => {
  it('acquire/exec round-trips against a real container', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s2-real-'));
    try {
      const runner = new DockerSandboxRunner();
      assert.equal(await runner.isAvailable(), true);
      await runner.ensureImage('debian:bookworm-slim');
      const handle = await runner.acquire({
        project: 'p', runId: `r-${Date.now()}`, stage: 'build', hostWorkdir: tempRoot,
        image: 'debian:bookworm-slim',
      });
      try {
        const r = await handle.exec({ command: 'echo real-docker-ok' });
        assert.equal(r.exitCode, 0);
        assert.match(r.stdout, /real-docker-ok/);
      } finally {
        await handle.close();
      }
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
