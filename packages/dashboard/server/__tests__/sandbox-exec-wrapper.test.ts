/**
 * Phase P3 — sandbox exec wrapper installation tests.
 *
 * Verifies installSandboxExecWrapper bridges agent-core's slot to
 * core-pipeline's wrapSandboxExec correctly: state hash is computed
 * via buildHandleStateHasher, idempotency key folds in the hash,
 * and the recorded effect name matches the §I.1 spec.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  getSandboxExecWrapper,
  setSandboxExecWrapper,
} from '@esankhan3/anvil-agent-core';
import {
  installSandboxExecWrapper,
  __clearSandboxExecHashersForTests,
} from '../sandbox/install-exec-wrapper.js';

let tempRoot: string;

before(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-p3-'));
  await fsp.writeFile(path.join(tempRoot, 'state.txt'), 'baseline');
});

after(async () => {
  setSandboxExecWrapper(undefined);
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

describe('installSandboxExecWrapper', () => {
  it('registers a wrapper on the agent-core slot', () => {
    setSandboxExecWrapper(undefined);
    assert.equal(getSandboxExecWrapper(), undefined);
    installSandboxExecWrapper();
    const w = getSandboxExecWrapper();
    assert.ok(w);
    assert.equal(typeof w, 'function');
  });

  it('wrapper records via ctx.effect with state-hash-bound idempotency key', async () => {
    __clearSandboxExecHashersForTests();
    installSandboxExecWrapper();
    const wrapper = getSandboxExecWrapper();
    assert.ok(wrapper);

    interface Recorded { name: string; idempotencyKey: string }
    const recorded: Recorded[] = [];
    const stubCtx = {
      runId: 'r1',
      stage: 'build',
      effect: async (name: string, fn: () => Promise<unknown>, opts: { idempotencyKey: string }) => {
        const out = await fn();
        recorded.push({ name, idempotencyKey: opts.idempotencyKey });
        return out;
      },
    };
    const stubHandle = {
      id: 'h1',
      workdir: tempRoot,
      async exec() {
        return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 };
      },
    };

    const r = await wrapper!({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx: stubCtx as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handle: stubHandle as any,
      execArgs: { command: 'echo hi' },
      idx: 0,
      fn: () => stubHandle.exec(),
    });

    assert.equal(recorded.length, 1);
    assert.match(recorded[0]!.name, /^sandbox:exec:r1:build:0:/);
    assert.match(recorded[0]!.idempotencyKey, /^r1:build:exec:0:/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((r as any).stdout, 'ok');
  });

  it('same command + same workdir state = same idempotency key', async () => {
    __clearSandboxExecHashersForTests();
    installSandboxExecWrapper();
    const wrapper = getSandboxExecWrapper()!;
    const keys: string[] = [];
    const stubCtx = {
      runId: 'r2',
      stage: 'build',
      effect: async (_name: string, fn: () => Promise<unknown>, opts: { idempotencyKey: string }) => {
        keys.push(opts.idempotencyKey);
        return fn();
      },
    };
    const stubHandle = { id: 'h2', workdir: tempRoot, async exec() { return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 }; } };

    for (let i = 0; i < 2; i++) {
      await wrapper({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx: stubCtx as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handle: stubHandle as any,
        execArgs: { command: 'echo dup' },
        idx: 0,
        fn: () => stubHandle.exec(),
      });
    }
    assert.equal(keys[0], keys[1]);
  });

  it('different workdir state = different idempotency key', async () => {
    __clearSandboxExecHashersForTests();
    installSandboxExecWrapper();
    const wrapper = getSandboxExecWrapper()!;
    const keys: string[] = [];
    const stubCtx = {
      runId: 'r3',
      stage: 'build',
      effect: async (_name: string, fn: () => Promise<unknown>, opts: { idempotencyKey: string }) => {
        keys.push(opts.idempotencyKey);
        return fn();
      },
    };

    // First handle on tempRoot baseline.
    const handleA = { id: 'hA', workdir: tempRoot, async exec() { return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 }; } };
    await wrapper({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx: stubCtx as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handle: handleA as any,
      execArgs: { command: 'echo same' },
      idx: 0,
      fn: () => handleA.exec(),
    });

    // Change workdir state, fresh handle (different id forces fresh hasher).
    const tempRoot2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-p3-state2-'));
    try {
      await fsp.writeFile(path.join(tempRoot2, 'different.txt'), 'totally different content');
      const handleB = { id: 'hB', workdir: tempRoot2, async exec() { return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 }; } };
      await wrapper({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx: stubCtx as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handle: handleB as any,
        execArgs: { command: 'echo same' },
        idx: 0,
        fn: () => handleB.exec(),
      });
    } finally {
      await fsp.rm(tempRoot2, { recursive: true, force: true });
    }

    assert.notEqual(keys[0], keys[1]);
  });
});
