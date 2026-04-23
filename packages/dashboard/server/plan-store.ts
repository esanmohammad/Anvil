/**
 * PlanStore — structured plan artifacts with versioned persistence.
 *
 * A Plan is a typed object produced by the /plan flow BEFORE the pipeline
 * runs. Plans are the contract between idea and implementation: they describe
 * the problem, scope, affected repos, cross-repo contracts, risks, rollout,
 * and tests, and estimate cost/time/PRs.
 *
 * Storage layout:
 *   ~/.anvil/plans/<project>/<slug>/
 *   ├── v1.json, v2.json, ...       # versioned plan snapshots
 *   ├── current.json                # { currentVersion: N, slug, title, updatedAt }
 *   └── validation.json             # last validator result (may be stale)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────────

export type RiskSeverity = 'low' | 'med' | 'high';
export type ContractKind = 'http' | 'grpc' | 'kafka' | 'db' | 'other';

export interface PlanRepoImpact {
  name: string;
  changes: string;
  files: string[];
  symbols: string[];
}

export interface PlanContract {
  kind: ContractKind;
  name: string;
  producer: string;
  consumers: string[];
  description: string;
}

export interface PlanRisk {
  title: string;
  mitigation: string;
  severity: RiskSeverity;
}

export interface PlanRollout {
  strategy: string;
  flags: string[];
  order: string[];
  rollback: string;
}

export interface PlanTests {
  unit: string[];
  integration: string[];
  manual: string[];
}

export interface PlanEstimate {
  usd: number;
  minutes: number;
  prs: number;
}

export interface Plan {
  version: number;
  slug: string;
  project: string;
  title: string;
  problem: string;
  scope: { inScope: string[]; outOfScope: string[] };
  repos: PlanRepoImpact[];
  contracts: PlanContract[];
  architecture: { mermaid: string; notes: string };
  risks: PlanRisk[];
  rollout: PlanRollout;
  tests: PlanTests;
  estimate: PlanEstimate;
  model: string;
  feature: string;             // original feature description
  createdAt: string;
  updatedAt: string;
}

export interface PlanPointer {
  slug: string;
  title: string;
  currentVersion: number;
  updatedAt: string;
}

export type PlanSection =
  | 'problem' | 'scope' | 'repos' | 'contracts' | 'architecture'
  | 'risks' | 'rollout' | 'tests' | 'estimate';

export interface PlanComment {
  id: string;              // `c-${Date.now().toString(36)}-${randHex}`
  sectionPath: string;     // e.g. "problem", "repos[2].files", "risks[0]"
  author: string;          // from ANVIL_USER_NAME env or 'anonymous'
  body: string;
  createdAt: string;       // ISO
  resolved: boolean;
}

export interface PlanApproval {
  id: string;
  user: string;
  approvedVersion: number;
  approvedAt: string;
  note?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

function readJsonSync<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function slugify(input: string): string {
  let slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 50) slug = slug.slice(0, 50).replace(/-+$/, '');
  return slug || 'plan';
}

// ── PlanStore ────────────────────────────────────────────────────────────

export class PlanStore {
  private baseDir: string;

  constructor(anvilHome?: string) {
    const home = anvilHome ?? process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
    this.baseDir = join(home, 'plans');
    ensureDir(this.baseDir);
  }

  // ── Path helpers ──────────────────────────────────────────────────────

  getPlanDir(project: string, slug: string): string {
    return join(this.baseDir, project, slug);
  }

  private projectDir(project: string): string {
    return join(this.baseDir, project);
  }

  private versionPath(project: string, slug: string, version: number): string {
    return join(this.getPlanDir(project, slug), `v${version}.json`);
  }

  private pointerPath(project: string, slug: string): string {
    return join(this.getPlanDir(project, slug), 'current.json');
  }

  validationPath(project: string, slug: string): string {
    return join(this.getPlanDir(project, slug), 'validation.json');
  }

  private commentsPath(project: string, slug: string): string {
    return join(this.getPlanDir(project, slug), 'comments.json');
  }

  private approvalsPath(project: string, slug: string): string {
    return join(this.getPlanDir(project, slug), 'approvals.json');
  }

  // ── Slug ──────────────────────────────────────────────────────────────

  private uniqueSlug(project: string, base: string): string {
    const dir = this.projectDir(project);
    if (!existsSync(dir) || !existsSync(join(dir, base))) return base;
    let n = 2;
    while (existsSync(join(dir, `${base}-${n}`))) n++;
    return `${base}-${n}`;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────

  /** Create v1 of a new plan from a partial payload. */
  createPlan(project: string, feature: string, model: string, seed: Partial<Plan> = {}): Plan {
    const baseSlug = slugify(seed.title || feature);
    const slug = this.uniqueSlug(project, baseSlug);
    const dir = this.getPlanDir(project, slug);
    ensureDir(dir);

    const now = new Date().toISOString();
    const plan: Plan = {
      version: 1,
      slug,
      project,
      title: seed.title || feature.slice(0, 80),
      problem: seed.problem ?? feature,
      scope: seed.scope ?? { inScope: [], outOfScope: [] },
      repos: seed.repos ?? [],
      contracts: seed.contracts ?? [],
      architecture: seed.architecture ?? { mermaid: '', notes: '' },
      risks: seed.risks ?? [],
      rollout: seed.rollout ?? { strategy: '', flags: [], order: [], rollback: '' },
      tests: seed.tests ?? { unit: [], integration: [], manual: [] },
      estimate: seed.estimate ?? { usd: 0, minutes: 0, prs: 0 },
      model,
      feature,
      createdAt: now,
      updatedAt: now,
    };

    atomicWriteFileSync(this.versionPath(project, slug, 1), JSON.stringify(plan, null, 2));
    this.writePointer(project, slug, {
      slug, title: plan.title, currentVersion: 1, updatedAt: now,
    });
    return plan;
  }

  /** Append a new version by merging updates into the current version. */
  bumpVersion(project: string, slug: string, updates: Partial<Plan>): Plan {
    const current = this.readCurrent(project, slug);
    if (!current) throw new Error(`Plan not found: ${project}/${slug}`);

    const next: Plan = {
      ...current,
      ...updates,
      // never let callers rewrite identity
      slug: current.slug,
      project: current.project,
      createdAt: current.createdAt,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };

    atomicWriteFileSync(this.versionPath(project, slug, next.version), JSON.stringify(next, null, 2));
    this.writePointer(project, slug, {
      slug, title: next.title, currentVersion: next.version, updatedAt: next.updatedAt,
    });
    return next;
  }

  /** Read the current (latest) version. */
  readCurrent(project: string, slug: string): Plan | null {
    const pointer = readJsonSync<PlanPointer>(this.pointerPath(project, slug));
    if (!pointer) return null;
    return readJsonSync<Plan>(this.versionPath(project, slug, pointer.currentVersion));
  }

  /** Read a specific version. */
  readVersion(project: string, slug: string, version: number): Plan | null {
    return readJsonSync<Plan>(this.versionPath(project, slug, version));
  }

  /** List all versions for a plan (sorted ascending). */
  listVersions(project: string, slug: string): number[] {
    const dir = this.getPlanDir(project, slug);
    if (!existsSync(dir)) return [];
    const versions: number[] = [];
    for (const entry of readdirSync(dir)) {
      const m = entry.match(/^v(\d+)\.json$/);
      if (m) versions.push(parseInt(m[1], 10));
    }
    return versions.sort((a, b) => a - b);
  }

  /** List all plan pointers for a project (or all projects if omitted). */
  listPlans(project?: string): PlanPointer[] {
    const out: PlanPointer[] = [];
    const projects = project
      ? [project]
      : existsSync(this.baseDir)
        ? readdirSync(this.baseDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
        : [];

    for (const p of projects) {
      const dir = this.projectDir(p);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const ptr = readJsonSync<PlanPointer>(this.pointerPath(p, entry.name));
        if (ptr) out.push(ptr);
      }
    }

    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  }

  /** Render plan as markdown (for copy / pipeline context injection). */
  renderMarkdown(plan: Plan): string {
    const lines: string[] = [];
    lines.push(`# ${plan.title}`);
    lines.push(`> Plan v${plan.version} — ${plan.project} — ${plan.model}`);
    lines.push('');
    lines.push('## Problem'); lines.push(plan.problem); lines.push('');

    lines.push('## Scope');
    lines.push('**In scope**');
    for (const s of plan.scope.inScope) lines.push(`- ${s}`);
    lines.push('');
    lines.push('**Out of scope**');
    for (const s of plan.scope.outOfScope) lines.push(`- ${s}`);
    lines.push('');

    lines.push('## Affected repositories');
    for (const r of plan.repos) {
      lines.push(`### ${r.name}`);
      lines.push(r.changes);
      if (r.files.length) lines.push(`\n**Files:** ${r.files.map((f) => `\`${f}\``).join(', ')}`);
      if (r.symbols.length) lines.push(`\n**Symbols:** ${r.symbols.map((s) => `\`${s}\``).join(', ')}`);
      lines.push('');
    }

    if (plan.contracts.length) {
      lines.push('## Cross-repo contracts');
      for (const c of plan.contracts) {
        lines.push(`- **${c.kind.toUpperCase()} · ${c.name}** — ${c.producer} → ${c.consumers.join(', ') || '(none)'}`);
        lines.push(`  ${c.description}`);
      }
      lines.push('');
    }

    if (plan.architecture.mermaid || plan.architecture.notes) {
      lines.push('## Architecture');
      if (plan.architecture.notes) { lines.push(plan.architecture.notes); lines.push(''); }
      if (plan.architecture.mermaid) {
        lines.push('```mermaid');
        lines.push(plan.architecture.mermaid);
        lines.push('```');
      }
      lines.push('');
    }

    if (plan.risks.length) {
      lines.push('## Risks');
      for (const r of plan.risks) lines.push(`- **[${r.severity}] ${r.title}** — ${r.mitigation}`);
      lines.push('');
    }

    lines.push('## Rollout');
    if (plan.rollout.strategy) lines.push(plan.rollout.strategy);
    if (plan.rollout.flags.length) lines.push(`- Flags: ${plan.rollout.flags.join(', ')}`);
    if (plan.rollout.order.length) lines.push(`- Order: ${plan.rollout.order.join(' → ')}`);
    if (plan.rollout.rollback) lines.push(`- Rollback: ${plan.rollout.rollback}`);
    lines.push('');

    lines.push('## Tests');
    if (plan.tests.unit.length) {
      lines.push('**Unit**');
      for (const t of plan.tests.unit) lines.push(`- ${t}`);
    }
    if (plan.tests.integration.length) {
      lines.push('**Integration**');
      for (const t of plan.tests.integration) lines.push(`- ${t}`);
    }
    if (plan.tests.manual.length) {
      lines.push('**Manual**');
      for (const t of plan.tests.manual) lines.push(`- ${t}`);
    }
    lines.push('');

    lines.push('## Estimate');
    lines.push(`- ~$${plan.estimate.usd.toFixed(2)} · ${plan.estimate.minutes} min · ${plan.estimate.prs} PR(s)`);

    return lines.join('\n');
  }

  // ── Pointer ───────────────────────────────────────────────────────────

  private writePointer(project: string, slug: string, pointer: PlanPointer): void {
    ensureDir(this.getPlanDir(project, slug));
    atomicWriteFileSync(this.pointerPath(project, slug), JSON.stringify(pointer, null, 2));
  }

  readPointer(project: string, slug: string): PlanPointer | null {
    return readJsonSync<PlanPointer>(this.pointerPath(project, slug));
  }

  // ── Validation artifact ───────────────────────────────────────────────

  writeValidation(project: string, slug: string, result: unknown): void {
    atomicWriteFileSync(this.validationPath(project, slug), JSON.stringify(result, null, 2));
  }

  readValidation<T = unknown>(project: string, slug: string): T | null {
    return readJsonSync<T>(this.validationPath(project, slug));
  }

  // ── Comments ──────────────────────────────────────────────────────────
  //
  // Comments are stored per-plan (NOT per-version) because a review
  // conversation is about the plan as a whole; tying comments to an immutable
  // version snapshot would orphan them every time the plan is bumped. The
  // optional `sectionPath` field lets UIs surface comments next to the
  // section they reference.

  listComments(project: string, slug: string): PlanComment[] {
    const data = readJsonSync<PlanComment[]>(this.commentsPath(project, slug));
    return data ?? [];
  }

  addComment(
    project: string,
    slug: string,
    sectionPath: string,
    body: string,
    author?: string,
  ): PlanComment {
    ensureDir(this.getPlanDir(project, slug));
    const comments = this.listComments(project, slug);
    const comment: PlanComment = {
      id: `c-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
      sectionPath,
      author: author ?? process.env.ANVIL_USER_NAME ?? 'anonymous',
      body,
      createdAt: new Date().toISOString(),
      resolved: false,
    };
    comments.push(comment);
    atomicWriteFileSync(
      this.commentsPath(project, slug),
      JSON.stringify(comments, null, 2),
    );
    return comment;
  }

  resolveComment(project: string, slug: string, commentId: string): boolean {
    const comments = this.listComments(project, slug);
    const idx = comments.findIndex((c) => c.id === commentId);
    if (idx === -1) return false;
    if (comments[idx].resolved) return true;
    comments[idx] = { ...comments[idx], resolved: true };
    atomicWriteFileSync(
      this.commentsPath(project, slug),
      JSON.stringify(comments, null, 2),
    );
    return true;
  }

  deleteComment(project: string, slug: string, commentId: string): boolean {
    const comments = this.listComments(project, slug);
    const next = comments.filter((c) => c.id !== commentId);
    if (next.length === comments.length) return false;
    atomicWriteFileSync(
      this.commentsPath(project, slug),
      JSON.stringify(next, null, 2),
    );
    return true;
  }

  // ── Approvals ─────────────────────────────────────────────────────────
  //
  // Approvals pin to the plan's current version at the moment of approval.
  // Bumping the plan (new version) does NOT delete prior approvals — we
  // simply stop counting them toward the gate. This preserves the audit
  // trail of who approved which version while ensuring the freshest version
  // must be re-approved before the pipeline can run.

  listApprovals(project: string, slug: string): PlanApproval[] {
    const data = readJsonSync<PlanApproval[]>(this.approvalsPath(project, slug));
    return data ?? [];
  }

  addApproval(
    project: string,
    slug: string,
    user: string,
    note?: string,
  ): PlanApproval {
    const pointer = this.readPointer(project, slug);
    if (!pointer) throw new Error(`Plan not found: ${project}/${slug}`);
    ensureDir(this.getPlanDir(project, slug));

    const approvals = this.listApprovals(project, slug);
    const approval: PlanApproval = {
      id: `a-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
      user,
      approvedVersion: pointer.currentVersion,
      approvedAt: new Date().toISOString(),
      ...(note !== undefined ? { note } : {}),
    };
    approvals.push(approval);
    atomicWriteFileSync(
      this.approvalsPath(project, slug),
      JSON.stringify(approvals, null, 2),
    );
    return approval;
  }

  meetsApprovalRequirement(
    project: string,
    slug: string,
    required: number,
  ): boolean {
    if (required <= 0) return true;
    const pointer = this.readPointer(project, slug);
    if (!pointer) return false;
    const matching = this.listApprovals(project, slug)
      .filter((a) => a.approvedVersion === pointer.currentVersion);
    // Unique by user so the same approver cannot double-count.
    const uniqueUsers = new Set(matching.map((a) => a.user));
    return uniqueUsers.size >= required;
  }
}
