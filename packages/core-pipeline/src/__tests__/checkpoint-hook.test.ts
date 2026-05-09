/**
 * Phase A4 — attachCheckpointHook + createFileCheckpointStore.
 *
 * Coverage:
 *   - in-memory store: write on each step:completed; final snapshot
 *     reflects all completed steps.
 *   - successful run deletes the checkpoint by default.
 *   - keepOnSuccess: true retains it.
 *   - failed run keeps the checkpoint (for resume).
 *   - getShared() snapshot is mirrored when provided.
 *   - file-backed store round-trip: write → read returns the same snapshot;
 *     delete removes the file.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryEventBus,
  InMemoryStepRegistry,
  Pipeline,
  attachCheckpointHook,
  createFileCheckpointStore,
  type CheckpointSnapshot,
  type CheckpointStore,
  type Step,
} from '../index.js';

const tmpRoots: string[] = [];
function mkTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-checkpoint-'));
  tmpRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpRoots) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

function memStore(): CheckpointStore & { writes: CheckpointSnapshot[]; deleted: string[] } {
  const writes: CheckpointSnapshot[] = [];
  const deleted: string[] = [];
  let last: CheckpointSnapshot | null = null;
  return {
    writes,
    deleted,
    write(_runId, snap) { last = JSON.parse(JSON.stringify(snap)); writes.push(last!); },
    read() { return last; },
    delete(runId) { last = null; deleted.push(runId); },
  };
}

function step(id: string): Step<unknown, unknown> {
  return { id, parallelism: 'serial', run: async () => id };
}

describe('attachCheckpointHook', () => {
  it('writes after each step completes; final snapshot has all completed steps', async () => {
    const store = memStore();
    const bus = new InMemoryEventBus();
    const handle = attachCheckpointHook(bus, { store, runId: 'r1' });
    const reg = new InMemoryStepRegistry();
    reg.register(step('a'));
    reg.register(step('b'));
    await new Pipeline({ registry: reg, bus, runId: 'r1', workspaceDir: '/tmp' }).run();

    // Should have at least: pipeline:started, a started, a completed,
    // b started, b completed, pipeline:completed → 6 writes (+ delete on success).
    assert.ok(store.writes.length >= 6, `expected >=6 writes, got ${store.writes.length}`);
    const lastBeforeDelete = store.writes.at(-1)!;
    assert.equal(lastBeforeDelete.status, 'completed');
    assert.deepEqual(lastBeforeDelete.completedSteps, ['a', 'b']);
    handle.unsubscribe();
  });

  it('deletes checkpoint after successful pipeline:completed by default', async () => {
    const store = memStore();
    const bus = new InMemoryEventBus();
    attachCheckpointHook(bus, { store, runId: 'r1' });
    const reg = new InMemoryStepRegistry();
    reg.register(step('a'));
    await new Pipeline({ registry: reg, bus, runId: 'r1', workspaceDir: '/tmp' }).run();
    assert.deepEqual(store.deleted, ['r1']);
  });

  it('keepOnSuccess retains the checkpoint after success', async () => {
    const store = memStore();
    const bus = new InMemoryEventBus();
    attachCheckpointHook(bus, { store, runId: 'r1', keepOnSuccess: true });
    const reg = new InMemoryStepRegistry();
    reg.register(step('a'));
    await new Pipeline({ registry: reg, bus, runId: 'r1', workspaceDir: '/tmp' }).run();
    assert.deepEqual(store.deleted, []);
  });

  it('keeps the checkpoint after a failed run', async () => {
    const store = memStore();
    const bus = new InMemoryEventBus();
    attachCheckpointHook(bus, { store, runId: 'r1' });
    const reg = new InMemoryStepRegistry();
    reg.register(step('a'));
    reg.register({ id: 'boom', parallelism: 'serial', run: async () => { throw new Error('x'); } });
    await new Pipeline({ registry: reg, bus, runId: 'r1', workspaceDir: '/tmp' }).run();
    assert.deepEqual(store.deleted, [], 'failed runs are not deleted');
    const last = store.writes.at(-1)!;
    assert.equal(last.status, 'failed');
    assert.equal(last.failedStepId, 'boom');
    // resume contract: completedSteps still has the successful 'a'.
    assert.deepEqual(last.completedSteps, ['a']);
  });

  it('mirrors getShared() when provided', async () => {
    const store = memStore();
    const bus = new InMemoryEventBus();
    attachCheckpointHook(bus, {
      store,
      runId: 'r1',
      keepOnSuccess: true,
      getShared: () => ({ project: 'p1', planSeed: { id: 42 } }),
    });
    const reg = new InMemoryStepRegistry();
    reg.register(step('a'));
    await new Pipeline({ registry: reg, bus, runId: 'r1', workspaceDir: '/tmp' }).run();
    const last = store.writes.at(-1)!;
    assert.deepEqual(last.shared, { project: 'p1', planSeed: { id: 42 } });
  });

  it('snapshot is shaped for Pipeline.run({ resumeFromStep, completedSteps })', async () => {
    const store = memStore();
    const bus = new InMemoryEventBus();
    attachCheckpointHook(bus, { store, runId: 'r1' });
    const reg = new InMemoryStepRegistry();
    reg.register(step('a'));
    reg.register({ id: 'b', parallelism: 'serial', run: async () => { throw new Error('x'); } });
    reg.register(step('c'));
    await new Pipeline({ registry: reg, bus, runId: 'r1', workspaceDir: '/tmp' }).run();
    const last = store.writes.at(-1)!;
    // Shape: completedSteps is feedable to the resume API.
    const reg2 = new InMemoryStepRegistry();
    reg2.register(step('a'));
    reg2.register(step('b')); // healed
    reg2.register(step('c'));
    const result = await new Pipeline({
      registry: reg2, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
      completedSteps: last.completedSteps, resumeFromStep: last.failedStepId,
    }).run();
    assert.equal(result.status, 'success');
  });
});

describe('createFileCheckpointStore', () => {
  it('round-trips snapshot through the file system', async () => {
    const root = mkTmp();
    const store = createFileCheckpointStore({ rootDir: root });
    const snap: CheckpointSnapshot = {
      runId: 'r1',
      status: 'running',
      completedSteps: ['a'],
      currentStepId: 'b',
      lastEventTs: '2026-01-01T00:00:00Z',
      v: 1,
    };
    await store.write('r1', snap);
    const got = await store.read('r1');
    assert.deepEqual(got, snap);
    await store.delete('r1');
    assert.equal(await store.read('r1'), null);
    assert.equal(existsSync(join(root, 'r1', 'checkpoint.json')), false);
  });

  it('read returns null for an unknown run', async () => {
    const store = createFileCheckpointStore({ rootDir: mkTmp() });
    assert.equal(await store.read('nope'), null);
  });

  it('read returns null when the file is corrupt JSON', async () => {
    const root = mkTmp();
    const store = createFileCheckpointStore({ rootDir: root });
    // Manually write garbage.
    const fs = await import('node:fs');
    fs.mkdirSync(join(root, 'r1'), { recursive: true });
    fs.writeFileSync(join(root, 'r1', 'checkpoint.json'), '{not json');
    assert.equal(await store.read('r1'), null);
  });

  it('attachCheckpointHook + createFileCheckpointStore — full E2E', async () => {
    const root = mkTmp();
    const store = createFileCheckpointStore({ rootDir: root });
    const bus = new InMemoryEventBus();
    attachCheckpointHook(bus, { store, runId: 'r2', keepOnSuccess: true });
    const reg = new InMemoryStepRegistry();
    reg.register(step('a'));
    reg.register(step('b'));
    await new Pipeline({ registry: reg, bus, runId: 'r2', workspaceDir: '/tmp' }).run();
    const persisted = await store.read('r2');
    assert.ok(persisted);
    assert.equal(persisted!.status, 'completed');
    assert.deepEqual(persisted!.completedSteps, ['a', 'b']);
  });
});
