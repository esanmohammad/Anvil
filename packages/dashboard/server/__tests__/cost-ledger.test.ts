/**
 * Tests for CostLedger — record/summarize, daily totals, topSpenders,
 * and recovery from a malformed NDJSON line.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  appendFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CostLedger } from '../cost-ledger.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-cost-'));
}

describe('CostLedger', () => {
  let home: string;
  let ledger: CostLedger;

  beforeEach(() => {
    home = tmpHome();
    ledger = new CostLedger(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('record() writes to both run and daily files and computes usd', () => {
    const entry = ledger.record({
      runId: 'run-1',
      project: 'demo',
      stage: 'plan',
      agent: 'planner',
      model: 'claude-sonnet-4-6',
      tokensIn: 1_000_000,
      tokensOut: 0,
    });
    assert.equal(entry.usd, 3);
    assert.ok(entry.id);
    assert.ok(entry.at);

    const runFile = join(home, 'cost-ledger', 'demo', 'run-1.ndjson');
    assert.ok(existsSync(runFile));

    const day = entry.at.slice(0, 10);
    const dailyFile = join(home, 'cost-ledger', 'demo', 'daily', `${day}.ndjson`);
    assert.ok(existsSync(dailyFile));

    const runLines = readFileSync(runFile, 'utf-8').split('\n').filter(Boolean);
    assert.equal(runLines.length, 1);
  });

  it('summarize() folds entries into totals by stage/model/agent', () => {
    ledger.record({
      runId: 'run-s', project: 'demo', stage: 'plan', agent: 'planner',
      model: 'claude-sonnet-4-6', tokensIn: 1_000_000, tokensOut: 0,
    }); // $3
    ledger.record({
      runId: 'run-s', project: 'demo', stage: 'implement', agent: 'coder',
      model: 'claude-opus-4-7', tokensIn: 0, tokensOut: 1_000_000,
    }); // $75
    ledger.record({
      runId: 'run-s', project: 'demo', stage: 'implement', agent: 'coder',
      model: 'claude-haiku-4-5', tokensIn: 1_000_000, tokensOut: 1_000_000,
    }); // $1 + $5 = $6

    const s = ledger.summarize('run-s', 'demo');
    assert.equal(s.runId, 'run-s');
    assert.equal(s.project, 'demo');
    assert.equal(s.totalUsd, 84);
    assert.equal(s.totalTokensIn, 2_000_000);
    assert.equal(s.totalTokensOut, 2_000_000);
    assert.equal(s.byStage.plan, 3);
    assert.equal(s.byStage.implement, 81);
    assert.equal(s.byModel['claude-opus-4-7'], 75);
    assert.equal(s.byAgent.planner, 3);
    assert.equal(s.byAgent.coder, 81);
    assert.ok(s.startedAt);
    assert.ok(s.lastAt);
  });

  it('summarize() returns zeroed totals for an unknown run', () => {
    const s = ledger.summarize('ghost', 'demo');
    assert.equal(s.totalUsd, 0);
    assert.equal(s.totalTokensIn, 0);
    for (const v of Object.values(s.byStage)) assert.equal(v, 0);
  });

  it('projectDailyTotal sums entries across runs for a day', () => {
    const today = new Date().toISOString().slice(0, 10);
    ledger.record({
      runId: 'r1', project: 'demo', stage: 'plan', model: 'claude-sonnet-4-6',
      tokensIn: 1_000_000, tokensOut: 0,
    }); // $3
    ledger.record({
      runId: 'r2', project: 'demo', stage: 'plan', model: 'claude-sonnet-4-6',
      tokensIn: 500_000, tokensOut: 0,
    }); // $1.5

    const total = ledger.projectDailyTotal('demo', today);
    assert.equal(total, 4.5);
  });

  it('projectDailyTotal separates different days', () => {
    // Write directly into the daily file paths to inject a specific date.
    const d1 = '2025-01-01';
    const d2 = '2025-01-02';
    ledger.record({
      runId: 'r-d1', project: 'demo', stage: 'plan', model: 'claude-sonnet-4-6',
      tokensIn: 1_000_000, tokensOut: 0, at: `${d1}T10:00:00.000Z`,
    });
    ledger.record({
      runId: 'r-d2', project: 'demo', stage: 'plan', model: 'claude-sonnet-4-6',
      tokensIn: 2_000_000, tokensOut: 0, at: `${d2}T10:00:00.000Z`,
    });

    assert.equal(ledger.projectDailyTotal('demo', d1), 3);
    assert.equal(ledger.projectDailyTotal('demo', d2), 6);
  });

  it('topSpenders returns stages ordered by usd descending', () => {
    ledger.record({
      runId: 'run-t', project: 'demo', stage: 'plan', model: 'claude-sonnet-4-6',
      tokensIn: 1_000_000, tokensOut: 0,
    }); // $3
    ledger.record({
      runId: 'run-t', project: 'demo', stage: 'implement', model: 'claude-opus-4-7',
      tokensIn: 0, tokensOut: 1_000_000,
    }); // $75
    ledger.record({
      runId: 'run-t', project: 'demo', stage: 'review', model: 'claude-haiku-4-5',
      tokensIn: 100_000, tokensOut: 0,
    }); // $0.1

    const top = ledger.topSpenders('run-t', 3);
    assert.equal(top.length, 3);
    assert.equal(top[0].stage, 'implement');
    assert.equal(top[1].stage, 'plan');
    assert.equal(top[2].stage, 'review');
    assert.ok(top[0].usd > top[1].usd);
    assert.ok(top[1].usd > top[2].usd);
  });

  it('recovers from a malformed NDJSON line and still summarizes valid ones', () => {
    ledger.record({
      runId: 'run-m', project: 'demo', stage: 'plan', model: 'claude-sonnet-4-6',
      tokensIn: 1_000_000, tokensOut: 0,
    });
    // Inject a garbage line between the valid entries.
    const runFile = join(home, 'cost-ledger', 'demo', 'run-m.ndjson');
    appendFileSync(runFile, '{not-valid-json\n', 'utf-8');
    ledger.record({
      runId: 'run-m', project: 'demo', stage: 'plan', model: 'claude-sonnet-4-6',
      tokensIn: 500_000, tokensOut: 0,
    });

    const s = ledger.summarize('run-m', 'demo');
    // 3 + 1.5 = 4.5 — the garbage line is skipped.
    assert.equal(s.totalUsd, 4.5);
  });

  it('recentEntries honors limit and keeps newest-last ordering', () => {
    for (let i = 0; i < 5; i += 1) {
      ledger.record({
        runId: 'run-r', project: 'demo', stage: 'plan', model: 'claude-sonnet-4-6',
        tokensIn: (i + 1) * 1_000, tokensOut: 0,
      });
    }
    const recent = ledger.recentEntries('demo', 'run-r', 3);
    assert.equal(recent.length, 3);
    // The last recorded had 5*1000 tokens.
    assert.equal(recent[recent.length - 1].tokensIn, 5000);
  });
});
