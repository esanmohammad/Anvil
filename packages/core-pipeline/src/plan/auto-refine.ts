/**
 * Plan auto-refine — applies deterministic patches for every
 * `Issue.autoFixable` issue surfaced by the rule engine.
 *
 * Two patch kinds are supported today:
 *   - `set-field`        → assigns a value at a JSON path.
 *   - `push-to-array`    → appends a value to an array at a JSON path.
 *   - `remove-field`     → removes a key/element at a JSON path.
 *
 * LLM-targeted refinement (regen a single section with the failing
 * rule's fixHint) is left as a TODO — wired by the dashboard when it
 * can spawn an agent and apply the corrective output. Until then,
 * auto-fixable issues that don't carry a `autoFixSuggestion` payload
 * fall through to the human-edit path.
 */

import type { Plan } from '../utils/plan-types.js';
import type { AutoFixSuggestion, Issue, PlanValidationReport } from './index.js';
import { planContentHash } from './hash.js';

export interface AutoRefineOutcome {
  /** Plan after applying every deterministic patch. */
  plan: Plan;
  /** Issues that were patched in this pass. */
  applied: Issue[];
  /** Issues left for the human-edit / LLM-regen path. */
  remaining: Issue[];
  /** Number of patches applied in this pass. */
  changes: number;
}

// ── JSON-path helpers ────────────────────────────────────────────────────

function parsePath(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  // Match: foo, [0], foo.bar — supports both dotted + bracketed.
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(parseInt(m[2], 10));
  }
  return out;
}

function setAtPath(obj: unknown, path: string, value: unknown): boolean {
  const parts = parsePath(path);
  if (parts.length === 0) return false;
  let cursor: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cursor === null || typeof cursor !== 'object') return false;
    const next = (cursor as Record<string | number, unknown>)[parts[i] as never];
    if (next === undefined) return false;
    cursor = next;
  }
  if (cursor === null || typeof cursor !== 'object') return false;
  (cursor as Record<string | number, unknown>)[parts[parts.length - 1] as never] = value as never;
  return true;
}

function pushAtPath(obj: unknown, path: string, value: unknown): boolean {
  const parts = parsePath(path);
  let cursor: unknown = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cursor === null || typeof cursor !== 'object') return false;
    cursor = (cursor as Record<string | number, unknown>)[parts[i] as never];
  }
  if (!Array.isArray(cursor)) return false;
  cursor.push(value);
  return true;
}

function removeAtPath(obj: unknown, path: string): boolean {
  const parts = parsePath(path);
  if (parts.length === 0) return false;
  let cursor: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cursor === null || typeof cursor !== 'object') return false;
    cursor = (cursor as Record<string | number, unknown>)[parts[i] as never];
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(cursor) && typeof last === 'number') {
    cursor.splice(last, 1);
    return true;
  }
  if (cursor !== null && typeof cursor === 'object') {
    delete (cursor as Record<string, unknown>)[String(last)];
    return true;
  }
  return false;
}

function applySuggestion(plan: Plan, s: AutoFixSuggestion): boolean {
  if (s.kind === 'set-field') return setAtPath(plan, s.path, s.value);
  if (s.kind === 'push-to-array') return pushAtPath(plan, s.path, s.value);
  if (s.kind === 'remove-field') return removeAtPath(plan, s.path);
  return false;
}

// ── Public entrypoint ────────────────────────────────────────────────────

/**
 * Apply every deterministic patch from `report.issues` to `plan`.
 *
 * The returned plan is a **new object** — the input plan is cloned
 * before patches are applied so callers can compare before vs after.
 * The plan's `contentHash` is recomputed after patches so the
 * downstream gate sees a fresh hash.
 *
 * Returns `applied` (the issues that were patched) and `remaining`
 * (the issues left for the human-edit / LLM-regen path).
 */
export function autoRefinePlan(
  plan: Plan,
  report: PlanValidationReport,
): AutoRefineOutcome {
  const clone: Plan = JSON.parse(JSON.stringify(plan));
  const applied: Issue[] = [];
  const remaining: Issue[] = [];
  let changes = 0;
  for (const issue of report.issues) {
    if (!issue.autoFixable || !issue.autoFixSuggestion) {
      remaining.push(issue);
      continue;
    }
    const ok = applySuggestion(clone, issue.autoFixSuggestion);
    if (ok) {
      changes++;
      applied.push(issue);
    } else {
      remaining.push(issue);
    }
  }
  if (changes > 0) {
    clone.contentHash = planContentHash(clone);
    // Approval is invalidated by any edit — drop the stamp.
    if (clone.approval) delete (clone as { approval?: unknown }).approval;
  }
  return { plan: clone, applied, remaining, changes };
}
