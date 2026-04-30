/**
 * Phase 4f.4 tests — `runClarifyForProject` and `createClarifyStageStep`
 * orchestrate the full 3-phase clarify dance (explore → Q&A → synthesize)
 * that `pipeline-runner.ts:runClarifyStage()` implements.
 *
 * Tests use a fake AgentManager so we exercise the spawn → poll →
 * sendInput → second poll path without spinning up a real subprocess.
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
  createClarifyStageStep,
  runClarifyForProject,
  type RunClarifyForProjectResult,
} from '../steps/clarify-stage.step.js';
import type { AgentManager, AgentState, SpawnConfig } from '../agent-manager.js';

interface FakeOpts {
  /** First-phase poll responses (explore). */
  exploreStatuses?: AgentState['status'][];
  /** Second-phase poll responses (synthesize, after sendInput). */
  synthesizeStatuses?: AgentState['status'][];
  /** Final artifact for the explore phase. */
  exploreArtifact?: string;
  /** Final artifact for the synthesize phase. */
  synthesizeArtifact?: string;
}

/**
 * Per-id polling fake. Tracks when sendInput is called so the second
 * polling phase ("synthesize") returns the synthesize artifact rather
 * than the explore one.
 */
function fakeAgentManager(opts: FakeOpts = {}): {
  manager: AgentManager;
  spawned: SpawnConfig[];
  sendInputs: Array<{ agentId: string; text: string }>;
} {
  const spawned: SpawnConfig[] = [];
  const sendInputs: Array<{ agentId: string; text: string }> = [];
  const pollPhase = new Map<string, 'explore' | 'synthesize'>();
  const phasePollIndex = new Map<string, number>();
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
      pollPhase.set(id, 'explore');
      phasePollIndex.set(id, 0);
      return {
        id, name: config.name, persona: config.persona,
        sessionId: 's', model: config.model,
        status: 'pending', cost: baseCost, output: '', activities: [],
        startedAt: Date.now(), finishedAt: null, error: null,
      };
    },
    sendInput: (agentId: string, text: string) => {
      sendInputs.push({ agentId, text });
      // Switch the polling phase: subsequent getAgent calls walk the
      // synthesize statuses sequence, returning the synthesize artifact
      // when status hits 'done'.
      pollPhase.set(agentId, 'synthesize');
      phasePollIndex.set(agentId, 0);
    },
    kill: () => undefined,
    getAgent: (id: string): AgentState | undefined => {
      const phase = pollPhase.get(id) ?? 'explore';
      const i = phasePollIndex.get(id) ?? 0;
      phasePollIndex.set(id, i + 1);
      const seq = phase === 'explore'
        ? (opts.exploreStatuses ?? ['done'])
        : (opts.synthesizeStatuses ?? ['done']);
      const status: AgentState['status'] = seq[i] ?? 'done';
      const finalArtifact = phase === 'explore'
        ? (opts.exploreArtifact ?? 'EXPLORE-OUT')
        : (opts.synthesizeArtifact ?? 'SYNTH-OUT');
      const idx = parseInt(id.replace('agent-', ''), 10) - 1;
      const spec = spawned[idx];
      return {
        id,
        name: spec?.name ?? 'agent',
        persona: spec?.persona ?? 'clarifier',
        sessionId: 's',
        model: spec?.model ?? 'claude',
        status,
        cost: status === 'done'
          ? { ...baseCost, totalUsd: 0.05, stopReason: 'end_turn' } as AgentState['cost']
          : baseCost,
        output: status === 'done' ? finalArtifact : '',
        activities: [],
        startedAt: 0,
        finishedAt: status === 'done' ? Date.now() : null,
        error: null,
      };
    },
  } as unknown as AgentManager;

  return { manager, spawned, sendInputs };
}

const NO_SLEEP = async (_: number) => undefined;

const TWO_QUESTIONS = `Here are my questions:

1. Should we rate-limit per-IP or per-account?
2. **What's the token rotation cadence**?

Please answer in any order.`;

function baseOptions(overrides: Partial<Parameters<typeof runClarifyForProject>[0]> = {}) {
  return {
    project: 'demo',
    workspaceDir: '/tmp/ws',
    model: 'claude',
    maxOutputTokens: 2000,
    explorePrompt: 'explore prompt',
    projectPrompt: 'project prompt',
    isCancelled: () => false,
    inputResolver: async (_q: string, _i: number, _t: number) => 'answer-text',
    pollIntervalMs: 1,
    sleep: NO_SLEEP,
    ...overrides,
  } as Parameters<typeof runClarifyForProject>[0];
}

// ── runClarifyForProject — explore-only path ────────────────────────────

