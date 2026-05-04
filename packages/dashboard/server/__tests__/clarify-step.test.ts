/**
 * Phase 4e parity tests — `createClarifyStep` orchestrates the same Q&A
 * loop as `pipeline-runner.ts:runClarifyStage()` (deterministic parts only:
 * parseQuestions + per-question userMessage await + qaText assembly).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryEventBus,
  InMemoryStepRegistry,
  Pipeline,
  type PipelineEvent,
  type Step,
} from '@anvil/core-pipeline';

import {
  createClarifyStep,
  formatQAPairs,
  parseClarifyQuestions,
  type ClarifyEvent,
  type ClarifyResult,
} from '../steps/index.js';

const EXPLORE_OUTPUT = `Here are my questions:

1. Should we rate-limit per-IP or per-account?
2. **What's the token rotation cadence**?
3. Where do session events get logged?

Please answer in any order.`;

describe('parseClarifyQuestions — Phase 4e helper parity', () => {
  it('parses numbered questions and dedupes', () => {
    const out = parseClarifyQuestions(EXPLORE_OUTPUT);
    assert.equal(out.length, 3);
    assert.match(out[0], /rate-limit/i);
    assert.match(out[1], /token rotation/i);
    assert.match(out[2], /session events/i);
  });

  it('strips the "Please answer ..." footer', () => {
    const out = parseClarifyQuestions(EXPLORE_OUTPUT);
    for (const q of out) {
      assert.ok(!/please answer/i.test(q), `question still contains footer: ${q}`);
    }
  });

  it('drops short fragments', () => {
    const md = `1. ok\n2. This is a real question we expect to keep`;
    const out = parseClarifyQuestions(md);
    assert.equal(out.length, 1);
    assert.match(out[0], /real question/);
  });

  it('returns empty list when no numbered headings present', () => {
    assert.deepEqual(parseClarifyQuestions('plain prose without numbering'), []);
  });
});

describe('formatQAPairs', () => {
  it('produces the canonical Q1/A1 layout used by the synthesis prompt', () => {
    const out = formatQAPairs([
      { question: 'Q one?', answer: 'A one' },
      { question: 'Q two?', answer: 'A two' },
    ]);
    assert.equal(
      out,
      '**Q1**: Q one?\n**A1**: A one\n\n**Q2**: Q two?\n**A2**: A two',
    );
  });
});

interface RunOpts {
  resolver: (q: string, idx: number, total: number) => Promise<string>;
  abort?: AbortSignal;
  onEvent?: (e: ClarifyEvent) => void;
  initialInput?: string;
}

async function runClarifyPipeline(opts: RunOpts): Promise<{
  result: ClarifyResult | undefined;
  artifacts: Array<{ id: string; data: unknown }>;
  status: string;
}> {
  const step = createClarifyStep({
    inputResolver: opts.resolver,
    onEvent: opts.onEvent,
  });
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
    runId: 'clarify-test',
    workspaceDir: '/tmp',
    initialInput: opts.initialInput ?? EXPLORE_OUTPUT,
    signal: opts.abort,
  });
  const runResult = await pipeline.run();
  const seen = pipeline.getArtifacts();
  return {
    result: seen.read<ClarifyResult>('CLARIFY-QA.json') as ClarifyResult | undefined,
    artifacts,
    status: runResult.status,
  };
}

describe('createClarifyStep — Phase 4e', () => {
  it('asks each parsed question via the resolver and collects qaPairs', async () => {
    const askedQuestions: string[] = [];
    const { result, artifacts } = await runClarifyPipeline({
      resolver: async (q) => {
        askedQuestions.push(q);
        return `answer-${askedQuestions.length}`;
      },
    });
    assert.ok(result);
    assert.equal(result.questions.length, 3);
    assert.equal(askedQuestions.length, 3);
    assert.equal(result.qaPairs.length, 3);
    assert.deepEqual(result.qaPairs.map((p) => p.answer), ['answer-1', 'answer-2', 'answer-3']);
    assert.equal(result.cancelled, false);
    // Synthesis prompt is non-empty when at least one Q&A pair landed.
    assert.match(result.synthesisPrompt, /CLARIFICATION\.md/);
    // Artifact emitted: clarify-qa.json with the result.
    assert.ok(artifacts.some((a) => a.id === 'CLARIFY-QA.json'));
  });

  it('emits question / answer / complete events in order', async () => {
    const events: ClarifyEvent[] = [];
    await runClarifyPipeline({
      resolver: async () => 'reply',
      onEvent: (e) => events.push(e),
    });
    const types = events.map((e) => e.type);
    // 3 questions × (question, answer) + 1 complete.
    assert.deepEqual(types, [
      'question', 'answer',
      'question', 'answer',
      'question', 'answer',
      'complete',
    ]);
  });

  it('treats an empty resolver reply as cancellation', async () => {
    const { result } = await runClarifyPipeline({
      resolver: async (_q, idx) => (idx === 1 ? '' : `ans-${idx}`),
    });
    assert.ok(result);
    // First answered, second cancelled, third never asked.
    assert.equal(result.qaPairs.length, 1);
    assert.equal(result.cancelled, true);
    assert.equal(result.synthesisPrompt.length > 0, true); // first answer still produces a synth prompt
  });

  it('returns empty synthesisPrompt when no answers collected', async () => {
    const { result } = await runClarifyPipeline({
      resolver: async () => '', // user immediately cancels
    });
    assert.ok(result);
    assert.equal(result.qaPairs.length, 0);
    assert.equal(result.cancelled, true);
    assert.equal(result.synthesisPrompt, '');
  });

  it('aborts cleanly when ctx.signal fires mid-loop', async () => {
    const controller = new AbortController();
    let asked = 0;
    const { result } = await runClarifyPipeline({
      resolver: async () => {
        asked += 1;
        if (asked === 1) controller.abort();
        return `ans-${asked}`;
      },
      abort: controller.signal,
    });
    assert.ok(result);
    // First answer landed; abort fires before second iteration loop check.
    assert.equal(result.qaPairs.length, 1);
    assert.equal(result.cancelled, true);
  });

  it('falls back to the entire output as a single question when none parse', async () => {
    const { result } = await runClarifyPipeline({
      resolver: async () => 'fine',
      initialInput: 'no numbered questions here at all but plenty of text content',
    });
    assert.ok(result);
    assert.equal(result.questions.length, 1);
    assert.equal(result.qaPairs.length, 1);
  });

  it('returns an empty result when input is empty', async () => {
    const { result, artifacts } = await runClarifyPipeline({
      resolver: async () => 'unused',
      initialInput: '',
    });
    assert.ok(result);
    assert.equal(result.questions.length, 0);
    assert.equal(result.qaPairs.length, 0);
    // Artifact still emitted (with empty result) so downstream consumers can
    // distinguish "ran but found nothing" from "step never ran".
    assert.ok(artifacts.some((a) => a.id === 'CLARIFY-QA.json'));
  });

  it('treats resolver rejection as cancellation', async () => {
    const { result } = await runClarifyPipeline({
      resolver: async (_q, idx) => {
        if (idx === 1) throw new Error('user disconnected');
        return `ans-${idx}`;
      },
    });
    assert.ok(result);
    assert.equal(result.qaPairs.length, 1);
    assert.equal(result.cancelled, true);
  });
});
