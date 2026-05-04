/**
 * ReviewStore — versioned persistence for PR Review artifacts.
 *
 * A Review is the result of one or more reviewer personas analysing a pull
 * request. It contains structured findings, plan compliance (if the PR was
 * Anvil-authored from a plan), a verdict, and an audit trail.
 *
 * Storage layout:
 *   ~/.anvil/reviews/<project>/<prId>/
 *   ├── v1.json, v2.json, ...       # versioned snapshots
 *   ├── current.json                # pointer
 *   └── index.json                  # per-review quick-access summary
 *
 * prId = "<owner>-<repo>-<number>" (slugified)
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

export type Severity = 'blocker' | 'error' | 'warn' | 'info' | 'nit';
export type Category = 'correctness' | 'security' | 'convention' | 'test' | 'perf' | 'docs' | 'plan-drift';
export type Verdict = 'approve' | 'request-changes' | 'comment';
export type Persona = 'architect' | 'security' | 'style' | 'tester' | 'domain';
export type Resolution = 'pending' | 'addressed' | 'dismissed' | 'wont-fix';
export type Confidence = 'high' | 'med' | 'low';

export interface ReviewFinding {
  id: string;
  severity: Severity;
  category: Category;
  persona?: Persona;
  file: string;
  line: number;
  snippet: string;
  description: string;
  suggestedFix: { diff: string; rationale: string } | null;
  kbRef?: { nodeId: string; repo: string };
  cve?: string;
  confidence: Confidence;
  resolution: Resolution;
  createdAt: string;
}

export interface PlanComplianceReport {
  matchRate: number;
  unplannedFiles: Array<{ repo: string; file: string; severity: 'warn' | 'info' }>;
  missedFiles: Array<{ repo: string; file: string; severity: 'error' | 'warn' }>;
  missedSymbols: string[];
  deliveredContracts: string[];
  missingContracts: string[];
}

export interface PRMeta {
  repo: string;           // owner/repo
  number: number;
  url: string;
  headSha: string;
  baseSha: string;
  title?: string;
  author?: string;
}

export interface Review {
  version: number;
  id: string;                  // prId
  project: string;
  pr: PRMeta;
  planSlug?: string;
  trigger: 'ship' | 'push' | 'manual' | 'webhook' | 'schedule';
  personas: Persona[];
  diffStats: { additions: number; deletions: number; files: number };
  findings: ReviewFinding[];
  planCompliance: PlanComplianceReport | null;
  convention: { rulesChecked: number; violations: number };
  security: { checks: string[]; flags: number };
  summary: string;
  verdict: Verdict;
  estimate: { usd: number; seconds: number };
  model: string;
  createdAt: string;
  startedAt: string;
  completedAt: string;
}

export interface ReviewPointer {
  id: string;
  prUrl: string;
  prTitle?: string;
  currentVersion: number;
  updatedAt: string;
  verdict: Verdict;
}

export interface ReviewSummary {
  reviewId: string;
  prUrl: string;
  prTitle?: string;
  project: string;
  verdict: Verdict;
  createdAt: string;
  severityCounts: Record<Severity, number>;
  resolutionCounts: Record<Resolution, number>;
  topCategory: Category | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

function readJsonSync<T>(filePath: string): T | null {
  try { return JSON.parse(readFileSync(filePath, 'utf-8')) as T; } catch { return null; }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Parse a PR URL into `<owner>-<repo>-<number>` as the canonical review id. */
export function prIdFromUrl(url: string): { prId: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  const owner = m[1].toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const name = m[2].toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const n = parseInt(m[3], 10);
  return { prId: `${owner}-${name}-${n}`, repo: `${m[1]}/${m[2]}`, number: n };
}

