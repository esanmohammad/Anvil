/**
 * Reflection prompt templates (Phase 11 — plan §11.2).
 *
 * The system prompt asks the model for four discrete buckets so the
 * extractor can route them to the right `MemoryKind` / `SemanticSubtype`
 * without follow-up parsing:
 *
 *   - failures (what went wrong)        → semantic.fix-pattern
 *   - successes (what worked)           → semantic.success
 *   - surprises (notable observations)  → semantic.manual
 *   - skill_proposals (reusable how-to) → procedural (Plan C SKILL.md)
 *
 * Kept short on purpose — reflection runs after every pipeline complete,
 * so the per-call context budget is the dominant cost (plan §11.6).
 */

export const REFLECTION_SYSTEM_PROMPT = `You are reviewing the audit log + diff of a just-completed engineering run.

Identify what is worth remembering for future runs. Output strict JSON only:

{
  "failures": [{ "what": string, "root_cause": string, "fix": string, "file_path"?: string }],
  "successes": [{ "pattern": string, "applies_when": string, "code_snippet"?: string, "file_path"?: string }],
  "surprises": [{ "what": string, "why_surprising": string }],
  "skill_proposals": [{ "name": string, "description": string, "body": string }]
}

Rules:
- Empty arrays are fine — do not invent items.
- "name" for skill_proposals must be kebab-case.
- "code_snippet" should be ≤ 20 lines.
- Reference real file paths from the diff when applicable; use file_path only when you can be specific.
- Do not include any prose outside the JSON.
`;

export interface ReflectionRunContext {
  /** Identifier for this pipeline / PR / CI run. */
  runId: string;
  /** Caller-formatted summary of the run (audit log, diff, CI status). */
  runSummary: string;
}

export function buildReflectionUserPrompt(ctx: ReflectionRunContext): string {
  return `Run id: ${ctx.runId}\n\n${ctx.runSummary}`;
}
