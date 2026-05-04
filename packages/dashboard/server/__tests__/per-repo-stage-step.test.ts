/**
 * Phase 4f.2 tests — `runPerRepoStageForRepo`, `combinePerRepoArtifacts`,
 * and `createPerRepoStageStep` are drop-in replacements for the per-repo
 * branch of `pipeline-runner.ts:runPerRepoStage()`.
 *
 * Tests use a fake AgentManager so we exercise the spawn → wait →
 * artifact-write path without spinning up a real subprocess. The Step
 * factory is exercised through `Pipeline.run()` so the per-repo walker
 * (Phase 4a) is in the loop.
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
  combinePerRepoArtifacts,
  createPerRepoStageStep,
  disallowedToolsForPersona,
  runPerRepoStageForRepo,
  type RunPerRepoStageResult,
} from '../steps/per-repo-stage.step.js';
import type { AgentManager, AgentState, SpawnConfig } from '@anvil/agent-core';

interface FakeOpts {
  /** Status sequence the next getAgent() calls return for each agent id. */
  statuses?: AgentState['status'][];
  /** Final cost / output to surface when status hits 'done'. */
  result?: Partial<AgentState>;
}

/**
 * Returns a fake AgentManager whose `spawn` records every config and whose
 * `getAgent` walks a per-id `statuses` queue. Mirrors the fake used in
 * `agent-spawner.test.ts` but tracks per-id polling so we can fan out to
 * multiple repos in one test.
 */
function fakeAgentManager(opts: FakeOpts = {}): {
  manager: AgentManager;
  spawned: SpawnConfig[];
  spawnedIds: string[];
} {
  const spawned: SpawnConfig[] = [];
  const spawnedIds: string[] = [];
  const pollIndex = new Map<string, number>();

  const cost: AgentState['cost'] = {
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
        status: 'pending', cost, output: '', activities: [],
        startedAt: Date.now(), finishedAt: null, error: null,
      };
    },
    getAgent: (id: string): AgentState | undefined => {
      const i = pollIndex.get(id) ?? 0;
      pollIndex.set(id, i + 1);
      const status = opts.statuses ? (opts.statuses[i] ?? 'done') : 'done';
      const finalOutput = status === 'done'
        ? `${opts.result?.output ?? 'art'}:${id}`
        : '';
      const sourceConfig = spawned[spawnedIds.indexOf(id)];
      return {
        id,
        name: sourceConfig?.name ?? 'agent',
        persona: sourceConfig?.persona ?? 'planner',
        sessionId: 's',
        model: sourceConfig?.model ?? 'claude',
        status,
        cost: status === 'done'
          ? { ...cost, ...(opts.result?.cost ?? {}) }
          : cost,
        output: finalOutput,
        activities: [],
        startedAt: 0,
        finishedAt: status === 'done' ? Date.now() : null,
        error: status === 'error' ? 'fake-failure' : null,
      };
    },
  } as unknown as AgentManager;

  return { manager, spawned, spawnedIds };
}

const NO_SLEEP = async (_: number) => undefined;

// ── disallowedToolsForPersona ────────────────────────────────────────────

describe('disallowedToolsForPersona', () => {
  it('grants engineers + testers write access (only Agent disabled)', () => {
    assert.deepEqual(disallowedToolsForPersona('engineer'), ['Agent']);
    assert.deepEqual(disallowedToolsForPersona('tester'), ['Agent']);
  });

  it('disables write tools + Bash for non-engineer/non-tester personas', () => {
    // Read-only-explorer personas (clarifier asks questions, test-author
    // generates tests against the existing tree). Keep Grep + Glob.
    for (const p of ['test-author', 'clarifier']) {
      assert.deepEqual(
        disallowedToolsForPersona(p),
        ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Agent'],
        `persona "${p}" should have write tools + Bash disabled`,
      );
    }
  });

  it('disables exploration tools (Grep/Glob) for KB-only personas', () => {
    // Spec-writing personas read from the injected Knowledge Base, not
    // from re-exploring the repo. They keep Read for spot-checks.
    for (const p of ['analyst', 'architect', 'lead']) {
      assert.deepEqual(
        disallowedToolsForPersona(p),
        ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Grep', 'Glob', 'Agent'],
        `persona "${p}" should have exploration tools disabled (KB-only)`,
      );
    }
  });
});

