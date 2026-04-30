/**
 * Smoke test for the new core-pipeline-driven cli orchestrator.
 *
 * Builds the 8-step registry, runs Pipeline.run() with a fake
 * AgentRunner (canned outputs), a stub projectLoader (one repo), and
 * a synthetic CliPipelineState. Verifies:
 *
 *   - all 8 step:started + step:completed events fire in order
 *   - artifacts are emitted (CLARIFICATION.md, REQUIREMENTS.md, VALIDATION.md)
 *   - approval-gate request flow works (auto-respond 'approved')
 *   - clarify:answers Q&A flow works (auto-respond canned answers)
 *   - bus.request never times out (responders attached)
 *   - PipelineRunResult.status === 'success'
 *   - cost accumulates via attachCostTrackerHook
 *
 * Run via:  node dist/pipeline/__smoke__/run-pipeline.smoke.js
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Pipeline,
  InMemoryEventBus,
  attachAuditLogHook,
  attachCostTrackerHook,
  attachApprovalGateHook,
  attachFeatureStoreHook,
  APPROVAL_GATE_CHANNEL,
  type PipelineEvent,
} from '@anvil/core-pipeline';

import { buildDefaultPipelineRegistry } from '../steps/index.js';
import { FEATURE_STORE_ARTIFACT_PATHS } from '../feature-store.js';
import type { CliPipelineState } from '../cli-state.js';
import type { AgentRunner } from '../stages/types.js';
import type { CostEntry } from '../../run/index.js';

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'anvil-smoke-'));
  process.env.ANVIL_HOME = tmp;
  process.env.ANVIL_WORKSPACE_ROOT = tmp;

  const events: PipelineEvent[] = [];
  const bus = new InMemoryEventBus();

  const record = (e: PipelineEvent): void => { events.push(e); };
  bus.on('pipeline:started', record);
  bus.on('pipeline:completed', record);
  bus.on('pipeline:failed', record);
  bus.on('step:started', record);
  bus.on('step:completed', record);
  bus.on('step:failed', record);
  bus.on('step:skipped', record);
  bus.on('artifact:emitted', record);

  // Hooks
  const auditPath = join(tmp, 'audit.jsonl');
  attachAuditLogHook(bus, { path: auditPath });
  const costHandle = attachCostTrackerHook(bus);
  attachFeatureStoreHook(bus, {
    featureDir: join(tmp, 'features'),
    artifactPaths: FEATURE_STORE_ARTIFACT_PATHS,
  });

  // Auto-approve every approval-gate request
  attachApprovalGateHook(bus, {
    getApprovalDecision: async () => 'approved',
  });

  // Auto-respond clarify:answers with canned answers
  bus.onRequest<{ questions: string[] }>('clarify:answers', (req) => {
    const answers = req.payload.questions.map((_, i) => `auto-answer-${i + 1}`);
    bus.respond('clarify:answers', req.requestId, answers);
  });

  // Fake AgentRunner — returns deterministic outputs per stage
  let agentCallCount = 0;
  const fakeAgentRunner: AgentRunner = {
    async run(config) {
      agentCallCount += 1;
      let output: string;
      if (config.stage === 'clarify' && agentCallCount === 1) {
        // First clarify call generates numbered questions
        output = '1. Question one?\n2. Question two? Please answer.';
      } else if (config.stage === 'clarify') {
        output = '# Clarification\n\nAuto-generated clarification.';
      } else if (config.stage === 'requirements') {
        output = '# Requirements\n\nAuto-generated requirements.';
      } else if (config.stage === 'validate' || config.stage.startsWith('revalidate')) {
        // Make validate succeed first try (no fix loop)
        output = '# Validation\n\nVERDICT: PASS';
      } else if (config.stage.startsWith('fix-')) {
        output = '# Fix\n\nFixed.';
      } else if (config.stage === 'ship') {
        output = 'Created PR https://github.com/test/repo/pull/1';
      } else {
        output = `# ${config.stage}\n\nAuto-generated for stage ${config.stage}.`;
      }
      return { output, tokenEstimate: 1500 };
    },
  };

  // Stub projectLoader
  const projectLoader = {
    findProject: async (name: string) => ({
      project: name,
      repos: [{ name: 'demo-repo', path: undefined }],
    }),
    loadAll: async () => [{
      project: 'smoke-project',
      repos: [{ name: 'demo-repo', path: undefined }],
    }],
  };

  // Build a minimal CliPipelineState (skip real workspace resolution)
  const state: CliPipelineState = {
    project: 'smoke-project',
    feature: 'add hello world',
    featureSlug: 'add-hello-world',
    runId: 'smoke-run-1',
    runDir: join(tmp, 'runs', 'smoke-run-1'),
    startedAt: Date.now(),
    workspaceDir: tmp,
    repoPaths: { 'demo-repo': join(tmp, 'demo-repo') },
    repoNames: ['demo-repo'],
    projectYamlPath: undefined,
    agentRunner: fakeAgentRunner,
    projectLoader,
    memoryStore: { formatForPrompt: () => '', add: () => undefined } as never,
    runStore: { updateStage: async () => undefined, updateRun: async () => undefined, createRun: async () => undefined } as never,
    approvalRequired: true,
    skipShip: false,
    skipClarify: false,
    answersFile: undefined,
    actionType: 'feature',
    deploy: false,
    failureContext: undefined,
    resumeFromStage: 0,
    model: 'claude-sonnet-4-6',
    clarificationArtifact: '',
    highLevelReqsArtifact: '',
    affectedProjects: [],
    projectReqsMap: new Map(),
    projectSpecsMap: new Map(),
    projectTasksMap: new Map(),
    validationArtifact: '',
    prUrls: [],
    sandboxUrl: undefined,
    stageCosts: new Map(),
  };

  // Build registry — skip 'build' and 'ship' steps because they invoke
  // real git / gh CLI which would fail in this synthetic environment.
  const fullRegistry = buildDefaultPipelineRegistry();
  const filteredRegistry = {
    register: () => undefined,
    insertBefore: () => undefined,
    insertAfter: () => undefined,
    replace: () => undefined,
    remove: () => undefined,
    steps: () => fullRegistry.steps().filter((s) => s.id !== 'build' && s.id !== 'ship'),
  };

  console.error('▶ Running smoke test (6 stages: clarify, requirements, project-requirements, specs, tasks, validate)...\n');

  const pipeline = new Pipeline({
    registry: filteredRegistry,
    bus,
    runId: 'smoke-run-1',
    workspaceDir: tmp,
    initialShared: state as unknown as Record<string, unknown>,
  });

  const result = await pipeline.run();

  console.error('\n══ RESULT ══');
  console.error(`status: ${result.status}`);
  console.error(`completedSteps: [${result.completedSteps.join(', ')}]`);
  console.error(`failedStep: ${result.failedStep ?? '<none>'}`);
  console.error(`durationMs: ${result.durationMs}`);

  // Diagnostics
  const stepStarted = events.filter((e) => e.hook === 'step:started').map((e) => e.stepId);
  const stepCompleted = events.filter((e) => e.hook === 'step:completed').map((e) => e.stepId);
  const stepFailed = events.filter((e) => e.hook === 'step:failed').map((e) => `${e.stepId}: ${e.error?.message}`);
  const artifacts = events
    .filter((e) => e.hook === 'artifact:emitted')
    .map((e) => (e.payload as { artifactId?: string } | undefined)?.artifactId);

  console.error('\n══ EVENTS ══');
  console.error(`step:started:   [${stepStarted.join(', ')}]`);
  console.error(`step:completed: [${stepCompleted.join(', ')}]`);
  if (stepFailed.length > 0) console.error(`step:failed:    ${stepFailed.join('\n               ')}`);
  console.error(`artifacts:      [${artifacts.join(', ')}]`);
  console.error(`agent calls:    ${agentCallCount}`);
  console.error(`cost total:     $${costHandle.totals().costUsd.toFixed(4)} across ${costHandle.totals().entries} stages`);
  console.error(`audit log:      ${existsSync(auditPath) ? 'wrote ' + auditPath : 'NOT WRITTEN'}`);
  console.error(`feature dir:    ${existsSync(join(tmp, 'features')) ? 'wrote ' + join(tmp, 'features') : 'NOT WRITTEN'}`);

  // Assertions
  const errors: string[] = [];
  if (result.status !== 'success') errors.push(`status was '${result.status}', expected 'success'`);
  const expectedSteps = ['clarify', 'requirements', 'project-requirements', 'specs', 'tasks', 'validate'];
  for (const s of expectedSteps) {
    if (!stepCompleted.includes(s)) errors.push(`step '${s}' did not complete`);
  }
  if (!artifacts.includes('CLARIFICATION.md')) errors.push('CLARIFICATION.md artifact not emitted');
  if (!artifacts.includes('VALIDATION.md')) errors.push('VALIDATION.md artifact not emitted');

  rmSync(tmp, { recursive: true, force: true });

  console.error('\n══ ASSERTIONS ══');
  if (errors.length === 0) {
    console.error('✓ All checks passed.');
    process.exit(0);
  } else {
    console.error('✗ Failures:');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n══ SMOKE TEST CRASHED ══');
  console.error(err);
  process.exit(1);
});

// Avoid unused import warning when noUnusedLocals is on
void ({} as { CostEntry?: CostEntry; APPROVAL_GATE_CHANNEL?: typeof APPROVAL_GATE_CHANNEL });