describe('runClarifyForProject — no Q&A pairs collected', () => {
  it('returns explore artifact when resolver returns empty (cancellation)', async () => {
    const f = fakeAgentManager({ exploreArtifact: TWO_QUESTIONS });
    const result = await runClarifyForProject({
      ...baseOptions({
        inputResolver: async () => '', // user cancels first question
      }),
      agentManager: f.manager,
    });
    assert.equal(result.synthesizeRan, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.qaPairs.length, 0);
    assert.equal(result.artifact, TWO_QUESTIONS);
    // sendInput must not be called when synthesize is skipped.
    assert.equal(f.sendInputs.length, 0);
  });

  it('returns explore artifact when isCancelled flips before first question', async () => {
    const f = fakeAgentManager({ exploreArtifact: TWO_QUESTIONS });
    let cancelled = false;
    const result = await runClarifyForProject({
      ...baseOptions({
        isCancelled: () => cancelled,
        inputResolver: async () => {
          cancelled = true; // legacy: any answer + cancel → bail
          return '';
        },
      }),
      agentManager: f.manager,
    });
    assert.equal(result.synthesizeRan, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.artifact, TWO_QUESTIONS);
  });

  it('falls back to treating empty/non-numbered output as a single question', async () => {
    // No numbered questions → parseClarifyQuestions returns []. The helper
    // falls back to the entire artifact as one question. If the resolver
    // returns empty, no synthesize → explore artifact propagates.
    const f = fakeAgentManager({ exploreArtifact: 'plain prose, no numbering' });
    const askedQuestions: string[] = [];
    const result = await runClarifyForProject({
      ...baseOptions({
        inputResolver: async (q) => {
          askedQuestions.push(q);
          return ''; // cancel
        },
      }),
      agentManager: f.manager,
    });
    assert.equal(askedQuestions.length, 1);
    assert.equal(askedQuestions[0], 'plain prose, no numbering');
    assert.equal(result.artifact, 'plain prose, no numbering');
    assert.equal(result.synthesizeRan, false);
  });
});

// ── runClarifyForProject — Q&A loop + synthesize ────────────────────────