// ── combinePerRepoArtifacts ──────────────────────────────────────────────

describe('combinePerRepoArtifacts', () => {
  it('joins per-repo artifacts with the legacy "## <repo>" header + "---" separator', () => {
    const out = combinePerRepoArtifacts([
      { repoName: 'api', artifact: 'API spec body' },
      { repoName: 'web', artifact: 'Web spec body' },
    ]);
    assert.equal(out, '## api\n\nAPI spec body\n\n---\n\n## web\n\nWeb spec body');
  });

  it('drops empty-artifact entries (failed repos contribute nothing)', () => {
    const out = combinePerRepoArtifacts([
      { repoName: 'api', artifact: 'good' },
      { repoName: 'web', artifact: '' },
      { repoName: 'worker', artifact: 'also good' },
    ]);
    assert.equal(out, '## api\n\ngood\n\n---\n\n## worker\n\nalso good');
  });

  it('returns empty string when every repo failed', () => {
    assert.equal(
      combinePerRepoArtifacts([
        { repoName: 'api', artifact: '' },
        { repoName: 'web', artifact: '' },
      ]),
      '',
    );
  });
});

// ── runPerRepoStageForRepo ───────────────────────────────────────────────

describe('runPerRepoStageForRepo', () => {
  it('forwards the persona-aware disallowedTools rule into the spawn config', async () => {
    const f = fakeAgentManager({ statuses: ['done'] });
    await runPerRepoStageForRepo({
      agentManager: f.manager,
      project: 'demo',
      stageName: 'specs',
      persona: 'architect', // non-engineer/non-tester
      model: 'claude',
      maxOutputTokens: 6000,
      repoName: 'api',
      repoPath: '/tmp/api',
      projectPrompt: 'sys',
      prompt: 'usr',
      isCancelled: () => false,
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
    });
    assert.equal(f.spawned.length, 1);
    const spec = f.spawned[0];
    assert.deepEqual(spec.disallowedTools, ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Grep', 'Glob', 'Agent']);
    assert.equal(spec.cwd, '/tmp/api');
    assert.equal(spec.stage, 'specs:api');
    assert.equal(spec.name, 'architect-api');
    assert.equal(spec.maxOutputTokens, 6000);
    assert.equal(spec.permissionMode, 'bypassPermissions');
  });

  it('engineers retain write tools (only Agent disabled)', async () => {
    const f = fakeAgentManager({ statuses: ['done'] });
    await runPerRepoStageForRepo({
      agentManager: f.manager,
      project: 'demo',
      stageName: 'validate',
      persona: 'tester',
      model: 'claude',
      repoName: 'web',
      repoPath: '/tmp/web',
      projectPrompt: 'sys',
      prompt: 'usr',
      isCancelled: () => false,
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
    });
    assert.deepEqual(f.spawned[0].disallowedTools, ['Agent']);
  });

  it('returns agentId, artifact, and cost when the agent completes', async () => {
    const f = fakeAgentManager({
      statuses: ['running', 'done'],
      result: { output: 'final-art', cost: { totalUsd: 0.42, outputTokens: 50, stopReason: 'end_turn' } as AgentState['cost'] },
    });
    const ids: string[] = [];
    const result = await runPerRepoStageForRepo({
      agentManager: f.manager,
      project: 'demo',
      stageName: 'specs',
      persona: 'architect',
      model: 'claude',
      repoName: 'api',
      repoPath: '/tmp/api',
      projectPrompt: 'sys',
      prompt: 'usr',
      isCancelled: () => false,
      onSpawn: (id) => ids.push(id),
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
    });
    assert.equal(result.agentId, 'agent-1');
    assert.equal(result.artifact, 'final-art:agent-1');
    assert.equal(result.cost, 0.42);
    assert.deepEqual(ids, ['agent-1']);
  });

  it('propagates agent-side errors (caller is expected to mark repo as failed)', async () => {
    const f = fakeAgentManager({ statuses: ['running', 'error'] });
    await assert.rejects(
      runPerRepoStageForRepo({
        agentManager: f.manager,
        project: 'demo',
        stageName: 'specs',
        persona: 'architect',
        model: 'claude',
        repoName: 'api',
        repoPath: '/tmp/api',
        projectPrompt: 'sys',
        prompt: 'usr',
        isCancelled: () => false,
        pollIntervalMs: 1,
        sleep: NO_SLEEP,
      }),
      /Agent failed|fake-failure/,
    );
  });

  it('forwards onTruncation when the agent stops at max_tokens', async () => {
    const f = fakeAgentManager({
      statuses: ['done'],
      result: {
        output: 'cut',
        cost: { totalUsd: 0.1, outputTokens: 16000, stopReason: 'max_tokens' } as AgentState['cost'],
      },
    });
    const truncations: Array<{ name: string; tokens: number }> = [];
    await runPerRepoStageForRepo({
      agentManager: f.manager,
      project: 'demo',
      stageName: 'specs',
      persona: 'architect',
      model: 'claude',
      repoName: 'api',
      repoPath: '/tmp/api',
      projectPrompt: 'sys',
      prompt: 'usr',
      isCancelled: () => false,
      onTruncation: (name, tokens) => truncations.push({ name, tokens }),
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
    });
    assert.equal(truncations.length, 1);
    assert.equal(truncations[0].tokens, 16000);
  });
});

// ── createPerRepoStageStep ──────────────────────────────────────────────

describe('createPerRepoStageStep', () => {
  it('declares parallelism: per-repo and a default id derived from stageName', () => {
    const f = fakeAgentManager({ statuses: ['done'] });
    const step = createPerRepoStageStep({
      agentManager: f.manager,
      project: 'demo',
      stageName: 'specs',
      persona: 'architect',
      model: 'claude',
      buildProjectPrompt: () => '',
      buildStagePrompt: () => '',
    });
    assert.equal(step.parallelism, 'per-repo');
    assert.equal(step.id, 'per-repo-stage:specs');
  });

  it('runs once per repoPaths key (Pipeline walker fans out — Phase 4a)', async () => {
    const f = fakeAgentManager({
      statuses: ['done'],
      result: { output: 'art', cost: { totalUsd: 0.1, outputTokens: 10, stopReason: 'end_turn' } as AgentState['cost'] },
    });
    const projectPromptCalls: string[] = [];
    const stagePromptCalls: Array<{ repo: string; prev: string }> = [];
    const writes: Array<{ repo: string; artifact: string }> = [];

    const step = createPerRepoStageStep({
      agentManager: f.manager,
      project: 'demo',
      stageName: 'specs',
      persona: 'architect',
      model: 'claude',
      buildProjectPrompt: (repo) => {
        projectPromptCalls.push(repo);
        return `sys-for-${repo}`;
      },
      buildStagePrompt: (repo, prev) => {
        stagePromptCalls.push({ repo, prev });
        return `usr-for-${repo}`;
      },
      writeRepoArtifact: (repo, artifact) => {
        writes.push({ repo, artifact });
      },
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
    });

    // Downstream serial step captures the aggregated `Record<string, O>`
    // that the per-repo walker emits as its output.
    let aggregated: Record<string, RunPerRepoStageResult> | undefined;
    const downstream: Step<Record<string, RunPerRepoStageResult>, void> = {
      id: 'capture-downstream',
      async run(ctx) {
        aggregated = ctx.input;
      },
    };

    const registry = new InMemoryStepRegistry();
    registry.register(step as Step<unknown, unknown>);
    registry.register(downstream as Step<unknown, unknown>);

    const pipeline = new Pipeline({
      registry,
      bus: new InMemoryEventBus(),
      runId: 'run-spec',
      workspaceDir: '/tmp',
      repoPaths: { api: '/tmp/api', web: '/tmp/web' },
      initialInput: 'PREV-ARTIFACT',
    });
    const runResult = await pipeline.run();

    assert.equal(runResult.status, 'success');
    assert.equal(f.spawned.length, 2);
    assert.deepEqual(projectPromptCalls.sort(), ['api', 'web']);
    assert.deepEqual(stagePromptCalls.map((c) => c.prev).sort(), ['PREV-ARTIFACT', 'PREV-ARTIFACT']);
    // Pipeline aggregates per-repo outputs into Record<string, O> — read via downstream input.
    assert.ok(aggregated);
    assert.deepEqual(Object.keys(aggregated).sort(), ['api', 'web']);
    assert.equal(aggregated.api.cost, 0.1);
    assert.equal(aggregated.web.cost, 0.1);
    // writeRepoArtifact called once per repo with the agent's output.
    assert.deepEqual(writes.map((w) => w.repo).sort(), ['api', 'web']);
  });

  it('forwards onAgentSpawned with the repo name', async () => {
    const f = fakeAgentManager({ statuses: ['done'] });
    const spawned: Array<{ repo: string; id: string }> = [];
    const step = createPerRepoStageStep({
      agentManager: f.manager,
      project: 'demo',
      stageName: 'tasks',
      persona: 'lead',
      model: 'claude',
      buildProjectPrompt: () => 'sys',
      buildStagePrompt: () => 'usr',
      onAgentSpawned: (repo, id) => spawned.push({ repo, id }),
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
    });

    const registry = new InMemoryStepRegistry();
    registry.register(step as Step<unknown, unknown>);
    const pipeline = new Pipeline({
      registry,
      bus: new InMemoryEventBus(),
      runId: 'run-onspawn',
      workspaceDir: '/tmp',
      repoPaths: { api: '/tmp/api' },
    });
    const runResult = await pipeline.run();

    assert.equal(runResult.status, 'success');
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].repo, 'api');
    assert.equal(spawned[0].id, 'agent-1');
  });

  it('throws when ctx.repoName is missing (walker invariant violated)', async () => {
    const f = fakeAgentManager({ statuses: ['done'] });
    const step = createPerRepoStageStep({
      agentManager: f.manager,
      project: 'demo',
      stageName: 'specs',
      persona: 'architect',
      model: 'claude',
      buildProjectPrompt: () => '',
      buildStagePrompt: () => '',
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
    });

    // No repoPaths → the walker calls run() once with ctx.repoName=undefined.
    const registry = new InMemoryStepRegistry();
    registry.register(step as Step<unknown, unknown>);
    const pipeline = new Pipeline({
      registry,
      bus: new InMemoryEventBus(),
      runId: 'run-no-repos',
      workspaceDir: '/tmp',
      // repoPaths intentionally omitted.
    });
    const runResult = await pipeline.run();
    assert.equal(runResult.status, 'failed');
    assert.equal(runResult.failedStep, 'per-repo-stage:specs');
  });

  it('throws when repoPaths has the key but no path', async () => {
    const f = fakeAgentManager({ statuses: ['done'] });
    const step = createPerRepoStageStep({
      agentManager: f.manager,
      project: 'demo',
      stageName: 'specs',
      persona: 'architect',
      model: 'claude',
      buildProjectPrompt: () => '',
      buildStagePrompt: () => '',
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
    });

    // ctx.repoPaths exists but value is empty string for this repo.
    const registry = new InMemoryStepRegistry();
    registry.register(step as Step<unknown, unknown>);
    const pipeline = new Pipeline({
      registry,
      bus: new InMemoryEventBus(),
      runId: 'run-empty-path',
      workspaceDir: '/tmp',
      repoPaths: { api: '' }, // Falsy → helper rejects.
    });
    const runResult = await pipeline.run();
    assert.equal(runResult.status, 'failed');
  });
});
