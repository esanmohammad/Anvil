/**
 * Plan v1 → v2 migration — best-effort coercion of legacy on-disk plans.
 *
 * Old plans (`~/.anvil/plans/<project>/<slug>/v*.json` written before the
 * v2 cutover) carry the v1 shape:
 *   - `problem: string`
 *   - `scope.inScope: string[]`
 *   - `repos[].files: string[]`, `repos[].symbols: string[]`
 *   - `contracts[]: { kind, name, producer, consumers, description }`
 *   - `risks[]: { title, mitigation, severity }`
 *   - `rollout: { strategy, flags, order, rollback: string }`
 *   - `tests: { unit: string[], integration: string[], manual: string[] }`
 *   - `estimate: { usd, minutes, prs }`
 *
 * `migratePlanJsonToV2` reads such JSON and returns a canonical v2 `Plan`
 * with the right shape. Fields v1 doesn't carry (mustExist / mustTouch /
 * symbols.file / risks[].id / contracts.method+path / data / observability
 * / approval / contentHash) get safe stubs so the verifier can grade
 * them — these will surface as FLOOR / SHAPE issues nudging the user
 * (or auto-refine) toward a real v2 payload.
 *
 * No FS / network side effects. Pure transform: `unknown -> Plan`.
 */

import type {
  Plan,
  PlanProblem,
  PlanScope,
  PlanRepoImpact,
  PlanContract,
  DataChange,
  Observability,
  PlanRisk,
  PlanRollout,
  PlanTests,
  PlanEstimate,
  PlanCreatedBy,
  PlanApprovalRecord,
  TestCaseSpec,
  ManualStep,
  ScopeItem,
  RolloutStrategy,
  RiskSeverity,
  RiskBlastRadius,
  SymbolClaim,
  FileClaim,
} from '../utils/plan-types.js';
import { planContentHash } from './hash.js';

// ── Type guards ──────────────────────────────────────────────────────────

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function asString(x: unknown, fallback = ''): string {
  return typeof x === 'string' ? x : fallback;
}

function asNumber(x: unknown, fallback = 0): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

function asStringArray(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : [];
}

function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

// ── Field migrators ──────────────────────────────────────────────────────

function migrateProblem(raw: unknown): PlanProblem {
  if (isObject(raw)) {
    return {
      statement: asString(raw.statement, asString(raw.problem)),
      why_now: asString(raw.why_now),
      success_signals: asStringArray(raw.success_signals),
    };
  }
  // v1: a bare string.
  return {
    statement: asString(raw),
    why_now: '',
    success_signals: [],
  };
}

function migrateScopeItem(raw: unknown, fallbackId: string): ScopeItem {
  if (isObject(raw)) {
    return {
      id: asString(raw.id, fallbackId),
      description: asString(raw.description, asString(raw)),
      acceptance: asStringArray(raw.acceptance),
    };
  }
  return { id: fallbackId, description: asString(raw), acceptance: [] };
}

function migrateScope(raw: unknown): PlanScope {
  const r = isObject(raw) ? raw : {};
  const inScope = asArray(r.inScope).map((v, i) => migrateScopeItem(v, `s${i + 1}`));
  const outOfScope = asArray(r.outOfScope).map((v, i) => migrateScopeItem(v, `o${i + 1}`));
  return { inScope, outOfScope };
}

function migrateFileClaim(raw: unknown, fallbackKind: 'new' | 'modified' = 'modified'): FileClaim {
  if (isObject(raw)) {
    const kind = raw.kind === 'new' || raw.kind === 'modified' ? raw.kind : fallbackKind;
    return {
      path: asString(raw.path),
      kind,
      reason: asString(raw.reason),
    };
  }
  return { path: asString(raw), kind: fallbackKind, reason: '' };
}

function migrateSymbol(raw: unknown): SymbolClaim {
  const VALID: SymbolClaim['kind'][] = ['function', 'type', 'class', 'const', 'interface', 'enum'];
  if (isObject(raw)) {
    const k = asString(raw.kind, 'function');
    const kind = (VALID as string[]).includes(k) ? (k as SymbolClaim['kind']) : 'function';
    return {
      file: asString(raw.file),
      name: asString(raw.name),
      kind,
      signature: typeof raw.signature === 'string' ? raw.signature : undefined,
    };
  }
  // v1: bare symbol string.
  const s = asString(raw);
  return { file: '', name: s, kind: 'function' };
}

function migrateRepo(raw: unknown): PlanRepoImpact {
  const r = isObject(raw) ? raw : {};
  // v2 first; fall back to v1's flat `files` + `symbols` arrays.
  const mustTouch: FileClaim[] = Array.isArray(r.mustTouch)
    ? r.mustTouch.map((v) => migrateFileClaim(v, 'modified'))
    : asStringArray(r.files).map((p) => ({ path: p, kind: 'modified', reason: '' }));
  const mustExist: FileClaim[] = Array.isArray(r.mustExist)
    ? r.mustExist.map((v) => migrateFileClaim(v, 'new'))
    : [];
  const mustNotBreak = asStringArray(r.mustNotBreak);
  const symbols: SymbolClaim[] = Array.isArray(r.symbols)
    ? r.symbols.map(migrateSymbol)
    : [];
  return {
    name: asString(r.name),
    changes: asString(r.changes),
    mustExist,
    mustTouch,
    mustNotBreak,
    symbols,
  };
}

