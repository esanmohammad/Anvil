/**
 * Plan vocabulary — v2 (canonical).
 *
 * v2 makes the plan a **machine-verifiable contract**: every field has
 * a deterministic verifier downstream (KB grounding, build-compliance,
 * validate-compliance, ship gate). v1 is no longer a supported in-memory
 * shape — the only place v1 still surfaces is `migratePlanJsonToV2()`
 * which converts old on-disk JSON during plan-store reads.
 *
 * The split:
 *   • `Plan` is the canonical typed Plan handed around in-memory.
 *   • `PlanV1` is preserved ONLY as `LegacyPlanV1` (see migrate.ts) for
 *     reading old `~/.anvil/plans/<project>/<slug>/v*.json` files written
 *     before the v2 cutover. The migrator promotes them to `Plan` shape
 *     with best-effort stubs for fields v1 didn't carry.
 *
 * Pure data; zero runtime side effects.
 */

// ── Identity & lineage ───────────────────────────────────────────────────

export interface PlanCreatedBy {
  kind: 'model' | 'human';
  /** Resolved model id when `kind:'model'`. */
  model?: string;
  /** Username when `kind:'human'`. */
  user?: string;
}

/**
 * The signed approval record stamped onto a plan when a user clicks
 * "Approve". `planHash` pins the approval to a specific content hash —
 * subsequent edits invalidate it (verifier requires
 * `approval.planHash === contentHash` to count).
 */
export interface PlanApprovalRecord {
  user: string;
  /** ISO. */
  approvedAt: string;
  /** sha256(canonical JSON) of the plan version at approval time. */
  planHash: string;
  note?: string;
}

// ── Narrative (graded for quality, not just shape) ───────────────────────

export interface PlanProblem {
  /** ≥ 80 chars enforced by FLOOR.problem-statement-length. */
  statement: string;
  /** ≥ 40 chars enforced by FLOOR.problem-why-now-length. */
  why_now: string;
  /** ≥ 1 enforced by FLOOR.success-signals-nonempty. */
  success_signals: string[];
}

export interface ScopeItem {
  /** Stable id, referenced by TestCaseSpec.acceptanceRef. */
  id: string;
  description: string;
  /** Gherkin-shaped; ≥ 1 per inScope item. */
  acceptance: string[];
}

export interface PlanScope {
  inScope: ScopeItem[];
  outOfScope: ScopeItem[];
}

// ── The contract (every field is mechanically checked) ───────────────────

export type FileClaimKind = 'new' | 'modified';

export interface FileClaim {
  /** Repo-relative path. */
  path: string;
  kind: FileClaimKind;
  /** Why this file is touched. */
  reason: string;
}

export type SymbolKind =
  | 'function' | 'type' | 'class' | 'const' | 'interface' | 'enum';

export interface SymbolClaim {
  /** Repo-relative path to the file declaring the symbol. */
  file: string;
  /** Symbol name. */
  name: string;
  kind: SymbolKind;
  /** Optional declared signature; verified when present. */
  signature?: string;
}

export interface PlanRepoImpact {
  name: string;
  /** Human summary of what changes in this repo. */
  changes: string;
  /** Files that must exist after build. */
  mustExist: FileClaim[];
  /** Files that must be modified (≥ 1 line in the diff). */
  mustTouch: FileClaim[];
  /** Paths whose public exports must NOT change shape. */
  mustNotBreak: string[];
  /** Functions / types / classes asserted to land in the diff. */
  symbols: SymbolClaim[];
}

export interface TypeRef {
  /** Repo-relative path to the type declaration. */
  file: string;
  /** Exported name. */
  name: string;
}

export interface ColumnSpec {
  name: string;
  /** SQL type, free-form: 'varchar(255)', 'integer', 'jsonb', … */
  type: string;
  nullable?: boolean;
  defaultValue?: string;
}

export type ContractKind = 'http' | 'kafka' | 'grpc' | 'db';

export type PlanContract =
  | {
      kind: 'http';
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      path: string;
      producer: string;
      consumers: string[];
      request?: TypeRef;
      response?: TypeRef;
      /** Allowed response codes. ≥ 1. */
      status: number[];
    }
  | {
      kind: 'kafka';
      topic: string;
      producer: string;
      consumers: string[];
      /** Path or fully qualified schema id. */
      schemaRef: string;
    }
  | {
      kind: 'grpc';
      service: string;
      method: string;
      producer: string;
      consumers: string[];
    }
  | {
      kind: 'db';
      table: string;
      producer: string;
      columns: ColumnSpec[];
    };

