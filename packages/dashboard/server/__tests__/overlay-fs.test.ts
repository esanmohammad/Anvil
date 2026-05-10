/**
 * Phase S3 — overlay filesystem tests.
 *
 * Pure FS module; no Docker required. Each test creates a temp host
 * + upper directory, simulates a sandbox session by populating the
 * upper, then exercises diffOverlay / applyOverlay.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  applyOverlay,
  captureBaselineMtimes,
  diffOverlay,
} from '../sandbox/overlay-fs.js';

let tempRoot: string;

before(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-s3-'));
});

after(async () => {
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

async function makePair(name: string): Promise<{ host: string; upper: string }> {
  const host = path.join(tempRoot, name, 'host');
  const upper = path.join(tempRoot, name, 'upper');
  await fsp.mkdir(host, { recursive: true });
  await fsp.mkdir(upper, { recursive: true });
  return { host, upper };
}

describe('diffOverlay', () => {
  it('reports adds for files only in upper', async () => {
    const { host, upper } = await makePair('add');
    await fsp.writeFile(path.join(host, 'unchanged.txt'), 'a');
    await fsp.writeFile(path.join(upper, 'new.txt'), 'b');
    const diff = await diffOverlay(upper, host);
    assert.deepEqual(diff.added, ['new.txt']);
    assert.deepEqual(diff.modified, []);
  });

  it('reports modifies for files with different content', async () => {
    const { host, upper } = await makePair('mod');
    await fsp.writeFile(path.join(host, 'shared.txt'), 'old');
    await fsp.writeFile(path.join(upper, 'shared.txt'), 'new');
    const diff = await diffOverlay(upper, host);
    assert.deepEqual(diff.modified, ['shared.txt']);
    assert.deepEqual(diff.added, []);
  });

  it('skips files identical to host', async () => {
    const { host, upper } = await makePair('same');
    await fsp.writeFile(path.join(host, 'eq.txt'), 'same');
    await fsp.writeFile(path.join(upper, 'eq.txt'), 'same');
    const diff = await diffOverlay(upper, host);
    assert.deepEqual(diff.modified, []);
    assert.deepEqual(diff.added, []);
  });

  it('reports removes via .wh. whiteout files', async () => {
    const { host, upper } = await makePair('rm');
    await fsp.writeFile(path.join(host, 'gone.txt'), 'bye');
    await fsp.writeFile(path.join(upper, '.wh.gone.txt'), '');
    const diff = await diffOverlay(upper, host);
    assert.deepEqual(diff.removed, ['gone.txt']);
  });

  it('detects host-changed-during-sandbox conflicts via baseline mtimes', async () => {
    const { host, upper } = await makePair('conflict');
    await fsp.writeFile(path.join(host, 'shared.txt'), 'before');
    const baseline = await captureBaselineMtimes(host);

    // Sandbox edits to upper.
    await fsp.writeFile(path.join(upper, 'shared.txt'), 'sandbox-edit');

    // Host edits during the sandbox lifetime.
    await new Promise((r) => setTimeout(r, 20));
    await fsp.writeFile(path.join(host, 'shared.txt'), 'host-edit');

    const diff = await diffOverlay(upper, host, { baselineMtimes: baseline });
    assert.deepEqual(diff.conflicts, ['shared.txt']);
    assert.deepEqual(diff.modified, []);
  });
});

describe('applyOverlay', () => {
  it('writes adds + modifies into the host workdir', async () => {
    const { host, upper } = await makePair('apply');
    await fsp.writeFile(path.join(host, 'old.txt'), 'old');
    await fsp.writeFile(path.join(upper, 'new.txt'), 'new');
    await fsp.writeFile(path.join(upper, 'old.txt'), 'old-modified');

    const r = await applyOverlay(upper, host);
    assert.equal(r.conflictResolution, 'merged');
    assert.equal(r.added.length, 1);
    assert.equal(r.modified.length, 1);

    assert.equal(await fsp.readFile(path.join(host, 'new.txt'), 'utf8'), 'new');
    assert.equal(await fsp.readFile(path.join(host, 'old.txt'), 'utf8'), 'old-modified');
  });

  it('host-wins policy writes a .anvil-conflict sibling', async () => {
    const { host, upper } = await makePair('hw-conflict');
    await fsp.writeFile(path.join(host, 'shared.txt'), 'before');
    const baseline = await captureBaselineMtimes(host);
    await fsp.writeFile(path.join(upper, 'shared.txt'), 'sandbox-edit');
    await new Promise((r) => setTimeout(r, 20));
    await fsp.writeFile(path.join(host, 'shared.txt'), 'host-edit');

    const r = await applyOverlay(upper, host, { baselineMtimes: baseline });
    assert.equal(r.conflictResolution, 'host-wins');
    assert.equal(await fsp.readFile(path.join(host, 'shared.txt'), 'utf8'), 'host-edit');
    assert.equal(
      await fsp.readFile(path.join(host, 'shared.txt.anvil-conflict'), 'utf8'),
      'sandbox-edit',
    );
    assert.deepEqual(r.conflictFiles, ['shared.txt.anvil-conflict']);
  });

  it('sandbox-wins policy overwrites host with sandbox edit', async () => {
    const { host, upper } = await makePair('sw-conflict');
    await fsp.writeFile(path.join(host, 'shared.txt'), 'before');
    const baseline = await captureBaselineMtimes(host);
    await fsp.writeFile(path.join(upper, 'shared.txt'), 'sandbox-edit');
    await new Promise((r) => setTimeout(r, 20));
    await fsp.writeFile(path.join(host, 'shared.txt'), 'host-edit');

    const r = await applyOverlay(upper, host, {
      baselineMtimes: baseline,
      policy: 'sandbox-wins',
    });
    assert.equal(r.conflictResolution, 'sandbox-wins');
    assert.equal(await fsp.readFile(path.join(host, 'shared.txt'), 'utf8'), 'sandbox-edit');
    // No conflict sibling created.
    await assert.rejects(() => fsp.access(path.join(host, 'shared.txt.anvil-conflict')));
  });

  it('dryRun computes the diff without writing', async () => {
    const { host, upper } = await makePair('dry');
    await fsp.writeFile(path.join(upper, 'new.txt'), 'sandbox');
    const r = await applyOverlay(upper, host, { dryRun: true });
    assert.deepEqual(r.added, ['new.txt']);
    await assert.rejects(() => fsp.access(path.join(host, 'new.txt')));
  });

  it('skip-globs prevent node_modules / .git / dist from propagating', async () => {
    const { host, upper } = await makePair('skip');
    await fsp.mkdir(path.join(upper, 'node_modules', 'foo'), { recursive: true });
    await fsp.writeFile(path.join(upper, 'node_modules', 'foo', 'index.js'), 'big');
    await fsp.mkdir(path.join(upper, '.git'), { recursive: true });
    await fsp.writeFile(path.join(upper, '.git', 'HEAD'), 'ref: x');
    await fsp.writeFile(path.join(upper, 'real.txt'), 'real');

    const r = await applyOverlay(upper, host);
    assert.deepEqual(r.added.sort(), ['real.txt']);
    await assert.rejects(() => fsp.access(path.join(host, 'node_modules', 'foo', 'index.js')));
    await assert.rejects(() => fsp.access(path.join(host, '.git', 'HEAD')));
  });

  it('removes files via whiteout', async () => {
    const { host, upper } = await makePair('rm-apply');
    await fsp.writeFile(path.join(host, 'gone.txt'), 'bye');
    await fsp.writeFile(path.join(upper, '.wh.gone.txt'), '');
    const r = await applyOverlay(upper, host);
    assert.deepEqual(r.removed, ['gone.txt']);
    await assert.rejects(() => fsp.access(path.join(host, 'gone.txt')));
  });
});
