/**
 * @anvil/memory-core/reflect — reflection-on-completion (Phase 11).
 */

export {
  REFLECTION_SYSTEM_PROMPT,
  buildReflectionUserPrompt,
  type ReflectionRunContext,
} from './prompts.js';
export {
  parseReflectionJson,
  type ReflectionResult,
  type ReflectionFailure,
  type ReflectionSuccess,
  type ReflectionSurprise,
  type ReflectionSkillProposal,
} from './extractor.js';
export {
  reflectIntoProposals,
  type ReflectIntoProposalsOptions,
  type ReflectionEnqueueResult,
} from './mapper.js';
export {
  reflectOnRun,
  type ReflectOnRunOptions,
  type ReflectOnRunResult,
  type ReflectionInvoker,
} from './reflector.js';
