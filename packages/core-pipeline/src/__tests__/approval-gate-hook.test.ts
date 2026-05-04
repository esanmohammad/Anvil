/**
 * Phase 4 — approval-gate hook unit tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventBus } from '../event-bus.js';
import {
  APPROVAL_GATE_CHANNEL,
  attachApprovalGateHook,
} from '../hooks/approval-gate.hook.js';

describe('attachApprovalGateHook', () => {
  it('responds with the decision provider result', async () => {
    const bus = new InMemoryEventBus();
    attachApprovalGateHook(bus, {
      getApprovalDecision: async (req) => {
        assert.equal(req.stepId, 'clarify');
        return 'approved';
      },
    });
    const decision = await bus.request<unknown, string>(APPROVAL_GATE_CHANNEL, {
      stepId: 'clarify',
      stageIndex: 0,
    });
    assert.equal(decision, 'approved');
  });

  it('responds rejected when decision provider throws', async () => {
    const bus = new InMemoryEventBus();
    const handle = attachApprovalGateHook(bus, {
      getApprovalDecision: async () => { throw new Error('user closed dialog'); },
    });
    const decision = await bus.request<unknown, string>(APPROVAL_GATE_CHANNEL, {
      stepId: 'build',
    });
    assert.equal(decision, 'rejected');
    assert.ok(handle.lastError);
    assert.match(handle.lastError!.message, /user closed dialog/);
  });

  it('handles parallel approval requests independently', async () => {
    const bus = new InMemoryEventBus();
    let n = 0;
    attachApprovalGateHook(bus, {
      getApprovalDecision: async (req) => {
        n += 1;
        return req.stepId === 'a' ? 'approved' : 'rejected';
      },
    });
    const [a, b] = await Promise.all([
      bus.request<unknown, string>(APPROVAL_GATE_CHANNEL, { stepId: 'a' }),
      bus.request<unknown, string>(APPROVAL_GATE_CHANNEL, { stepId: 'b' }),
    ]);
    assert.equal(a, 'approved');
    assert.equal(b, 'rejected');
    assert.equal(n, 2);
  });

  it('tracks handledCount', async () => {
    const bus = new InMemoryEventBus();
    const handle = attachApprovalGateHook(bus, {
      getApprovalDecision: async () => 'approved',
    });
    await bus.request<unknown, string>(APPROVAL_GATE_CHANNEL, { stepId: 'a' });
    await bus.request<unknown, string>(APPROVAL_GATE_CHANNEL, { stepId: 'b' });
    assert.equal(handle.handledCount, 2);
  });

  it('unsubscribe stops handling', async () => {
    const bus = new InMemoryEventBus();
    const handle = attachApprovalGateHook(bus, {
      getApprovalDecision: async () => 'approved',
    });
    handle.unsubscribe();
    // No responder remains — request should time out.
    await assert.rejects(
      () => bus.request<unknown, string>(APPROVAL_GATE_CHANNEL, { stepId: 'x' }, { timeoutMs: 30 }),
    );
  });
});
