/**
 * H10-followup #3 — AsyncLocalStorage propagation for the active step
 * context. Concurrent stages must each see their own ctx without
 * trampling each other.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  withCurrentStepContext,
  getCurrentStepContext,
  setCurrentStepContext,
} from '../current-step-context.js';

describe('withCurrentStepContext', () => {
  it('propagates ctx through async awaits inside the wrapped fn', async () => {
    let inner: unknown;
    await withCurrentStepContext({ runId: 'r1' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      inner = getCurrentStepContext();
    });
    assert.deepEqual(inner, { runId: 'r1' });
  });

  it('isolates concurrent stages — each sees its own ctx', async () => {
    const seen: string[] = [];
    await Promise.all([
      withCurrentStepContext({ runId: 'r1' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push((getCurrentStepContext() as { runId: string }).runId);
      }),
      withCurrentStepContext({ runId: 'r2' }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push((getCurrentStepContext() as { runId: string }).runId);
      }),
    ]);
    assert.equal(seen.length, 2);
    assert.ok(seen.includes('r1'));
    assert.ok(seen.includes('r2'));
  });

  it('returns undefined outside any registered ctx', () => {
    setCurrentStepContext(undefined);
    assert.equal(getCurrentStepContext(), undefined);
  });

  it('legacy setCurrentStepContext is observable from getCurrentStepContext', () => {
    setCurrentStepContext({ runId: 'legacy' });
    try {
      assert.deepEqual(getCurrentStepContext(), { runId: 'legacy' });
    } finally {
      setCurrentStepContext(undefined);
    }
  });
});
