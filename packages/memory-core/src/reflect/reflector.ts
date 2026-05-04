/**
 * `reflectOnRun` — orchestrates one reflection cycle (Phase 11).
 *
 * Steps:
 *   1. Build the user prompt from `runContext`.
 *   2. Call the caller-supplied `llmInvoke(systemPrompt, userPrompt)`.
 *      Today's adapter is whatever shape the caller already uses for
 *      LLM access; once memory-core gains a LanguageModel registry the
 *      default invoker will plug in here.
 *   3. Parse the JSON the model emits.
 *   4. Enqueue the parsed items through the proposal queue.
 *
 * No durable memory is touched — sleeptime ratifies via `consolidate`.
 */

import { ProposalQueue } from '../sleeptime/proposal-queue.js';
import { parseReflectionJson, type ReflectionResult } from './extractor.js';
import {
  reflectIntoProposals,
  type ReflectionEnqueueResult,
} from './mapper.js';
import {
  REFLECTION_SYSTEM_PROMPT,
  buildReflectionUserPrompt,
  type ReflectionRunContext,
} from './prompts.js';
import type { MemoryNamespace } from '../types.js';

export type ReflectionInvoker = (
  systemPrompt: string,
  userPrompt: string,
) => Promise<string>;

export interface ReflectOnRunOptions {
  queue: ProposalQueue;
  namespace: MemoryNamespace;
  runContext: ReflectionRunContext;
  /**
   * Caller-supplied LLM invoker. Receives the system + user prompts and
   * returns the raw model output (expected to contain a JSON block —
   * the parser tolerates surrounding prose).
   */
  llmInvoke: ReflectionInvoker;
  /** ISO-8601 stamped on every proposed memory. */
  now?: string;
  ttlDays?: number;
}

export interface ReflectOnRunResult extends ReflectionEnqueueResult {
  reflection: ReflectionResult;
  /** Raw model output, kept around for debugging. */
  rawOutput: string;
}

export async function reflectOnRun(
  opts: ReflectOnRunOptions,
): Promise<ReflectOnRunResult> {
  const userPrompt = buildReflectionUserPrompt(opts.runContext);
  const rawOutput = await opts.llmInvoke(REFLECTION_SYSTEM_PROMPT, userPrompt);
  const reflection = parseReflectionJson(rawOutput);
  const enqueued = reflectIntoProposals(opts.queue, reflection, {
    namespace: opts.namespace,
    runId: opts.runContext.runId,
    now: opts.now,
    ttlDays: opts.ttlDays,
  });
  return { ...enqueued, reflection, rawOutput };
}
