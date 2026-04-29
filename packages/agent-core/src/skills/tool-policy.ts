/**
 * Tool-policy reconciliation between caller-allowed tools and skill-declared
 * `allowed-tools` constraints.
 *
 * Per ADR §H1 + plan §2.4:
 *   - Skills can constrain (subtract from caller's wide list) but never expand.
 *   - If no activated skill declares `allowed-tools`, caller's policy passes
 *     through unchanged.
 *   - Otherwise the result is `(union of all skill allowed-tools) ∩ caller`.
 *   - If caller is undefined ("any tool"), the result is the union itself.
 */

import type { Skill } from './types.js';

export interface ToolPolicyResult {
  /**
   * Resolved tool list. `undefined` means "no constraint" (caller's
   * pre-existing semantics for unrestricted tool access).
   */
  allowedTools: string[] | undefined;
  /**
   * True iff at least one activated skill declared an allowed-tools list,
   * i.e. the caller's policy was actually narrowed.
   */
  constrained: boolean;
}

export function applyToolPolicy(
  callerAllowed: string[] | undefined,
  activatedSkills: Skill[],
): ToolPolicyResult {
  const skillUnion = new Set<string>();
  let anySkillConstraint = false;
  for (const s of activatedSkills) {
    const at = s.frontmatter.allowedTools;
    if (at && at.length > 0) {
      anySkillConstraint = true;
      for (const tool of at) skillUnion.add(tool);
    }
  }

  if (!anySkillConstraint) {
    return { allowedTools: callerAllowed, constrained: false };
  }

  if (callerAllowed === undefined) {
    return { allowedTools: [...skillUnion].sort(), constrained: true };
  }

  const callerSet = new Set(callerAllowed);
  const intersection = [...skillUnion].filter((t) => callerSet.has(t)).sort();
  return { allowedTools: intersection, constrained: true };
}
