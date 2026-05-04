// Phase 9 (deviation fix) — verify the planner retries on envelope
// validation failure and gracefully degrades after MAX_RETRIES + 1 fails.

import { runProjectTasksStage } from '../project-tasks.js';
import type { AgentRunner, StageContext } from '../types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeRunner(responses: string[]): { runner: AgentRunner; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const runner: AgentRunner = {
    async run({ userPrompt }) {
      calls.push(userPrompt);
      const out = i < responses.length ? responses[i] : responses[responses.length - 1];
      i += 1;
      return { output: out, tokenEstimate: 100 };
    },
  };
  return { runner, calls };
}

const validTasksJson =
  '```json\n' +
  JSON.stringify([
    {
      id: 'T-1',
      repo: 'sample-repo',
      files_affected: ['src/x.ts'],
      operation: 'create',
      routing: { capability: 'code', complexity: 'M', context_estimate_tokens: 1000 },
      acceptance_criteria: [{ type: 'prose', text: 'works' }],
    },
  ]) +
  '\n```';

describe('runProjectTasksStage — envelope validation retry', () => {
  let runDir: string;

  beforeAll(() => { runDir = mkdtempSync(join(tmpdir(), 'anvil-tasks-stage-')); });
  afterAll(() => { rmSync(runDir, { recursive: true, force: true }); });

  function makeCtx(runner: AgentRunner): StageContext {
    return {
      runDir,
      project: 'demo',
      feature: 'add x',
      agentRunner: runner,
    };
  }

  it('succeeds on first attempt when envelope is valid', async () => {
    const { runner, calls } = makeRunner([validTasksJson + '\n\nNarration after JSON.']);
    const out = await runProjectTasksStage(
      makeCtx(runner),
      'spec',
      { name: 'demo-proj', repos: ['sample-repo'] },
    );
    expect(calls.length).toBe(1);
    expect(out.artifact).toContain('"id"');
    expect(out.tokenEstimate).toBe(100);
  });

  it('retries when JSON is missing, succeeds on retry', async () => {
    const { runner, calls } = makeRunner([
      'No JSON block here, just narration about tasks.',
      validTasksJson,
    ]);
    const out = await runProjectTasksStage(
      makeCtx(runner),
      'spec',
      { name: 'p', repos: ['r'] },
    );
    expect(calls.length).toBe(2);
    // Retry prompt must include the failure detail.
    expect(calls[1]).toContain('previous attempt');
    expect(calls[1]).toMatch(/no JSON task block/i);
    expect(out.tokenEstimate).toBe(200);
  });

  it('retries when JSON is malformed, succeeds on retry', async () => {
    const { runner, calls } = makeRunner([
      '```json\n{ invalid json\n```',
      validTasksJson,
    ]);
    const out = await runProjectTasksStage(
      makeCtx(runner),
      'spec',
      { name: 'p', repos: ['r'] },
    );
    expect(calls.length).toBe(2);
    expect(out.artifact).toBe(validTasksJson);
  });

  it('retries when JSON parses but envelope is invalid', async () => {
    const { runner, calls } = makeRunner([
      '```json\n[{"id":"T-1"}]\n```', // missing required routing/acceptance
      validTasksJson,
    ]);
    const out = await runProjectTasksStage(
      makeCtx(runner),
      'spec',
      { name: 'p', repos: ['r'] },
    );
    expect(calls.length).toBe(2);
    expect(out.artifact).toBe(validTasksJson);
  });

  it('caps retries at MAX_RETRIES (3 total invocations)', async () => {
    const { runner, calls } = makeRunner([
      'no json',
      'still no json',
      'final no json',
    ]);
    const out = await runProjectTasksStage(
      makeCtx(runner),
      'spec',
      { name: 'p', repos: ['r'] },
    );
    expect(calls.length).toBe(3);
    // Graceful degrade: returns the last markdown artifact, no throw.
    expect(out.artifact).toBe('final no json');
    expect(out.tokenEstimate).toBe(300);
  });

  it('passes the schema hint in the first prompt', async () => {
    const { runner, calls } = makeRunner([validTasksJson]);
    await runProjectTasksStage(
      makeCtx(runner),
      'spec',
      { name: 'p', repos: ['r'] },
    );
    expect(calls[0]).toContain('TaskEnvelope[]');
    expect(calls[0]).toMatch(/```json/);
  });
});
