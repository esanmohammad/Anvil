/**
 * Phase 4f.3 tests — `runBuildForOneRepo`, `combineTaskArtifacts`, and
 * `createPerRepoBuildStep` are drop-in replacements for the per-task
 * fanout implemented in `pipeline-runner.ts:runBuildForRepo()`.
 *
 * Tests use a fake AgentManager so we exercise the parse → group →
 * fanout → combine path without spinning up a real subprocess. Per-task
 * failures are swallowed into UNRESOLVED placeholders (legacy parity);
 * the fallback path propagates errors so the caller can mark the repo
 * failed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryEventBus,
  InMemoryStepRegistry,
  Pipeline,
  type Step,
} from '@anvil/core-pipeline';

import {
  BUILD_DISALLOWED_TOOLS,
  combineTaskArtifacts,
  createPerRepoBuildStep,
  runBuildForOneRepo,
  type RunBuildForRepoResult,
} from '../steps/per-repo-build.step.js';
import type { ParsedTask } from '../engineer-task-bundler.js';
import type { AgentManager, AgentState, SpawnConfig } from '../agent-manager.js';

interface FakeOpts {
  /** Status sequence the next getAgent() calls return. */
  statuses?: AgentState['status'][];
  /** Per-id (or default) artifact override. */
  resultByName?: Record<string, { artifact: string; cost: number }>;
  /** Force certain agents (matched by spec.name) to fail mid-poll. */
  failByName?: Record<string, string>;
}

/**
 * Per-id polling fake — tracks every spawn so tests can assert spawn
 * configs (disallowedTools, stage label, prompt) and per-id status walks.
 */
function fakeAgentManager(opts: FakeOpts = {}): {
  manager: AgentManager;
  spawned: SpawnConfig[];
  spawnedIds: string[];
} {
  const spawned: SpawnConfig[] = [];
  const spawnedIds: string[] = [];
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
    getAgent: (id: string): AgentState | undefined => {
      const i = pollIndex.get(id) ?? 0;
      pollIndex.set(id, i + 1);
      const idx = spawnedIds.indexOf(id);
      const spec = spawned[idx];
      const failureMessage = spec ? opts.failByName?.[spec.name] : undefined;
      const status: AgentState['status'] = failureMessage
        ? (i === 0 ? 'running' : 'error')
        : (opts.statuses ? (opts.statuses[i] ?? 'done') : 'done');
      const override = spec ? opts.resultByName?.[spec.name] : undefined;
      const finalArtifact = override?.artifact ?? `art:${spec?.name ?? id}`;
      const finalCost = override?.cost ?? 0.01;
      return {
        id,
        name: spec?.name ?? 'agent',
        persona: spec?.persona ?? 'engineer',
        sessionId: 's',
        model: spec?.model ?? 'claude',
        status,
        cost: status === 'done'
          ? { ...baseCost, totalUsd: finalCost, stopReason: 'end_turn' } as AgentState['cost']
          : baseCost,
        output: status === 'done' ? finalArtifact : '',
        activities: [],
        startedAt: 0,
        finishedAt: status === 'done' ? Date.now() : null,
        error: status === 'error' ? failureMessage ?? null : null,
      };
    },
  } as unknown as AgentManager;

  return { manager, spawned, spawnedIds };
}

const NO_SLEEP = async (_: number) => undefined;

const TASKS_MD = `### TASK-001: Implement A
- **Scope**: \`a.ts\`
- **Prerequisites**: None

### TASK-002: Implement B
- **Scope**: \`b.ts\`
- **Prerequisites**: TASK-001

### TASK-003: Implement C
- **Scope**: \`c.ts\`
- **Prerequisites**: None
`;

function buildOpts(overrides: Partial<Parameters<typeof runBuildForOneRepo>[0]> = {}) {
  const f = fakeAgentManager(overrides.tasksMarkdown !== undefined
    ? { /* fake tweaked by overrides */ }
    : {});
  return {
    f,
    base: {
      agentManager: f.manager,
      project: 'demo',
      stageName: 'build',
      persona: 'engineer',
      model: 'claude',
      maxOutputTokens: 16000,
      repoName: 'api',
      repoPath: '/tmp/api',
      projectPrompt: 'sys',
      tasksMarkdown: TASKS_MD,
      buildPerTaskPrompt: (task: ParsedTask) => `usr-${task.id}`,
      buildFallbackPrompt: () => 'usr-fallback',
      isCancelled: () => false,
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
      ...overrides,
    } as Parameters<typeof runBuildForOneRepo>[0],
  };
}

