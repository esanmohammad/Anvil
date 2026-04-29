/**
 * Skills directory resolution — locked search order per ADR §8.
 *
 *   1. process.env.ANVIL_SKILLS_DIR (full-path override)
 *   2. <workspaceRoot>/.claude/skills/
 *   3. $HOME/.claude/skills/
 *
 * Returns the first existing path, or undefined when none of the candidates
 * exist (in which case `loadSkills` returns []).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface ResolveSkillsDirOptions {
  /** Absolute workspace root; .claude/skills under this is checked second. */
  workspaceRoot?: string;
  /** Override for env-var lookup (test seam). */
  env?: NodeJS.ProcessEnv;
  /** Override for $HOME lookup (test seam). */
  homeDir?: string;
}

export function resolveSkillsDir(opts: ResolveSkillsDirOptions = {}): string | undefined {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();

  const override = env.ANVIL_SKILLS_DIR;
  if (override && existsSync(override)) return override;

  if (opts.workspaceRoot) {
    const ws = join(opts.workspaceRoot, '.claude', 'skills');
    if (existsSync(ws)) return ws;
  }

  const userGlobal = join(home, '.claude', 'skills');
  if (existsSync(userGlobal)) return userGlobal;

  return undefined;
}
