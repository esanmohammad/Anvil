/**
 * Phase 4 tests for SpendLedger + budget enforcement.
 *
 * Uses on-disk temp SQLite files (better-sqlite3 doesn't support
 * `:memory:` cleanly with WAL pragma). Each test gets its own file.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SpendLedger,
  LlmRouter,
  DEFAULT_RETRY_POLICY,
} from '../router/index.js';
import type {
  RouterConfig,
  SpendRow,
} from '../router/index.js';
import type {
  LanguageModel,
  LanguageModelInvokeOptions,
  InvokeResult,
  ProviderCapabilities,
} from '../types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const fakeCapabilities: ProviderCapabilities = {
  tier: 'function-calling',
  streaming: false,
  toolUse: false,
  fileSystem: false,
  shellExecution: false,
  sessionResume: false,
};

function fakeResult(costUsd: number, model = 'claude-sonnet-4-6'): InvokeResult {
  return {
    text: 'hi',
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd,
    durationMs: 1,
    provider: 'claude',
    model,
    finishReason: 'end',
  };
}

function fakeAdapter(behavior: () => Promise<InvokeResult>): LanguageModel {
  return {
    provider: 'claude',
    capabilities: fakeCapabilities,
    supportsModel: () => true,
    getModelPricing: () => null,
    checkAvailability: async () => ({ available: true }),
    invokeStream: async function* () {},
    invoke: behavior as (opts: LanguageModelInvokeOptions) => Promise<InvokeResult>,
  };
}

let tempDir = '';
let counter = 0;
function newLedgerPath(): string {
  counter += 1;
  return join(tempDir, `spend-${counter}.sqlite`);
}

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'anvil-spend-'));
});
after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SpendLedger direct tests
// ---------------------------------------------------------------------------

describe('SpendLedger (direct)', () => {
  it('round-trips a single row', () => {
    const ledger = new SpendLedger(newLedgerPath());
    const row: SpendRow = {
      id: 'r1',
      ts: new Date().toISOString(),
      runId: 'run-1',
      project: 'p',
      tag: 'planner',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0123,
      durationMs: 800,
      fallbackIndex: 0,
      attemptCount: 1,
    };
    ledger.record(row);
    assert.equal(ledger.count(), 1);
    assert.equal(ledger.totalUsd({ runId: 'run-1' }), 0.0123);
    ledger.close();
  });

  it('aggregates totals by tag', () => {
    const ledger = new SpendLedger(newLedgerPath());
    const ts = new Date().toISOString();
    const base = (id: string, tag: string, costUsd: number): SpendRow => ({
      id,
      ts,
      tag,
      provider: 'claude',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      costUsd,
      durationMs: 1,
      fallbackIndex: 0,
      attemptCount: 1,
    });
    ledger.record(base('1', 'planner', 0.01));
    ledger.record(base('2', 'planner', 0.02));
    ledger.record(base('3', 'reviewer', 0.05));

    const groups = ledger.groupBy('tag');
    const planner = groups.find((g) => g.key === 'planner');
    const reviewer = groups.find((g) => g.key === 'reviewer');
    assert.ok(planner && Math.abs(planner.totalUsd - 0.03) < 1e-9);
    assert.equal(planner.count, 2);
    assert.ok(reviewer && Math.abs(reviewer.totalUsd - 0.05) < 1e-9);
    ledger.close();
  });

  it('idempotent schema migration on existing file', () => {
    const path = newLedgerPath();
    const ledger1 = new SpendLedger(path);
    ledger1.close();
    // Reopen — must not throw, schema_version row already present.
    const ledger2 = new SpendLedger(path);
    assert.equal(ledger2.count(), 0);
    ledger2.close();
  });

  it('honors since/until time bounds', () => {
    const ledger = new SpendLedger(newLedgerPath());
    const t0 = '2026-04-29T00:00:00.000Z';
    const t1 = '2026-04-29T01:00:00.000Z';
    const t2 = '2026-04-29T02:00:00.000Z';
    const mk = (id: string, ts: string, c: number): SpendRow => ({
      id,
      ts,
      tag: 't',
      provider: 'claude',
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: c,
      durationMs: 0,
      fallbackIndex: 0,
      attemptCount: 1,
    });
    ledger.record(mk('a', t0, 1));
    ledger.record(mk('b', t1, 2));
    ledger.record(mk('c', t2, 4));
    assert.equal(ledger.totalUsd({ since: t1 }), 6);
    assert.equal(ledger.totalUsd({ until: t1 }), 1);
    assert.equal(ledger.totalUsd({ since: t1, until: t2 }), 2);
    ledger.close();
  });
});

// ---------------------------------------------------------------------------
// LlmRouter integration with ledger + budgets
// ---------------------------------------------------------------------------

describe('LlmRouter + SpendLedger', () => {
  it('writes a spend row on each successful call', async () => {
    const ledger = new SpendLedger(newLedgerPath());
    const router = new LlmRouter({
      config: {
        routes: [{ tag: 'planner', primary: 'claude-sonnet-4-6' }],
        retryPolicy: DEFAULT_RETRY_POLICY,
      },
      resolver: { resolve: () => fakeAdapter(async () => fakeResult(0.005)) },
      ledger,
    });
    await router.invoke({ tag: 'planner', prompt: 'q', runId: 'r-A' });
    await router.invoke({ tag: 'planner', prompt: 'q', runId: 'r-A' });
    assert.equal(ledger.count(), 2);
    assert.ok(Math.abs(ledger.totalUsd({ runId: 'r-A' }) - 0.01) < 1e-9);
    ledger.close();
  });

  it('writes a row even when the call fails terminally', async () => {
    const ledger = new SpendLedger(newLedgerPath());
    const router = new LlmRouter({
      config: {
        routes: [{ tag: 'planner', primary: 'claude-sonnet-4-6' }],
        retryPolicy: DEFAULT_RETRY_POLICY,
      },
      resolver: {
        resolve: () =>
          fakeAdapter(async () => {
            throw Object.assign(new Error('unauthorized'), { status: 401 });
          }),
      },
      ledger,
    });
    await assert.rejects(router.invoke({ tag: 'planner', prompt: 'q', runId: 'r-fail' }));
    assert.equal(ledger.count(), 1);
    const recent = ledger.recent(1);
    assert.equal(recent[0].errorClass, 'auth');
    assert.equal(recent[0].costUsd, 0);
    ledger.close();
  });

  it('blocks calls when perRunUsd budget is exhausted (onBreach=fail)', async () => {
    const ledger = new SpendLedger(newLedgerPath());
    const config: RouterConfig = {
      routes: [{ tag: 'planner', primary: 'claude-sonnet-4-6' }],
      retryPolicy: DEFAULT_RETRY_POLICY,
      budgets: { perRunUsd: 0.005, onBreach: 'fail' },
    };
    const router = new LlmRouter({
      config,
      resolver: { resolve: () => fakeAdapter(async () => fakeResult(0.004)) },
      ledger,
    });
    // First call uses 0.004 — under budget.
    const out1 = await router.invoke({ tag: 'planner', prompt: 'q', runId: 'r-bud' });
    assert.ok(out1.budgetRemainingUsd !== undefined && out1.budgetRemainingUsd > 0);
    // Second call brings spend to 0.008 — over budget; rejected pre-flight.
    await router.invoke({ tag: 'planner', prompt: 'q', runId: 'r-bud' });
    await assert.rejects(
      router.invoke({ tag: 'planner', prompt: 'q', runId: 'r-bud' }),
      /budget exhausted/i,
    );
    ledger.close();
  });

  it('exposes budgetRemainingUsd on the outcome', async () => {
    const ledger = new SpendLedger(newLedgerPath());
    const config: RouterConfig = {
      routes: [{ tag: 'planner', primary: 'claude-sonnet-4-6' }],
      retryPolicy: DEFAULT_RETRY_POLICY,
      budgets: { perRunUsd: 1.0, onBreach: 'fail' },
    };
    const router = new LlmRouter({
      config,
      resolver: { resolve: () => fakeAdapter(async () => fakeResult(0.1)) },
      ledger,
    });
    const out = await router.invoke({ tag: 'planner', prompt: 'q', runId: 'r-b2' });
    assert.ok(out.budgetRemainingUsd !== undefined);
    assert.ok(Math.abs(out.budgetRemainingUsd - 0.9) < 1e-9, `expected ~0.9, got ${out.budgetRemainingUsd}`);
    ledger.close();
  });
});