// ── BUILD_DISALLOWED_TOOLS / combineTaskArtifacts ───────────────────────

describe('BUILD_DISALLOWED_TOOLS', () => {
  it('locks down Read/Grep/Glob/Agent for build spawns', () => {
    assert.deepEqual([...BUILD_DISALLOWED_TOOLS], ['Read', 'Grep', 'Glob', 'Agent']);
  });
});

describe('combineTaskArtifacts', () => {
  const tasks: ParsedTask[] = [
    { id: 'TASK-001', title: 'A', files: ['a'], specRef: null, prerequisites: [], block: '' },
    { id: 'TASK-002', title: 'B', files: ['b'], specRef: null, prerequisites: [], block: '' },
    { id: 'TASK-003', title: 'C', files: ['c'], specRef: null, prerequisites: [], block: '' },
  ];

  it('preserves original task order regardless of completion order', () => {
    // Outputs collected in reverse order — combine must restore original.
    const out = combineTaskArtifacts(tasks, [
      { id: 'TASK-003', title: 'C', artifact: 'C-art' },
      { id: 'TASK-001', title: 'A', artifact: 'A-art' },
      { id: 'TASK-002', title: 'B', artifact: 'B-art' },
    ]);
    assert.equal(out, 'A-art\n\n---\n\nB-art\n\n---\n\nC-art');
  });

  it('trims each artifact and joins with the legacy separator', () => {
    const out = combineTaskArtifacts(tasks, [
      { id: 'TASK-001', title: 'A', artifact: '\n  A body  \n' },
      { id: 'TASK-002', title: 'B', artifact: 'B body\n' },
    ]);
    assert.equal(out, 'A body\n\n---\n\nB body');
  });
});

// ── runBuildForOneRepo — fallback path ──────────────────────────────────

describe('runBuildForOneRepo — fallback (no parseable tasks)', () => {
  it('spawns a single repo-wide agent when TASKS.md is empty', async () => {
    const { f, base } = buildOpts({ tasksMarkdown: '' });
    const result = await runBuildForOneRepo(base);

    assert.equal(f.spawned.length, 1);
    assert.equal(result.fallback, true);
    assert.equal(result.taskCount, 0);
    const spec = f.spawned[0];
    assert.deepEqual(spec.disallowedTools, ['Read', 'Grep', 'Glob', 'Agent']);
    assert.equal(spec.stage, 'build:api');
    assert.equal(spec.name, 'engineer-api');
    assert.equal(spec.prompt, 'usr-fallback');
  });

  it('propagates fallback agent errors (caller marks repo failed)', async () => {
    const { base } = buildOpts({ tasksMarkdown: '' });
    // Re-bind to a manager that fails.
    const failingManager = fakeAgentManager({ failByName: { 'engineer-api': 'spawn died' } });
    await assert.rejects(
      runBuildForOneRepo({ ...base, agentManager: failingManager.manager }),
      /spawn died|Agent failed/,
    );
  });

  it('treats unparseable markdown (no tasks with files) as fallback too', async () => {
    // The only "task" has no Scope line → parseTasks() drops it.
    const md = '### TASK-001: no scope\n- **Prerequisites**: None\n';
    const { f, base } = buildOpts({ tasksMarkdown: md });
    const result = await runBuildForOneRepo(base);
    assert.equal(result.fallback, true);
    assert.equal(f.spawned.length, 1);
    assert.equal(f.spawned[0].prompt, 'usr-fallback');
  });
});

// ── runBuildForOneRepo — per-task fanout ────────────────────────────────

