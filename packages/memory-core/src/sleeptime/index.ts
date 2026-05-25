/**
 * @esankhan3/anvil-memory-core/sleeptime — proposal queue + consolidator (Phase 10).
 */

export {
  ProposalQueue,
  type EnqueueOptions,
  type ListProposalOptions,
} from './proposal-queue.js';
export {
  contentDigest,
  findNearestDuplicate,
  jaccardSimilarity,
  type NearestDuplicate,
} from './dedupe.js';
export {
  ratifyProposal,
  defaultDecide,
  llmDedupeDecide,
  DEDUPE_JUDGE_SYSTEM_PROMPT,
  parseDedupeJudgeOutput,
  type RatifyArgs,
  type RatifyOutcome,
  type RatificationDecision,
  type RatificationKind,
  type DedupeJudge,
  type DedupeJudgeRequest,
  type DedupeJudgeVerdict,
  type LlmDedupeOptions,
} from './ratify.js';
export {
  consolidate,
  type ConsolidateOptions,
  type ConsolidateResult,
  type DecideFn,
} from './consolidate.js';
