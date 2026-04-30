/**
 * Tests for CheckpointStore — record lifecycle, get/write atomicity,
 * stats math.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BlobStore } from '../blob-store.js';
import { CheckpointStore } from '../store.js';
import { checkpointPath, computeKey } from '../key.js';
import type { CheckpointInputs } from '../types.js';

function baseInputs(over: Partial<CheckpointInputs> = {}): CheckpointInputs {
  return {
    stage: 'plan',
    taskId: 'plan:root',
    promptVersion: 'v1',
    model: 'claude',
    toolVersions: { tsc: '5.3.3' },
    inputs: { feature: 'login' },
    ...over,
  };
}

describe('CheckpointStore', () => {
  let home: string;
  let blobs: BlobStore;
  let store: CheckpointStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'anvil-ckpt-'));
    blobs = new BlobStore(home);
    store = new CheckpointStore({ anvilHome: home, blobStore: blobs });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('begin() writes a running record with startedAt', () => {
    const inputs = baseInputs();
    const rec = store.begin('demo', 'run-1', inputs);
    assert.equal(rec.status, 'running');
    assert.equal(rec.project, 'demo');
    assert.ok(rec.startedAt);
    assert.equal(rec.key.stage, 'plan');

    const path = checkpointPath(home, 'demo', 'run-1', 'plan', rec.key.hash);
    assert.ok(existsSync(path));
  });

  it('complete() transitions to completed, writes blob, and sets outputRef', () => {
    const inputs = baseInputs();
    const begun = store.begin('demo', 'run-1', inputs);
    const completed = store.complete(
      'demo',
      'run-1',
      begun.key,
      'result-payload',
      { usd: 0.25, tokensIn: 10, tokensOut: 20 },
    );
    assert.equal(completed.status, 'completed');
    assert.ok(completed.outputRef);
    assert.ok(blobs.exists(completed.outputRef!));
    assert.ok(completed.completedAt);
    assert.ok(typeof completed.durationMs === 'number');
    assert.equal(completed.cost?.usd, 0.25);
  });

  it('get() on a completed record increments the hit counter', () => {
    const inputs = baseInputs();
    const begun = store.begin('demo', 'run-1', inputs);
    store.complete('demo', 'run-1', begun.key, 'output', { usd: 0.1, tokensIn: 1, tokensOut: 2 });

    store.resetCounters();
    const fetched = store.get('demo', 'run-1', begun.key);
    assert.ok(fetched);
    assert.equal(fetched!.status, 'completed');
    assert.equal(store.getCounters().hits, 1);
  });

  it('get() on a missing record returns null', () => {
    const inputs = baseInputs();
    const key = computeKey('run-1', inputs);
    assert.equal(store.get('demo', 'run-1', key), null);
  });

  it('get() on a corrupt record returns null and does not throw', () => {
    const inputs = baseInputs();
    const key = computeKey('run-1', inputs);
    const path = checkpointPath(home, 'demo', 'run-1', 'plan', key.hash);
    mkdirSync(path.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(path, '{ not json ', 'utf-8');
    assert.equal(store.get('demo', 'run-1', key), null);
  });

  it('interrupt() transitions to interrupted and stores partial output when present', () => {
    const inputs = baseInputs();
    const begun = store.begin('demo', 'run-1', inputs);
    const interrupted = store.interrupt(
      'demo',
      'run-1',
      begun.key,
      'partial-bytes',
      'signal:SIGTERM',
    );
    assert.equal(interrupted.status, 'interrupted');
    assert.ok(interrupted.outputRef);
    assert.equal(interrupted.errorMessage, 'signal:SIGTERM');
    assert.equal(blobs.read(interrupted.outputRef!)!.toString('utf-8'), 'partial-bytes');
  });

  it('interrupt() without partial output omits outputRef', () => {
    const inputs = baseInputs();
    const begun = store.begin('demo', 'run-1', inputs);
    const interrupted = store.interrupt('demo', 'run-1', begun.key, undefined, 'cancel');
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.outputRef, undefined);
  });

  it('fail() transitions to failed with errorMessage', () => {
    const inputs = baseInputs();
    const begun = store.begin('demo', 'run-1', inputs);
    const failed = store.fail('demo', 'run-1', begun.key, 'boom');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorMessage, 'boom');
  });

  it('listForRun() returns every record across stages', () => {
    const a = store.begin('demo', 'run-1', baseInputs({ stage: 'plan', taskId: 'plan:root' }));
    const b = store.begin('demo', 'run-1', baseInputs({ stage: 'implement', taskId: 'impl:a' }));
    store.begin('demo', 'run-1', baseInputs({ stage: 'implement', taskId: 'impl:b' }));
    store.complete('demo', 'run-1', a.key, 'a-out');
    store.complete('demo', 'run-1', b.key, 'b-out');

    const records = store.listForRun('demo', 'run-1');
    assert.equal(records.length, 3);
    const stages = records.map((r) => r.key.stage).sort();
    assert.deepEqual(stages, ['implement', 'implement', 'plan']);
  });

  it('invalidateStage() deletes only records for that stage', () => {
    const a = store.begin('demo', 'run-1', baseInputs({ stage: 'plan', taskId: 'plan:root' }));
    const b = store.begin('demo', 'run-1', baseInputs({ stage: 'implement', taskId: 'impl:a' }));
    store.complete('demo', 'run-1', a.key, 'a');
    store.complete('demo', 'run-1', b.key, 'b');
    const n = store.invalidateStage('demo', 'run-1', 'plan');
    assert.equal(n, 1);
    const remaining = store.listForRun('demo', 'run-1');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.key.stage, 'implement');
  });

  it('stats() math: hits/misses/hitRate/costSaved', () => {
    store.resetCounters();
    const a = store.begin('demo', 'run-1', baseInputs({ taskId: 'a' }));
    store.complete('demo', 'run-1', a.key, 'a', { usd: 0.5, tokensIn: 1, tokensOut: 2 });

    // First get = hit.
    store.get('demo', 'run-1', a.key);
    // Second get = another hit.
    store.get('demo', 'run-1', a.key);

    // A fresh begin = miss.
    store.begin('demo', 'run-1', baseInputs({ taskId: 'b' }));

    const stats = store.stats('demo', 'run-1');
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 2); // a + b begins
    assert.ok(stats.hitRate > 0 && stats.hitRate < 1);
    assert.equal(stats.costSavedUsd, 1.0); // 2 hits × $0.5
    assert.equal(stats.total, 2);
    assert.equal(stats.interrupted, 0);
  });

  it('stats() counts interrupted records', () => {
    const a = store.begin('demo', 'run-1', baseInputs({ taskId: 'a' }));
    store.interrupt('demo', 'run-1', a.key, undefined, 'cancel');
    const stats = store.stats('demo', 'run-1');
    assert.equal(stats.interrupted, 1);
  });
});
