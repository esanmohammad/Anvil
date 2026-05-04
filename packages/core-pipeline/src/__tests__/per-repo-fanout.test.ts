/**
 * Per-repo fanout — Phase 4a of the dashboard consolidation.
 *
 * Verifies that a `Step` declared with `parallelism: 'per-repo'` runs once
 * per `repoPaths` key, in parallel, with `ctx.repoName` populated, and that
 * the step's output is aggregated into a `Record<string, O>` for downstream
 * consumers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryEventBus,
  InMemoryStepRegistry,
  Pipeline,
  type Step,
  type StepContext,
} from '../index.js';

function makeBus(): InMemoryEventBus {
  return new InMemoryEventBus();
}

describe('Pipeline — per-repo fanout (Phase 4a)', () => {
  it('runs the step once per repoPaths key with ctx.repoName populated', async () => {
    const seen: Array<{ repoName: string | undefined; repoPaths: Record<string, string> | undefined }> = [];
    const step: Step<unknown, string> = {
      id: 'per-repo-step',
      parallelism: 'per-repo',
      async run(ctx: StepContext<unknown>) {
        seen.push({ repoName: ctx.repoName, repoPaths: ctx.repoPaths });
        return `built:${ctx.repoName ?? 'none'}`;
      },
    };

    const registry = new InMemoryStepRegistry();
    registry.register(step as Step<unknown, unknown>);

    const pipeline = new Pipeline({
      registry,
      bus: makeBus(),
      runId: 'run-1',
      workspaceDir: '/tmp/ws',
      repoPaths: { api: '/tmp/api', web: '/tmp/web', worker: '/tmp/worker' },
    });
    const result = await pipeline.run();

    assert.equal(result.status, 'success');
    assert.equal(seen.length, 3);
    const repoNames = seen.map((s) => s.repoName).sort();
    assert.deepEqual(repoNames, ['api', 'web', 'worker']);
    // Full repoPaths map remains visible from each fanout iteration.
    for (const entry of seen) {
      assert.deepEqual(entry.repoPaths, { api: '/tmp/api', web: '/tmp/web', worker: '/tmp/worker' });
    }
  });

  it('aggregates per-repo outputs into Record<string, O> for downstream steps', async () => {
    let downstreamInput: unknown;
    const fanout: Step<unknown, string> = {
      id: 'fanout',
      parallelism: 'per-repo',
      async run(ctx: StepContext<unknown>) {
        return `art-${ctx.repoName}`;
      },
    };
    const downstream: Step<unknown, void> = {
      id: 'downstream',
      async run(ctx: StepContext<unknown>) {
        downstreamInput = ctx.input;
      },
    };

    const registry = new InMemoryStepRegistry();
    registry.register(fanout as Step<unknown, unknown>);
    registry.register(downstream as Step<unknown, unknown>);

    const pipeline = new Pipeline({
      registry,
      bus: makeBus(),
      runId: 'run-2',
      workspaceDir: '/tmp/ws',
      repoPaths: { api: '/tmp/api', web: '/tmp/web' },
    });
    const result = await pipeline.run();

    assert.equal(result.status, 'success');
    assert.deepEqual(downstreamInput, { api: 'art-api', web: 'art-web' });
  });

  it('falls back to a single serial run when repoPaths is empty', async () => {
    const calls: Array<string | undefined> = [];
    const step: Step<unknown, string> = {
      id: 'mono-repo',
      parallelism: 'per-repo',
      async run(ctx: StepContext<unknown>) {
        calls.push(ctx.repoName);
        return 'mono-output';
      },
    };

    const registry = new InMemoryStepRegistry();
    registry.register(step as Step<unknown, unknown>);

    const pipeline = new Pipeline({
      registry,
      bus: makeBus(),
      runId: 'run-3',
      workspaceDir: '/tmp/ws',
      // repoPaths intentionally omitted.
    });
    const result = await pipeline.run();

    assert.equal(result.status, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0], undefined);
  });

  it('falls back to a single serial run when repoPaths is an empty object', async () => {
    const calls: Array<string | undefined> = [];
    const step: Step<unknown, string> = {
      id: 'empty-repos',
      parallelism: 'per-repo',
      async run(ctx: StepContext<unknown>) {
        calls.push(ctx.repoName);
        return 'fallback';
      },
    };

    const registry = new InMemoryStepRegistry();
    registry.register(step as Step<unknown, unknown>);

    const pipeline = new Pipeline({
      registry,
      bus: makeBus(),
      runId: 'run-4',
      workspaceDir: '/tmp/ws',
      repoPaths: {},
    });
    const result = await pipeline.run();

    assert.equal(result.status, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0], undefined);
  });

  it('rejects when any repo run() rejects (Promise.all semantics)', async () => {
    const step: Step<unknown, string> = {
      id: 'flaky',
      parallelism: 'per-repo',
      async run(ctx: StepContext<unknown>) {
        if (ctx.repoName === 'api') throw new Error('api blew up');
        return 'ok';
      },
    };

    const registry = new InMemoryStepRegistry();
    registry.register(step as Step<unknown, unknown>);

    const bus = makeBus();
    const failures: string[] = [];
    bus.on('step:failed', (event) => {
      failures.push(event.error?.message ?? '');
    });

    const pipeline = new Pipeline({
      registry,
      bus,
      runId: 'run-5',
      workspaceDir: '/tmp/ws',
      repoPaths: { api: '/tmp/api', web: '/tmp/web' },
    });
    const result = await pipeline.run();

    assert.equal(result.status, 'failed');
    assert.equal(result.failedStep, 'flaky');
    assert.equal(failures.length, 1);
    assert.match(failures[0], /api blew up/);
  });

  it('throws when per-repo step also declares sub-steps', async () => {
    const sub: Step<unknown, unknown> = { id: 'inner', run: async () => undefined };
    const step: Step<unknown, unknown> = {
      id: 'parent',
      parallelism: 'per-repo',
      subSteps: [sub],
      run: async () => undefined,
    };

    const registry = new InMemoryStepRegistry();
    registry.register(step);

    const bus = makeBus();
    const failures: string[] = [];
    bus.on('step:failed', (event) => {
      failures.push(event.error?.message ?? '');
    });

    const pipeline = new Pipeline({
      registry,
      bus,
      runId: 'run-6',
      workspaceDir: '/tmp/ws',
      repoPaths: { api: '/tmp/api' },
    });
    const result = await pipeline.run();

    assert.equal(result.status, 'failed');
    assert.match(failures[0], /per-repo.*sub-steps/i);
  });

  it('runs all repos in parallel — total time ≈ slowest repo, not the sum', async () => {
    const delays: Record<string, number> = { api: 60, web: 60, worker: 60 };
    const step: Step<unknown, string> = {
      id: 'slow',
      parallelism: 'per-repo',
      async run(ctx: StepContext<unknown>) {
        const ms = delays[ctx.repoName ?? ''] ?? 0;
        await new Promise((r) => setTimeout(r, ms));
        return `done-${ctx.repoName}`;
      },
    };

    const registry = new InMemoryStepRegistry();
    registry.register(step as Step<unknown, unknown>);

    const pipeline = new Pipeline({
      registry,
      bus: makeBus(),
      runId: 'run-7',
      workspaceDir: '/tmp/ws',
      repoPaths: { api: '/tmp/api', web: '/tmp/web', worker: '/tmp/worker' },
    });
    const start = Date.now();
    const result = await pipeline.run();
    const elapsed = Date.now() - start;

    assert.equal(result.status, 'success');
    // Sequential would take ~180ms; parallel should be ~60ms with generous slack.
    assert.ok(elapsed < 150, `expected <150ms (parallel), got ${elapsed}ms`);
  });
});
