#!/usr/bin/env node
/**
 * seed-mvp2-demo — populate ~/.anvil/ with realistic data for the
 * space-company project so the dashboard looks lived-in when the user
 * dogfoods MVP 2 over the weekend.
 *
 * Idempotent-ish: running it a second time appends more entries.
 * To start fresh, delete the subdirs under ~/.anvil/ for space-company.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

const ANVIL_HOME = process.env.ANVIL_HOME ?? join(homedir(), '.anvil');
const PROJECT = 'space-company';
const BASE = '/Users/esanmohammad/prototyping/Anvil/packages/cli/dist/dashboard/server';

const { PipelinePauseStore }        = await import(`${BASE}/pipeline-pause-store.js`);
const { CostLedger }                = await import(`${BASE}/cost-ledger.js`);
const { CostBreachHandler }         = await import(`${BASE}/cost-breach-handler.js`);
const { PipelineLearningsStore }    = await import(`${BASE}/pipeline-learnings-store.js`);
const { PipelineReviewersStore }    = await import(`${BASE}/pipeline-reviewers-store.js`);
const { PipelineAuditLog }          = await import(`${BASE}/pipeline-audit-log.js`);
const { BlobStore }                 = await import(`${BASE}/checkpoint-blob-store.js`);
const { CheckpointStore }           = await import(`${BASE}/checkpoint-store.js`);
const { computeKey }                = await import(`${BASE}/checkpoint-key.js`);

const now = new Date();
const daysAgo = (n) => new Date(now.getTime() - n * 86_400_000).toISOString();
const hoursAgo = (n) => new Date(now.getTime() - n * 3_600_000).toISOString();
const minutesAgo = (n) => new Date(now.getTime() - n * 60_000).toISOString();

// ── Pipeline pauses ──────────────────────────────────────────────────────
const pauseStore = new PipelinePauseStore(ANVIL_HOME);

const pauses = [
  // Live pause — still awaiting user
  {
    runId: 'run-booking-refactor',
    project: PROJECT,
    stage: 'plan',
    reason: 'paused by rule: web/src/pages/BookingPage.tsx',
    matchedRules: ['web/src/pages/BookingPage.tsx'],
    reviewers: ['frontend-leads', 'alice'],
    timeoutHours: 2,
  },
  // Completed pause — approved 3h ago
  {
    runId: 'run-rocket-seat-tiers',
    project: PROJECT,
    stage: 'plan',
    reason: 'paused by rule: ui/src/components/**',
    matchedRules: ['ui/src/components/**'],
    reviewers: ['design-system-owners'],
    timeoutHours: 4,
  },
  // Completed pause — cancelled
  {
    runId: 'run-legacy-cleanup',
    project: PROJECT,
    stage: 'review',
    reason: 'paused by rule: ui/src/tokens/**',
    matchedRules: ['ui/src/tokens/**'],
    reviewers: ['design-system-owners'],
    timeoutHours: 6,
  },
];

for (const p of pauses) pauseStore.pause(p);
pauseStore.resume('run-rocket-seat-tiers', {
  action: 'approve',
  note: 'Looks clean — matches the tier decision from last week.',
}, 'alice');
pauseStore.cancel('run-legacy-cleanup', 'bob');

console.log(`✓ pauses: ${pauseStore.list({ project: PROJECT }).length} records`);

// ── Reviewers + audit log ────────────────────────────────────────────────
const reviewersStore = new PipelineReviewersStore(ANVIL_HOME);
const auditLog = new PipelineAuditLog(ANVIL_HOME);

for (const p of pauses) {
  reviewersStore.assign({
    runId: p.runId,
    project: PROJECT,
    reviewers: p.reviewers,
    approvalsRequired: p.reviewers.length > 1 ? 2 : 1,
  });
  auditLog.record({
    runId: p.runId, project: PROJECT,
    event: 'paused', actor: 'system',
    details: { reviewers: p.reviewers, reason: p.reason },
  });
}

reviewersStore.recordApproval('run-rocket-seat-tiers', 'alice', 'approve', 'Ship it.');
auditLog.record({
  runId: 'run-rocket-seat-tiers', project: PROJECT,
  event: 'approved', actor: 'alice',
  details: { note: 'Ship it.' },
});

reviewersStore.recordApproval('run-legacy-cleanup', 'bob', 'reject', 'Scope too broad — split into 3 PRs.');
auditLog.record({
  runId: 'run-legacy-cleanup', project: PROJECT,
  event: 'rejected', actor: 'bob',
  details: { note: 'Scope too broad — split into 3 PRs.' },
});

// Reassign case on the live pause
reviewersStore.reassign('run-booking-refactor', ['frontend-leads', 'alice', 'carol'], 'system');
auditLog.record({
  runId: 'run-booking-refactor', project: PROJECT,
  event: 'reassigned', actor: 'system',
  details: { added: ['carol'] },
});

console.log(`✓ reviewers + audit: 3 assignments, ${auditLog.tail(PROJECT, 10).length} audit entries`);

// ── Plan-approval learnings ─────────────────────────────────────────────
const learnings = new PipelineLearningsStore(ANVIL_HOME);

const learningsData = [
  { outcome: 'approved',  dirs: ['docs'],            risk: 'low',  conf: 0.92, latency: 45_000,   decidedAt: daysAgo(6) },
  { outcome: 'approved',  dirs: ['web/src/pages'],   risk: 'med',  conf: 0.78, latency: 420_000,  decidedAt: daysAgo(5), path: 'web/src/pages' },
  { outcome: 'modified',  dirs: ['ui/src/components'], risk: 'med', conf: 0.65, latency: 780_000, decidedAt: daysAgo(5), path: 'ui/src/components',
    mods: { filesAdded: ['ui/src/components/SeatPicker/SeatPicker.test.tsx'], filesRemoved: [], notes: 'Added missing test file.' } },
  { outcome: 'rejected',  dirs: ['ui/src/tokens'],   risk: 'high', conf: 0.58, latency: 1_200_000, decidedAt: daysAgo(4), path: 'ui/src/tokens',
    reason: 'Token rename would break every downstream consumer — needs coordinated migration.' },
  { outcome: 'approved',  dirs: ['docs'],            risk: 'low',  conf: 0.95, latency: 12_000,   decidedAt: daysAgo(4) },
  { outcome: 'approved',  dirs: ['web/src/components/BookingForm'], risk: 'med', conf: 0.82, latency: 210_000, decidedAt: daysAgo(3), path: 'web/src/components/BookingForm' },
  { outcome: 'modified',  dirs: ['tsconfig'],        risk: 'med',  conf: 0.70, latency: 540_000,  decidedAt: daysAgo(3), path: 'tsconfig',
    mods: { filesAdded: [], filesRemoved: [], notes: 'Narrowed lib target — safer for Node-only consumers.' } },
  { outcome: 'rejected',  dirs: ['ui/src/tokens'],   risk: 'high', conf: 0.61, latency: 960_000,  decidedAt: daysAgo(2), path: 'ui/src/tokens',
    reason: 'Same blast-radius concern. Plan didn\'t update consumers.' },
  { outcome: 'approved',  dirs: ['web/src/pages'],   risk: 'low',  conf: 0.93, latency: 60_000,   decidedAt: daysAgo(2), path: 'web/src/pages' },
  { outcome: 'approved',  dirs: ['eslint-config'],   risk: 'low',  conf: 0.97, latency: 30_000,   decidedAt: daysAgo(1) },
  { outcome: 'modified',  dirs: ['web/src/pages'],   risk: 'med',  conf: 0.74, latency: 690_000,  decidedAt: daysAgo(1), path: 'web/src/pages',
    mods: { filesAdded: ['web/src/pages/__tests__/BookingPage.test.tsx'], filesRemoved: [], notes: 'Added regression coverage for seat-picker bug.' } },
  { outcome: 'timed-out', dirs: ['web/src/components/BookingForm'], risk: 'med', conf: 0.68, latency: 7_200_000, decidedAt: hoursAgo(6), path: 'web/src/components/BookingForm' },
];

for (const [i, d] of learningsData.entries()) {
  const input = {
    runId: `learn-${String(i + 1).padStart(3, '0')}`,
    planVersion: 1,
    outcome: d.outcome,
    riskTier: d.risk,
    riskOverall: d.risk === 'low' ? 0.22 : d.risk === 'med' ? 0.55 : 0.82,
    confidence: d.conf,
    touchedTopLevelDirs: d.dirs,
    decisionLatencyMs: d.latency,
    decidedAt: d.decidedAt,
    approvedBy: d.outcome === 'approved' ? 'alice' : d.outcome === 'modified' ? 'bob' : undefined,
  };
  if (d.mods) input.modifications = d.mods;
  if (d.reason) input.rejectionReason = d.reason;
  learnings.record(PROJECT, input);
}

const stats = learnings.computeStats(PROJECT);
console.log(`✓ learnings: ${stats.totalPlans} records, approval ${(stats.approvalRate * 100).toFixed(0)}%, modification ${(stats.modificationRate * 100).toFixed(0)}%`);

// ── Cost ledger ──────────────────────────────────────────────────────────
const ledger = new CostLedger(ANVIL_HOME);

// Run 1 — completed successfully
const run1 = 'run-booking-refactor';
const run1Entries = [
  { stage: 'plan',      agent: 'planner',        model: 'claude-opus-4-7',    tokensIn: 8_400,  tokensOut: 2_200, minAgo: 50 },
  { stage: 'plan',      agent: 'plan-validator', model: 'claude-sonnet-4-6',  tokensIn: 3_100,  tokensOut: 850,   minAgo: 48 },
  { stage: 'implement', agent: 'engineer',       model: 'claude-sonnet-4-6',  tokensIn: 24_000, tokensOut: 8_200, minAgo: 42 },
  { stage: 'implement', agent: 'engineer',       model: 'claude-sonnet-4-6',  tokensIn: 19_500, tokensOut: 5_100, minAgo: 38 },
  { stage: 'review',    agent: 'security-reviewer',  model: 'claude-sonnet-4-6', tokensIn: 12_000, tokensOut: 1_800, minAgo: 30 },
  { stage: 'review',    agent: 'convention-reviewer',model: 'claude-haiku-4-5-20251001', tokensIn: 9_200, tokensOut: 1_400, minAgo: 29 },
  { stage: 'test',      agent: 'test-author',    model: 'claude-sonnet-4-6',  tokensIn: 15_800, tokensOut: 6_400, minAgo: 22 },
  { stage: 'ship',      agent: 'shipper',        model: 'claude-haiku-4-5-20251001', tokensIn: 4_500,  tokensOut: 900, minAgo: 15 },
];
for (const e of run1Entries) {
  ledger.record({ runId: run1, project: PROJECT, stage: e.stage, agent: e.agent, model: e.model,
    tokensIn: e.tokensIn, tokensOut: e.tokensOut, at: minutesAgo(e.minAgo) });
}

// Run 2 — ran hot and breached
const run2 = 'run-rocket-seat-tiers';
const run2Entries = [
  { stage: 'plan',      agent: 'planner',    model: 'claude-opus-4-7',   tokensIn: 10_200, tokensOut: 3_500, hrAgo: 4 },
  { stage: 'implement', agent: 'engineer',   model: 'claude-opus-4-7',   tokensIn: 62_000, tokensOut: 18_000, hrAgo: 3.5 },
  { stage: 'implement', agent: 'engineer',   model: 'claude-opus-4-7',   tokensIn: 48_000, tokensOut: 12_500, hrAgo: 3 },
  { stage: 'review',    agent: 'security-reviewer', model: 'claude-sonnet-4-6', tokensIn: 18_000, tokensOut: 2_400, hrAgo: 2.5 },
  { stage: 'test',      agent: 'test-author',       model: 'claude-sonnet-4-6', tokensIn: 22_000, tokensOut: 9_800, hrAgo: 2 },
];
for (const e of run2Entries) {
  ledger.record({ runId: run2, project: PROJECT, stage: e.stage, agent: e.agent, model: e.model,
    tokensIn: e.tokensIn, tokensOut: e.tokensOut, at: hoursAgo(e.hrAgo) });
}

// Run 3 — smaller, docs-only
const run3 = 'run-docs-readme';
ledger.record({ runId: run3, project: PROJECT, stage: 'plan', agent: 'planner',
  model: 'claude-haiku-4-5-20251001', tokensIn: 2_800, tokensOut: 900, at: hoursAgo(1) });
ledger.record({ runId: run3, project: PROJECT, stage: 'implement', agent: 'engineer',
  model: 'claude-haiku-4-5-20251001', tokensIn: 3_400, tokensOut: 1_100, at: minutesAgo(55) });
ledger.record({ runId: run3, project: PROJECT, stage: 'ship', agent: 'shipper',
  model: 'claude-haiku-4-5-20251001', tokensIn: 1_800, tokensOut: 450, at: minutesAgo(50) });

const s1 = ledger.summarize(run1);
const s2 = ledger.summarize(run2);
const s3 = ledger.summarize(run3);
console.log(`✓ cost ledger: run1 $${s1.totalUsd.toFixed(2)}, run2 $${s2.totalUsd.toFixed(2)}, run3 $${s3.totalUsd.toFixed(2)}`);

// ── Cost breach (run2 went over the $10 limit) ───────────────────────────
const breachHandler = new CostBreachHandler({
  ledger,
  storeDir: join(ANVIL_HOME, 'cost-breaches'),
  onNotify: () => {},
  onRejectStop: () => {},
});
// Use a lower per-run limit so the simulated run actually breaches.
await breachHandler.evaluate(run2, PROJECT, {
  limits: { perRun: 3.00, perProjectDaily: 30.00 },
  graceWindowSeconds: 60,
  onBreach: 'ask',
  autoApproveBelow: 0.15,
});
const existingBreach = breachHandler.getBreach(run2);
if (existingBreach && existingBreach.status === 'pending') {
  breachHandler.respond(run2, 'raise', 5.00);
  console.log(`✓ cost breach: run2 breached $${existingBreach.currentUsdAtBreach.toFixed(2)} / $${existingBreach.limitUsdAtBreach.toFixed(2)} → raised by $5`);
} else {
  console.log(`  (no breach persisted for run2 — current: $${s2.totalUsd.toFixed(2)})`);
}

// ── Checkpoints ──────────────────────────────────────────────────────────
const blobStore = new BlobStore(ANVIL_HOME);
const checkpointStore = new CheckpointStore({ anvilHome: ANVIL_HOME, blobStore });

const runFamily = 'fam-booking-refactor';

const ckptSamples = [
  { stage: 'plan',      taskId: 'plan:root',                 output: '{"feature":"booking refactor","steps":[...]}' },
  { stage: 'implement', taskId: 'impl:web/src/pages/BookingPage.tsx', output: 'diff --git a/web/src/pages/BookingPage.tsx ...' },
  { stage: 'implement', taskId: 'impl:web/src/components/BookingForm/index.tsx', output: 'diff --git a/web/src/components/...' },
  { stage: 'review',    taskId: 'review:security-tester',    output: '[{"finding":"no XSS risk detected"}]' },
  { stage: 'review',    taskId: 'review:edge-case-hunter',   output: '[{"finding":"missing boundary test for max-seats"}]' },
  { stage: 'test',      taskId: 'test:BookingPage',          output: '{"behaviors":[...],"cases":[...]}' },
];

for (const sample of ckptSamples) {
  const blob = blobStore.write(sample.output);
  const key = computeKey(runFamily, {
    stage: sample.stage, taskId: sample.taskId,
    inputs: { prompt: `persona:${sample.stage}`, file: sample.taskId },
    promptVersion: '1', model: 'claude-sonnet-4-6',
  });
  checkpointStore.write(PROJECT, {
    key, project: PROJECT, status: 'completed',
    outputRef: blob.sha,
    cost: { usd: 0.08 + Math.random() * 0.2, tokensIn: 8_000, tokensOut: 1_500 },
    startedAt: minutesAgo(45), completedAt: minutesAgo(44), durationMs: 45_000,
  });
}

const ckptStats = checkpointStore.stats(PROJECT, runFamily);
console.log(`✓ checkpoints: ${ckptStats.total} records, hit rate ${(ckptStats.hitRate * 100).toFixed(0)}%`);

// ── Summary ──────────────────────────────────────────────────────────────
console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('MVP 2 demo data seeded into ~/.anvil for project "space-company".');
console.log('═══════════════════════════════════════════════════════════════');
console.log('What to look at:');
console.log('  1. Tests tab           — existing test specs for rocket booking');
console.log('  2. Incidents panel     — bound tests + replay history');
console.log('  3. Insights page       — plan-approval stats (should show 12 records)');
console.log('  4. Active Runs         — paused run "run-booking-refactor" awaiting you');
console.log('  5. Knowledge Graph     — 4 repos, 133 nodes, project graph ready');
console.log('');
console.log('To enable live behavior:');
console.log('  ANVIL_POLICY_ENABLED=1 \\');
console.log('  ANVIL_COST_LIMITS_ENABLED=1 \\');
console.log('  ANVIL_CHECKPOINTS_ENABLED=1 \\');
console.log('    anvil dashboard');
console.log('');
