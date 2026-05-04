/**
 * Tests for PipelineReviewersStore — assignment, approval flow, quorum,
 * and reassignment.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PipelineReviewersStore } from '../pipeline-reviewers-store.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-reviewers-'));
}

describe('PipelineReviewersStore', () => {
  let home: string;
  let store: PipelineReviewersStore;

  beforeEach(() => {
    home = tmpHome();
    store = new PipelineReviewersStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('assign() persists a new assignment and get() returns it', () => {
    const a = store.assign({
      runId: 'run-1',
      project: 'demo',
      reviewers: ['@alice', '@bob'],
      approvalsRequired: 2,
    });
    assert.equal(a.runId, 'run-1');
    assert.equal(a.approvalsRequired, 2);
    assert.deepEqual(a.reviewers, ['@alice', '@bob']);
    assert.deepEqual(a.approvals, []);
    assert.ok(a.createdAt);

    const fetched = store.get('run-1');
    assert.ok(fetched);
    assert.deepEqual(fetched.reviewers, ['@alice', '@bob']);
  });

  it('coerces approvalsRequired to at least 1', () => {
    const a = store.assign({
      runId: 'run-zero',
      project: 'demo',
      reviewers: ['@alice'],
      approvalsRequired: 0,
    });
    assert.equal(a.approvalsRequired, 1);
  });

  it('recordApproval() drives toward quorum; 2-of-2 approvers meet it', () => {
    store.assign({
      runId: 'run-1',
      project: 'demo',
      reviewers: ['@alice', '@bob'],
      approvalsRequired: 2,
    });

    let a = store.recordApproval('run-1', '@alice', 'approve', 'lgtm');
    assert.equal(a.approvals.length, 1);
    assert.equal(store.hasQuorum(a), false);

    a = store.recordApproval('run-1', '@bob', 'approve');
    assert.equal(a.approvals.length, 2);
    assert.equal(store.hasQuorum(a), true);
  });

  it('a reject vote kills quorum even when approvals are sufficient', () => {
    store.assign({
      runId: 'run-1',
      project: 'demo',
      reviewers: ['@alice', '@bob', '@carol'],
      approvalsRequired: 2,
    });
    store.recordApproval('run-1', '@alice', 'approve');
    store.recordApproval('run-1', '@bob', 'approve');
    const a = store.recordApproval('run-1', '@carol', 'reject', 'regression risk');
    assert.equal(store.hasQuorum(a), false);
  });

  it('repeat vote by same user replaces the previous one', () => {
    store.assign({
      runId: 'run-1',
      project: 'demo',
      reviewers: ['@alice'],
      approvalsRequired: 1,
    });
    store.recordApproval('run-1', '@alice', 'reject');
    const a = store.recordApproval('run-1', '@alice', 'approve');
    assert.equal(a.approvals.length, 1);
    assert.equal(a.approvals[0]!.action, 'approve');
    assert.equal(store.hasQuorum(a), true);
  });

  it('reassign() replaces reviewers and clears approvals', () => {
    store.assign({
      runId: 'run-1',
      project: 'demo',
      reviewers: ['@alice'],
      approvalsRequired: 1,
    });
    store.recordApproval('run-1', '@alice', 'approve');

    const after = store.reassign('run-1', ['@dan', '@eve'], 'manager');
    assert.deepEqual(after.reviewers, ['@dan', '@eve']);
    assert.equal(after.approvals.length, 0);
    assert.equal(store.hasQuorum(after), false);
    // createdAt preserved
    const originalCreatedAt = store.get('run-1')!.createdAt;
    assert.equal(after.createdAt, originalCreatedAt);
  });

  it('recordApproval on missing runId throws', () => {
    assert.throws(
      () => store.recordApproval('nope', '@alice', 'approve'),
      /not found/,
    );
  });
});
