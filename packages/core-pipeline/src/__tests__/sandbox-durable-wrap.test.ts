/**
 * Phase S6 — durable wrapping + state-hash tests.
 *
 * Two areas:
 *   1. State-hash determinism: hashWorkdir produces stable digests
 *      across re-runs; skip-globs honored; stat-cache hits.
 *   2. Durable wrappers: when a stub StepContext.effect is supplied,
 *      the wrappers call through with stable idempotency keys; same
 *      command + same state hash = same key; different state hash =
 *      different key.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  StatHashCache,
  hashWorkdir,
  wrapSandboxExec,
  wrapSandboxAcquire,
  wrapSandboxWrite,
  wrapSandboxEdit,
  sandboxEffectName,
} from '../sandbox/index.js';

let tempRoot: string;

before(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s6-'));
});

after(async () => {
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

describe('hashWorkdir', () => {
  it('produces stable digests across repeated runs', async () => {
    const dir = path.join(tempRoot, 'stable');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'a.txt'), 'alpha');
    await fsp.writeFile(path.join(dir, 'b.txt'), 'beta');
    const h1 = await hashWorkdir(dir);
    const h2 = await hashWorkdir(dir);
    assert.equal(h1.contentHash, h2.contentHash);
    assert.equal(h1.fileCount, 2);
    assert.match(h1.contentHash, /^sha256:[a-f0-9]{64}$/);
  });

  it('changes when a file content changes', async () => {
    const dir = path.join(tempRoot, 'change');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'f.txt'), 'one');
    const before = await hashWorkdir(dir);
    await fsp.writeFile(path.join(dir, 'f.txt'), 'two');
    const after = await hashWorkdir(dir);
    assert.notEqual(before.contentHash, after.contentHash);
  });

  it('honors skip-globs (node_modules / .git / dist)', async () => {
    const dir = path.join(tempRoot, 'skip');
    await fsp.mkdir(path.join(dir, 'node_modules', 'foo'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'node_modules', 'foo', 'big.js'), 'x'.repeat(1000));
    await fsp.writeFile(path.join(dir, 'real.txt'), 'a');
    const h = await hashWorkdir(dir);
    // Only `real.txt` should be counted.
    assert.equal(h.fileCount, 1);
  });

  it('shares results via the stat cache', async () => {
    const dir = path.join(tempRoot, 'cache');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'a.txt'), 'a');
    await fsp.writeFile(path.join(dir, 'b.txt'), 'b');
    const cache = new StatHashCache();
    const first = await hashWorkdir(dir, { statCache: cache });
    const second = await hashWorkdir(dir, { statCache: cache });
    assert.equal(first.contentHash, second.contentHash);
    assert.equal(second.cacheHits, 2);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Durable wrappers — stubbed StepContext
// ───────────────────────────────────────────────────────────────────────

interface RecordedEffect {
  name: string;
  idempotencyKey: string;
  result: unknown;
}

function makeStubCtx(): { ctx: { effect: (name: string, fn: () => Promise<unknown>, opts: { idempotencyKey: string }) => Promise<unknown> }; recorded: RecordedEffect[] } {
  const recorded: RecordedEffect[] = [];
  const ctx = {
    async effect(name: string, fn: () => Promise<unknown>, opts: { idempotencyKey: string }): Promise<unknown> {
      const result = await fn();
      recorded.push({ name, idempotencyKey: opts.idempotencyKey, result });
      return result;
    },
  };
  return { ctx, recorded };
}

describe('durable-wrap — sandboxEffectName', () => {
  it('formats consistent stage-prefixed effect names', () => {
    assert.equal(sandboxEffectName('exec', 'r1', 'build'), 'sandbox:exec:r1:build');
    assert.equal(sandboxEffectName('exec', 'r1', 'build', '0:abc'), 'sandbox:exec:r1:build:0:abc');
  });
});

describe('durable-wrap — wrapSandboxExec', () => {
  it('falls through to fn() when ctx is undefined', async () => {
    const r = await wrapSandboxExec(
      undefined,
      { runId: 'r1', stage: 'build', idx: 0 },
      { command: 'echo' },
      async () => ({ exitCode: 0, stdout: 'x', stderr: '', durationMs: 1 }),
    );
    assert.equal(r.stdout, 'x');
  });

  it('records via ctx.effect when provided', async () => {
    const { ctx, recorded } = makeStubCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wrapSandboxExec(ctx as any, { runId: 'r1', stage: 'build', idx: 0 },
      { command: 'echo hi' },
      async () => ({ exitCode: 0, stdout: 'hi', stderr: '', durationMs: 1 }),
    );
    assert.equal(recorded.length, 1);
    assert.match(recorded[0]!.name, /^sandbox:exec:r1:build:0:/);
    assert.match(recorded[0]!.idempotencyKey, /^r1:build:exec:0:/);
  });

  it('produces the same idempotency key for the same command + state', async () => {
    const { ctx, recorded } = makeStubCtx();
    const exec = { command: 'echo same' };
    const stateHash = async () => 'state-h-1';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wrapSandboxExec(ctx as any, { runId: 'r1', stage: 'build', idx: 0, sandboxStateHash: stateHash },
      exec, async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wrapSandboxExec(ctx as any, { runId: 'r1', stage: 'build', idx: 0, sandboxStateHash: stateHash },
      exec, async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0 }));
    assert.equal(recorded[0]!.idempotencyKey, recorded[1]!.idempotencyKey);
  });

  it('produces different idempotency keys when state hash changes', async () => {
    const { ctx, recorded } = makeStubCtx();
    const exec = { command: 'echo same' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wrapSandboxExec(ctx as any, { runId: 'r1', stage: 'build', idx: 0, sandboxStateHash: async () => 'A' },
      exec, async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wrapSandboxExec(ctx as any, { runId: 'r1', stage: 'build', idx: 0, sandboxStateHash: async () => 'B' },
      exec, async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0 }));
    assert.notEqual(recorded[0]!.idempotencyKey, recorded[1]!.idempotencyKey);
  });
});

describe('durable-wrap — write/edit/acquire', () => {
  it('wrapSandboxWrite hashes path + content into the key', async () => {
    const { ctx, recorded } = makeStubCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wrapSandboxWrite(ctx as any, { runId: 'r1', stage: 'build', idx: 0, path: 'x.txt' },
      'hello', async () => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wrapSandboxWrite(ctx as any, { runId: 'r1', stage: 'build', idx: 0, path: 'x.txt' },
      'world', async () => undefined);
    assert.notEqual(recorded[0]!.idempotencyKey, recorded[1]!.idempotencyKey);
  });

  it('wrapSandboxEdit folds (path, old, new) into the key', async () => {
    const { ctx, recorded } = makeStubCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wrapSandboxEdit(ctx as any, { runId: 'r1', stage: 'build', idx: 0, path: 'x.txt', oldString: 'foo', newString: 'bar' },
      async () => undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wrapSandboxEdit(ctx as any, { runId: 'r1', stage: 'build', idx: 0, path: 'x.txt', oldString: 'foo', newString: 'bar' },
      async () => undefined);
    assert.equal(recorded[0]!.idempotencyKey, recorded[1]!.idempotencyKey);
  });

  it('wrapSandboxAcquire dedupes by (runId, stage, image, limitsHash)', async () => {
    const { ctx, recorded } = makeStubCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wrapSandboxAcquire(ctx as any, { runId: 'r1', stage: 'build', image: 'anvil/sandbox:1', limitsHash: 'h1' },
      async () => ({} as any));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wrapSandboxAcquire(ctx as any, { runId: 'r1', stage: 'build', image: 'anvil/sandbox:1', limitsHash: 'h1' },
      async () => ({} as any));
    assert.equal(recorded[0]!.idempotencyKey, recorded[1]!.idempotencyKey);
  });
});
