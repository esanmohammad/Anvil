/**
 * cost-bridge — verifies that BridgedCostLedger writes a matching SpendRow
 * for every CostLedger.record(), and that daily summaries from both stores
 * agree to within $0.0001.
 *
 * Phase 3 of the dashboard consolidation.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SpendLedger } from '@anvil/agent-core';

import {
  BridgedCostLedger,
  costEntryToSpendRow,
  inferProvider,
  __resetCostBridgeWarnedForTests,
} from '../cost-bridge.js';
import type { CostEntry } from '../cost-types.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-cost-bridge-'));
}

function makeBridge(home: string): { bridge: BridgedCostLedger; spend: SpendLedger; spendPath: string } {
  const spendPath = join(home, 'router', 'spend.sqlite');
  const spend = new SpendLedger(spendPath);
  const bridge = new BridgedCostLedger(home, { spendLedger: spend });
  return { bridge, spend, spendPath };
}

describe('inferProvider', () => {
  it('maps claude-* to anthropic', () => {
    assert.equal(inferProvider('claude-opus-4-7'), 'anthropic');
    assert.equal(inferProvider('claude-sonnet-4-6'), 'anthropic');
  });

  it('maps gpt-/o1-/o3-/o4- to openai', () => {
    assert.equal(inferProvider('gpt-4o'), 'openai');
    assert.equal(inferProvider('o1-preview'), 'openai');
    assert.equal(inferProvider('o3-mini'), 'openai');
    assert.equal(inferProvider('o4'), 'openai');
  });

  it('maps gemini-* to google', () => {
    assert.equal(inferProvider('gemini-2.5-pro'), 'google');
  });

  it('maps llama / mistral / qwen / phi to ollama', () => {
    assert.equal(inferProvider('llama3.1'), 'ollama');
    assert.equal(inferProvider('mistral-large'), 'ollama');
    assert.equal(inferProvider('qwen2.5'), 'ollama');
    assert.equal(inferProvider('phi-4'), 'ollama');
  });

  it('falls back to unknown for unfamiliar ids', () => {
    assert.equal(inferProvider('some-random-model'), 'unknown');
  });
});

describe('costEntryToSpendRow', () => {
  it('maps every CostEntry field to the matching SpendRow field', () => {
    const entry: CostEntry = {
      id: 'cost-id',
      runId: 'run-1',
      project: 'demo',
      stage: 'plan',
      agent: 'planner',
      model: 'claude-opus-4-7',
      tokensIn: 1234,
      tokensOut: 567,
      cacheReadTokens: 89,
      cacheWriteTokens: 12,
      usd: 0.5,
      at: '2026-04-29T00:00:00.000Z',
    };
    const row = costEntryToSpendRow(entry);
    assert.equal(row.runId, 'run-1');
    assert.equal(row.project, 'demo');
    assert.equal(row.tag, 'plan');
    assert.equal(row.provider, 'anthropic');
    assert.equal(row.model, 'claude-opus-4-7');
    assert.equal(row.inputTokens, 1234);
    assert.equal(row.outputTokens, 567);
    assert.equal(row.cacheReadTokens, 89);
    assert.equal(row.cacheWriteTokens, 12);
    assert.equal(row.costUsd, 0.5);
    assert.equal(row.ts, entry.at);
    assert.equal(row.durationMs, 0);
    assert.equal(row.fallbackIndex, 0);
    assert.equal(row.attemptCount, 1);
    // SpendRow id is independent of CostEntry id.
    assert.notEqual(row.id, entry.id);
    assert.ok(row.id.startsWith('cb-'));
  });

  it('defaults missing cache token counts to 0', () => {
    const entry: CostEntry = {
      id: 'cost-id',
      runId: 'run-1',
      project: 'demo',
      stage: 'other',
      model: 'claude-sonnet-4-6',
      tokensIn: 100,
      tokensOut: 200,
      usd: 0.001,
      at: '2026-04-29T00:00:00.000Z',
    };
    const row = costEntryToSpendRow(entry);
    assert.equal(row.cacheReadTokens, 0);
    assert.equal(row.cacheWriteTokens, 0);
  });
});

describe('BridgedCostLedger', () => {
  let home: string;

  beforeEach(() => {
    home = tmpHome();
    __resetCostBridgeWarnedForTests();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('subclasses CostLedger and preserves the public surface', () => {
    const { bridge, spend } = makeBridge(home);
    bridge.record({
      runId: 'run-1', project: 'demo', stage: 'plan',
      model: 'claude-sonnet-4-6', tokensIn: 1_000_000, tokensOut: 0,
    });
    // CostLedger reads still work.
    const summary = bridge.summarize('run-1', 'demo');
    assert.equal(summary.totalUsd, 3);
    assert.equal(summary.byStage.plan, 3);
    spend.close();
  });

  it('record() writes a SpendRow for every CostEntry', () => {
    const { bridge, spend, spendPath } = makeBridge(home);
    const inputs = [
      { runId: 'run-1', project: 'demo', stage: 'plan' as const, model: 'claude-sonnet-4-6', tokensIn: 1000, tokensOut: 500 },
      { runId: 'run-1', project: 'demo', stage: 'implement' as const, model: 'claude-opus-4-7', tokensIn: 2000, tokensOut: 800 },
      { runId: 'run-1', project: 'demo', stage: 'review' as const, model: 'claude-haiku-4-5', tokensIn: 300, tokensOut: 100 },
    ];
    const entries = inputs.map((input) => bridge.record(input));

    assert.ok(existsSync(spendPath), 'SpendLedger sqlite file created');
    assert.equal(spend.count(), entries.length);

    // SQLite `ORDER BY ts` ties when records land in the same ms — match
    // pairs by (tag, model) instead of relying on row order.
    const spendRows = spend.recent(100);
    for (const e of entries) {
      const r = spendRows.find((row) => row.tag === e.stage && row.model === e.model);
      assert.ok(r, `no SpendRow found for stage=${e.stage} model=${e.model}`);
      assert.equal(r.runId, e.runId);
      assert.equal(r.project, e.project);
      assert.equal(r.inputTokens, e.tokensIn);
      assert.equal(r.outputTokens, e.tokensOut);
      assert.equal(r.costUsd, e.usd);
    }
    spend.close();
  });

  it('SpendLedger total agrees with CostLedger summary to within $0.0001', () => {
    const { bridge, spend } = makeBridge(home);
    const inputs = [
      { runId: 'run-1', project: 'demo', stage: 'plan' as const, model: 'claude-opus-4-7', tokensIn: 1234, tokensOut: 567 },
      { runId: 'run-1', project: 'demo', stage: 'implement' as const, model: 'claude-sonnet-4-6', tokensIn: 8901, tokensOut: 234 },
      { runId: 'run-1', project: 'demo', stage: 'review' as const, model: 'claude-haiku-4-5', tokensIn: 555, tokensOut: 666 },
    ];
    for (const input of inputs) bridge.record(input);

    const dashTotal = bridge.summarize('run-1', 'demo').totalUsd;
    const routerTotal = spend.totalUsd({ runId: 'run-1', project: 'demo' });

    assert.ok(
      Math.abs(dashTotal - routerTotal) < 1e-4,
      `expected within $0.0001, dash=${dashTotal} router=${routerTotal}`,
    );
    spend.close();
  });

  it('fires onMirror after a successful mirror write', () => {
    const spend = new SpendLedger(join(home, 'router', 'spend.sqlite'));
    const mirrors: Array<{ runId: string; tag: string; costUsd: number }> = [];
    const bridge = new BridgedCostLedger(home, {
      spendLedger: spend,
      onMirror: (entry, row) => mirrors.push({ runId: row.runId!, tag: row.tag, costUsd: row.costUsd }),
    });
    bridge.record({
      runId: 'run-1', project: 'demo', stage: 'plan',
      model: 'claude-sonnet-4-6', tokensIn: 1000, tokensOut: 500,
    });
    assert.equal(mirrors.length, 1);
    assert.equal(mirrors[0].runId, 'run-1');
    assert.equal(mirrors[0].tag, 'plan');
    assert.ok(mirrors[0].costUsd > 0);
    spend.close();
  });

  it('SpendLedger failures are isolated — CostLedger record still returns a valid entry', () => {
    const spend = new SpendLedger(join(home, 'router', 'spend.sqlite'));
    spend.close(); // force every later record() to throw on a closed db

    const errors: unknown[] = [];
    const bridge = new BridgedCostLedger(home, {
      spendLedger: spend,
      onMirrorError: (_entry, error) => errors.push(error),
    });

    const entry = bridge.record({
      runId: 'run-1', project: 'demo', stage: 'plan',
      model: 'claude-sonnet-4-6', tokensIn: 1000, tokensOut: 0,
    });

    assert.ok(entry.id);
    assert.equal(entry.usd, 0.003);
    assert.equal(errors.length, 1, 'mirror error reported once');
    // CostLedger NDJSON write succeeded — summarize works without the spend ledger.
    assert.equal(bridge.summarize('run-1', 'demo').totalUsd, 0.003);
  });

  it('different runs land in the same SpendLedger and remain queryable by runId', () => {
    const { bridge, spend } = makeBridge(home);
    bridge.record({
      runId: 'run-A', project: 'demo', stage: 'plan',
      model: 'claude-sonnet-4-6', tokensIn: 1000, tokensOut: 0,
    });
    bridge.record({
      runId: 'run-B', project: 'demo', stage: 'plan',
      model: 'claude-sonnet-4-6', tokensIn: 2000, tokensOut: 0,
    });
    assert.equal(spend.count({ runId: 'run-A' }), 1);
    assert.equal(spend.count({ runId: 'run-B' }), 1);
    assert.equal(spend.count({ project: 'demo' }), 2);
    spend.close();
  });
});
