/**
 * Task envelope — three-layer contract between the planner and the
 * resolver/reviewer.
 *
 * Layer 1: identity & provenance — id, parent_spec, repo, files_affected,
 *          operation
 * Layer 2: routing dimensions — capability, complexity, needs_vision,
 *          context_estimate_tokens (read by resolveModelForStage)
 * Layer 3: verification contract — acceptance_criteria, tests_required,
 *          done_definition (read by the review loop)
 *
 * Hand-rolled validator (no zod dependency) matching the convention
 * already used by model-registry and stage-policy in this repo.
 *
 * Acceptance criteria support TWO shapes intentionally:
 *   • Predicate — machine-checkable ({ type: 'predicate', check: ..., ... })
 *   • Prose — model-graded ({ type: 'prose', text: '...' })
 *
 * The reviewer prefers predicates because they're free + deterministic;
 * prose only when a fact can't be expressed mechanically.
 */

import type { ModelCapability, ModelComplexity, ModelTier } from '@anvil/agent-core';

export type TaskOperation = 'create' | 'modify' | 'delete';

/**
 * Priority drives execution order in the build stage. P0 tasks ship
 * before P1 ships before P2. Within a priority bucket the topological
 * sort by `depends_on` decides order.
 */
export type TaskPriority = 'P0' | 'P1' | 'P2';

export interface TaskRouting {
  capability: ModelCapability;
  complexity: ModelComplexity;
  needs_vision?: boolean;
  context_estimate_tokens: number;
  /**
   * Optional per-task tier hint. When set, the per-task resolver
   * promotes this tier to the front of the chain (followed by the
   * stage's normal `prefer` minus this tier). Lets the planner say
   * "this one's mechanical, do it locally" or "this one needs Sonnet".
   */
  preferred_tier?: ModelTier;
}

export interface TaskAcceptancePredicate {
  type: 'predicate';
  check: string;
  /** Free-form predicate args (path, symbol, regex, ...). */
  [arg: string]: unknown;
}

export interface TaskAcceptanceProse {
  type: 'prose';
  text: string;
}

export type TaskAcceptanceCriterion = TaskAcceptancePredicate | TaskAcceptanceProse;

export interface TaskTestRequirement {
  path: string;
  cases: string[];
}

export interface TaskEnvelope {
  id: string;
  repo: string;
  files_affected: string[];
  operation: TaskOperation;
  parent_spec?: string;
  routing: TaskRouting;
  acceptance_criteria: TaskAcceptanceCriterion[];
  tests_required?: TaskTestRequirement[];
  done_definition?: string[];
  /** Optional priority. Default = 'P1' when missing. */
  priority?: TaskPriority;
  /** Task ids that MUST complete before this task can start. */
  depends_on?: string[];
}

export class TaskEnvelopeValidationError extends Error {
  constructor(message: string) {
    super(`task envelope validation failed: ${message}`);
    this.name = 'TaskEnvelopeValidationError';
  }
}

const CAPABILITIES: readonly ModelCapability[] = ['embed', 'rerank', 'code', 'reasoning', 'vision'];
const COMPLEXITIES: readonly ModelComplexity[] = ['S', 'M', 'L'];
const OPERATIONS: readonly TaskOperation[] = ['create', 'modify', 'delete'];
const TIERS: readonly ModelTier[] = ['local', 'cheap', 'premium'];
const PRIORITIES: readonly TaskPriority[] = ['P0', 'P1', 'P2'];

export function parseTaskEnvelope(raw: unknown, ctx = '<task>'): TaskEnvelope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TaskEnvelopeValidationError(`${ctx}: expected object, got ${describe(raw)}`);
  }
  const r = raw as Record<string, unknown>;

  const id = requireString(r.id, `${ctx}.id`);
  const repo = requireString(r.repo, `${ctx}.repo`);
  const operation = requireEnum(r.operation, OPERATIONS, `${ctx}.operation`);
  const files_affected = requireStringArray(r.files_affected, `${ctx}.files_affected`, { allowEmpty: false });

  const routing = parseRouting(r.routing, `${ctx}.routing`);
  const acceptance_criteria = parseAcceptanceCriteria(r.acceptance_criteria, `${ctx}.acceptance_criteria`);

  const out: TaskEnvelope = {
    id,
    repo,
    files_affected,
    operation,
    routing,
    acceptance_criteria,
  };

  if (r.parent_spec !== undefined) {
    out.parent_spec = requireString(r.parent_spec, `${ctx}.parent_spec`);
  }
  if (r.tests_required !== undefined) {
    out.tests_required = parseTestRequirements(r.tests_required, `${ctx}.tests_required`);
  }
  if (r.done_definition !== undefined) {
    out.done_definition = requireStringArray(r.done_definition, `${ctx}.done_definition`, { allowEmpty: true });
  }
  if (r.priority !== undefined) {
    out.priority = requireEnum(r.priority, PRIORITIES, `${ctx}.priority`);
  }
  if (r.depends_on !== undefined) {
    out.depends_on = requireStringArray(r.depends_on, `${ctx}.depends_on`, { allowEmpty: true });
  }

  return out;
}

