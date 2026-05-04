/**
 * Phase 4f.5 tests — `runFixLoop`, `hasValidationFailures`,
 * `extractRepoSection` are drop-in replacements for the same logic in
 * `pipeline-runner.ts`.
 *
 * Tests use a fake AgentManager so we exercise the spawn → wait + the
 * sendInput-resume path (P9: attempt > 1 reuses the prior agent).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractRepoSection,
  hasValidationFailures,
  runFixLoop,
} from '../steps/fix-loop.step.js';
import type { AgentManager, AgentState, SpawnConfig } from '@anvil/agent-core';

interface FakeOpts {
  /** Per-id-status sequence (default: each agent reports `done` on first poll). */
  statuses?: AgentState['status'][];
  /** Result the agent emits on `done`. */
  artifactByName?: Record<string, string>;
}

function fakeAgentManager(opts: FakeOpts = {}): {
  manager: AgentManager;
  spawned: SpawnConfig[];
  spawnedIds: string[];
  sendInputs: Array<{ agentId: string; text: string }>;
} {
  const spawned: SpawnConfig[] = [];
  const spawnedIds: string[] = [];
  const sendInputs: Array<{ agentId: string; text: string }> = [];
  const pollIndex = new Map<string, number>();
  const baseCost: AgentState['cost'] = {
    inputTokens: 0,
    outputTokens: 100,
    totalUsd: 0.001,
    stopReason: 'end_turn',
  } as AgentState['cost'];

  const manager = {
    spawn: (config: SpawnConfig): AgentState => {
      const id = `agent-${spawned.length + 1}`;
      spawned.push(config);
      spawnedIds.push(id);
      pollIndex.set(id, 0);
      return {
        id, name: config.name, persona: config.persona,
        sessionId: 's', model: config.model,
        status: 'pending', cost: baseCost, output: '', activities: [],
        startedAt: Date.now(), finishedAt: null, error: null,
      };
    },
    sendInput: (agentId: string, text: string) => {
      sendInputs.push({ agentId, text });
      // Reset polling so the next waitForAgent walks the statuses anew.
      pollIndex.set(agentId, 0);
    },
    getAgent: (id: string): AgentState | undefined => {
      // Test convenience: if the id has never been spawned, return
      // undefined so callers' "agent missing" branches fire.
      if (!spawnedIds.includes(id)) return undefined;
      const i = pollIndex.get(id) ?? 0;
      pollIndex.set(id, i + 1);
      const status: AgentState['status'] = opts.statuses
        ? (opts.statuses[i] ?? 'done')
        : 'done';
      const idx = spawnedIds.indexOf(id);
      const spec = spawned[idx];
      const finalArtifact = spec
        ? (opts.artifactByName?.[spec.name] ?? `art:${spec.name}`)
        : '';
      return {
        id,
        name: spec?.name ?? 'agent',
        persona: spec?.persona ?? 'engineer',
        sessionId: 's',
        model: spec?.model ?? 'claude',
        status,
        cost: status === 'done'
          ? { ...baseCost, totalUsd: 0.05, stopReason: 'end_turn' } as AgentState['cost']
          : baseCost,
        output: status === 'done' ? finalArtifact : '',
        activities: [],
        startedAt: 0,
        finishedAt: status === 'done' ? Date.now() : null,
        error: null,
      };
    },
  } as unknown as AgentManager;

  return { manager, spawned, spawnedIds, sendInputs };
}

const NO_SLEEP = async (_: number) => undefined;

// ── hasValidationFailures ───────────────────────────────────────────────