describe('runClarifyForProject — synthesize phase', () => {
  it('runs synthesize when at least one Q&A pair landed', async () => {
    const f = fakeAgentManager({
      exploreArtifact: TWO_QUESTIONS,
      synthesizeArtifact: 'CLARIFICATION.md content',
    });
    const result = await runClarifyForProject({
      ...baseOptions({
        inputResolver: async (_q, i) => `ans-${i + 1}`,
      }),
      agentManager: f.manager,
    });
    assert.equal(result.synthesizeRan, true);
    assert.equal(result.cancelled, false);
    assert.equal(result.qaPairs.length, 2);
    assert.deepEqual(result.qaPairs.map((p) => p.answer), ['ans-1', 'ans-2']);
    assert.equal(result.artifact, 'CLARIFICATION.md content');
    // explore + synthesize each cost 0.05 → total 0.10.
    assert.ok(Math.abs(result.cost - 0.10) < 1e-9);
  });

  it('passes the synthesis prompt with **Q/A** formatting to sendInput', async () => {
    const f = fakeAgentManager({ exploreArtifact: TWO_QUESTIONS });
    await runClarifyForProject({
      ...baseOptions({
        inputResolver: async (_q, i) => `ans-${i + 1}`,
      }),
      agentManager: f.manager,
    });
    assert.equal(f.sendInputs.length, 1);
    const text = f.sendInputs[0].text;
    assert.match(text, /\*\*Q1\*\*: /);
    assert.match(text, /\*\*A1\*\*: ans-1/);
    assert.match(text, /\*\*Q2\*\*: /);
    assert.match(text, /\*\*A2\*\*: ans-2/);
    assert.match(text, /CLARIFICATION\.md/);
  });

  it('falls back to explore artifact when synthesize returns empty', async () => {
    const f = fakeAgentManager({
      exploreArtifact: 'EXPLORE',
      synthesizeArtifact: '', // synthesize emits nothing → fall back
    });
    const result = await runClarifyForProject({
      ...baseOptions({
        inputResolver: async () => 'a',
      }),
      agentManager: f.manager,
    });
    assert.equal(result.synthesizeRan, true);
    assert.equal(result.artifact, 'EXPLORE');
  });

  it('treats resolver rejection as cancellation (no synthesize)', async () => {
    const f = fakeAgentManager({ exploreArtifact: TWO_QUESTIONS });
    const result = await runClarifyForProject({
      ...baseOptions({
        inputResolver: async () => { throw new Error('user closed dashboard'); },
      }),
      agentManager: f.manager,
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.synthesizeRan, false);
    assert.equal(f.sendInputs.length, 0);
  });

  it('cancellation between questions still synthesizes if a Q&A pair already landed', async () => {
    // First question answered; second question canceled. Legacy:
    // qaPairs.length === 1 > 0 AND cancelled → bail, no synthesize.
    const f = fakeAgentManager({ exploreArtifact: TWO_QUESTIONS });
    let cancelled = false;
    const result = await runClarifyForProject({
      ...baseOptions({
        isCancelled: () => cancelled,
        inputResolver: async (_q, i) => {
          if (i === 0) return 'first answer';
          cancelled = true;
          return ''; // simulate cancel-after-first
        },
      }),
      agentManager: f.manager,
    });
    assert.equal(result.qaPairs.length, 1);
    assert.equal(result.cancelled, true);
    // Legacy behavior: cancelled || empty answers → no synthesize.
    assert.equal(result.synthesizeRan, false);
    assert.equal(f.sendInputs.length, 0);
  });
});

// ── State callback ordering ─────────────────────────────────────────────

describe('runClarifyForProject — state callback ordering', () => {
  it('fires callbacks in the legacy WS event vocabulary', async () => {
    const f = fakeAgentManager({ exploreArtifact: TWO_QUESTIONS });
    const events: string[] = [];
    await runClarifyForProject({
      ...baseOptions({
        inputResolver: async (_q, i) => `a${i}`,
      }),
      agentManager: f.manager,
      onAgentSpawned: () => events.push('spawned'),
      onClarifyQuestion: (i) => events.push(`Q${i}`),
      onWaitingForInput: () => events.push('waiting'),
      onAnswerReceived: (a) => events.push(`ans:${a}`),
      onClarifyAck: (i, _t, hasMore) => events.push(`ack${i}:${hasMore ? 'more' : 'last'}`),
      onSynthesizeStart: () => events.push('synth'),
    });

    assert.deepEqual(events, [
      'spawned',
      'Q0', 'waiting', 'ans:a0', 'ack0:more',
      'Q1', 'waiting', 'ans:a1', 'ack1:last',
      'synth',
    ]);
  });

  it('does not fire onSynthesizeStart when no Q&A pair landed', async () => {
    const f = fakeAgentManager({ exploreArtifact: TWO_QUESTIONS });
    let synthFired = false;
    await runClarifyForProject({
      ...baseOptions({
        inputResolver: async () => '',
      }),
      agentManager: f.manager,
      onSynthesizeStart: () => { synthFired = true; },
    });
    assert.equal(synthFired, false);
  });
});

// ── createClarifyStageStep — Pipeline.run integration ──────────────────

describe('createClarifyStageStep — Step factory', () => {
  it('declares serial parallelism + default id', () => {
    const f = fakeAgentManager();
    const step = createClarifyStageStep({
      agentManager: f.manager,
      project: 'demo',
      workspaceDir: '/tmp',
      model: 'claude',
      buildExplorePrompt: () => '',
      buildProjectPrompt: () => '',
      inputResolver: async () => '',
    });
    assert.equal(step.parallelism, 'serial');
    assert.equal(step.id, 'clarify-stage');
  });

  it('runs the full 3-phase flow when invoked through Pipeline.run', async () => {
    const f = fakeAgentManager({
      exploreArtifact: TWO_QUESTIONS,
      synthesizeArtifact: 'final clarification',
    });
    const step = createClarifyStageStep({
      agentManager: f.manager,
      project: 'demo',
      workspaceDir: '/tmp',
      model: 'claude',
      buildExplorePrompt: () => 'explore prompt',
      buildProjectPrompt: () => 'project prompt',
      inputResolver: async (_q, i) => `ans-${i + 1}`,
      pollIntervalMs: 1,
      sleep: NO_SLEEP,
    });

    let captured: RunClarifyForProjectResult | undefined;
    const downstream: Step<RunClarifyForProjectResult, void> = {
      id: 'capture',
      async run(ctx) { captured = ctx.input; },
    };
    const registry = new InMemoryStepRegistry();
    registry.register(step as Step<unknown, unknown>);
    registry.register(downstream as Step<unknown, unknown>);

    const pipeline = new Pipeline({
      registry,
      bus: new InMemoryEventBus(),
      runId: 'run-clarify',
      workspaceDir: '/tmp',
    });
    const runResult = await pipeline.run();

    assert.equal(runResult.status, 'success');
    assert.ok(captured);
    assert.equal(captured.synthesizeRan, true);
    assert.equal(captured.qaPairs.length, 2);
    assert.equal(captured.artifact, 'final clarification');
  });
});