export type DataChangeKind =
  | 'migration' | 'seed' | 'drop' | 'rename' | 'index';

export interface DataChange {
  kind: DataChangeKind;
  repo: string;
  /** Migration file path the plan promises will exist after build. */
  migrationFile: string;
  /** Rollback script or one-liner. */
  rollback: string;
}

// ── Observability ────────────────────────────────────────────────────────

export interface ObservabilitySignal {
  kind: 'metric' | 'log' | 'trace' | 'monitor';
  /** Identifier (metric name, log query, monitor id, …). */
  name: string;
  /** Why this signal matters; surfaced in PR body. */
  reason: string;
}

export interface Observability {
  signals: ObservabilitySignal[];
}

// ── Risk + rollout ───────────────────────────────────────────────────────

export type RiskSeverity = 'low' | 'med' | 'high';

export type RiskBlastRadius =
  | 'one-repo' | 'cross-repo' | 'data-loss' | 'auth-bypass';

export interface PlanRisk {
  id: string;
  title: string;
  severity: RiskSeverity;
  blastRadius: RiskBlastRadius;
  mitigation: string;
  /** How prod observability would catch this in the wild. */
  detection: string;
}

export type RolloutStrategy =
  | 'feature-flag' | 'canary' | 'blue-green' | 'direct';

export interface PlanRollout {
  strategy: RolloutStrategy;
  flags: string[];
  /** Deploy order, repo names. */
  order: string[];
  rollback: {
    /** Command to run to undo. */
    command: string;
    /** Verification command — exit 0 means rollback succeeded. */
    verify: string;
  };
}

// ── Tests — drive test-gen, not decorate ─────────────────────────────────

export interface TestCaseSpec {
  id: string;
  /** Foreign key into scope.inScope[].acceptance — every acceptance has ≥ 1. */
  acceptanceRef: string;
  /** Repo-relative path the test must live in. */
  file: string;
  /** Exact test function name. */
  name: string;
  given: string;
  when: string;
  then: string;
}

export interface ManualStep {
  id: string;
  description: string;
  expected: string;
}

export interface PlanTests {
  unit: TestCaseSpec[];
  integration: TestCaseSpec[];
  manual: ManualStep[];
}

// ── Estimate (calibrated against history) ────────────────────────────────

export interface PlanEstimate {
  usd: number;
  minutes: number;
  prs: number;
  /** Slugs of plan-learnings used to anchor this estimate. */
  calibratedFrom: string[];
}

// ── Top-level Plan ───────────────────────────────────────────────────────

export interface Plan {
  /** Schema discriminator. Always 2 for v2 — present so future migrations have a hook. */
  schema: 2;

  // Identity & lineage
  version: number;
  parentVersion: number | null;
  /** sha256(canonical JSON minus contentHash + approval). */
  contentHash: string;
  slug: string;
  project: string;
  title: string;
  /** Original feature description. */
  feature: string;
  /** ISO. */
  createdAt: string;
  /** ISO. */
  updatedAt: string;
  /** Resolved model id used to draft the current version. */
  model: string;
  createdBy: PlanCreatedBy;
  /** Latest approval record; absent until "Approve" is clicked. */
  approval?: PlanApprovalRecord;

  // Body (every field has a deterministic verifier downstream)
  problem: PlanProblem;
  scope: PlanScope;
  repos: PlanRepoImpact[];
  contracts: PlanContract[];
  data: DataChange[];
  observability: Observability;
  architecture: { mermaid: string; notes: string };
  risks: PlanRisk[];
  rollout: PlanRollout;
  tests: PlanTests;
  estimate: PlanEstimate;
}

// ── Pointer + Comment ────────────────────────────────────────────────────

export interface PlanPointer {
  slug: string;
  title: string;
  currentVersion: number;
  updatedAt: string;
}

export type PlanSection =
  | 'problem' | 'scope' | 'repos' | 'contracts' | 'data' | 'observability'
  | 'architecture' | 'risks' | 'rollout' | 'tests' | 'estimate';

