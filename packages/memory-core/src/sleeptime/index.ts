/**
 * @anvil/memory-core/sleeptime — proposal queue + consolidator (Phase 10).
 */

export {
  ProposalQueue,
  type EnqueueOptions,
  type ListProposalOptions,
} from './proposal-queue.js';
export {
  contentDigest,
  findNearestDuplicate,
  type NearestDuplicate,
} from './dedupe.js';
export {
  ratifyProposal,
  defaultDecide,
  type RatifyArgs,
  type RatifyOutcome,
  type RatificationDecision,
  type RatificationKind,
} from './ratify.js';
export {
  consolidate,
  type ConsolidateOptions,
  type ConsolidateResult,
  type DecideFn,
} from './consolidate.js';
