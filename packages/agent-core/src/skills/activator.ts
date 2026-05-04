/**
 * Skill activator — selects which skills go into the prompt under a byte budget.
 *
 * v1 logic per ADR §H4: alphabetical order; include all skills whose body fits
 * the cumulative byte budget; skip the rest and report `truncated` count.
 */

import type { Skill } from './types.js';

export interface ActivatedSkills {
  /** Skills selected for inclusion in the rendered prompt. */
  skills: Skill[];
  /** Cumulative body bytes (UTF-8) of `skills`. */
  totalBytes: number;
  /** Number of skills dropped because they wouldn't fit the budget. */
  truncated: number;
}

const DEFAULT_MAX_BYTES = 32 * 1024;

export function activateSkills(skills: Skill[], maxBytes = DEFAULT_MAX_BYTES): ActivatedSkills {
  const sorted = [...skills].sort((a, b) =>
    a.frontmatter.name.localeCompare(b.frontmatter.name),
  );
  const out: Skill[] = [];
  let total = 0;
  let truncated = 0;
  for (const s of sorted) {
    const bytes = Buffer.byteLength(s.body, 'utf-8');
    if (total + bytes > maxBytes) {
      truncated++;
      continue;
    }
    out.push(s);
    total += bytes;
  }
  return { skills: out, totalBytes: total, truncated };
}
