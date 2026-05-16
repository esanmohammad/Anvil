/**
 * Phase 2 — EventBus mature behavior.
 *
 * Coverage:
 *   - emit awaits async listeners
 *   - listener throw is isolated (subsequent listeners still run; emit
 *     rejects with AggregateError after all complete)
 *   - emitFireAndForget never blocks; rejections swallowed
 *   - off / once / unsubscribe-handle removal
 *   - priority ordering (descending priority, FIFO tie-break)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventBus } from '../event-bus.js';
import type {
  PipelineEvent,
  StageRepoProgressPayload,
  StageCostUpdatePayload,
  StageFixAttemptPayload,
  ReviewerNotePayload,
} from '../types.js';

const make = (overrides: Partial<PipelineEvent> = {}): PipelineEvent => ({
  hook: 'step:started',
  runId: 'r1',
  ts: '2026-04-29T00:00:00.000Z',
  ...overrides,
});

describe('InMemoryEventBus (Phase 2)', () => {
  it('awaits async listeners before emit resolves', async () => {
    const bus = new InMemoryEventBus();
    const order: string[] = [];
    bus.on('step:started', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('listener');
    });
    await bus.emit(make());
    order.push('after-emit');
    assert.deepEqual(order, ['listener', 'after-emit']);
  });

  it('isolates listener throws — every listener runs; emit rejects after', async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.on('step:completed', () => {
      seen.push('a');
    });
    bus.on('step:completed', () => {
      seen.push('b');
      throw new Error('boom');
    });
    bus.on('step:completed', () => {
      seen.push('c');
    });
    await assert.rejects(bus.emit(make({ hook: 'step:completed' })), /boom/);
    assert.deepEqual(seen, ['a', 'b', 'c']);
  });

  it('AggregateErrors when multiple listeners throw', async () => {
    const bus = new InMemoryEventBus();
    bus.on('step:failed', () => {
      throw new Error('e1');
    });
    bus.on('step:failed', () => {
      throw new Error('e2');
    });
    await assert.rejects(bus.emit(make({ hook: 'step:failed' })), (err: unknown) => {
      assert.ok(err instanceof AggregateError);
      assert.equal((err as AggregateError).errors.length, 2);
      return true;
    });
  });

  it('emitFireAndForget never blocks; async rejections silently swallowed', () => {
    const bus = new InMemoryEventBus();
    let saw = 0;
    bus.on('artifact:emitted', async () => {
      await new Promise((r) => setTimeout(r, 10));
      saw++;
      throw new Error('async-fail');
    });
    bus.emitFireAndForget(make({ hook: 'artifact:emitted' }));
    assert.equal(saw, 0, 'fire-and-forget did not block');
  });

  it('off and unsubscribe-handle both remove the listener', async () => {
    const bus = new InMemoryEventBus();
    let count = 0;
    const lA = (): void => {
      count++;
    };
    bus.on('step:started', lA);
    const offB = bus.on('step:started', () => {
      count++;
    });
    await bus.emit(make());
    assert.equal(count, 2);
    bus.off('step:started', lA);
    offB();
    await bus.emit(make());
    assert.equal(count, 2, 'both listeners removed');
  });

  it('once auto-unsubscribes after first delivery', async () => {
    const bus = new InMemoryEventBus();
    let count = 0;
    bus.once('step:started', () => {
      count++;
    });
    await bus.emit(make());
    await bus.emit(make());
    assert.equal(count, 1);
  });

  // ── Phase E — dashboard-domain events (ADR §4.5) ───────────────────

  it('stage:repo-progress flows through on/emit with documented payload', async () => {
    const bus = new InMemoryEventBus();
    const seen: StageRepoProgressPayload[] = [];
    bus.on('stage:repo-progress', (e) => {
      seen.push(e.payload as StageRepoProgressPayload);
    });
    const payload: StageRepoProgressPayload = {
      stageId: 'build',
      stageIndex: 5,
      repoName: 'svc-orders',
      status: 'running',
    };
    await bus.emit({ hook: 'stage:repo-progress', runId: 'r1', stepId: 'build', ts: '2026-04-29T00:00:00.000Z', payload });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], payload);
  });

  it('stage:repo-progress carries costUsd on completed and error on failed', async () => {
    const bus = new InMemoryEventBus();
    const seen: StageRepoProgressPayload[] = [];
    bus.on('stage:repo-progress', (e) => {
      seen.push(e.payload as StageRepoProgressPayload);
    });
    await bus.emit({
      hook: 'stage:repo-progress',
      runId: 'r1',
      ts: '2026-04-29T00:00:00.000Z',
      payload: { stageId: 'specs', stageIndex: 3, repoName: 'web', status: 'completed', costUsd: 0.014 },
    });
    await bus.emit({
      hook: 'stage:repo-progress',
      runId: 'r1',
      ts: '2026-04-29T00:00:01.000Z',
      payload: { stageId: 'specs', stageIndex: 3, repoName: 'api', status: 'failed', error: { message: 'spawn timeout' } },
    });
    assert.equal(seen[0].costUsd, 0.014);
    assert.equal(seen[1].error?.message, 'spawn timeout');
  });

  it('stage:cost-update flows through on/emit with documented payload', async () => {
    const bus = new InMemoryEventBus();
    const totals: number[] = [];
    bus.on('stage:cost-update', (e) => {
      const p = e.payload as StageCostUpdatePayload;
      totals.push(p.totalUsd);
    });
    await bus.emit({
      hook: 'stage:cost-update',
      runId: 'r1',
      ts: '2026-04-29T00:00:00.000Z',
      payload: { stageId: 'build', stageIndex: 5, deltaUsd: 0.022, totalUsd: 0.022 },
    });
    await bus.emit({
      hook: 'stage:cost-update',
      runId: 'r1',
      ts: '2026-04-29T00:00:01.000Z',
      payload: { stageId: 'build', stageIndex: 5, deltaUsd: 0.011, totalUsd: 0.033 },
    });
    assert.deepEqual(totals, [0.022, 0.033]);
  });

  it('stage:fix-attempt flows through with phase + attempt counters', async () => {
    const bus = new InMemoryEventBus();
    const seen: StageFixAttemptPayload[] = [];
    bus.on('stage:fix-attempt', (e) => {
      seen.push(e.payload as StageFixAttemptPayload);
    });
    await bus.emit({
      hook: 'stage:fix-attempt',
      runId: 'r1',
      ts: '2026-04-29T00:00:00.000Z',
      payload: { stageId: 'validate', stageIndex: 7, attempt: 1, maxAttempts: 3, phase: 'fix' },
    });
    await bus.emit({
      hook: 'stage:fix-attempt',
      runId: 'r1',
      ts: '2026-04-29T00:00:01.000Z',
      payload: { stageId: 'validate', stageIndex: 7, attempt: 1, maxAttempts: 3, phase: 'revalidate' },
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].phase, 'fix');
    assert.equal(seen[1].phase, 'revalidate');
    assert.equal(seen[1].attempt, 1);
  });

  it('reviewer:note flows through with source discriminator', async () => {
    const bus = new InMemoryEventBus();
    const seen: ReviewerNotePayload[] = [];
    bus.on('reviewer:note', (e) => {
      seen.push(e.payload as ReviewerNotePayload);
    });
    await bus.emit({
      hook: 'reviewer:note',
      runId: 'r1',
      ts: '2026-04-29T00:00:00.000Z',
      payload: { stageId: 'specs', stageIndex: 3, note: 'Tighten the auth scopes', source: 'pause-resolution' },
    });
    await bus.emit({
      hook: 'reviewer:note',
      runId: 'r1',
      ts: '2026-04-29T00:00:01.000Z',
      payload: { stageId: 'tasks', stageIndex: 4, note: 'Split task 3 into two', source: 'edit-artifact' },
    });
    assert.equal(seen[0].source, 'pause-resolution');
    assert.equal(seen[1].source, 'edit-artifact');
  });

  it('new dashboard-domain events honor priority ordering with existing hooks', async () => {
    const bus = new InMemoryEventBus();
    const order: string[] = [];
    bus.on('stage:cost-update', () => { order.push('audit'); }, { priority: 100 });
    bus.on('stage:cost-update', () => { order.push('rollup'); }, { priority: 10 });
    bus.on('stage:cost-update', () => { order.push('cost'); }, { priority: 20 });
    await bus.emit({
      hook: 'stage:cost-update',
      runId: 'r1',
      ts: '2026-04-29T00:00:00.000Z',
      payload: { stageId: 'build', stageIndex: 5, deltaUsd: 0.01, totalUsd: 0.01 },
    });
    assert.deepEqual(order, ['audit', 'cost', 'rollup']);
  });

  it('priority ordering: high → low, FIFO tie-break at equal priority', async () => {
    const bus = new InMemoryEventBus();
    const order: string[] = [];
    bus.on(
      'step:completed',
      () => {
        order.push('default');
      },
      // default priority 0
    );
    bus.on(
      'step:completed',
      () => {
        order.push('audit');
      },
      { priority: 100 },
    );
    bus.on(
      'step:completed',
      () => {
        order.push('learners');
      },
      { priority: 50 },
    );
    bus.on(
      'step:completed',
      () => {
        order.push('default-2');
      },
      // default 0; tie-break vs first 'default' by FIFO
    );
    await bus.emit(make({ hook: 'step:completed' }));
    assert.deepEqual(order, ['audit', 'learners', 'default', 'default-2']);
  });
});
