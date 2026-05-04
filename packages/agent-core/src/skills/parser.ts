/**
 * SKILL.md parser — frontmatter + body splitter.
 *
 * Per ADR §3.3, accepts both kebab-case (spec) and camelCase frontmatter
 * keys and normalizes to camelCase internally.
 */

import { parse as parseYaml } from 'yaml';
import type { SkillFrontmatter } from './types.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]+?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

export function parseSkillMarkdown(raw: string): ParsedSkill {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) {
    throw new Error('SKILL.md missing frontmatter (--- ... ---)');
  }
  const fmRaw = parseYaml(m[1]);
  if (!fmRaw || typeof fmRaw !== 'object') {
    throw new Error('SKILL.md frontmatter is not a YAML mapping');
  }
  const fm = fmRaw as Record<string, unknown>;

  const name = pickString(fm, 'name');
  const description = pickString(fm, 'description');
  if (!name) throw new Error('SKILL.md frontmatter missing required `name`');
  if (!description) throw new Error('SKILL.md frontmatter missing required `description`');

  return {
    frontmatter: {
      name,
      description,
      allowedTools: pickStringArray(fm, 'allowedTools', 'allowed-tools'),
      disableModelInvocation: pickBool(fm, 'disableModelInvocation', 'disable-model-invocation'),
      version: pickString(fm, 'version'),
    },
    body: m[2].trim(),
  };
}

function pickString(fm: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = fm[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function pickStringArray(fm: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const k of keys) {
    const v = fm[k];
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  }
  return undefined;
}

function pickBool(fm: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = fm[k];
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}
