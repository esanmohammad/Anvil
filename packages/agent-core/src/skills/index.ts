/**
 * @anvil/agent-core/skills — public skills barrel.
 *
 * Phase 1: parser + loader + activator.
 * Phase 2: render + resolve-dir + tool-policy + composeSkillContext.
 * Phase 4 will wire `composeSkillContext` into the headless `runAgent` entry.
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
