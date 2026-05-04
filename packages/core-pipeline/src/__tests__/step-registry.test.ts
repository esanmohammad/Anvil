/**
 * Phase 4 — StepRegistry contract tests + Step<I,O> integration with the
 * Pipeline walker.
 *
 * Coverage:
 *   - register / insertBefore / insertAfter / replace / remove ordering
 *   - duplicate-id rejection at register / insertBefore / insertAfter
 *   - missing-id rejection at insertBefore / insertAfter / replace / remove
 *   - replace at same id is allowed (no duplicate-id error)
 *   - integration: a typed Step<ClarifyIn, ClarifyOut> threads input/output
 *     through the Pipeline walker
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryEventBus,
  InMemoryStepRegistry,
  Pipeline,
  type Step,
} from '../index.js';

const make = (id: string): Step<unknown, unknown> => ({ id, run: async () => undefined });

describe('StepRegistry contract (Phase 4)', () => {
  it('register adds in order; steps() is a snapshot', () => {
    const r = new InMemoryStepRegistry();
    r.register(make('a'));
    r.register(make('b'));
    const snap1 = r.steps();
    r.register(make('c'));
    assert.deepEqual(snap1.map((s) => s.id), ['a', 'b']);
    assert.deepEqual(r.steps().map((s) => s.id), ['a', 'b', 'c']);
  });

  it('insertBefore / insertAfter respect target', () => {
    const r = new InMemoryStepRegistry();
    r.register(make('a'));
    r.register(make('d'));
    r.insertAfter('a', make('b'));
    r.insertBefore('d', make('c'));
    assert.deepEqual(r.steps().map((s) => s.id), ['a', 'b', 'c', 'd']);
  });

  it('replace swaps the step at the same id without duplicate-id error', () => {
    const r = new InMemoryStepRegistry();
    r.register(make('a'));
    r.register(make('b'));
    const replacement: Step<unknown, unknown> = { id: 'a', run: async () => 'replaced' };
    r.replace('a', replacement);
    assert.equal(r.steps()[0], replacement);
    assert.deepEqual(r.steps().map((s) => s.id), ['a', 'b']);
  });

  it('replace can change id when target has no other entry', () => {
    const r = new InMemoryStepRegistry();
    r.register(make('a'));
    r.replace('a', make('a-new'));
    assert.deepEqual(r.steps().map((s) => s.id), ['a-new']);
  });

  it('rejects duplicate ids at register / insertBefore / insertAfter', () => {
    const r = new InMemoryStepRegistry();
    r.register(make('a'));
    assert.throws(() => r.register(make('a')), /duplicate/);
    assert.throws(() => r.insertBefore('a', make('a')), /duplicate/);
    assert.throws(() => r.insertAfter('a', make('a')), /duplicate/);
  });

  it('rejects missing ids at insertBefore / insertAfter / replace / remove', () => {
    const r = new InMemoryStepRegistry();
    r.register(make('a'));
    assert.throws(() => r.insertBefore('x', make('y')), /no step with id "x"/);
    assert.throws(() => r.insertAfter('x', make('y')), /no step with id "x"/);
    assert.throws(() => r.replace('x', make('y')), /no step with id "x"/);
    assert.throws(() => r.remove('x'), /no step with id "x"/);
  });

  it('integration: typed Step threads input → output through the walker', async () => {
    interface ClarifyIn {
      feature: string;
    }
    interface ClarifyOut {
      questions: string[];
      tokenEstimate: number;
    }
    const clarifyStep: Step<ClarifyIn, ClarifyOut> = {
      id: 'clarify',
      name: 'Generate clarifying questions',
      run: async (ctx) => {
        const out: ClarifyOut = {
          questions: [`Q1 about ${ctx.input.feature}`],
          tokenEstimate: 42,
        };
        ctx.emit('CLARIFICATION.md', `# ${ctx.input.feature}`);
        return out;
      },
    };
    interface ReqIn {
      questions: string[];
      tokenEstimate: number;
    }
    const reqStep: Step<ReqIn, { reqMd: string }> = {
      id: 'requirements',
      run: async (ctx) => {
        return { reqMd: `## Requirements derived from ${ctx.input.questions.length} question(s)` };
      },
    };

    const r = new InMemoryStepRegistry();
    r.register(clarifyStep as Step<unknown, unknown>);
    r.register(reqStep as Step<unknown, unknown>);
    const bus = new InMemoryEventBus();
    const p = new Pipeline({
      bus,
      registry: r,
      runId: 'r1',
      workspaceDir: '/tmp',
      initialInput: { feature: 'multi-tenant-billing' } satisfies ClarifyIn,
    });
    const result = await p.run();
    assert.equal(result.status, 'success');
    assert.deepEqual(result.completedSteps, ['clarify', 'requirements']);
    assert.equal(p.getArtifacts().read('CLARIFICATION.md'), '# multi-tenant-billing');
  });
});
