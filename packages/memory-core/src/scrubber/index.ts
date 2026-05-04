/**
 * @anvil/memory-core/scrubber — PII/secret scrubbing (Phase 7).
 */

export {
  scrub,
  resolveScrubMode,
  HardRejectError,
  type ScrubResult,
  type ScrubOptions,
  type ScrubRedaction,
} from './scrub.js';
export {
  SCRUB_RULES,
  type ScrubRule,
  type ScrubCategory,
} from './regex-rules.js';