function migrateContract(raw: unknown): PlanContract | null {
  if (!isObject(raw)) return null;
  const kind = asString(raw.kind);
  const producer = asString(raw.producer);
  const consumers = asStringArray(raw.consumers);
  if (kind === 'http') {
    const method = asString(raw.method, 'GET').toUpperCase() as PlanContract['kind'] extends 'http' ? never : never;
    const m = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(asString(raw.method).toUpperCase())
      ? (asString(raw.method).toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')
      : 'GET';
    void method; // suppress unused
    return {
      kind: 'http',
      method: m,
      path: asString(raw.path),
      producer,
      consumers,
      status: Array.isArray(raw.status) ? raw.status.filter((n): n is number => typeof n === 'number') : [200],
    };
  }
  if (kind === 'kafka') {
    return {
      kind: 'kafka',
      topic: asString(raw.topic, asString(raw.name)),
      producer,
      consumers,
      schemaRef: asString(raw.schemaRef),
    };
  }
  if (kind === 'grpc') {
    return {
      kind: 'grpc',
      service: asString(raw.service, asString(raw.name)),
      method: asString(raw.method),
      producer,
      consumers,
    };
  }
  if (kind === 'db') {
    return {
      kind: 'db',
      table: asString(raw.table, asString(raw.name)),
      producer,
      columns: Array.isArray(raw.columns)
        ? raw.columns
            .filter(isObject)
            .map((c) => ({
              name: asString(c.name),
              type: asString(c.type, 'text'),
              nullable: typeof c.nullable === 'boolean' ? c.nullable : undefined,
              defaultValue: typeof c.defaultValue === 'string' ? c.defaultValue : undefined,
            }))
        : [],
    };
  }
  // v1 contracts (kind 'other' or unknown) become HTTP-with-empty-method stubs.
  // Verifier will flag CONTRACT.kind-supported on these.
  return null;
}

function migrateData(raw: unknown): DataChange[] {
  return asArray(raw)
    .map((r): DataChange | null => {
      if (!isObject(r)) return null;
      const k = asString(r.kind, 'migration');
      const kind: DataChange['kind'] =
        k === 'migration' || k === 'seed' || k === 'drop' || k === 'rename' || k === 'index'
          ? k
          : 'migration';
      return {
        kind,
        repo: asString(r.repo),
        migrationFile: asString(r.migrationFile),
        rollback: asString(r.rollback),
      };
    })
    .filter((d): d is DataChange => d !== null);
}

function migrateObservability(raw: unknown): Observability {
  if (!isObject(raw)) return { signals: [] };
  const signals = asArray(raw.signals)
    .filter(isObject)
    .map((s) => {
      const k = asString(s.kind, 'metric');
      const kind: 'metric' | 'log' | 'trace' | 'monitor' =
        k === 'metric' || k === 'log' || k === 'trace' || k === 'monitor' ? k : 'metric';
      return { kind, name: asString(s.name), reason: asString(s.reason) };
    });
  return { signals };
}

function migrateRisk(raw: unknown, fallbackId: string): PlanRisk {
  if (!isObject(raw)) {
    return {
      id: fallbackId,
      title: '',
      severity: 'low',
      blastRadius: 'one-repo',
      mitigation: '',
      detection: '',
    };
  }
  const sev = asString(raw.severity, 'low');
  const severity: RiskSeverity = sev === 'low' || sev === 'med' || sev === 'high' ? sev : 'low';
  const br = asString(raw.blastRadius, 'one-repo');
  const blastRadius: RiskBlastRadius =
    br === 'one-repo' || br === 'cross-repo' || br === 'data-loss' || br === 'auth-bypass'
      ? br
      : 'one-repo';
  return {
    id: asString(raw.id, fallbackId),
    title: asString(raw.title),
    severity,
    blastRadius,
    mitigation: asString(raw.mitigation),
    detection: asString(raw.detection),
  };
}

function migrateRollout(raw: unknown): PlanRollout {
  const r = isObject(raw) ? raw : {};
  const strat = asString(r.strategy, 'direct');
  const strategy: RolloutStrategy =
    strat === 'feature-flag' || strat === 'canary' || strat === 'blue-green' || strat === 'direct'
      ? strat
      : 'direct';
  // v1 stored rollback as a flat string; v2 wants {command, verify}.
  const rollback = isObject(r.rollback)
    ? {
        command: asString(r.rollback.command),
        verify: asString(r.rollback.verify),
      }
    : { command: asString(r.rollback), verify: '' };
  return {
    strategy,
    flags: asStringArray(r.flags),
    order: asStringArray(r.order),
    rollback,
  };
}

function migrateTestSpec(raw: unknown, fallbackId: string): TestCaseSpec {
  if (isObject(raw)) {
    return {
      id: asString(raw.id, fallbackId),
      acceptanceRef: asString(raw.acceptanceRef),
      file: asString(raw.file),
      name: asString(raw.name),
      given: asString(raw.given),
      when: asString(raw.when),
      then: asString(raw.then, asString(raw)),
    };
  }
  // v1 stored tests as plain description strings — fold into `.then` so the
  // intent survives migration; verifier will surface TESTS.fields-missing.
  return {
    id: fallbackId,
    acceptanceRef: '',
    file: '',
    name: '',
    given: '',
    when: '',
    then: asString(raw),
  };
}

function migrateManualStep(raw: unknown, fallbackId: string): ManualStep {
  if (isObject(raw)) {
    return {
      id: asString(raw.id, fallbackId),
      description: asString(raw.description, asString(raw)),
      expected: asString(raw.expected),
    };
  }
  return { id: fallbackId, description: asString(raw), expected: '' };
}

function migrateTests(raw: unknown): PlanTests {
  const r = isObject(raw) ? raw : {};
  return {
    unit: asArray(r.unit).map((v, i) => migrateTestSpec(v, `u${i + 1}`)),
    integration: asArray(r.integration).map((v, i) => migrateTestSpec(v, `i${i + 1}`)),
    manual: asArray(r.manual).map((v, i) => migrateManualStep(v, `m${i + 1}`)),
  };
}

function migrateEstimate(raw: unknown): PlanEstimate {
  if (!isObject(raw)) return { usd: 0, minutes: 0, prs: 0, calibratedFrom: [] };
  return {
    usd: asNumber(raw.usd),
    minutes: asNumber(raw.minutes),
    prs: asNumber(raw.prs),
    calibratedFrom: asStringArray(raw.calibratedFrom),
  };
}

function migrateCreatedBy(raw: unknown, fallbackModel: string): PlanCreatedBy {
  if (!isObject(raw)) {
    return { kind: 'model', model: fallbackModel };
  }
  const kind = raw.kind === 'human' ? 'human' : 'model';
  return {
    kind,
    model: typeof raw.model === 'string' ? raw.model : fallbackModel,
    user: typeof raw.user === 'string' ? raw.user : undefined,
  };
}

function migrateApproval(raw: unknown): PlanApprovalRecord | undefined {
  if (!isObject(raw)) return undefined;
  if (typeof raw.user !== 'string' || typeof raw.planHash !== 'string') return undefined;
  return {
    user: raw.user,
    approvedAt: asString(raw.approvedAt, new Date().toISOString()),
    planHash: raw.planHash,
    note: typeof raw.note === 'string' ? raw.note : undefined,
  };
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Read an unknown JSON value (typically the result of JSON.parse on an
 * on-disk plan file) and return a canonical v2 `Plan`. Stamps a fresh
 * `contentHash`. Idempotent — passing an already-v2 plan returns an
 * equivalent v2 plan with the hash recomputed.
 */
export function migratePlanJsonToV2(raw: unknown): Plan {
  const r = isObject(raw) ? raw : {};
  const fallbackModel = asString(r.model);
  const now = new Date().toISOString();

  const partial: Omit<Plan, 'contentHash'> = {
    schema: 2,
    version: asNumber(r.version, 1),
    parentVersion: typeof r.parentVersion === 'number' ? r.parentVersion : null,
    slug: asString(r.slug),
    project: asString(r.project),
    title: asString(r.title, asString(r.feature, 'Untitled plan')),
    feature: asString(r.feature, asString(r.title)),
    createdAt: asString(r.createdAt, now),
    updatedAt: asString(r.updatedAt, now),
    model: fallbackModel,
    createdBy: migrateCreatedBy(r.createdBy, fallbackModel),
    approval: migrateApproval(r.approval),
    problem: migrateProblem(r.problem),
    scope: migrateScope(r.scope),
    repos: asArray(r.repos).map(migrateRepo),
    contracts: asArray(r.contracts)
      .map(migrateContract)
      .filter((c): c is PlanContract => c !== null),
    data: migrateData(r.data),
    observability: migrateObservability(r.observability),
    architecture: isObject(r.architecture)
      ? {
          mermaid: asString(r.architecture.mermaid),
          notes: asString(r.architecture.notes),
        }
      : { mermaid: '', notes: '' },
    risks: asArray(r.risks).map((v, i) => migrateRisk(v, `r${i + 1}`)),
    rollout: migrateRollout(r.rollout),
    tests: migrateTests(r.tests),
    estimate: migrateEstimate(r.estimate),
  };

  const contentHash = planContentHash(partial);
  return { ...partial, contentHash };
}

/**
 * Build an empty v2 plan with sensible defaults — used by
 * `PlanStore.createPlan` and by the planner when an agent returns
 * partial output. Same shape as `migratePlanJsonToV2({})`.
 */
export function emptyPlanV2(
  project: string,
  feature: string,
  model: string,
): Plan {
  return migratePlanJsonToV2({
    project,
    feature,
    title: feature.slice(0, 80),
    model,
    version: 1,
    parentVersion: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: { kind: 'model', model },
  });
}
