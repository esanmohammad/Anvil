/**
 * Tests for PipelinePauseStore — node:test + node:assert.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PipelinePauseStore } from '../pipeline-pause-store.js';
import type { PauseState, ResumeDecision } from '../pipeline-pause-types.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-pause-'));
}

function baseInput(overrides: Partial<Parameters<PipelinePauseStore['pause']>[0]> = {}) {
  return {
    runId: 'run-1',
    project: 'demo',
    stage: 'plan' as const,
    reason: 'high-risk path touched',
    matchedRules: ['src/**'],
    reviewers: ['alice'],
    timeoutHours: 1,
    ...overrides,
  };
}

describe('PipelinePauseStore', () => {
  let home: string;
  let store: PipelinePauseStore;

  beforeEach(() => {
    home = tmpHome();
    store = new PipelinePauseStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('pause() persists record and shows it in list()', () => {
    const state = store.pause(baseInput());
    assert.equal(state.status, 'paused-awaiting-user');
    assert.ok(state.pausedAt);
    assert.ok(state.timeoutAt, 'timeoutAt must be set when timeoutHours is provided');

    const listed = store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.runId, 'run-1');

    const fetched = store.get('run-1');
    assert.ok(fetched);
    assert.equal(fetched.project, 'demo');
    assert.deepEqual(fetched.matchedRules, ['src/**']);
  });

  it('resume(approve) transitions to resumed and stores decision', () => {
    store.pause(baseInput());
    const decision: ResumeDecision = { action: 'approve', note: 'lgtm' };
    const resumed = store.resume('run-1', decision, 'bob');
    assert.equal(resumed.status, 'resumed');
    assert.equal(resumed.resumedBy, 'bob');
    assert.ok(resumed.resumedAt);
    assert.deepEqual(resumed.resumeDecision, decision);

    const afterGet = store.get('run-1');
    assert.equal(afterGet?.status, 'resumed');
  });

  it('resume() on an already-resumed pause throws', () => {
    store.pause(baseInput());
    store.resume('run-1', { action: 'approve' }, 'bob');
    assert.throws(
      () => store.resume('run-1', { action: 'approve' }, 'carol'),
      /not awaiting/,
    );
  });

  it('markTimedOut transitions from paused-awaiting-user', () => {
    store.pause(baseInput());
    const timed = store.markTimedOut('run-1');
    assert.equal(timed.status, 'timed-out');
    assert.equal(timed.resumedBy, 'system');
    // idempotent: marking again leaves it timed-out
    const second = store.markTimedOut('run-1');
    assert.equal(second.status, 'timed-out');
  });

  it('list({status}) filters results', () => {
    store.pause(baseInput({ runId: 'run-a' }));
    store.pause(baseInput({ runId: 'run-b', project: 'demo' }));
    store.resume('run-a', { action: 'approve' }, 'bob');

    const awaiting = store.list({ status: 'paused-awaiting-user' });
    assert.equal(awaiting.length, 1);
    assert.equal(awaiting[0]!.runId, 'run-b');

    const resumed = store.list({ status: 'resumed' });
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0]!.runId, 'run-a');

    const byProject = store.list({ project: 'demo' });
    assert.equal(byProject.length, 2);

    const byStage = store.list({ stage: 'plan' });
    assert.equal(byStage.length, 2);
    const byWrongStage = store.list({ stage: 'ship' });
    assert.equal(byWrongStage.length, 0);
  });

  it('atomicity: corrupt one record file, index stays intact and list skips it', () => {
    store.pause(baseInput({ runId: 'run-good' }));
    store.pause(baseInput({ runId: 'run-bad' }));

    const badPath = join(home, 'pipeline-pauses', 'demo', 'run-bad.json');
    assert.ok(existsSync(badPath));
    // Simulate a crash mid-write by replacing the file contents with garbage.
    writeFileSync(badPath, '{not valid json', 'utf-8');

    // Index itself is not corrupt — pointer list is still readable.
    const indexPath = join(home, 'pipeline-pauses', 'index.json');
    const idx = JSON.parse(readFileSync(indexPath, 'utf-8')) as Array<{ runId: string }>;
    assert.equal(idx.length, 2);

    // list() hydrates each record and silently skips unreadable files.
    const rows: PauseState[] = store.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.runId, 'run-good');

    // Rebuild via index wipe still yields a working store.
    rmSync(indexPath, { force: true });
    const store2 = new PipelinePauseStore(home);
    const afterRebuild = store2.list();
    // The corrupt file is dropped during rebuild; only the good record remains.
    assert.equal(afterRebuild.length, 1);
    assert.equal(afterRebuild[0]!.runId, 'run-good');
  });
});