export interface PlanComment {
  /** `c-${Date.now().toString(36)}-${randHex}` */
  id: string;
  /** e.g. "problem", "repos[2].mustTouch", "risks[0]" */
  sectionPath: string;
  /** From `ANVIL_USER_NAME` env or 'anonymous'. */
  author: string;
  body: string;
  /** ISO. */
  createdAt: string;
  resolved: boolean;
}

/**
 * Multi-approver record. `approvedVersion` (number) keeps the
 * collaboration audit trail readable even when consumers also rely on
 * the single `Plan.approval` field for the active gate.
 */
export interface PlanApproval {
  id: string;
  user: string;
  approvedVersion: number;
  approvedAt: string;
  note?: string;
}

// ── Helpers (pure) ───────────────────────────────────────────────────────

/**
 * Union of every repo-relative path the plan claims to touch
 * (mustTouch + mustExist). Centralizes the "what files are involved
 * in this repo" question so plan-deviation / plan-risk-scorer /
 * test-gen don't each reinvent it.
 */
export function planRepoTouchedPaths(repo: PlanRepoImpact): string[] {
  const out = new Set<string>();
  for (const f of repo.mustTouch ?? []) if (f?.path) out.add(f.path);
  for (const f of repo.mustExist ?? []) if (f?.path) out.add(f.path);
  return [...out];
}

/** Every TestCaseSpec across unit + integration buckets. */
export function planAllTestCases(plan: Plan): TestCaseSpec[] {
  return [...(plan.tests.unit ?? []), ...(plan.tests.integration ?? [])];
}

/** All files claimed across all repos. */
export function planAllTouchedPaths(plan: Plan): string[] {
  const out = new Set<string>();
  for (const r of plan.repos ?? []) {
    for (const p of planRepoTouchedPaths(r)) out.add(p);
  }
  return [...out];
}

/** Cheap one-liner used by markdown renderers + UI cards. */
export function planRepoTouchedCount(repo: PlanRepoImpact): number {
  return planRepoTouchedPaths(repo).length;
}

/**
 * Display name for a contract — replaces v1's free-form `c.name`.
 * `POST /v1/login` for HTTP, `kafka:metrics.events` for kafka, etc.
 */
export function planContractDisplayName(c: PlanContract): string {
  if (c.kind === 'http') return `${c.method} ${c.path}`;
  if (c.kind === 'kafka') return c.topic;
  if (c.kind === 'grpc') return `${c.service}.${c.method}`;
  return c.table; // db
}

/**
 * Free-text description for a contract — derives a sentence from
 * kind-specific fields. Replaces v1's `c.description`.
 */
export function planContractDescription(c: PlanContract): string {
  if (c.kind === 'http') {
    const cons = c.consumers.length ? ` (consumers: ${c.consumers.join(', ')})` : '';
    const sc = c.status?.length ? ` → ${c.status.join('/')}` : '';
    return `HTTP ${c.method} ${c.path}${sc}${cons}`;
  }
  if (c.kind === 'kafka') {
    const cons = c.consumers.length ? `; consumers: ${c.consumers.join(', ')}` : '';
    return `Kafka topic "${c.topic}" (schema: ${c.schemaRef || 'unspecified'})${cons}`;
  }
  if (c.kind === 'grpc') {
    const cons = c.consumers.length ? `; consumers: ${c.consumers.join(', ')}` : '';
    return `gRPC ${c.service}.${c.method}${cons}`;
  }
  return `DB table "${c.table}" (${c.columns.length} cols)`;
}

/**
 * Consumers if the contract is consumer-aware (http / kafka / grpc).
 * Returns [] for db contracts which only have a producer.
 */
export function planContractConsumers(c: PlanContract): string[] {
  return c.kind === 'db' ? [] : c.consumers;
}

/** Symbol names as plain strings — for legacy callers that expected v1's string[]. */
export function planRepoSymbolNames(repo: PlanRepoImpact): string[] {
  return (repo.symbols ?? []).map((s) => s.name).filter(Boolean);
}

/** All test descriptions (TestCaseSpec.then ?? TestCaseSpec.name) for renderers expecting string[]. */
export function planTestDescriptions(plan: Plan): {
  unit: string[]; integration: string[]; manual: string[];
} {
  return {
    unit: (plan.tests?.unit ?? []).map((t) => t.then || t.name).filter(Boolean),
    integration: (plan.tests?.integration ?? []).map((t) => t.then || t.name).filter(Boolean),
    manual: (plan.tests?.manual ?? []).map((m) => m.description).filter(Boolean),
  };
}
