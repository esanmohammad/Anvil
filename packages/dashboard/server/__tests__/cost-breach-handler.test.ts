/**
 * Tests for CostBreachHandler + CostBreachSweeper.
 *
 * Scenarios:
 *  - breach triggers onNotify with topSpenders
 *  - auto-approve under threshold transitions to 'raised' silently
 *  - respond('raise') moves pending → raised
 *  - respond('reject') moves pending → rejected and calls onRejectStop
 *  - extend bumps graceEndsAt and caps at 2 extensions
 *  - sweeper auto-resolves expired grace windows
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CostLedger } from '../cost-ledger.js';
import {
  CostBreachHandler,
  MAX_EXTENSIONS,
  type CostPolicy,
} from '../cost-breach-handler.js';
import { CostBreachSweeper } from '../cost-breach-sweeper.js';
import type { BreachState, CostStage } from '../cost-types.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-breach-'));
}

type NotifyCall = { state: BreachState; top: Array<{ stage: CostStage; usd: number }> };

function makeHandler(home: string) {
  const ledger = new CostLedger(home);
  const notifyCalls: NotifyCall[] = [];
  const rejectCalls: string[] = [];
  const handler = new CostBreachHandler({
    ledger,
    storeDir: join(home, 'breaches'),
    onNotify: (state, top) => { notifyCalls.push({ state, top }); },
    onRejectStop: (runId) => { rejectCalls.push(runId); },
  });
  return { ledger, handler, notifyCalls, rejectCalls };
}

function recordOverLimit(ledger: CostLedger, runId: string, project: string): void {
  // Opus: 0 in + 1_000_000 out → $75. Three of these → $225.
  ledger.record({
    runId, project, stage: 'implement', model: 'claude-opus-4-7',
    tokensIn: 0, tokensOut: 1_000_000,
  });
  ledger.record({
    runId, project, stage: 'implement', model: 'claude-opus-4-7',
    tokensIn: 0, tokensOut: 1_000_000,
  });
  ledger.record({
    runId, project, stage: 'plan', model: 'claude-opus-4-7',
    tokensIn: 0, tokensOut: 1_000_000,
  });
}

describe('CostBreachHandler', () => {
  let home: string;

  beforeEach(() => { home = tmpHome(); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('creates a pending breach and calls onNotify with top spenders', async () => {
    const { ledger, handler, notifyCalls } = makeHandler(home);
    recordOverLimit(ledger, 'run-1', 'demo');
    const policy: CostPolicy = {
      limits: { perRun: 100 },
      graceWindowSeconds: 60,
      onBreach: 'ask',
    };

    const state = await handler.evaluate('run-1', 'demo', policy);
    assert.ok(state);
    assert.equal(state.status, 'pending');
    assert.equal(state.limitUsdAtBreach, 100);
    assert.ok(state.currentUsdAtBreach > 100);
    assert.equal(state.extensionsUsed, 0);

    assert.equal(notifyCalls.length, 1);
    assert.ok(notifyCalls[0].top.length > 0);
    assert.equal(notifyCalls[0].top[0].stage, 'implement');
  });

  it('does not re-notify on second evaluate while pending', async () => {
    const { ledger, handler, notifyCalls } = makeHandler(home);
    recordOverLimit(ledger, 'run-2', 'demo');
    const policy: CostPolicy = { limits: { perRun: 100 }, onBreach: 'ask' };

    await handler.evaluate('run-2', 'demo', policy);
    await handler.evaluate('run-2', 'demo', policy);
    await handler.evaluate('run-2', 'demo', policy);
    assert.equal(notifyCalls.length, 1);
  });

  it('auto-approves silently when overage is below threshold', async () => {
    const { ledger, handler, notifyCalls } = makeHandler(home);
    ledger.record({
      runId: 'run-a', project: 'demo', stage: 'plan', model: 'claude-sonnet-4-6',
      tokensIn: 1_000_000, tokensOut: 0,
    }); // $3 spend
    const policy: CostPolicy = {
      limits: { perRun: 1 },
      onBreach: 'auto-approve',
      autoApproveBelow: 10, // overage = 2
    };
    const state = await handler.evaluate('run-a', 'demo', policy);
    assert.ok(state);
    assert.equal(state.status, 'raised');
    assert.equal(state.decision, 'raise');
    assert.ok((state.deltaUsdApproved ?? 0) > 0);
    assert.equal(notifyCalls.length, 0);
  });

  it('auto-rejects and calls onRejectStop', async () => {
    const { ledger, handler, rejectCalls } = makeHandler(home);
    recordOverLimit(ledger, 'run-r', 'demo');
    const policy: CostPolicy = {
      limits: { perRun: 50 },
      onBreach: 'auto-reject',
    };
    const state = await handler.evaluate('run-r', 'demo', policy);
    assert.ok(state);
    assert.equal(state.status, 'rejected');
    assert.equal(rejectCalls.length, 1);
    assert.equal(rejectCalls[0], 'run-r');
  });

  it('respond("raise") transitions pending → raised with delta', async () => {
    const { ledger, handler } = makeHandler(home);
    recordOverLimit(ledger, 'run-ra', 'demo');
    await handler.evaluate('run-ra', 'demo', { limits: { perRun: 50 }, onBreach: 'ask' });

    const raised = await handler.respond('run-ra', 'raise', 25);
    assert.equal(raised.status, 'raised');
    assert.equal(raised.deltaUsdApproved, 25);
    assert.equal(raised.decision, 'raise');
    assert.ok(raised.decisionAt);
  });

  it('respond("reject") calls onRejectStop and is terminal', async () => {
    const { ledger, handler, rejectCalls } = makeHandler(home);
    recordOverLimit(ledger, 'run-rj', 'demo');
    await handler.evaluate('run-rj', 'demo', { limits: { perRun: 50 }, onBreach: 'ask' });

    const rejected = await handler.respond('run-rj', 'reject');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejectCalls.length, 1);

    // Idempotent: further responses are no-ops.
    const again = await handler.respond('run-rj', 'raise', 10);
    assert.equal(again.status, 'rejected');
  });

  it('extend bumps graceEndsAt and caps at MAX_EXTENSIONS', async () => {
    const { ledger, handler } = makeHandler(home);
    recordOverLimit(ledger, 'run-e', 'demo');
    const first = await handler.evaluate('run-e', 'demo', {
      limits: { perRun: 50 },
      graceWindowSeconds: 10,
      onBreach: 'ask',
    });
    const firstEnd = Date.parse(first!.graceEndsAt);

    const extended1 = await handler.respond('run-e', 'extend', undefined, 30);
    assert.equal(extended1.extensionsUsed, 1);
    assert.ok(Date.parse(extended1.graceEndsAt) > firstEnd);

    const extended2 = await handler.respond('run-e', 'extend', undefined, 30);
    assert.equal(extended2.extensionsUsed, 2);

    await assert.rejects(
      () => handler.respond('run-e', 'extend', undefined, 30),
      /Cannot extend/,
    );
    assert.equal(MAX_EXTENSIONS, 2);
  });

  it('listPending returns only pending breaches', async () => {
    const { ledger, handler } = makeHandler(home);
    recordOverLimit(ledger, 'run-p1', 'demo');
    recordOverLimit(ledger, 'run-p2', 'demo');
    await handler.evaluate('run-p1', 'demo', { limits: { perRun: 50 }, onBreach: 'ask' });
    await handler.evaluate('run-p2', 'demo', { limits: { perRun: 50 }, onBreach: 'ask' });

    assert.equal(handler.listPending().length, 2);
    await handler.respond('run-p1', 'raise', 10);
    assert.equal(handler.listPending().length, 1);
    assert.equal(handler.listPending()[0].runId, 'run-p2');
  });

  it('sweeper auto-resolves breaches whose grace has expired', async () => {
    const { ledger, handler, rejectCalls } = makeHandler(home);
    recordOverLimit(ledger, 'run-sw', 'demo');
    const state = await handler.evaluate('run-sw', 'demo', {
      limits: { perRun: 50 },
      graceWindowSeconds: 1,
      onBreach: 'ask',
    });
    assert.ok(state);

    // Force expiry by waiting past the 1s grace.
    await new Promise((r) => setTimeout(r, 1100));

    const sweeper = new CostBreachSweeper(handler, { intervalMs: 50 });
    await sweeper.tick();
    sweeper.stop();

    const resolved = handler.getBreach('run-sw');
    assert.ok(resolved);
    assert.equal(resolved.status, 'auto-resolved');
    assert.equal(resolved.decision, 'reject');
    assert.equal(rejectCalls.length, 1);
  });
});