export function newFindingId(): string {
  return `f-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function countSeverities(findings: ReviewFinding[]): Record<Severity, number> {
  const base: Record<Severity, number> = { blocker: 0, error: 0, warn: 0, info: 0, nit: 0 };
  for (const f of findings) base[f.severity] = (base[f.severity] ?? 0) + 1;
  return base;
}

function countResolutions(findings: ReviewFinding[]): Record<Resolution, number> {
  const base: Record<Resolution, number> = { pending: 0, addressed: 0, dismissed: 0, 'wont-fix': 0 };
  for (const f of findings) base[f.resolution] = (base[f.resolution] ?? 0) + 1;
  return base;
}

function topCategory(findings: ReviewFinding[]): Category | null {
  if (!findings.length) return null;
  const counts = new Map<Category, number>();
  for (const f of findings) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  let best: Category | null = null;
  let n = -1;
  for (const [cat, c] of counts) if (c > n) { best = cat; n = c; }
  return best;
}

// ── ReviewStore ──────────────────────────────────────────────────────────

export class ReviewStore {
  private baseDir: string;

  constructor(anvilHome?: string) {
    const home = anvilHome ?? process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
    this.baseDir = join(home, 'reviews');
    ensureDir(this.baseDir);
  }

  getReviewDir(project: string, reviewId: string): string {
    return join(this.baseDir, project, reviewId);
  }

  private projectDir(project: string): string {
    return join(this.baseDir, project);
  }

  private versionPath(project: string, id: string, v: number): string {
    return join(this.getReviewDir(project, id), `v${v}.json`);
  }

  private pointerPath(project: string, id: string): string {
    return join(this.getReviewDir(project, id), 'current.json');
  }

  // ── CRUD ──────────────────────────────────────────────────────────────

  createReview(project: string, seed: Omit<Review, 'version' | 'createdAt'> & { createdAt?: string }): Review {
    const dir = this.getReviewDir(project, seed.id);
    ensureDir(dir);

    const now = new Date().toISOString();
    const review: Review = {
      ...seed,
      version: 1,
      createdAt: seed.createdAt ?? now,
    };

    atomicWriteFileSync(this.versionPath(project, seed.id, 1), JSON.stringify(review, null, 2));
    this.writePointer(project, seed.id, {
      id: seed.id,
      prUrl: seed.pr.url,
      prTitle: seed.pr.title,
      currentVersion: 1,
      updatedAt: now,
      verdict: seed.verdict,
    });
    return review;
  }

  bumpVersion(project: string, id: string, updates: Partial<Review>): Review {
    const current = this.readCurrent(project, id);
    if (!current) throw new Error(`Review not found: ${project}/${id}`);

    const next: Review = {
      ...current,
      ...updates,
      id: current.id,
      project: current.project,
      createdAt: current.createdAt,
      version: current.version + 1,
    };

    atomicWriteFileSync(this.versionPath(project, id, next.version), JSON.stringify(next, null, 2));
    this.writePointer(project, id, {
      id,
      prUrl: next.pr.url,
      prTitle: next.pr.title,
      currentVersion: next.version,
      updatedAt: new Date().toISOString(),
      verdict: next.verdict,
    });
    return next;
  }

  /** Append a batch of findings (from a persona or a prepass) and bump version. */
  appendFindings(project: string, id: string, findings: ReviewFinding[]): Review {
    const current = this.readCurrent(project, id);
    if (!current) throw new Error(`Review not found: ${project}/${id}`);
    // Dedup by (file, line, description)
    const key = (f: ReviewFinding) => `${f.file}:${f.line}:${f.description}`;
    const existing = new Set(current.findings.map(key));
    const merged = [...current.findings, ...findings.filter((f) => !existing.has(key(f)))];
    return this.bumpVersion(project, id, {
      findings: merged,
      verdict: this.computeVerdict(merged),
    });
  }

  /**
   * Update a single finding's resolution. Bumps the review version so the
   * resolution change is captured in the audit trail and so verdict
   * recomputation has a versioned anchor. Cheap (one JSON write).
   */
  setResolution(project: string, id: string, findingId: string, resolution: Resolution): Review | null {
    const current = this.readCurrent(project, id);
    if (!current) return null;
    const idx = current.findings.findIndex((f) => f.id === findingId);
    if (idx === -1) return null;
    const updated = [...current.findings];
    updated[idx] = { ...updated[idx], resolution };
    // Resolution changes DO bump version — cheap, and useful audit trail.
    return this.bumpVersion(project, id, {
      findings: updated,
      verdict: this.computeVerdict(updated),
    });
  }

  readCurrent(project: string, id: string): Review | null {
    const pointer = readJsonSync<ReviewPointer>(this.pointerPath(project, id));
    if (!pointer) return null;
    return readJsonSync<Review>(this.versionPath(project, id, pointer.currentVersion));
  }

  readVersion(project: string, id: string, version: number): Review | null {
    return readJsonSync<Review>(this.versionPath(project, id, version));
  }

  listVersions(project: string, id: string): number[] {
    const dir = this.getReviewDir(project, id);
    if (!existsSync(dir)) return [];
    const versions: number[] = [];
    for (const entry of readdirSync(dir)) {
      const m = entry.match(/^v(\d+)\.json$/);
      if (m) versions.push(parseInt(m[1], 10));
    }
    return versions.sort((a, b) => a - b);
  }

  listReviews(project?: string, limit = 200): ReviewSummary[] {
    const out: ReviewSummary[] = [];
    const projects = project
      ? [project]
      : existsSync(this.baseDir)
        ? readdirSync(this.baseDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
        : [];

    for (const p of projects) {
      const pDir = this.projectDir(p);
      if (!existsSync(pDir)) continue;
      for (const entry of readdirSync(pDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const review = this.readCurrent(p, entry.name);
        if (!review) continue;
        out.push({
          reviewId: review.id,
          prUrl: review.pr.url,
          prTitle: review.pr.title,
          project: p,
          verdict: review.verdict,
          createdAt: review.createdAt,
          severityCounts: countSeverities(review.findings),
          resolutionCounts: countResolutions(review.findings),
          topCategory: topCategory(review.findings),
        });
      }
    }

    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out.slice(0, limit);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  computeVerdict(findings: ReviewFinding[]): Verdict {
    const active = findings.filter((f) => f.resolution === 'pending');
    const hasBlocker = active.some((f) => f.severity === 'blocker');
    const errorCount = active.filter((f) => f.severity === 'error').length;
    if (hasBlocker || errorCount >= 3) return 'request-changes';
    if (errorCount > 0) return 'request-changes';
    const hasWarn = active.some((f) => f.severity === 'warn');
    if (hasWarn) return 'comment';
    return 'approve';
  }

  private writePointer(project: string, id: string, pointer: ReviewPointer): void {
    ensureDir(this.getReviewDir(project, id));
    atomicWriteFileSync(this.pointerPath(project, id), JSON.stringify(pointer, null, 2));
  }

  readPointer(project: string, id: string): ReviewPointer | null {
    return readJsonSync<ReviewPointer>(this.pointerPath(project, id));
  }
}
