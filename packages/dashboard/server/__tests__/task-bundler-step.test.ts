/**
 * Phase 4d parity test — `createTaskBundlerStep` must produce the same
 * tasks + groups as direct `parseTasks` + `groupTasksForExecution`
 * calls, then emit the result as `TASK-BUNDLES.json`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryEventBus,
  InMemoryStepRegistry,
  Pipeline,
  type PipelineEvent,
  type Step,
  type StepContext,
} from '@esankhan3/anvil-core-pipeline';

import {
  createTaskBundlerStep,
  TASK_BUNDLES_ARTIFACT_ID,
  type TaskBundleOutput,
} from '../steps/index.js';
import {
  parseTasks,
  groupTasksForExecution,
} from '@esankhan3/anvil-core-pipeline';

const SAMPLE_TASKS_MD = `# Task Breakdown

## Tasks

### TASK-001: Seed types
- **Estimate**: S
- **Prerequisites**: None
- **Scope**: \`src/types.ts\`
- **Spec Reference**: "Types"

---

### TASK-002: Build component A
- **Prerequisites**: TASK-001
- **Scope**: \`src/components/A.tsx\`
- **Spec Reference**: "Component A"

---

### TASK-003: Build component B
- **Prerequisites**: TASK-001
- **Scope**: \`src/components/B.tsx\`
- **Spec Reference**: "Component B"

---

### TASK-004: Wire A and B
- **Prerequisites**: TASK-002, TASK-003
- **Scope**: \`src/wiring.ts\`
- **Spec Reference**: "Wiring"
`;

async function runStep(
  step: Step<string, TaskBundleOutput>,
  input: string,
): Promise<{
  artifacts: Array<{ id: string; data: unknown }>;
  output: unknown;
}> {
  const registry = new InMemoryStepRegistry();
  registry.register(step as Step<unknown, unknown>);

  const bus = new InMemoryEventBus();
  const artifacts: Array<{ id: string; data: unknown }> = [];
  bus.on('artifact:emitted', (event: PipelineEvent) => {
    const payload = event.payload as { artifactId: string; data: unknown } | undefined;
    if (payload) artifacts.push({ id: payload.artifactId, data: payload.data });
  });

  const pipeline = new Pipeline({
    registry,
    bus,
    runId: 'task-bundler-test',
    workspaceDir: '/tmp/ws',
    initialInput: input,
  });
  const result = await pipeline.run();
  assert.equal(result.status, 'success');
  const seen = pipeline.getArtifacts();
  return { artifacts, output: seen.read(seen.ids()[0] ?? '') };
}

describe('createTaskBundlerStep — Phase 4d', () => {
  it('emits TASK-BUNDLES.json matching parseTasks + groupTasksForExecution', async () => {
    const step = createTaskBundlerStep();
    const { artifacts, output } = await runStep(step, SAMPLE_TASKS_MD);

    const expectedTasks = parseTasks(SAMPLE_TASKS_MD);
    const expectedGroups = groupTasksForExecution(expectedTasks);

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].id, TASK_BUNDLES_ARTIFACT_ID);

    const emitted = artifacts[0].data as TaskBundleOutput;
    assert.deepEqual(
      emitted.tasks.map((t) => t.id),
      expectedTasks.map((t) => t.id),
    );
    assert.deepEqual(
      emitted.tasks.map((t) => t.files),
      expectedTasks.map((t) => t.files),
    );
    assert.equal(emitted.groups.length, expectedGroups.length);
    for (let i = 0; i < expectedGroups.length; i += 1) {
      assert.deepEqual(
        emitted.groups[i].tasks.map((t) => t.id),
        expectedGroups[i].tasks.map((t) => t.id),
      );
    }
    assert.deepEqual(output, emitted);
  });

  it('returns the bundle directly as the step output', async () => {
    const step = createTaskBundlerStep();
    let observed: unknown;
    const downstream: Step<TaskBundleOutput, void> = {
      id: 'sink',
      async run(ctx: StepContext<TaskBundleOutput>) {
        observed = ctx.input;
      },
    };

    const registry = new InMemoryStepRegistry();
    registry.register(step as Step<unknown, unknown>);
    registry.register(downstream as Step<unknown, unknown>);

    const pipeline = new Pipeline({
      registry,
      bus: new InMemoryEventBus(),
      runId: 'tb-passthrough',
      workspaceDir: '/tmp',
      initialInput: SAMPLE_TASKS_MD,
    });
    await pipeline.run();
    const bundle = observed as TaskBundleOutput;
    assert.equal(bundle.tasks.length, 4);
    assert.equal(bundle.groups.length, 3);
  });

  it('respects repoName and emits a per-repo artifact id', async () => {
    const step = createTaskBundlerStep({ repoName: 'api' });
    const { artifacts } = await runStep(step, SAMPLE_TASKS_MD);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].id, `${TASK_BUNDLES_ARTIFACT_ID}:api`);
  });

  it('returns an empty bundle and emits no artifact when input is empty', async () => {
    const step = createTaskBundlerStep();
    const { artifacts, output } = await runStep(step, '');
    assert.equal(artifacts.length, 0);
    assert.deepEqual(output, undefined);
    // empty bundle still surfaces via onBundle when supplied — sanity check
  });

  it('fires onBundle exactly once with the parsed bundle', async () => {
    const calls: TaskBundleOutput[] = [];
    const step = createTaskBundlerStep({
      onBundle: (bundle) => calls.push(bundle),
    });
    await runStep(step, SAMPLE_TASKS_MD);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tasks.length, 4);
    assert.equal(calls[0].groups.length, 3);
  });

  it('still fires onBundle with an empty bundle when input is empty', async () => {
    const calls: TaskBundleOutput[] = [];
    const step = createTaskBundlerStep({
      onBundle: (bundle) => calls.push(bundle),
    });
    await runStep(step, '');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tasks.length, 0);
    assert.equal(calls[0].groups.length, 0);
  });

  it('execution groups respect prerequisite order', async () => {
    const step = createTaskBundlerStep();
    const { artifacts } = await runStep(step, SAMPLE_TASKS_MD);
    const bundle = artifacts[0].data as TaskBundleOutput;

    // TASK-001 must land in the first group; TASK-004 in the last.
    assert.equal(bundle.groups[0].tasks[0].id, 'TASK-001');
    const lastGroup = bundle.groups[bundle.groups.length - 1];
    assert.deepEqual(lastGroup.tasks.map((t) => t.id), ['TASK-004']);

    // TASK-002 + TASK-003 share the middle group (different files, same prereq).
    const middle = bundle.groups.find(
      (g) => g.tasks.some((t) => t.id === 'TASK-002'),
    );
    assert.ok(middle);
    assert.deepEqual(middle.tasks.map((t) => t.id).sort(), ['TASK-002', 'TASK-003']);
  });
});
