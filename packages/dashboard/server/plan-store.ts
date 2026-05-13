/**
 * PlanStore — structured plan artifacts with versioned persistence.
 *
 * A Plan is a typed object produced by the /plan flow BEFORE the
 * pipeline runs. v2 (canonical) makes the plan a machine-verifiable
 * contract: every field has a deterministic verifier downstream.
 *
 * Storage layout:
 *   ~/.anvil/plans/<project>/<slug>/
 *   ├── v1.json, v2.json, ...       # versioned plan snapshots
 *   ├── current.json                # { currentVersion: N, slug, title, updatedAt }
 *   └── validation.json             # last validator result (may be stale)
 *
 * Old v1-shaped JSON on disk is migrated through
 * `migratePlanJsonToV2()` on read; writes are always v2.
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

import type {
  Plan,
  PlanPointer,
  PlanComment,
  PlanApproval,
  PlanSection,
  PlanRepoImpact,
  PlanContract,
  PlanRisk,
  PlanRollout,
  PlanTests,
  PlanEstimate,
  RiskSeverity,
  ContractKind,
} from '@esankhan3/anvil-core-pipeline';
import {
  migratePlanJsonToV2,
  emptyPlanV2,
  planContentHash,
  planRepoTouchedPaths,
  planContractDisplayName,
  planContractDescription,
} from '@esankhan3/anvil-core-pipeline';

export type {
  Plan,
  PlanPointer,
  PlanComment,
  PlanApproval,
  PlanSection,
  PlanRepoImpact,
  PlanContract,
  PlanRisk,
  PlanRollout,
  PlanTests,
  PlanEstimate,
  RiskSeverity,
  ContractKind,
};

// ── Helpers ──────────────────────────────────────────────────────────────

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

function readPlanJsonSync(filePath: string): Plan | null {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    return migratePlanJsonToV2(raw);
  } catch {
    return null;
  }
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

  /** Create v1 of a new plan from a partial payload. Always written v2. */
  createPlan(project: string, feature: string, model: string, seed: Partial<Plan> = {}): Plan {
    const baseSlug = slugify(seed.title || feature);
    const slug = this.uniqueSlug(project, baseSlug);
    const dir = this.getPlanDir(project, slug);
    ensureDir(dir);

    const now = new Date().toISOString();
    // Build a fresh v2 plan with sensible defaults, then overlay the
    // caller's seed (v2-shaped or v1-shaped — migrator handles both).
    const skeleton = emptyPlanV2(project, feature, model);
    const merged: Plan = migratePlanJsonToV2({
      ...skeleton,
      ...seed,
      slug,
      project,
      title: seed.title || feature.slice(0, 80),
      version: 1,
      parentVersion: null,
      createdAt: now,
      updatedAt: now,
      model,
      feature,
    });

    atomicWriteFileSync(this.versionPath(project, slug, 1), JSON.stringify(merged, null, 2));
    this.writePointer(project, slug, {
      slug, title: merged.title, currentVersion: 1, updatedAt: now,
    });
    return merged;
  }

  /** Append a new version by merging updates into the current version. */
  bumpVersion(project: string, slug: string, updates: Partial<Plan>): Plan {
    const current = this.readCurrent(project, slug);
    if (!current) throw new Error(`Plan not found: ${project}/${slug}`);

    const merged: Plan = migratePlanJsonToV2({
      ...current,
      ...updates,
      // never let callers rewrite identity
      slug: current.slug,
      project: current.project,
      createdAt: current.createdAt,
      version: current.version + 1,
      parentVersion: current.version,
      updatedAt: new Date().toISOString(),
    });
    // The migrator stamped a fresh contentHash; if the caller passed
    // `approval`, leave it stamped (rules will flag if it doesn't
    // match the new hash).
    merged.contentHash = planContentHash(merged);

    atomicWriteFileSync(this.versionPath(project, slug, merged.version), JSON.stringify(merged, null, 2));
    this.writePointer(project, slug, {
      slug, title: merged.title, currentVersion: merged.version, updatedAt: merged.updatedAt,
    });
    return merged;
  }

  /** Read the current (latest) version — auto-migrates on-disk v1 JSON. */
  readCurrent(project: string, slug: string): Plan | null {
    const pointer = readJsonSync<PlanPointer>(this.pointerPath(project, slug));
    if (!pointer) return null;
    return readPlanJsonSync(this.versionPath(project, slug, pointer.currentVersion));
  }

  /** Read a specific version. */
  readVersion(project: string, slug: string, version: number): Plan | null {
    return readPlanJsonSync(this.versionPath(project, slug, version));
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
    if (plan.contentHash) lines.push(`> hash: \`${plan.contentHash.slice(0, 12)}\``);
    lines.push('');
    lines.push('## Problem');
    lines.push(plan.problem.statement);
    if (plan.problem.why_now) lines.push(`\n**Why now:** ${plan.problem.why_now}`);
    if (plan.problem.success_signals.length) {
      lines.push('\n**Success signals:**');
      for (const s of plan.problem.success_signals) lines.push(`- ${s}`);
    }
    lines.push('');

    lines.push('## Scope');
    lines.push('**In scope**');
    for (const s of plan.scope.inScope) {
      lines.push(`- **${s.id}** — ${s.description}`);
      for (const a of s.acceptance) lines.push(`  - _Acceptance:_ ${a}`);
    }
    lines.push('');
    lines.push('**Out of scope**');
    for (const s of plan.scope.outOfScope) lines.push(`- ${s.description}`);
    lines.push('');

    lines.push('## Affected repositories');
    for (const r of plan.repos) {
      lines.push(`### ${r.name}`);
      lines.push(r.changes);
      const touched = planRepoTouchedPaths(r);
      if (touched.length) lines.push(`\n**Files:** ${touched.map((f) => `\`${f}\``).join(', ')}`);
      if (r.symbols.length) lines.push(`\n**Symbols:** ${r.symbols.map((s) => `\`${s.name}\``).join(', ')}`);
      lines.push('');
    }

    if (plan.contracts.length) {
      lines.push('## Cross-repo contracts');
      for (const c of plan.contracts) {
        lines.push(`- **${planContractDisplayName(c)}** — ${planContractDescription(c)}`);
      }
      lines.push('');
    }

    if (plan.data.length) {
      lines.push('## Data changes');
      for (const d of plan.data) {
        lines.push(`- **${d.kind}** in \`${d.repo}\` — \`${d.migrationFile}\` (rollback: ${d.rollback || '_not declared_'})`);
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
      for (const r of plan.risks) lines.push(`- **[${r.severity}/${r.blastRadius}] ${r.title}** — ${r.mitigation}`);
      lines.push('');
    }

    lines.push('## Rollout');
    if (plan.rollout.strategy) lines.push(`- Strategy: \`${plan.rollout.strategy}\``);
    if (plan.rollout.flags.length) lines.push(`- Flags: ${plan.rollout.flags.join(', ')}`);
    if (plan.rollout.order.length) lines.push(`- Order: ${plan.rollout.order.join(' → ')}`);
    if (plan.rollout.rollback.command) lines.push(`- Rollback: \`${plan.rollout.rollback.command}\``);
    if (plan.rollout.rollback.verify) lines.push(`  (verify: \`${plan.rollout.rollback.verify}\`)`);
    lines.push('');

    lines.push('## Tests');
    if (plan.tests.unit.length) {
      lines.push('**Unit**');
      for (const t of plan.tests.unit) lines.push(`- \`${t.name}\` in \`${t.file}\` — given ${t.given} when ${t.when} then ${t.then}`);
    }
    if (plan.tests.integration.length) {
      lines.push('**Integration**');
      for (const t of plan.tests.integration) lines.push(`- \`${t.name}\` in \`${t.file}\` — given ${t.given} when ${t.when} then ${t.then}`);
    }
    if (plan.tests.manual?.length) {
      lines.push('**Manual**');
      for (const t of plan.tests.manual) lines.push(`- ${t.description}`);
    }
    lines.push('');

    lines.push('## Estimate');
    lines.push(`- ~$${plan.estimate.usd.toFixed(2)} · ${plan.estimate.minutes} min · ${plan.estimate.prs} PR(s)`);
    if (plan.estimate.calibratedFrom?.length) {
      lines.push(`- Calibrated from: ${plan.estimate.calibratedFrom.join(', ')}`);
    }

    if (plan.approval) {
      lines.push('');
      lines.push(`## Approval`);
      lines.push(`Approved by **${plan.approval.user}** at ${plan.approval.approvedAt} (hash: \`${plan.approval.planHash.slice(0, 12)}\`).`);
    }

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
    // Phase C: stamp the active approval onto the plan version so the
    // execute-plan gate can read it without joining files. planHash
    // pins the approval to the content — subsequent edits invalidate it.
    try {
      const plan = this.readCurrent(project, slug);
      if (plan) {
        const stamped: Plan = {
          ...plan,
          approval: {
            user,
            approvedAt: approval.approvedAt,
            planHash: plan.contentHash,
            ...(note !== undefined ? { note } : {}),
          },
        };
        atomicWriteFileSync(
          this.versionPath(project, slug, plan.version),
          JSON.stringify(stamped, null, 2),
        );
      }
    } catch { /* leave the legacy approvals list as the audit trail */ }
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
    const uniqueUsers = new Set(matching.map((a) => a.user));
    return uniqueUsers.size >= required;
  }
}