describe('hasValidationFailures', () => {
  it('returns true when VERDICT: FAIL is present (any case)', () => {
    assert.equal(hasValidationFailures('VERDICT: FAIL'), true);
    assert.equal(hasValidationFailures('verdict: fail'), true);
  });

  it('returns true when an UNRESOLVED marker is present', () => {
    assert.equal(hasValidationFailures('Some output\nUNRESOLVED: build broke'), true);
  });

  it('detects "tests failed" / "build failed" / "lint errored" phrases', () => {
    assert.equal(hasValidationFailures('the tests failed'), true);
    assert.equal(hasValidationFailures('build failed with 3 errors'), true);
    assert.equal(hasValidationFailures('lint errored'), true);
    assert.equal(hasValidationFailures('typecheck failed in api'), true);
  });

  it('detects CI failure glyphs / FAIL: / FAILED:', () => {
    assert.equal(hasValidationFailures('  ✗ test foo'), true);
    assert.equal(hasValidationFailures('FAILED: 3 specs'), true);
    assert.equal(hasValidationFailures('FAIL: test bar'), true);
  });

  it('detects "N failed" / "N failing" count summaries', () => {
    assert.equal(hasValidationFailures('Tests:       3 failed, 5 passed'), true);
    assert.equal(hasValidationFailures('2 failing'), true);
    assert.equal(hasValidationFailures('0 failed'), false);
  });

  it('returns false on empty + healthy artifacts', () => {
    assert.equal(hasValidationFailures(''), false);
    assert.equal(hasValidationFailures('All tests passing.'), false);
    assert.equal(hasValidationFailures('Build PASS — lint PASS — tests PASS'), false);
  });

  it('PASS line with no FAIL is treated as healthy even if surrounding text mentions failures', () => {
    assert.equal(
      hasValidationFailures('Tests: PASS\nLint: PASS'),
      false,
    );
  });
});

// ── extractRepoSection ──────────────────────────────────────────────────