export function parseTaskEnvelopeArray(raw: unknown): TaskEnvelope[] {
  if (!Array.isArray(raw)) {
    throw new TaskEnvelopeValidationError(`expected array of tasks, got ${describe(raw)}`);
  }
  const out: TaskEnvelope[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const env = parseTaskEnvelope(raw[i], `tasks[${i}]`);
    if (seenIds.has(env.id)) {
      throw new TaskEnvelopeValidationError(`duplicate task id "${env.id}" at index ${i}`);
    }
    seenIds.add(env.id);
    out.push(env);
  }
  return out;
}

// — Internal validators —

function parseRouting(raw: unknown, ctx: string): TaskRouting {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TaskEnvelopeValidationError(`${ctx}: expected object`);
  }
  const r = raw as Record<string, unknown>;
  const out: TaskRouting = {
    capability: requireEnum(r.capability, CAPABILITIES, `${ctx}.capability`),
    complexity: requireEnum(r.complexity, COMPLEXITIES, `${ctx}.complexity`),
    context_estimate_tokens: requireNumber(r.context_estimate_tokens, `${ctx}.context_estimate_tokens`, {
      min: 1,
      integer: true,
    }),
  };
  if (r.needs_vision !== undefined) {
    out.needs_vision = requireBoolean(r.needs_vision, `${ctx}.needs_vision`);
  }
  if (r.preferred_tier !== undefined) {
    out.preferred_tier = requireEnum(r.preferred_tier, TIERS, `${ctx}.preferred_tier`);
  }
  return out;
}

function parseAcceptanceCriteria(raw: unknown, ctx: string): TaskAcceptanceCriterion[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new TaskEnvelopeValidationError(`${ctx}: expected non-empty array`);
  }
  const out: TaskAcceptanceCriterion[] = [];
  for (let i = 0; i < raw.length; i++) {
    out.push(parseAcceptanceCriterion(raw[i], `${ctx}[${i}]`));
  }
  return out;
}

function parseAcceptanceCriterion(raw: unknown, ctx: string): TaskAcceptanceCriterion {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TaskEnvelopeValidationError(`${ctx}: expected object`);
  }
  const r = raw as Record<string, unknown>;
  if (r.type === 'predicate') {
    if (typeof r.check !== 'string' || r.check.length === 0) {
      throw new TaskEnvelopeValidationError(`${ctx}.check: expected non-empty string`);
    }
    return r as unknown as TaskAcceptancePredicate;
  }
  if (r.type === 'prose') {
    if (typeof r.text !== 'string' || r.text.length === 0) {
      throw new TaskEnvelopeValidationError(`${ctx}.text: expected non-empty string`);
    }
    return { type: 'prose', text: r.text };
  }
  throw new TaskEnvelopeValidationError(`${ctx}.type: expected 'predicate' | 'prose', got ${describe(r.type)}`);
}

function parseTestRequirements(raw: unknown, ctx: string): TaskTestRequirement[] {
  if (!Array.isArray(raw)) {
    throw new TaskEnvelopeValidationError(`${ctx}: expected array`);
  }
  const out: TaskTestRequirement[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TaskEnvelopeValidationError(`${ctx}[${i}]: expected object`);
    }
    const r = item as Record<string, unknown>;
    out.push({
      path: requireString(r.path, `${ctx}[${i}].path`),
      cases: requireStringArray(r.cases, `${ctx}[${i}].cases`, { allowEmpty: true }),
    });
  }
  return out;
}

// — primitives —

function requireString(v: unknown, ctx: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new TaskEnvelopeValidationError(`${ctx}: expected non-empty string, got ${describe(v)}`);
  }
  return v;
}

function requireEnum<T extends string>(v: unknown, allowed: readonly T[], ctx: string): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new TaskEnvelopeValidationError(
      `${ctx}: expected one of [${allowed.join(', ')}], got ${describe(v)}`,
    );
  }
  return v as T;
}

function requireNumber(v: unknown, ctx: string, opts: { min?: number; integer?: boolean } = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new TaskEnvelopeValidationError(`${ctx}: expected number, got ${describe(v)}`);
  }
  if (opts.integer && !Number.isInteger(v)) {
    throw new TaskEnvelopeValidationError(`${ctx}: expected integer, got ${v}`);
  }
  if (opts.min !== undefined && v < opts.min) {
    throw new TaskEnvelopeValidationError(`${ctx}: must be >= ${opts.min}, got ${v}`);
  }
  return v;
}

function requireBoolean(v: unknown, ctx: string): boolean {
  if (typeof v !== 'boolean') {
    throw new TaskEnvelopeValidationError(`${ctx}: expected boolean, got ${describe(v)}`);
  }
  return v;
}

function requireStringArray(v: unknown, ctx: string, opts: { allowEmpty: boolean }): string[] {
  if (!Array.isArray(v)) {
    throw new TaskEnvelopeValidationError(`${ctx}: expected array of strings, got ${describe(v)}`);
  }
  if (!opts.allowEmpty && v.length === 0) {
    throw new TaskEnvelopeValidationError(`${ctx}: must be non-empty`);
  }
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'string' || v[i].length === 0) {
      throw new TaskEnvelopeValidationError(`${ctx}[${i}]: expected non-empty string, got ${describe(v[i])}`);
    }
  }
  return v as string[];
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
