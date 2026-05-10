/**
 * Phase F6 — replay-equivalence tests for the per-stage effect
 * pattern used in `pipeline-stages.ts` (E1–E10).
 *
 * Each test follows the canonical two-pass shape from the
 * effect-conversion plan §F:
 *
 *   Pass 1 — live run with a real spy runner; capture the durable
 *     log.
 *   Pass 2 — fresh InMemoryDurableStore seeded from the captured
 *     log; spy runner replaced with a `throwingSpy`. Step body
 *     executes from start; every effect should hit the recorded
 *     result instead of the spy.
 *
 * Asserts: zero outbound calls in pass 2 + identical step output.
 *
 * Stage shapes covered:
 *   - Single-stage spawn (`requirements:spawn-agent`).
 *   - Per-repo fanout with content-hash idempotency (`specs:spawn-<repo>`).
 *   - Multi-effect stage (`build:repo-<repo>` + per-task wraps).
 *   - Q&A multi-turn (`session-start` + `session-resume` + signal).
 *   - Reviewer-decision signal channel.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryDurableStore,
  seedStoreFromLog,
  artifactIdempotencyKey,
} from '../durable/index.js';
import { EffectRuntime } from '../durable/effect-runtime.js';

const RUN = 'run-rep';

function effectKeyMatchesScope(key: string | null | undefined, scope: string): boolean {
  if (!key) return false;
  if (key.startsWith('__anvil_')) return true;
  if (key.startsWith('__signal:')) return true;
  let idx = key.indexOf(scope);
  while (idx >= 0) {
    const before = idx === 0 ? '' : key[idx - 1];
    const afterIdx = idx + scope.length;
    const after = afterIdx >= key.length ? '' : key[afterIdx];
    const isBoundary = (c: string) => c === '' || c === '-' || c === ':';
    if (isBoundary(before) && isBoundary(after)) return true;
    idx = key.indexOf(scope, idx + 1);
  }
  return false;
}

async function newCtx(stepId: string, store: InMemoryDurableStore, repoName?: string) {
  const recorded = await store.readEffectEvents(RUN, stepId);
  return new EffectRuntime({
    store,
    runId: RUN,
    stepId,
    recordedEffects: recorded,
    realSleep: async () => undefined,
    ...(repoName
      ? { effectFilter: (pair) => effectKeyMatchesScope(pair.started.effectKey, repoName) }
      : {}),
  });
}

async function freshStore() {
  const store = new InMemoryDurableStore();
  await store.createRun({ runId: RUN, project: 'p', feature: 'f', featureSlug: 'f' });
  return store;
}

describe('Replay equivalence — single-stage spawn', () => {
  it('captures + replays requirements:spawn-agent', async () => {
    let live = 0;
    const spawn = async () => {
      live += 1;
      return { output: 'requirements body', costUsd: 0.05, tokenEstimate: 100 };
    };

    // Pass 1
    const store1 = await freshStore();
    const ctx1 = await newCtx('requirements', store1);
    const out1 = await ctx1.effect('requirements:spawn-agent', spawn);
    assert.equal(out1.output, 'requirements body');
    assert.equal(live, 1);
    const log = await store1.readEvents(RUN);

    // Pass 2 — replay
    const store2 = new InMemoryDurableStore();
    await store2.createRun({ runId: RUN, project: 'p', feature: 'f', featureSlug: 'f' });
    await seedStoreFromLog(store2, log);
    const ctx2 = await newCtx('requirements', store2);
    const out2 = await ctx2.effect('requirements:spawn-agent', async () => {
      throw new Error('outbound call should have been replayed');
    });
    assert.equal(out2.output, 'requirements body');
    assert.equal(out2.costUsd, 0.05);
    assert.equal(live, 1); // still only the pass-1 invocation
  });
});

describe('Replay equivalence — per-repo fanout', () => {
  it('replays per-repo spawns + writes by repo name', async () => {
    const repos = ['service-a', 'service-b', 'service-c'];
    let liveSpawns = 0;
    let liveWrites = 0;
    const spawn = async (repo: string) => {
      liveSpawns += 1;
      return { output: `${repo} artifact`, costUsd: 0.01, tokenEstimate: 50 };
    };
    const writeArtifact = async (_repo: string, _body: string) => {
      liveWrites += 1;
      return null;
    };

    // Pass 1 — per-repo runtimes scoped by repoName so each
    // iteration's recordedEffects view is independent.
    const store1 = await freshStore();
    const outputs1: Record<string, string> = {};
    for (const repo of repos) {
      const ctx = await newCtx('specs', store1, repo);
      const r = await ctx.effect(`specs:spawn-${repo}`, () => spawn(repo));
      outputs1[repo] = r.output;
      await ctx.effect(
        `specs:write-${repo}`,
        () => writeArtifact(repo, r.output),
        { idempotencyKey: artifactIdempotencyKey('specs', repo, r.output) },
      );
    }
    assert.equal(liveSpawns, 3);
    assert.equal(liveWrites, 3);
    const log = await store1.readEvents(RUN);

    // Pass 2 — replay; per-repo scope filters cross-repo events.
    const store2 = new InMemoryDurableStore();
    await store2.createRun({ runId: RUN, project: 'p', feature: 'f', featureSlug: 'f' });
    await seedStoreFromLog(store2, log);
    const outputs2: Record<string, string> = {};
    for (const repo of repos) {
      const ctx = await newCtx('specs', store2, repo);
      const r = await ctx.effect(`specs:spawn-${repo}`, async () => {
        throw new Error('replay should not invoke spawn');
      });
      outputs2[repo] = r.output;
      await ctx.effect(
        `specs:write-${repo}`,
        async () => {
          throw new Error('replay should not invoke write');
        },
        { idempotencyKey: artifactIdempotencyKey('specs', repo, r.output) },
      );
    }
    assert.deepEqual(outputs2, outputs1);
    assert.equal(liveSpawns, 3); // unchanged
    assert.equal(liveWrites, 3); // unchanged
  });
});

describe('Replay equivalence — partial replay (per-task build)', () => {
  it('completed tasks replay; un-recorded tail tasks run live', async () => {
    const tasks = ['T1', 'T2', 'T3', 'T4'];
    let liveCalls = 0;
    const runTask = async (id: string) => {
      liveCalls += 1;
      return { output: `${id}-out`, costUsd: 0.01, tokenEstimate: 25 };
    };

    // Pass 1 — only first 2 tasks recorded under a single repo scope.
    const REPO = 'repoA';
    const store1 = await freshStore();
    {
      const ctx = await newCtx('build', store1, REPO);
      for (const id of tasks.slice(0, 2)) {
        await ctx.effect(`build:spawn-task-${REPO}-${id}`, () => runTask(id));
      }
    }
    assert.equal(liveCalls, 2);
    const partialLog = await store1.readEvents(RUN);

    // Pass 2 — replay first 2; live-execute last 2.
    const store2 = new InMemoryDurableStore();
    await store2.createRun({ runId: RUN, project: 'p', feature: 'f', featureSlug: 'f' });
    await seedStoreFromLog(store2, partialLog);
    const ctx2 = await newCtx('build', store2, REPO);
    const results: string[] = [];
    for (const id of tasks) {
      const r = await ctx2.effect(`build:spawn-task-${REPO}-${id}`, () => runTask(id));
      results.push(r.output);
    }
    assert.deepEqual(results, ['T1-out', 'T2-out', 'T3-out', 'T4-out']);
    assert.equal(liveCalls, 4); // 2 from pass-1, 2 fresh in pass-2
  });
});

describe('Replay equivalence — Q&A multi-turn', () => {
  it('session start + signal + sendInput all replay deterministically', async () => {
    let liveStart = 0;
    let liveResume = 0;

    // Pass 1
    const store1 = await freshStore();
    const ctx1 = await newCtx('requirements', store1);
    const first = await ctx1.effect('requirements:session-start', async () => {
      liveStart += 1;
      return { sessionId: 'sess-1', output: '<questions>1) Question?\n</questions>', costUsd: 0.02, tokenEstimate: 80 };
    });
    // Producer enqueues the answer signal.
    await store1.enqueueSignal(RUN, 'stage-answer-1', '<answers>\n1) Answer.\n</answers>');
    const answer = await ctx1.waitForSignal<string>('stage-answer-1');
    assert.equal(answer, '<answers>\n1) Answer.\n</answers>');
    const second = await ctx1.effect('requirements:session-resume', async () => {
      liveResume += 1;
      return { sessionId: 'sess-1', output: 'requirements body', costUsd: 0.01, tokenEstimate: 50 };
    });
    assert.equal(second.output, 'requirements body');
    assert.equal(liveStart, 1);
    assert.equal(liveResume, 1);
    const log = await store1.readEvents(RUN);

    // Pass 2 — replay; spies throw if invoked
    const store2 = new InMemoryDurableStore();
    await store2.createRun({ runId: RUN, project: 'p', feature: 'f', featureSlug: 'f' });
    await seedStoreFromLog(store2, log);
    const ctx2 = await newCtx('requirements', store2);
    const first2 = await ctx2.effect('requirements:session-start', async () => {
      throw new Error('replay should not invoke session start');
    });
    const answer2 = await ctx2.waitForSignal<string>('stage-answer-1');
    const second2 = await ctx2.effect('requirements:session-resume', async () => {
      throw new Error('replay should not invoke session resume');
    });
    assert.equal(first2.output, first.output);
    assert.equal(answer2, answer);
    assert.equal(second2.output, second.output);
    assert.equal(liveStart, 1);
    assert.equal(liveResume, 1);
  });
});

describe('Replay equivalence — reviewer decision signal', () => {
  it('recorded decision returns immediately on replay', async () => {
    // Pass 1 — producer enqueues then consumer reads.
    const store1 = await freshStore();
    await store1.enqueueSignal(RUN, 'reviewer-decision-plan', { action: 'approve', note: 'looks good' });
    const ctx1 = await newCtx('reviewer-pause', store1);
    const decision1 = await ctx1.waitForSignal<{ action: string; note: string }>(
      'reviewer-decision-plan',
    );
    assert.deepEqual(decision1, { action: 'approve', note: 'looks good' });
    const log = await store1.readEvents(RUN);

    // Pass 2 — replay
    const store2 = new InMemoryDurableStore();
    await store2.createRun({ runId: RUN, project: 'p', feature: 'f', featureSlug: 'f' });
    await seedStoreFromLog(store2, log);
    const ctx2 = await newCtx('reviewer-pause', store2);
    const decision2 = await ctx2.waitForSignal<{ action: string; note: string }>(
      'reviewer-decision-plan',
    );
    assert.deepEqual(decision2, decision1);
  });
});

describe('Replay equivalence — idempotency-key drift', () => {
  it('replay with mismatched idempotency key throws DeterminismViolationError', async () => {
    const { DeterminismViolationError } = await import('../durable/types.js');
    const store = await freshStore();
    const ctx = await newCtx('build', store);
    await ctx.effect(
      'build:write-x',
      async () => null,
      { idempotencyKey: 'k-v1' },
    );

    // Replay with a different idempotency key must surface the
    // violation immediately; the dashboard renders this as a
    // "rerun from-stage" affordance.
    const ctx2 = await newCtx('build', store);
    await assert.rejects(
      () => ctx2.effect(
        'build:write-x',
        async () => null,
        { idempotencyKey: 'k-v2' },
      ),
      DeterminismViolationError,
    );
  });
});
