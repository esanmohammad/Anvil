/**
 * Per-task resolver + dispatch ordering tests.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolveModelForTask,
  orderTasksForDispatch,
  TaskCycleError,
} from '../routing/resolve-model-for-task.js';
import { _resetStageRoutingCache } from '../routing/resolve-model-for-stage.js';
import type { TaskEnvelope } from '../routing/task-envelope.js';

let home = '';

before(() => {
  home = mkdtempSync(join(tmpdir(), 'anvil-task-resolver-'));
  mkdirSync(home, { recursive: true });

  // Minimal models.yaml + stage-policy.yaml.
  writeFileSync(join(home, 'models.yaml'), [
    'models:',
    '  - id: qwen3:14b',
    '    provider: ollama',
    '    tier: local',
    '    capabilities: [code, reasoning]',
    '    complexity_max: M',
    '    vram_gb: 9',
    '    exclusive_slot: true',
    '  - id: claude-haiku-4-5-20251001',
    '    provider: claude',
    '    tier: cheap',
    '    capabilities: [code, reasoning]',
    '    complexity_max: M',
    '    vram_gb: 0',
    '    exclusive_slot: false',
    '  - id: claude-sonnet-4-6',
    '    provider: claude',
    '    tier: premium',
    '    capabilities: [code, reasoning, vision]',
    '    complexity_max: L',
    '    vram_gb: 0',
    '    exclusive_slot: false',
  ].join('\n'));

  writeFileSync(join(home, 'stage-policy.yaml'), [
    'stages:',
    '  build:',
    '    capability: code',
    '    complexity: M',
    '    prefer: [premium, cheap, local]',
  ].join('\n'));
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

const env = () => ({
  ANVIL_HOME: home,
  ANVIL_STAGE_POLICY: join(home, 'stage-policy.yaml'),
});

function makeTask(overrides: Partial<TaskEnvelope>): TaskEnvelope {
  return {
    id: overrides.id ?? 'T-001',
    repo: 'app',
    files_affected: ['src/x.ts'],
    operation: 'modify',
    routing: {
      capability: 'code',
      complexity: 'M',
      context_estimate_tokens: 1000,
      ...(overrides.routing ?? {}),
    },
    acceptance_criteria: [{ type: 'prose', text: 'works' }],
    ...overrides,
  };
}

describe('resolveModelForTask', () => {
  it('falls back to stage policy when task has no preferred_tier', () => {
    _resetStageRoutingCache();
    const task = makeTask({});
    const r = resolveModelForTask(task, { env: env() });
    // Stage prefer order is [premium, cheap, local] → primary is sonnet.
    assert.equal(r.primary, 'claude-sonnet-4-6');
  });

  it('honors task.routing.preferred_tier=local', () => {
    _resetStageRoutingCache();
    const task = makeTask({
      routing: {
        capability: 'code',
        complexity: 'M',
        context_estimate_tokens: 500,
        preferred_tier: 'local',
      },
    });
    const r = resolveModelForTask(task, { env: env() });
    assert.equal(r.primary, 'qwen3:14b');
  });

  it('honors task.routing.preferred_tier=cheap', () => {
    _resetStageRoutingCache();
    const task = makeTask({
      routing: {
        capability: 'code',
        complexity: 'M',
        context_estimate_tokens: 500,
        preferred_tier: 'cheap',
      },
    });
    const r = resolveModelForTask(task, { env: env() });
    assert.equal(r.primary, 'claude-haiku-4-5-20251001');
  });
});

describe('orderTasksForDispatch — priority + dependency', () => {
  it('orders simple tasks by priority (P0 first)', () => {
    const tasks = [
      makeTask({ id: 'T-3', priority: 'P2' }),
      makeTask({ id: 'T-1', priority: 'P0' }),
      makeTask({ id: 'T-2', priority: 'P1' }),
    ];
    const layers = orderTasksForDispatch(tasks);
    assert.equal(layers.length, 1);
    assert.deepEqual(layers[0].layer.map((t) => t.id), ['T-1', 'T-2', 'T-3']);
  });

  it('puts dependents in a later layer than their deps', () => {
    const tasks = [
      makeTask({ id: 'T-2', priority: 'P0', depends_on: ['T-1'] }),
      makeTask({ id: 'T-1', priority: 'P2' }),
    ];
    const layers = orderTasksForDispatch(tasks);
    assert.equal(layers.length, 2);
    assert.deepEqual(layers[0].layer.map((t) => t.id), ['T-1']);
    assert.deepEqual(layers[1].layer.map((t) => t.id), ['T-2']);
  });

  it('groups parallel deps in one layer', () => {
    const tasks = [
      makeTask({ id: 'T-1' }),
      makeTask({ id: 'T-2' }),
      makeTask({ id: 'T-3', depends_on: ['T-1', 'T-2'] }),
    ];
    const layers = orderTasksForDispatch(tasks);
    assert.equal(layers.length, 2);
    assert.deepEqual(new Set(layers[0].layer.map((t) => t.id)), new Set(['T-1', 'T-2']));
    assert.deepEqual(layers[1].layer.map((t) => t.id), ['T-3']);
  });

  it('throws TaskCycleError on circular dependency', () => {
    const tasks = [
      makeTask({ id: 'T-1', depends_on: ['T-2'] }),
      makeTask({ id: 'T-2', depends_on: ['T-1'] }),
    ];
    assert.throws(() => orderTasksForDispatch(tasks), TaskCycleError);
  });

  it('tolerates unknown ids in depends_on (treats as no-op)', () => {
    const tasks = [
      makeTask({ id: 'T-1', depends_on: ['ghost-task'] }),
    ];
    const layers = orderTasksForDispatch(tasks);
    assert.equal(layers.length, 1);
    assert.deepEqual(layers[0].layer.map((t) => t.id), ['T-1']);
  });

  it('default priority is P1 (in between P0 and P2)', () => {
    const tasks = [
      makeTask({ id: 'A', priority: 'P0' }),
      makeTask({ id: 'B' }),                   // defaults to P1
      makeTask({ id: 'C', priority: 'P2' }),
    ];
    const layers = orderTasksForDispatch(tasks);
    assert.deepEqual(layers[0].layer.map((t) => t.id), ['A', 'B', 'C']);
  });
});
