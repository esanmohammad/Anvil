/**
 * Skills → system prompt renderer.
 *
 * Output format follows ADR §H1 (Anthropic-OpenAI SKILL.md spec). The
 * "## Available Skills" anchor + the per-skill "### <name>" + description
 * pattern is what both Claude Code and Codex CLI emit.
 */

import type { ActivatedSkills } from './activator.js';

const SKILLS_HEADER = '## Available Skills';
const SKILLS_PREAMBLE = [
  'You have access to the following skills. Each skill provides procedural',
  "knowledge for a specific task. Read the skill's instructions when its",
  "description matches the user's request.",
].join('\n');

export function renderSkillsForPrompt(activated: ActivatedSkills): string {
  if (activated.skills.length === 0) return '';
  const sections = activated.skills.map(
    (s) => `### ${s.frontmatter.name}\n${s.frontmatter.description}\n\n${s.body}`,
  );
  return [SKILLS_HEADER, '', SKILLS_PREAMBLE, '', ...sections].join('\n');
}

export const SKILLS_PROMPT_HEADER = SKILLS_HEADER;
