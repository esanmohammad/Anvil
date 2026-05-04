/**
 * Skill types — Anthropic-OpenAI SKILL.md open standard.
 *
 * See AGENT-HARNESS-ADR.md §3 for the locked schema (required vs optional
 * fields, key normalization rules).
 */

export interface SkillFrontmatter {
  /** Slug-safe identifier; used in registry + namespacing. */
  name: string;
  /** One-sentence hook the model uses to decide whether to load the skill. */
  description: string;
  /**
   * Constrains the caller's tool list while the skill is active.
   * Semantics: intersection with caller's allowed tools — skills can subtract,
   * never expand.
   */
  allowedTools?: string[];
  /**
   * If true, skill is loaded only on explicit selection, not auto-routed
   * via description matching. Default: false.
   */
  disableModelInvocation?: boolean;
  /** Free-form (semver suggested) for cache busting. */
  version?: string;
}

export interface Skill {
  /** Filesystem path of the SKILL.md file. */
  path: string;
  /** Parsed + normalized frontmatter. */
  frontmatter: SkillFrontmatter;
  /** Markdown body (after the frontmatter block, trimmed). */
  body: string;
  /** Sibling files under the skill's directory (e.g. scripts, templates). */
  resources: string[];
}

export interface SkillLoadOptions {
  /** Absolute path to the skills directory. */
  dir: string;
  /** Maximum total body bytes to inject; defaults to 32 KB. */
  maxBytes?: number;
}
