/**
 * Phase 3 — hook subscriber tests.
 *
 * Covers each of the 4 hooks:
 *   - audit-log: writes JSONL with one line per emitted event; ordering
 *   - dashboard-state: debounced flush + final snapshot shape
 *   - cost-tracker: aggregates from artifact:emitted + step:completed
 *   - learners: forwards to provided callback on the right event types
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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
  const dir = mkdtempSync(join(tmpdir(), 'anvil-hooks-'));
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

describe('hooks (Phase 3)', () => {
  it('audit-log writes one JSONL row per event', async () => {
    const bus = new InMemoryEventBus();
    const reg = new InMemoryStepRegistry();
    const dir = mkTmp();
    const path = join(dir, 'audit.jsonl');
    const handle = attachAuditLogHook(bus, { path });

    reg.register({
      id: 'a',
      run: async (ctx) => {
        ctx.emit('A.md', '# A');
        return 'a-done';
      },
    } as Step<unknown, unknown>);

    await new Pipeline({ bus, registry: reg, runId: 'r1', workspaceDir: '/tmp' }).run();

    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const rows = lines.map((l) => JSON.parse(l) as PipelineEvent);
    assert.deepEqual(rows.map((r) => r.hook), [
      'pipeline:started',
      'step:started',
      'artifact:emitted',
      'step:completed',
      'pipeline:completed',
    ]);
    assert.equal(handle.entryCount, 5);
    assert.equal(handle.lastError, undefined);
  });

  it('dashboard-state debounces; flush() writes final snapshot', async () => {
    const bus = new InMemoryEventBus();
    const reg = new InMemoryStepRegistry();
    const dir = mkTmp();
    const path = join(dir, 'state.json');
    let pending: (() => void) | null = null;

    const handle = attachDashboardStateHook(bus, {
      path,
      debounceMs: 5,
      setTimer: (fn) => {
        pending = fn;
        return 1;
      },
      clearTimer: () => {
        pending = null;
      },
    });

    reg.register({
      id: 'a',
      run: async () => 'a-done',
    } as Step<unknown, unknown>);
    reg.register({
      id: 'b',
      run: async () => 'b-done',
    } as Step<unknown, unknown>);

    await new Pipeline({ bus, registry: reg, runId: 'r2', workspaceDir: '/tmp' }).run();
    handle.flush();
    pending = null;

    const snapshot = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(snapshot.runId, 'r2');
    assert.equal(snapshot.status, 'completed');
    assert.deepEqual(snapshot.completedStepIds, ['a', 'b']);
    assert.equal(snapshot.failedStepId, undefined);
  });

  it('cost-tracker aggregates from artifact:emitted + step:completed', async () => {
    const bus = new InMemoryEventBus();
    const cost = attachCostTrackerHook(bus);

    await bus.emit({
      hook: 'artifact:emitted',
      runId: 'r3',
      stepId: 'a',
      ts: '2026-04-29T00:00:00Z',
      payload: { artifactId: 'cost', data: { costUsd: 0.005 } },
    });
    await bus.emit({
      hook: 'step:completed',
      runId: 'r3',
      stepId: 'a',
      ts: '2026-04-29T00:00:01Z',
      payload: { costUsd: 0.01 },
    });
    await bus.emit({
      hook: 'step:completed',
      runId: 'r3',
      stepId: 'b',
      ts: '2026-04-29T00:00:02Z',
      payload: { costUsd: 0.02 },
    });
    cost.record('a', 0.001);

    const totals = cost.totals();
    assert.equal(totals.entries, 4);
    assert.ok(Math.abs(totals.costUsd - 0.036) < 1e-9);
    const byStep = cost.byStep();
    assert.ok(Math.abs((byStep.get('a') ?? 0) - 0.016) < 1e-9);
    assert.ok(Math.abs((byStep.get('b') ?? 0) - 0.02) < 1e-9);
  });

  it('learners hook forwards to onLearnEvent on step:completed/step:failed/pipeline:*', async () => {
    const bus = new InMemoryEventBus();
    const seen: PipelineEvent[] = [];
    const handle = attachLearnersHook(bus, {
      project: 'proj-x',
      onLearnEvent: (event, project) => {
        assert.equal(project, 'proj-x');
        seen.push(event);
      },
    });

    await bus.emit({ hook: 'step:started', runId: 'r4', stepId: 's', ts: 't' });
    await bus.emit({ hook: 'step:completed', runId: 'r4', stepId: 's', ts: 't' });
    await bus.emit({ hook: 'step:failed', runId: 'r4', stepId: 's', ts: 't' });
    await bus.emit({ hook: 'pipeline:completed', runId: 'r4', ts: 't' });

    assert.equal(handle.invocationCount, 3);
    assert.deepEqual(seen.map((e) => e.hook), ['step:completed', 'step:failed', 'pipeline:completed']);
  });
});
