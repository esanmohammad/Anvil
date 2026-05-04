/**
 * Canonical prompt envelope — Phase 1 of TOKEN-OPTIMIZATION-PLAN.
 *
 * Splits an agent prompt into a STABLE prefix and a VARIABLE suffix so
 * provider prompt caches (Anthropic explicit, OpenAI auto, Gemini auto)
 * fire on the stable side. The stable section MUST be byte-identical
 * across stages of the same run — caller code is responsible for feeding
 * memoised stable inputs in deterministic order.
 *
 *   ┌─ STABLE PREFIX ────────────────────────────────────────┐
 *   │ 1. System prompt (persona-agnostic invariants)         │
 *   │ 2. Project facts (factory.yaml summary, repo names)    │
 *   │ 3. Knowledge graph (locked tier within a run)          │
 *   │ 4. Conventions / repo invariants                       │
 *   │ 5. Feature manifest (Phase 2 — empty until then)       │
 *   ├─ CACHE BREAKPOINT ─────────────────────────────────────┤
 *   │ 6. Stage instructions (persona-specific)               │
 *   │ 7. Feature description                                 │
 *   │ 8. Prior artifact (if any)                             │
 *   │ 9. Resume / failure context                            │
 *   └────────────────────────────────────────────────────────┘
 *
 * Existing pipeline-runner architecture passes prompt + projectPrompt
 * separately to the adapter (system message vs user message). Callers
 * use `env.stable` as projectPrompt and `env.variable` as prompt; the
 * combined `env.prompt` (with explicit-cache marker when supported) is
 * available for adapters that consume a single string.
 */

import type { PromptAwareAdapter } from '@anvil/agent-core';

export interface PromptEnvelopeInput {
  // ── STABLE ──────────────────────────────────────────────
  /** Persona-agnostic invariants. Never mutated mid-run. */
  systemPrompt: string;
  /** factory.yaml summary, repo list, language hints. */
  projectFacts: string;
  /** Locked-tier KB block (same across stages within a run). */
  knowledgeBase: string;
  /** Long-lived rules and project conventions. */
  conventions: string;
  /** Feature manifest (Phase 2). Empty until then. */
  featureManifest: string;

  // ── VARIABLE ────────────────────────────────────────────
  /** Persona prompt body + per-stage overrides. */
  stageInstructions: string;
  /** "Feature: ..." line plus run-level facts. */
  featureDescription: string;
  /** Markdown artifact emitted by the previous stage. */
  priorArtifact: string;
  /** Failure context when this is a retry. */
  resumeContext: string;
}

export interface PromptEnvelopeOutput {
  /** Combined `stable + '\n\n' + variable`, with explicit cache marker
   *  inserted at `breakpointAt` when the adapter advertises explicit caching. */
  prompt: string;
  /** Stable prefix in isolation. Use as `projectPrompt` (system message). */
  stable: string;
  /** Variable suffix in isolation. Use as `prompt` (user message). */
  variable: string;
  /** UTF-8 bytes of `stable`. */
  stableBytes: number;
  /** UTF-8 bytes of `variable`. */
  variableBytes: number;
  /** Byte index in `prompt` immediately after the stable block. */
  breakpointAt: number;
}

const STABLE_HEADER = '<!-- anvil:stable-prefix:v1 -->';
const VARIABLE_HEADER = '<!-- anvil:variable-suffix:v1 -->';

function sectionIfNonEmpty(title: string, body: string): string | null {
  if (!body || body.trim().length === 0) return null;
  return `## ${title}\n${body.trim()}`;
}

export function buildPromptEnvelope(
  input: PromptEnvelopeInput,
  adapter: PromptAwareAdapter | null | undefined,
): PromptEnvelopeOutput {
  const stableParts = [
    STABLE_HEADER,
    sectionIfNonEmpty('System', input.systemPrompt),
    sectionIfNonEmpty('Project facts', input.projectFacts),
    sectionIfNonEmpty('Knowledge graph', input.knowledgeBase),
    sectionIfNonEmpty('Conventions', input.conventions),
    sectionIfNonEmpty('Feature manifest', input.featureManifest),
  ].filter((p): p is string => Boolean(p));

  const variableParts = [
    VARIABLE_HEADER,
    sectionIfNonEmpty('Stage instructions', input.stageInstructions),
    sectionIfNonEmpty('Feature', input.featureDescription),
    sectionIfNonEmpty('Previous stage output', input.priorArtifact),
    sectionIfNonEmpty('Resume context', input.resumeContext),
  ].filter((p): p is string => Boolean(p));

  const stable = stableParts.join('\n\n');
  const variable = variableParts.join('\n\n');

  const SEP = '\n\n';
  let prompt = stable + SEP + variable;
  // Place the breakpoint right after the stable block + separator. The
  // marker is inserted *before* the variable suffix so the cache-eligible
  // region is exactly `stable + SEP`.
  const breakpointAt = Buffer.byteLength(stable + SEP, 'utf-8');

  if (adapter && adapter.capabilities.promptCache === 'explicit') {
    prompt = adapter.markCacheBreakpoint(prompt, breakpointAt);
  }

  return {
    prompt,
    stable,
    variable,
    stableBytes: Buffer.byteLength(stable, 'utf-8'),
    variableBytes: Buffer.byteLength(variable, 'utf-8'),
    breakpointAt,
  };
}
