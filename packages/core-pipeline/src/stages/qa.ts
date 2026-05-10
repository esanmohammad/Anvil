/**
 * Generic stage Q&A primitives.
 *
 * Mirrors the clarify-stage Q&A loop but parameterised for any planning
 * stage (clarify · requirements · repo-requirements · specs). The agent
 * may emit a `<questions>...</questions>` block in its first response;
 * if present, the orchestrator pauses, asks the user, and resumes the
 * same agent session with the answers concatenated.
 *
 * If no `<questions>` block appears, the agent's output IS the artifact
 * and the orchestrator skips the Q&A path.
 *
 * This module is pure: no LLM calls, no I/O. The orchestrator wires
 * `parseStageQuestions` + `STAGE_QA_PROMPT_HEADER` into its agent loop.
 */

import { parseClarifyQuestions } from './clarify.js';

/**
 * Prompt prefix injected into a stage's user prompt when Q&A is enabled.
 * The orchestrator concatenates this with the existing stage prompt.
 *
 * Format contract: the agent emits `<questions>...</questions>` (one
 * numbered question per line) when it needs clarification; otherwise it
 * produces the artifact directly.
 */
export const STAGE_QA_PROMPT_HEADER = (
  maxQuestions: number,
): string => (
  `If you need clarification before producing this artifact, output ONLY a `
  + `<questions>...</questions>\nblock with one numbered question per line and `
  + `nothing else. List up to ${maxQuestions} questions, most important first. `
  + `If you're confident about the requirements, produce the artifact directly `
  + `with no <questions> block.\n\n`
);

/**
 * Parse a `<questions>...</questions>` block from the agent's first
 * response. Returns `[]` when no block is present (caller treats the
 * output as the artifact directly). Caps at `maxQuestions`.
 */
export function parseStageQuestions(text: string, maxQuestions: number): string[] {
  if (maxQuestions <= 0) return [];
  const m = /<questions>([\s\S]*?)<\/questions>/i.exec(text);
  if (!m) return [];
  const inner = m[1] ?? '';
  // Reuse clarify's numbered-list parser — same shape.
  const parsed = parseClarifyQuestions(inner);
  return parsed.slice(0, maxQuestions);
}

/** Format Q&A pairs for the `<answers>...</answers>` block sent on resume. */
export function formatStageAnswers(pairs: ReadonlyArray<{ question: string; answer: string }>): string {
  const body = pairs
    .map((p, i) => `${i + 1}. Q: ${p.question}\n   A: ${p.answer}`)
    .join('\n\n');
  return `<answers>\n${body}\n</answers>\n\n`
    + 'You now have the user\u2019s answers. Produce the artifact based on these answers + your codebase understanding. Output ONLY the markdown content.';
}
