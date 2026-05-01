/**
 * extractTaskEnvelopes — pulls a JSON task list out of an arbitrary LLM
 * response, validates it via parseTaskEnvelopeArray, and returns either
 * the parsed list OR a structured error the planner can feed back to the
 * model on retry.
 *
 * Recognises three shapes (in order):
 *   1. A fenced ```json ... ``` block whose content is a JSON array.
 *   2. A fenced ```tasks ... ``` block (custom alias).
 *   3. The raw response itself, if it parses as a JSON array directly.
 *
 * Returning a structured error (instead of throwing) lets the planner
 * stage compose a "your last response failed validation because X — please
 * fix and re-emit" follow-up prompt without try/catch noise.
 */

import { parseTaskEnvelopeArray, TaskEnvelopeValidationError } from './task-envelope.js';
import type { TaskEnvelope } from './task-envelope.js';

export type ExtractResult =
  | { ok: true; tasks: TaskEnvelope[]; rawJson: string }
  | { ok: false; reason: ExtractFailureReason; detail: string };

export type ExtractFailureReason =
  | 'no-block-found'
  | 'json-parse-failed'
  | 'validation-failed';

const BLOCK_RE = /```(?:json|tasks)\s*\n([\s\S]*?)\n```/i;

export function extractTaskEnvelopes(rawText: string): ExtractResult {
  // 1. Fenced ```json ... ``` or ```tasks ... ``` block.
  const blockMatch = rawText.match(BLOCK_RE);
  let candidate: string | null = blockMatch ? blockMatch[1] : null;

  // 2. Raw payload if it looks like a JSON array.
  if (!candidate) {
    const trimmed = rawText.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) candidate = trimmed;
  }

  if (!candidate) {
    return {
      ok: false,
      reason: 'no-block-found',
      detail:
        'no JSON task block detected. Wrap the task list in a fenced ```json``` ' +
        'code block as the first artifact in your response.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return {
      ok: false,
      reason: 'json-parse-failed',
      detail: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const tasks = parseTaskEnvelopeArray(parsed);
    return { ok: true, tasks, rawJson: candidate };
  } catch (err) {
    if (err instanceof TaskEnvelopeValidationError) {
      return { ok: false, reason: 'validation-failed', detail: err.message };
    }
    throw err;
  }
}

/**
 * Builds a follow-up user message instructing the model to fix a failed
 * envelope extraction. Used by retry logic in the planner stage.
 */
export function buildRetryPrompt(failure: Exclude<ExtractResult, { ok: true }>): string {
  return [
    `Your previous response could not be parsed as a valid task list.`,
    `Reason: ${failure.detail}`,
    ``,
    `Re-emit the task list as a fenced \`\`\`json\`\`\` code block. Each entry`,
    `must conform to TaskEnvelope:`,
    `  { id, repo, files_affected[], operation: 'create'|'modify'|'delete',`,
    `    routing: { capability, complexity: 'S'|'M'|'L', context_estimate_tokens },`,
    `    acceptance_criteria: [ { type:'predicate', check, ...args } | { type:'prose', text } ] }`,
  ].join('\n');
}
