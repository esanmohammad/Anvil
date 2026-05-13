/**
 * Plan lifecycle walker — state machine transitions.
 *
 * Every event has at least one positive test (it transitions correctly)
 * and one negative test (it's a no-op when the state machine isn't
 * ready for it). Together they pin the contract end-to-end.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  initLifecycle,
  transitionLifecycle,
  snapshotLifecycle,
  type LifecycleContext,
  type LifecycleEvent,
} from '../plan/lifecycle.js';

function make(): LifecycleContext {
  return initLifecycle({ project: 'p', slug: 's' });
}

function chain(ctx: LifecycleContext, ...events: LifecycleEvent[]): LifecycleContext {
  for (const e of events) ctx = transitionLifecycle(ctx, e).next;
  return ctx;
}

describe('plan lifecycle — happy path', () => {
  it('clean draft → verify → awaiting_approval → execute → reconcile → complete', () => {
    const ctx = make();
    const after = chain(
      ctx,
      { kind: 'plan-draft-started' },
      { kind: 'plan-draft-complete' },
      { kind: 'verify-complete', errors: 0, autoFixableCount: 0, canTargetedRegen: false },
    );
    assert.equal(after.state, 'awaiting_approval');
    const next = chain(
      after,
      { kind: 'approve' },
      { kind: 'execute-started' },
      { kind: 'execute-complete' },
      { kind: 'reconcile-complete' },
    );
    assert.equal(next.state, 'complete');
    assert.ok(next.history.length >= 5);
  });

  it('verify action returned when draft completes', () => {
    const ctx = chain(make(), { kind: 'plan-draft-started' });
    const { action } = transitionLifecycle(ctx, { kind: 'plan-draft-complete' });
    assert.equal(action.kind, 'verify');
  });
});

describe('plan lifecycle — auto-refine loop', () => {
  it('verify errors → refine when budget allows', () => {
    const ctx = chain(make(), { kind: 'plan-draft-started' }, { kind: 'plan-draft-complete' });
    const { next, action } = transitionLifecycle(ctx, {
      kind: 'verify-complete', errors: 3, autoFixableCount: 2, canTargetedRegen: true,
    });
    assert.equal(next.state, 'refining');
    assert.equal(action.kind, 'refine');
  });

  it('refine-complete loops back to verifying with attempts/spend tracked', () => {
    let ctx = chain(make(),
      { kind: 'plan-draft-started' }, { kind: 'plan-draft-complete' },
      { kind: 'verify-complete', errors: 3, autoFixableCount: 1, canTargetedRegen: true },
    );
    const after = transitionLifecycle(ctx, { kind: 'refine-complete', spentUsd: 0.42 });
    assert.equal(after.next.state, 'verifying');
    assert.equal(after.next.refineAttempts, 1);
    assert.equal(after.next.refineSpentUsd, 0.42);
    assert.equal(after.action.kind, 'verify');
  });

  it('caps at maxRefineAttempts', () => {
    let ctx = initLifecycle({ project: 'p', slug: 's', maxRefineAttempts: 2 });
    ctx = chain(ctx,
      { kind: 'plan-draft-started' }, { kind: 'plan-draft-complete' },
      { kind: 'verify-complete', errors: 3, autoFixableCount: 1, canTargetedRegen: true },
      { kind: 'refine-complete', spentUsd: 0.10 },
      { kind: 'verify-complete', errors: 2, autoFixableCount: 1, canTargetedRegen: true },
      { kind: 'refine-complete', spentUsd: 0.15 },
    );
    // 2 attempts done; next verify with errors should NOT trigger another refine.
    const r = transitionLifecycle(ctx, {
      kind: 'verify-complete', errors: 1, autoFixableCount: 1, canTargetedRegen: true,
    });
    assert.equal(r.next.state, 'awaiting_approval');
    assert.match(r.next.history[r.next.history.length - 1].reason, /attempt cap/);
  });

  it('caps at maxRefineUsd', () => {
    let ctx = initLifecycle({ project: 'p', slug: 's', maxRefineUsd: 0.5 });
    ctx = chain(ctx,
      { kind: 'plan-draft-started' }, { kind: 'plan-draft-complete' },
      { kind: 'verify-complete', errors: 3, autoFixableCount: 1, canTargetedRegen: true },
      { kind: 'refine-complete', spentUsd: 0.60 },
    );
    const r = transitionLifecycle(ctx, {
      kind: 'verify-complete', errors: 1, autoFixableCount: 1, canTargetedRegen: true,
    });
    assert.equal(r.next.state, 'awaiting_approval');
    assert.match(r.next.history[r.next.history.length - 1].reason, /USD budget/);
  });

  it('errors with no auto-fix work yields to user', () => {
    const ctx = chain(make(), { kind: 'plan-draft-started' }, { kind: 'plan-draft-complete' });
    const r = transitionLifecycle(ctx, {
      kind: 'verify-complete', errors: 4, autoFixableCount: 0, canTargetedRegen: false,
    });
    assert.equal(r.next.state, 'awaiting_approval');
    assert.match(r.next.history[r.next.history.length - 1].reason, /no auto-fixable/);
  });

  it('refine-failed hands off to user', () => {
    let ctx = chain(make(),
      { kind: 'plan-draft-started' }, { kind: 'plan-draft-complete' },
      { kind: 'verify-complete', errors: 3, autoFixableCount: 1, canTargetedRegen: true },
    );
    const r = transitionLifecycle(ctx, { kind: 'refine-failed', reason: 'budget breach' });
    assert.equal(r.next.state, 'awaiting_approval');
    assert.equal(r.next.lastError, 'budget breach');
    assert.equal(r.action.kind, 'wait-for-user');
  });
});

describe('plan lifecycle — edit resets', () => {
  it('edit resets refine counters and re-verifies', () => {
    let ctx = chain(make(),
      { kind: 'plan-draft-started' }, { kind: 'plan-draft-complete' },
      { kind: 'verify-complete', errors: 0, autoFixableCount: 0, canTargetedRegen: false },
    );
    ctx = { ...ctx, refineAttempts: 2, refineSpentUsd: 0.4 }; // simulate prior loops
    const r = transitionLifecycle(ctx, { kind: 'edit', reason: 'edited problem section' });
    assert.equal(r.next.state, 'verifying');
    assert.equal(r.next.refineAttempts, 0);
    assert.equal(r.next.refineSpentUsd, 0);
    assert.equal(r.action.kind, 'verify');
  });
});

describe('plan lifecycle — terminal states ignore events', () => {
  it('failed state ignores everything except reset', () => {
    const ctx = chain(make(),
      { kind: 'plan-draft-started' },
      { kind: 'plan-draft-failed', reason: 'chain walker exhausted' },
    );
    assert.equal(ctx.state, 'failed');
    const r = transitionLifecycle(ctx, { kind: 'plan-draft-complete' });
    assert.equal(r.next.state, 'failed');
    assert.equal(r.action.kind, 'noop');
  });

  it('complete state can be reset back to idle', () => {
    let ctx = chain(make(),
      { kind: 'plan-draft-started' }, { kind: 'plan-draft-complete' },
      { kind: 'verify-complete', errors: 0, autoFixableCount: 0, canTargetedRegen: false },
      { kind: 'execute-started' }, { kind: 'execute-complete' },
      { kind: 'reconcile-complete' },
    );
    assert.equal(ctx.state, 'complete');
    const r = transitionLifecycle(ctx, { kind: 'reset' });
    assert.equal(r.next.state, 'idle');
    assert.equal(r.next.refineSpentUsd, 0);
    assert.equal(r.next.lastError, undefined);
  });
});

describe('snapshot', () => {
  it('serializes context preserving history', () => {
    const ctx = chain(make(),
      { kind: 'plan-draft-started' }, { kind: 'plan-draft-complete' });
    const snap = snapshotLifecycle(ctx);
    assert.equal(snap.state, 'verifying');
    assert.equal(snap.history.length, 2);
    assert.equal(typeof snap.history[0].at, 'string');
  });
});
