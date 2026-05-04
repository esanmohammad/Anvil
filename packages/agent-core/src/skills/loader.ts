/**
 * Skill loader — scans a directory for `<name>/SKILL.md` files and parses each.
 *
 * Malformed SKILL.md files are logged to stderr and skipped (non-fatal),
 * matching ADR acceptance.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillMarkdown } from './parser.js';
import type { Skill, SkillLoadOptions } from './types.js';

export function loadSkills(opts: SkillLoadOptions): Skill[] {
  const { dir } = opts;
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    process.stderr.write(`[anvil-skills] WARN: cannot read ${dir}: ${(err as Error).message}\n`);
    return [];
  }

  const out: Skill[] = [];
  for (const entry of entries) {
    const skillDir = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(skillDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;

    try {
      const raw = readFileSync(skillFile, 'utf-8');
      const { frontmatter, body } = parseSkillMarkdown(raw);
      const resources = readdirSync(skillDir).filter((f) => f !== 'SKILL.md');
      out.push({ path: skillFile, frontmatter, body, resources });
    } catch (err) {
      process.stderr.write(
        `[anvil-skills] WARN: skipping ${skillFile}: ${(err as Error).message}\n`,
      );
    }
  }
  return out;
}
