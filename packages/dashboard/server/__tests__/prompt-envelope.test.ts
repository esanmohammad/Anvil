/**
 * Tests for prompt-envelope — Phase 1 cache-stability guarantees.
 *
 * The whole point of the envelope is that the stable prefix is byte-identical
 * across calls when the stable inputs match. These tests guard against any
 * future change that quietly busts that property.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPromptEnvelope,
  type PromptEnvelopeInput,
} from '../prompt-envelope.js';
import type { PromptAwareAdapter } from '@anvil/agent-core';

type AdapterStub = Pick<PromptAwareAdapter, 'capabilities' | 'markCacheBreakpoint'>;

const STABLE: Pick<
  PromptEnvelopeInput,
  'systemPrompt' | 'projectFacts' | 'knowledgeBase' | 'conventions' | 'featureManifest'
> = {
  systemPrompt: 'You are an Anvil pipeline agent.',
  projectFacts: 'Project: pet-company\nRepos: api, web, worker',
  knowledgeBase: '## Architecture\n- api: Go service\n- web: React app',
  conventions: 'TypeScript strict mode; commits via Anvil pipeline only.',
  featureManifest: '',
};

function makeInput(variable: Partial<PromptEnvelopeInput>): PromptEnvelopeInput {
  return {
    ...STABLE,
    stageInstructions: '',
    featureDescription: '',
    priorArtifact: '',
    resumeContext: '',
    ...variable,
  };
}

describe('buildPromptEnvelope — stable prefix invariance', () => {
  it('stable prefix is byte-identical across two calls with different variable inputs', () => {
    const a = buildPromptEnvelope(
      makeInput({ stageInstructions: 'Stage A', featureDescription: 'feat-a' }),
      null,
    );
    const b = buildPromptEnvelope(
      makeInput({ stageInstructions: 'Stage B', featureDescription: 'feat-b', priorArtifact: 'prev' }),
      null,
    );
    assert.equal(a.stable, b.stable);
    assert.equal(a.stableBytes, b.stableBytes);
  });

  it('breakpoint sits exactly at the byte boundary between stable and variable', () => {
    const env = buildPromptEnvelope(
      makeInput({ stageInstructions: 'Do X', featureDescription: 'F' }),
      null,
    );
    const stablePrefix = env.prompt.slice(0, env.breakpointAt);
    const expected = env.stable + '\n\n';
    assert.equal(Buffer.byteLength(stablePrefix, 'utf-8'), Buffer.byteLength(expected, 'utf-8'));
  });

  it('omits empty sections — no trailing blank "## Feature manifest" header', () => {
    const env = buildPromptEnvelope(makeInput({}), null);
    assert.ok(!env.stable.includes('Feature manifest'));
  });

  it('drops empty variable sections — no resume header when there is no resume context', () => {
    const env = buildPromptEnvelope(
      makeInput({ stageInstructions: 'Run', featureDescription: 'F' }),
      null,
    );
    assert.ok(!env.variable.includes('Resume context'));
  });
});

describe('buildPromptEnvelope — explicit cache marker', () => {
  it('inserts the breakpoint marker only when adapter advertises explicit caching', () => {
    const explicitAdapter: AdapterStub = {
      capabilities: { promptCache: 'explicit', countTokens: 'heuristic', structuredOutput: 'tool-shim', maxOutputTokens: false },
      markCacheBreakpoint: (prompt: string, position: number): string =>
        prompt.slice(0, position) + '\n<!-- MARKER -->\n' + prompt.slice(position),
    };
    const env = buildPromptEnvelope(
      makeInput({ stageInstructions: 'Run' }),
      explicitAdapter as PromptAwareAdapter,
    );
    assert.ok(env.prompt.includes('MARKER'));
  });

  it('leaves prompt unchanged for auto-cache adapters', () => {
    const autoAdapter: AdapterStub = {
      capabilities: { promptCache: 'auto', countTokens: 'heuristic', structuredOutput: 'strict', maxOutputTokens: true },
      markCacheBreakpoint: () => {
        throw new Error('should not be called');
      },
    };
    const env = buildPromptEnvelope(
      makeInput({ stageInstructions: 'Run' }),
      autoAdapter as PromptAwareAdapter,
    );
    assert.ok(!env.prompt.includes('MARKER'));
    assert.equal(env.prompt, env.stable + '\n\n' + env.variable);
  });

  it('null adapter is supported (KB indexing / standalone tooling)', () => {
    const env = buildPromptEnvelope(makeInput({ stageInstructions: 'Run' }), null);
    assert.equal(env.prompt, env.stable + '\n\n' + env.variable);
  });
});

describe('buildPromptEnvelope — byte accounting', () => {
  it('stableBytes + variableBytes match the UTF-8 lengths of each section', () => {
    const env = buildPromptEnvelope(
      makeInput({ stageInstructions: 'multi-byte: café résumé' }),
      null,
    );
    assert.equal(env.stableBytes, Buffer.byteLength(env.stable, 'utf-8'));
    assert.equal(env.variableBytes, Buffer.byteLength(env.variable, 'utf-8'));
  });
});