describe('runBuildForOneRepo — per-task fanout', () => {
  it('spawns one agent per task with build-stage tool lockdown', async () => {
    const { f, base } = buildOpts();
    const result = await runBuildForOneRepo(base);

    assert.equal(result.fallback, false);
    assert.equal(result.taskCount, 3);
    assert.equal(f.spawned.length, 3);
    for (const spec of f.spawned) {
      assert.deepEqual(spec.disallowedTools, ['Read', 'Grep', 'Glob', 'Agent']);
      assert.match(spec.stage, /^build:api:TASK-/);
      assert.match(spec.name, /^engineer-api-TASK-/);
    }
  });

  it('combines per-task artifacts in original task order', async () => {
    // Spawn order is dependency-driven (TASK-001 + TASK-003 in group 0, TASK-002 in group 1)
    // — combine must still emit them as 1, 2, 3.
    const { base } = buildOpts({});
    const result = await runBuildForOneRepo({
      ...base,
      // Override per-task prompts so we can identify them in spawn configs.
      buildPerTaskPrompt: (task) => `prompt-for-${task.id}`,
    });
    // Simple substring assertions — order is the load-bearing claim.
    const idxOne = result.artifact.indexOf('art:engineer-api-TASK-001');
    const idxTwo = result.artifact.indexOf('art:engineer-api-TASK-002');
    const idxThree = result.artifact.indexOf('art:engineer-api-TASK-003');
    assert.ok(idxOne >= 0 && idxTwo >= 0 && idxThree >= 0);
    assert.ok(idxOne < idxTwo && idxTwo < idxThree, 'task artifacts must appear in TASK-001 → 002 → 003 order');
  });

  it('groups tasks by prerequisites — group 0 spawns before group 1', async () => {
    // TASK-001 and TASK-003 have no prereqs → group 0 (parallel).
    // TASK-002 depends on TASK-001 → group 1 (serial after group 0 settles).
    // Spawn order in the fake's `spawned` array reflects call order: group 0
    // spawns synchronously before group 1 iterates.
    const { f, base } = buildOpts();
    await runBuildForOneRepo(base);

    const order = f.spawned.map((s) => s.name);
    const group0 = ['engineer-api-TASK-001', 'engineer-api-TASK-003'];
    const idx002 = order.indexOf('engineer-api-TASK-002');
    for (const n of group0) {
      assert.ok(order.indexOf(n) < idx002, `${n} (group 0) must spawn before TASK-002 (group 1)`);
    }
  });

  it('swallows per-task failures into UNRESOLVED placeholders', async () => {
    // Replace the agentManager with one that fails the second task.
    const failingF = fakeAgentManager({
      failByName: { 'engineer-api-TASK-002': 'fixture failure' },
    });
    const { base } = buildOpts();
    const events: Array<{ level: string; message: string }> = [];
    const result = await runBuildForOneRepo({
      ...base,
      agentManager: failingF.manager,
      onProjectEvent: (level, message) => events.push({ level, message }),
    });
    assert.equal(result.fallback, false);
    assert.equal(result.taskCount, 3);
    assert.match(result.artifact, /UNRESOLVED: fixture failure/);
    assert.match(result.artifact, /## Implementation: TASK-002 — Implement B/);
    assert.ok(events.some((e) => e.level === 'warn' && /TASK-002 failed/.test(e.message)));
  });

  it('throws when cancellation flips between groups', async () => {
    // Use a manager whose agents take two polls to complete so sleep IS
    // called between polls; the sleep callback flips cancellation, which the
    // top-of-group check sees on the next iteration and throws.
    const f = fakeAgentManager({ statuses: ['running', 'done'] });
    let cancelled = false;
    const { base } = buildOpts();
    await assert.rejects(
      runBuildForOneRepo({
        ...base,
        agentManager: f.manager,
        sleep: async () => { cancelled = true; },
        isCancelled: () => cancelled,
      }),
      /Pipeline cancelled/,
    );
  });

  it('forwards onAgentSpawned per task spawn', async () => {
    const seen: string[] = [];
    const { base } = buildOpts();
    await runBuildForOneRepo({
      ...base,
      onAgentSpawned: (id) => seen.push(id),
    });
    assert.equal(seen.length, 3);
    // Three distinct agent ids.
    assert.equal(new Set(seen).size, 3);
  });

  it('emits an info event with task / group counts', async () => {
    const events: Array<{ level: string; message: string }> = [];
    const { base } = buildOpts();
    await runBuildForOneRepo({
      ...base,
      onProjectEvent: (level, message) => events.push({ level, message }),
    });
    const announce = events.find((e) => /3 tasks in 2 groups/.test(e.message));
    assert.ok(announce, 'must announce task / group counts');
    assert.equal(announce?.level, 'info');
  });
});

// ── createPerRepoBuildStep ──────────────────────────────────────────────

describe('createPerRepoBuildStep', () => {
  it('declares parallelism: per-repo and a default id derived from stageName', () => {
    const f = fakeAgentManager();
    const step = createPerRepoBuildStep({
      agentManager: f.manager,
      project: 'demo',
      stageName: 'build',
      persona: 'engineer',
      model: 'claude',
      buildProjectPrompt: () => '',
      loadTasksMarkdown: () => '',
      buildPerTaskPrompt: () => '',
      buildFallbackPrompt: () => '',
    });
    assert.equal(step.parallelism, 'per-repo');
    assert.equal(step.id, 'per-repo-build:build');
  });

  it('runs once per repoPaths key (Pipeline walker fans out — Phase 4a)', async () => {
    const f = fakeAgentManager();
    const writes: Array<{ repo: string; artifact: string }> = [];

    const step = createPerRepoBuildStep({
      agentManager: f.manager,
      project: 'demo',
      stageName: 'build',
      persona: 'engineer',
      model: 'claude',
      buildProjectPrompt: (repo) => `sys-${repo}`,
      loadTasksMarkdown: (repo) => repo === 'api' ? TASKS_MD : '',
      buildPerTaskPrompt: (repo, _path, task) => `${repo}-${task.id}`,
      buildFallbackPrompt: (repo) => `${repo}-fallback`,
      writeRepoArtifact: (repo, artifact) => writes.push({ repo, artifact }),
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
    });

    let aggregated: Record<string, RunBuildForRepoResult> | undefined;
    const downstream: Step<Record<string, RunBuildForRepoResult>, void> = {
      id: 'capture',
      async run(ctx) { aggregated = ctx.input; },
    };

    const registry = new InMemoryStepRegistry();
    registry.register(step as Step<unknown, unknown>);
    registry.register(downstream as Step<unknown, unknown>);

    const pipeline = new Pipeline({
      registry,
      bus: new InMemoryEventBus(),
      runId: 'run-build',
      workspaceDir: '/tmp',
      repoPaths: { api: '/tmp/api', web: '/tmp/web' },
    });
    const runResult = await pipeline.run();

    assert.equal(runResult.status, 'success');
    assert.ok(aggregated);
    // api ran the per-task path (3 tasks) → 3 spawns; web fell back → 1 spawn = 4 total.
    assert.equal(f.spawned.length, 4);
    assert.equal(aggregated.api.fallback, false);
    assert.equal(aggregated.api.taskCount, 3);
    assert.equal(aggregated.web.fallback, true);
    assert.equal(aggregated.web.taskCount, 0);
    // writeRepoArtifact called once per repo with the combined output.
    assert.deepEqual(writes.map((w) => w.repo).sort(), ['api', 'web']);
  });

  it('fails the Step when ctx.repoName is missing', async () => {
    const f = fakeAgentManager();
    const step = createPerRepoBuildStep({
      agentManager: f.manager,
      project: 'demo',
      stageName: 'build',
      persona: 'engineer',
      model: 'claude',
      buildProjectPrompt: () => '',
      loadTasksMarkdown: () => '',
      buildPerTaskPrompt: () => '',
      buildFallbackPrompt: () => '',
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
    });
    const registry = new InMemoryStepRegistry();
    registry.register(step as Step<unknown, unknown>);
    const pipeline = new Pipeline({
      registry,
      bus: new InMemoryEventBus(),
      runId: 'run-no-repos',
      workspaceDir: '/tmp',
      // repoPaths intentionally omitted — walker calls run() once with repoName=undefined.
    });
    const runResult = await pipeline.run();
    assert.equal(runResult.status, 'failed');
    assert.equal(runResult.failedStep, 'per-repo-build:build');
  });
});
