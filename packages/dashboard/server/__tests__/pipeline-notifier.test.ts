/**
 * Tests for pipeline-notifier — confirms fire-and-forget semantics (no-op
 * when webhook/SMTP are unconfigured, never throws).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  notifyPipelinePaused,
  notifyPipelineResumed,
  notifyCostBreach,
  sendEmailIfConfigured,
  type PauseState,
} from '../pipeline-notifier.js';
import {
  createApprovalToken,
  verifyApprovalToken,
} from '../pipeline-approval-tokens.js';

const SECRET = 'notifier-test-secret';

function samplePause(overrides: Partial<PauseState> = {}): PauseState {
  return {
    runId: 'run-abc',
    project: 'my-project',
    stage: 'review',
    reason: 'Risky change — manual review required',
    matchedRules: ['risk:high', 'path:src/**'],
    reviewers: ['alice', 'bob'],
    pausedAt: new Date().toISOString(),
    timeoutAt: new Date(Date.now() + 3600_000).toISOString(),
    status: 'paused-awaiting-user',
    ...overrides,
  };
}

describe('pipeline-notifier (unconfigured)', () => {
  let savedSlack: string | undefined;
  let savedSmtp: string | undefined;

  beforeEach(() => {
    savedSlack = process.env.ANVIL_SLACK_WEBHOOK_URL;
    savedSmtp = process.env.ANVIL_SMTP_URL;
    process.env.ANVIL_SLACK_WEBHOOK_URL = '';
    process.env.ANVIL_SMTP_URL = '';
  });

  afterEach(() => {
    if (savedSlack === undefined) delete process.env.ANVIL_SLACK_WEBHOOK_URL;
    else process.env.ANVIL_SLACK_WEBHOOK_URL = savedSlack;
    if (savedSmtp === undefined) delete process.env.ANVIL_SMTP_URL;
    else process.env.ANVIL_SMTP_URL = savedSmtp;
  });

  it('notifyPipelinePaused is a no-op without webhook', async () => {
    await assert.doesNotReject(async () => {
      await notifyPipelinePaused(samplePause());
    });
  });

  it('notifyPipelineResumed is a no-op without webhook', async () => {
    await assert.doesNotReject(async () => {
      await notifyPipelineResumed(samplePause({ status: 'resumed' }));
    });
  });

  it('notifyCostBreach is a no-op without webhook', async () => {
    await assert.doesNotReject(async () => {
      await notifyCostBreach({
        runId: 'run-cost',
        project: 'my-project',
        currentUsd: 12.5,
        limitUsd: 10,
        projectedUsd: 15,
        graceEndsAt: new Date(Date.now() + 900_000).toISOString(),
        topSpenders: [{ stage: 'implement', usd: 8 }],
      });
    });
  });

  it('sendEmailIfConfigured is a no-op without ANVIL_SMTP_URL', async () => {
    await assert.doesNotReject(async () => {
      await sendEmailIfConfigured(['ops@example.com'], 'hello', 'world');
    });
  });
});

describe('approval token round-trip (from notifier perspective)', () => {
  it('tokens generated for notifier links verify correctly', () => {
    const token = createApprovalToken('run-abc', 'approve', SECRET, 1);
    const url = `https://anvil.example.com/api/pipeline/approve?token=${encodeURIComponent(token)}`;
    assert.ok(url.includes(token));

    const verified = verifyApprovalToken(token, SECRET);
    assert.ok(verified !== null);
    assert.strictEqual(verified.runId, 'run-abc');
    assert.strictEqual(verified.action, 'approve');
  });
});
