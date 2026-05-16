/**
 * Canonical 9-stage pipeline definition. Both cli and dashboard
 * consume this registry instead of duplicating their own STAGES
 * arrays. The order here matches the dashboard's `state.json` and
 * the cli's `STAGE_NAMES`.
 *
 * Adding a stage here makes it visible to both consumers; both still
 * need their own dispatch wired. Removing one is a breaking change.
 */

export type StagePersona =
  | 'clarifier'
  | 'analyst'
  | 'architect'
  | 'lead'
  | 'engineer'
  | 'test-author'
  | 'tester';

export interface StageDefinition {
  /** Order index 0..8 — stable. */
  index: number;
  /** Stage name used by the resolver, prompt-builder, permissions table. */
  name: string;
  /** User-facing label shown in the dashboard. */
  label: string;
  /** Default persona for this stage. */
  persona: StagePersona;
  /** Whether the stage fans out across repos. */
  perRepo: boolean;
  /**
   * True when the stage runs deterministic code instead of invoking an
   * LLM. The dashboard hides the model badge and cost row for these
   * stages — showing `$0.00` next to a model name reads as "agent
   * failed silently" rather than "no agent involved".
   */
  deterministic?: boolean;
}

export const STAGES: readonly StageDefinition[] = [
  { index: 0, name: 'clarify',           label: 'Understanding',         persona: 'clarifier',   perRepo: false },
  { index: 1, name: 'requirements',      label: 'Planning requirements', persona: 'analyst',     perRepo: false },
  { index: 2, name: 'repo-requirements', label: 'Repo requirements',    persona: 'analyst',     perRepo: true  },
  { index: 3, name: 'specs',             label: 'Writing specs',         persona: 'architect',   perRepo: true  },
  { index: 4, name: 'tasks',             label: 'Creating tasks',        persona: 'lead',        perRepo: true  },
  { index: 5, name: 'build',             label: 'Writing code',          persona: 'engineer',    perRepo: true  },
  { index: 6, name: 'test',              label: 'Generating tests',      persona: 'test-author', perRepo: true,  deterministic: true },
  { index: 7, name: 'validate',          label: 'Testing',               persona: 'tester',      perRepo: true  },
  { index: 8, name: 'ship',              label: 'Shipping',              persona: 'engineer',    perRepo: false },
] as const;

/** Lookup by stage name. Throws when the name is unknown. */
export function getStage(name: string): StageDefinition {
  const stage = STAGES.find((s) => s.name === name);
  if (!stage) throw new Error(`Unknown pipeline stage: "${name}"`);
  return stage;
}

/** Lookup by index. Throws when out of range. */
export function getStageByIndex(index: number): StageDefinition {
  const stage = STAGES[index];
  if (!stage) throw new Error(`Pipeline stage index out of range: ${index}`);
  return stage;
}

/** Stage names in canonical order. */
export const STAGE_NAMES: readonly string[] = STAGES.map((s) => s.name);