describe('extractRepoSection', () => {
  const ARTIFACT = `## api

Tests passed.

---

## web

Tests failed.

---

## worker

build failed
`;

  it('extracts a single H2-delimited section by repo name', () => {
    const out = extractRepoSection(ARTIFACT, 'web');
    assert.match(out, /## web/);
    assert.match(out, /Tests failed/);
    assert.ok(!/## api/.test(out));
    assert.ok(!/## worker/.test(out));
  });

  it('falls back to the whole artifact when repo is mentioned but not headed', () => {
    const out = extractRepoSection('build failed in worker repo', 'worker');
    assert.match(out, /build failed/);
  });

  it('returns empty string when the repo is not mentioned at all', () => {
    assert.equal(extractRepoSection('something happened', 'absent'), '');
  });
});

// ── runFixLoop — single-repo path ──────────────────────────────────────

describe('runFixLoop — single-repo (repos.length === 0)', () => {
  function baseOptions(overrides: Partial<Parameters<typeof runFixLoop>[0]> = {}) {
    return {
      project: 'demo',
      model: 'claude',
      maxOutputTokens: 16000,
      workspaceDir: '/tmp/ws',
      repoNames: [],
      repoPaths: {},
      validateArtifact: 'VERDICT: FAIL\nbuild failed',
      attempt: 1,
      priorByRepo: new Map<string, string>(),
      priorSingleId: null,
      buildProjectPromptForBuildStage: () => 'sys',
      buildRepoProjectPromptForBuildStage: () => 'sys',
      isCancelled: () => false,
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
      ...overrides,
    } as Parameters<typeof runFixLoop>[0];
  }

  it('spawns a fresh fixer on attempt 1 and returns its id as newSingleId', async () => {
    const f = fakeAgentManager();
    const result = await runFixLoop({
      ...baseOptions(),
      agentManager: f.manager,
    });
    assert.equal(f.spawned.length, 1);
    assert.equal(f.spawned[0].name, 'fixer-demo-1');
    assert.equal(f.spawned[0].stage, 'fix-1');
    assert.deepEqual(f.spawned[0].disallowedTools, ['Agent']);
    assert.equal(result.newSingleId, 'agent-1');
    assert.equal(f.sendInputs.length, 0);
  });

  it('resumes the prior agent via sendInput on attempt > 1', async () => {
    const f = fakeAgentManager();
    // Pre-spawn an agent so getAgent returns a real state.
    const prior = f.manager.spawn({
      name: 'prior', persona: 'engineer', project: 'demo', stage: 'fix-1',
      prompt: '', model: 'claude', cwd: '/tmp',
    });
    const result = await runFixLoop({
      ...baseOptions({
        attempt: 2,
        priorSingleId: prior.id,
      }),
      agentManager: f.manager,
    });
    // No new fixer spawn; only the pre-spawned agent and the sendInput resume.
    assert.equal(f.spawned.length, 1);
    assert.equal(f.sendInputs.length, 1);
    assert.equal(f.sendInputs[0].agentId, prior.id);
    assert.match(f.sendInputs[0].text, /attempt 2/);
    assert.equal(result.newSingleId, prior.id);
  });

  it('falls back to a fresh spawn when the prior id is gone (manager returned undefined)', async () => {
    const f = fakeAgentManager();
    const result = await runFixLoop({
      ...baseOptions({
        attempt: 2,
        priorSingleId: 'agent-stale', // never spawned → getAgent returns undefined
      }),
      agentManager: f.manager,
    });
    assert.equal(f.spawned.length, 1);
    assert.equal(f.spawned[0].name, 'fixer-demo-2');
    assert.equal(result.newSingleId, 'agent-1');
  });
});

// ── runFixLoop — per-repo path ──────────────────────────────────────────

describe('runFixLoop — per-repo path', () => {
  const VALIDATE_MULTI = `## api

Tests passed.

---

## web

Tests failed: 3 failing

---

## worker

build failed`;

  function baseOptions(overrides: Partial<Parameters<typeof runFixLoop>[0]> = {}) {
    return {
      project: 'demo',
      model: 'claude',
      maxOutputTokens: 16000,
      workspaceDir: '/tmp/ws',
      repoNames: ['api', 'web', 'worker'],
      repoPaths: { api: '/tmp/api', web: '/tmp/web', worker: '/tmp/worker' },
      validateArtifact: VALIDATE_MULTI,
      attempt: 1,
      priorByRepo: new Map<string, string>(),
      priorSingleId: null,
      buildProjectPromptForBuildStage: () => 'sys',
      buildRepoProjectPromptForBuildStage: () => 'repo-sys',
      isCancelled: () => false,
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
      ...overrides,
    } as Parameters<typeof runFixLoop>[0];
  }

  it('skips repos whose section has no validation failures', async () => {
    const f = fakeAgentManager();
    await runFixLoop({
      ...baseOptions(),
      agentManager: f.manager,
    });
    // api passed → no spawn. web + worker failed → 2 spawns.
    assert.equal(f.spawned.length, 2);
    const stages = f.spawned.map((s) => s.stage);
    assert.ok(stages.includes('fix-1:web'));
    assert.ok(stages.includes('fix-1:worker'));
    assert.ok(!stages.includes('fix-1:api'));
  });

  it('records each spawned agent into priorByRepo for next attempt', async () => {
    const f = fakeAgentManager();
    const priorByRepo = new Map<string, string>();
    await runFixLoop({
      ...baseOptions({ priorByRepo }),
      agentManager: f.manager,
    });
    assert.equal(priorByRepo.size, 2);
    assert.ok(priorByRepo.has('web'));
    assert.ok(priorByRepo.has('worker'));
  });

  it('resumes per-repo prior agents via sendInput on attempt > 1', async () => {
    const f = fakeAgentManager();
    // Pre-spawn two priors so getAgent returns valid state.
    const webPrior = f.manager.spawn({
      name: 'fixer-web-1', persona: 'engineer', project: 'demo', stage: 'fix-1:web',
      prompt: '', model: 'claude', cwd: '/tmp/web',
    });
    const workerPrior = f.manager.spawn({
      name: 'fixer-worker-1', persona: 'engineer', project: 'demo', stage: 'fix-1:worker',
      prompt: '', model: 'claude', cwd: '/tmp/worker',
    });
    const priorByRepo = new Map<string, string>([
      ['web', webPrior.id],
      ['worker', workerPrior.id],
    ]);

    await runFixLoop({
      ...baseOptions({ attempt: 2, priorByRepo }),
      agentManager: f.manager,
    });
    // No new spawns — both repos resumed.
    assert.equal(f.spawned.length, 2);
    assert.equal(f.sendInputs.length, 2);
    const ids = f.sendInputs.map((s) => s.agentId).sort();
    assert.deepEqual(ids, [webPrior.id, workerPrior.id].sort());
    for (const send of f.sendInputs) {
      assert.match(send.text, /still failing/);
      assert.match(send.text, /attempt 2/);
    }
  });

  it('returns combined per-repo artifacts joined with double newlines', async () => {
    const f = fakeAgentManager({
      artifactByName: {
        'fixer-web-1': 'fixed web',
        'fixer-worker-1': 'fixed worker',
      },
    });
    const result = await runFixLoop({
      ...baseOptions(),
      agentManager: f.manager,
    });
    assert.match(result.artifact, /fixed web/);
    assert.match(result.artifact, /fixed worker/);
    // Cost = 2 spawns × 0.05.
    assert.ok(Math.abs(result.cost - 0.10) < 1e-9);
  });

  it('newSingleId is unchanged on the per-repo path', async () => {
    const f = fakeAgentManager();
    const result = await runFixLoop({
      ...baseOptions({ priorSingleId: 'preserve-me' }),
      agentManager: f.manager,
    });
    assert.equal(result.newSingleId, 'preserve-me');
  });
});
