/**
 * @anvil/agent-core/skills — public skills barrel.
 *
 * Phase 1: parser + loader + activator.
 * Phase 2: render + resolve-dir + tool-policy + composeSkillContext.
 * Consumed by `defaultAdapterFactory` per AGENT-PROCESS-CONSOLIDATION-ADR §C3,
 * which wires skills into every `AgentProcess` spawn for non-Claude paths.
 */

export type { Skill, SkillFrontmatter, SkillLoadOptions } from './types.js';
export { parseSkillMarkdown, type ParsedSkill } from './parser.js';
export { loadSkills } from './loader.js';
export { activateSkills, type ActivatedSkills } from './activator.js';
export { renderSkillsForPrompt, SKILLS_PROMPT_HEADER } from './render.js';
export {
  resolveSkillsDir,
  type ResolveSkillsDirOptions,
} from './resolve-dir.js';
export { applyToolPolicy, type ToolPolicyResult } from './tool-policy.js';
export {
  composeSkillContext,
  type ComposeSkillContextOptions,
  type SkillContext,
} from './compose.js';
