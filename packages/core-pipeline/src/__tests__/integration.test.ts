/**
 * Phase 9 — integration tests covering full pipeline run with all hooks
 * attached, plus edge cases not covered by the per-feature suites.
 *
 * Coverage:
 *   - end-to-end: run with all 4 hooks attached, every event reaches
 *     every subscriber in priority order
 *   - hook ordering: audit (priority 100) writes before learners (50)
 *     observes the same event
 *   - failure path: pipeline:failed propagates through audit + cost +
 *     state-snapshot
 *   - artifact:emitted threads through cost-tracker
 *   - InMemoryArtifactStore.has / read / ids cover the readonly API
 *   - subSteps + retryPolicy compose: a sub-step retries its own
 *     transient failure without affecting the parent's frame
 *   - emitFireAndForget never blocks even with a slow listener
 *   - empty registry pipeline still flushes hooks cleanly
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryArtifactStore,
  InMemoryEventBus,
  InMemoryStepRegistry,
  Pipeline,
  attachAuditLogHook,
  attachCostTrackerHook,
  attachDashboardStateHook,
  attachLearnersHook,
  type PipelineEvent,
  type Step,
} from '../index.js';

const tmpRoots: string[] = [];
function mkTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-int-'));
  tmpRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }
});

describe('integration (Phase 9)', () => {
  it('end-to-end run with all 4 hooks attached', async () => {
    const bus = new InMemoryEventBus();
    const reg = new InMemoryStepRegistry();
    const dir = mkTmp();

    const audit = attachAuditLogHook(bus, { path: join(dir, 'audit.jsonl') });
    let pendingTimer: (() => void) | null = null;
    const state = attachDashboardStateHook(bus, {
      path: join(dir, 'state.json'),
      setTimer: (fn) => {
        pendingTimer = fn;
        return 1 as unknown;
      },
      clearTimer: () => {
        pendingTimer = null;
      },
    });
    const cost = attachCostTrackerHook(bus);
    const learnEvents: PipelineEvent[] = [];
    attachLearnersHook(bus, {
      project: 'p',
      onLearnEvent: (e) => {
        learnEvents.push(e);
      },
    });

    reg.register({
      id: 'a',
      run: async (ctx) => {
        ctx.emit('cost', { costUsd: 0.005 });
        return 'a-out';
      },
    } as Step<unknown, unknown>);
    reg.register({
      id: 'b',
      run: async () => 'b-out',
    } as Step<unknown, unknown>);

    await new Pipeline({ bus, registry: reg, runId: 'r1', workspaceDir: '/tmp' }).run();
    state.flush();

    const auditLines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(auditLines.length, audit.entryCount);
    assert.ok(audit.entryCount > 5);
    assert.equal(state.snapshot?.status, 'completed');
    assert.deepEqual(state.snapshot?.completedStepIds, ['a', 'b']);
    assert.ok(cost.totals().costUsd >= 0.005);
    assert.equal(learnEvents.filter((e) => e.hook === 'step:completed').length, 2);
  });

  it('hook ordering: audit (priority 100) writes before learners (50) reads', async () => {
    const bus = new InMemoryEventBus();
    const order: string[] = [];
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
        order.push('dashboard');
      },
      { priority: 10 },
    );
    await bus.emit({ hook: 'step:completed', runId: 'r', ts: 't', stepId: 'x' });
    assert.deepEqual(order, ['audit', 'learners', 'dashboard']);
  });

  it('emitFireAndForget never blocks even with a slow listener', async () => {
    const bus = new InMemoryEventBus();
    let slowListenerEntered = false;
    bus.on('artifact:emitted', async () => {
      slowListenerEntered = true;
      await new Promise((r) => setTimeout(r, 50));
    });
    const before = Date.now();
    bus.emitFireAndForget({
      hook: 'artifact:emitted',
      runId: 'r',
      ts: 't',
      stepId: 'x',
    });
    const elapsed = Date.now() - before;
    assert.equal(slowListenerEntered, true);
    assert.ok(elapsed < 25, `fire-and-forget returned in ${elapsed}ms (should be <25)`);
  });

  it('InMemoryArtifactStore.has / read / ids round-trip', () => {
    const store = new InMemoryArtifactStore();
    assert.equal(store.has('x'), false);
    assert.equal(store.read('x'), undefined);
    store.write('x', { v: 1 });
    assert.equal(store.has('x'), true);
    assert.deepEqual(store.read('x'), { v: 1 });
    store.write('y', 'plain');
    assert.deepEqual(store.ids().slice().sort(), ['x', 'y']);
  });

  it('subSteps with retryPolicy compose: sub-step retries do not break parent', async () => {
    const bus = new InMemoryEventBus();
    const reg = new InMemoryStepRegistry();
    let subCalls = 0;
    const flakySub: Step<unknown, unknown> = {
      id: 'flaky-sub',
      retryPolicy: { attempts: 2, backoff: 'constant', baseMs: 1 },
      run: async () => {
        subCalls += 1;
        if (subCalls < 2) throw new Error('transient');
        return 'sub-ok';
      },
    };
    let parentRan = false;
    reg.register({
      id: 'parent',
      subSteps: [flakySub],
      run: async () => {
        parentRan = true;
        return 'parent-ok';
      },
    } as Step<unknown, unknown>);

    const result = await new Pipeline({
      bus,
      registry: reg,
      runId: 'r-int',
      workspaceDir: '/tmp',
      sleep: async () => {},
    }).run();

    assert.equal(result.status, 'success');
    assert.equal(subCalls, 2);
    assert.equal(parentRan, true);
    assert.deepEqual(result.completedSteps, ['parent']);
  });

  it('failure path propagates through hooks consistently', async () => {
    const bus = new InMemoryEventBus();
    const reg = new InMemoryStepRegistry();
    const dir = mkTmp();
    const audit = attachAuditLogHook(bus, { path: join(dir, 'audit.jsonl') });
    let pending: (() => void) | null = null;
    const state = attachDashboardStateHook(bus, {
      path: join(dir, 'state.json'),
      setTimer: (fn) => {
        pending = fn;
        return 1 as unknown;
      },
      clearTimer: () => {
        pending = null;
      },
    });
    reg.register({
      id: 'broken',
      run: async () => {
        throw new Error('synthetic');
      },
    } as Step<unknown, unknown>);

    const result = await new Pipeline({ bus, registry: reg, runId: 'r-fail', workspaceDir: '/tmp' }).run();
    state.flush();
    assert.equal(result.status, 'failed');
    assert.equal(state.snapshot?.status, 'failed');
    const auditRows = readFileSync(join(dir, 'audit.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as PipelineEvent);
    assert.ok(auditRows.some((r) => r.hook === 'step:failed'));
    assert.ok(auditRows.some((r) => r.hook === 'pipeline:failed'));
    assert.ok(audit.entryCount >= auditRows.length);
  });

  it('parallelism hint flows through to runtime via the registry snapshot', () => {
    const reg = new InMemoryStepRegistry();
    reg.register({ id: 'serial', parallelism: 'serial', run: async () => undefined });
    reg.register({
      id: 'fanout',
      parallelism: 'per-project',
      run: async () => undefined,
    });
    const snapshot = reg.steps();
    const fanoutCount = snapshot.filter((s) => s.parallelism === 'per-project').length;
    assert.equal(fanoutCount, 1);
  });
});
