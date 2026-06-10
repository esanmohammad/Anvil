/**
 * Canonical fix-loop step — the §H3 per-repo `sessionForRepo` contract.
 *
 * fix-loop fans out per-repo AND resumes across attempts, so each repo gets
 * its OWN session (a burn-aware session in production: per-phase fallback +
 * per-repo turn recorder). These tests pin the contract with a fake session
 * factory — no AgentManager, no durable store:
 *   - per repo with failures → a DISTINCT session, `start` with `sessionStage`
 *   - attempt > 1 with a prior id → `sendInput` (resume), not `start`
 *   - single-repo (repoNames []) → `sessionForRepo(null)`
 *   - repos that PASS validation are skipped (no session)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runFixLoop } from '../steps/fix-loop.step.js';
import type { AgentSession, AgentSessionResult } from '../agent-session.js';
import type { AgentRunRequest } from '../agent-runner.js';

interface Call { kind: 'start' | 'sendInput'; repoName?: string; stage?: string; routingStage?: string; allowedTools?: readonly string[]; sessionId?: string }

function fakeFactory() {
  const calls: Call[] = [];
  const byKey = new Map<string, AgentSession>();
  let n = 0;
  const sessionForRepo = (repoName: string | null): AgentSession => {
    const key = repoName ?? '__single__';
    let s = byKey.get(key);
    if (!s) {
      s = {
        async start(req: AgentRunRequest): Promise<AgentSessionResult> {
          calls.push({ kind: 'start', repoName: req.repoName, stage: req.stage, routingStage: req.routingStage, allowedTools: req.allowedTools });
          return { sessionId: `agent-${++n}`, output: `fixed ${req.repoName ?? 'single'}`, tokenEstimate: 0, costUsd: 1 };
        },
        async sendInput(sessionId: string): Promise<AgentSessionResult> {
          calls.push({ kind: 'sendInput', sessionId });
          return { sessionId, output: 'resumed', tokenEstimate: 0, costUsd: 1 };
        },
        kill() { /* noop */ },
      };
      byKey.set(key, s);
    }
    return s;
  };
  return { sessionForRepo, calls, byKey };
}

const baseOpts = (over: Partial<Parameters<typeof runFixLoop>[0]>) => ({
  project: 'p',
  workspaceDir: '/tmp',
  repoPaths: {},
  priorByRepo: new Map<string, string>(),
  priorSingleId: null,
  buildProjectPromptForBuildStage: () => 'pp',
  buildRepoProjectPromptForBuildStage: (r: string) => `pp-${r}`,
  isCancelled: () => false,
  ...over,
} as Parameters<typeof runFixLoop>[0]);

describe('fix-loop canonical — per-repo sessionForRepo contract', () => {
  it('per repo with failures → distinct session, start with sessionStage + repoName', async () => {
    const { sessionForRepo, calls, byKey } = fakeFactory();
    const priorByRepo = new Map<string, string>();
    const r = await runFixLoop(baseOpts({
      sessionForRepo,
      repoNames: ['repoA', 'repoB'],
      repoPaths: { repoA: '/tmp/a', repoB: '/tmp/b' },
      validateArtifact: '## repoA\nVERDICT: FAIL\n\n## repoB\nVERDICT: FAIL\n',
      attempt: 1,
      sessionStage: 'validate',
      priorByRepo,
    }));
    assert.equal(byKey.size, 2, 'one session per repo');
    assert.ok(byKey.has('repoA') && byKey.has('repoB'));
    const starts = calls.filter((c) => c.kind === 'start');
    assert.equal(starts.length, 2);
    assert.deepEqual(new Set(starts.map((s) => s.repoName)), new Set(['repoA', 'repoB']));
    assert.ok(starts.every((s) => s.stage === 'validate'), 'sessionStage threaded to the spawn');
    assert.ok(priorByRepo.has('repoA') && priorByRepo.has('repoB'), 'prior agent ids recorded per repo');
    assert.ok(r.artifact.includes('fixed repoA') && r.artifact.includes('fixed repoB'));
  });

  it('attempt > 1 with a prior id → sendInput (resume), not start', async () => {
    const { sessionForRepo, calls } = fakeFactory();
    await runFixLoop(baseOpts({
      sessionForRepo,
      repoNames: ['repoA'],
      repoPaths: { repoA: '/tmp/a' },
      validateArtifact: '## repoA\nVERDICT: FAIL\n',
      attempt: 2,
      sessionStage: 'validate',
      priorByRepo: new Map([['repoA', 'agent-A']]),
    }));
    assert.ok(calls.some((c) => c.kind === 'sendInput' && c.sessionId === 'agent-A'), 'resumes the prior session');
    assert.ok(!calls.some((c) => c.kind === 'start'), 'no fresh start on resume');
  });

  it('single-repo (repoNames []) → sessionForRepo(null), with allowedTools + routingStage', async () => {
    const { sessionForRepo, calls, byKey } = fakeFactory();
    const r = await runFixLoop(baseOpts({
      sessionForRepo,
      repoNames: [],
      validateArtifact: 'VERDICT: FAIL',
      attempt: 1,
      sessionStage: 'validate',
      fallbackStage: 'fix-loop',
      allowedTools: ['edit', 'write_file', 'bash'],
    }));
    assert.ok(byKey.has('__single__'), 'single session keyed null');
    const start = calls.find((c) => c.kind === 'start');
    assert.equal(start?.stage, 'validate', 'records under the enclosing stage');
    assert.equal(start?.routingStage, 'fix-loop', 'burn-fallback chain stays on fix-loop');
    assert.deepEqual(start?.allowedTools, ['edit', 'write_file', 'bash'], 'single path threads allowedTools (not read-only)');
    assert.equal(r.newSingleId, 'agent-1');
  });

  it('threads routingStage=fix-loop on per-repo starts (recording stage ≠ fallback chain)', async () => {
    const { sessionForRepo, calls } = fakeFactory();
    await runFixLoop(baseOpts({
      sessionForRepo,
      repoNames: ['repoA'],
      repoPaths: { repoA: '/tmp/a' },
      validateArtifact: '## repoA\nVERDICT: FAIL\n',
      attempt: 1,
      sessionStage: 'validate',
      fallbackStage: 'fix-loop',
    }));
    const start = calls.find((c) => c.kind === 'start');
    assert.equal(start?.stage, 'validate');
    assert.equal(start?.routingStage, 'fix-loop', 'fix-loop burns re-resolve the fix-loop chain, not validate');
  });

  it('repos that PASS validation are skipped (no session)', async () => {
    const { sessionForRepo, byKey } = fakeFactory();
    await runFixLoop(baseOpts({
      sessionForRepo,
      repoNames: ['repoA', 'repoB'],
      repoPaths: { repoA: '/tmp/a', repoB: '/tmp/b' },
      validateArtifact: '## repoA\nVERDICT: FAIL\n\n## repoB\nbuild PASS, tests PASS\n',
      attempt: 1,
      sessionStage: 'validate',
    }));
    assert.ok(byKey.has('repoA'), 'failing repo gets a session');
    assert.ok(!byKey.has('repoB'), 'passing repo is skipped — no session');
  });
});
