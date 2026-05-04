/**
 * `composeSkillContext` — high-level entry point used by
 * `defaultAdapterFactory` (and future single-shot wrappers) to thread
 * skills into the system prompt + tool policy in one call.
 *
 * Steps:
 *   1. Resolve skills directory per ADR §8 search order.
 *   2. Load + activate skills under the byte budget.
 *   3. Render activated skills as an "## Available Skills" block.
 *   4. Compose final system prompt by appending the block.
 *   5. Reconcile tool policy with skill `allowed-tools` constraints.
 *
 * If no skills are found, the returned prompt equals the input verbatim and
 * the tool policy is unchanged.
 */

import { loadSkills } from './loader.js';
import { activateSkills, type ActivatedSkills } from './activator.js';
import { renderSkillsForPrompt } from './render.js';
import { resolveSkillsDir } from './resolve-dir.js';
import { applyToolPolicy } from './tool-policy.js';

export interface ComposeSkillContextOptions {
  /** Absolute workspace root — used to find `<root>/.claude/skills/`. */
  workspaceRoot?: string;
  /** Override skills dir (full path); takes precedence over env + workspace. */
  skillsDir?: string;
  /** Caller-allowed tools; reconciled with skill `allowed-tools`. */
  allowedTools?: string[];
  /** Byte budget for activated skills; defaults to 32 KB. */
  maxBytes?: number;
  /** Test seams. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface SkillContext {
  /** Final system prompt (input + appended skills block). */
  systemPrompt: string;
  /** Reconciled allowed-tools list, or undefined for "no constraint". */
  allowedTools: string[] | undefined;
  /** Whether skill `allowed-tools` actually narrowed caller's policy. */
  toolsConstrained: boolean;
  /** The activator output (for telemetry / debugging). */
  activated: ActivatedSkills;
  /** Resolved skills directory (undefined when no dir was found). */
  resolvedDir: string | undefined;
}

export function composeSkillContext(
  baseSystemPrompt: string,
  opts: ComposeSkillContextOptions = {},
): SkillContext {
  const dir =
    opts.skillsDir ??
    resolveSkillsDir({
      workspaceRoot: opts.workspaceRoot,
      env: opts.env,
      homeDir: opts.homeDir,
    });

  const empty: ActivatedSkills = { skills: [], totalBytes: 0, truncated: 0 };
  if (!dir) {
    return {
      systemPrompt: baseSystemPrompt,
      allowedTools: opts.allowedTools,
      toolsConstrained: false,
      activated: empty,
      resolvedDir: undefined,
    };
  }

  const skills = loadSkills({ dir });
  const activated = activateSkills(skills, opts.maxBytes);
  const block = renderSkillsForPrompt(activated);
  const policy = applyToolPolicy(opts.allowedTools, activated.skills);

  const systemPrompt = block
    ? [baseSystemPrompt, block].filter(Boolean).join('\n\n')
    : baseSystemPrompt;

  return {
    systemPrompt,
    allowedTools: policy.allowedTools,
    toolsConstrained: policy.constrained,
    activated,
    resolvedDir: dir,
  };
}
