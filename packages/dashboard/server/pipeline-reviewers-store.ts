/**
 * PipelineReviewersStore — persistence for reviewer assignments and
 * approval tracking (team mode, Phase 7).
 *
 * Storage layout:
 *   <anvilHome>/pipeline-reviewers/
 *   └── <project>/
 *       └── <runId>.json        # one file per assignment
 *
 * Each file holds a ReviewerAssignment: the resolved reviewer list, the
 * quorum threshold (approvalsRequired), and a growing list of approvals.
 *
 * Atomic writes: every file is written to `<path>.tmp` and `renameSync`d
 * into place. A crash mid-write can only leave a stray `.tmp` — the
 * authoritative file is never partially written.
 *
 * Quorum semantics (`hasQuorum`):
 *   - Count distinct users who voted 'approve'.
 *   - Any 'reject' by any user kills quorum regardless of approve count.
 *   - Returns true when distinct approve count >= approvalsRequired.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type {
  ReviewerApproval,
  ReviewerAssignment,
} from './pipeline-reviewers-types.js';

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

// ── Store ────────────────────────────────────────────────────────────────

export interface AssignInput {
  runId: string;
  project: string;
  reviewers: string[];
  approvalsRequired: number;
}

export class PipelineReviewersStore {
  private baseDir: string;

  constructor(anvilHome: string) {
    this.baseDir = join(anvilHome, 'pipeline-reviewers');
    ensureDir(this.baseDir);
  }

  // ── Path helpers ───────────────────────────────────────────────────────

  private projectDir(project: string): string {
    return join(this.baseDir, project);
  }

  private assignmentPath(project: string, runId: string): string {
    return join(this.projectDir(project), `${runId}.json`);
  }

  // ── Index lookup (per-project scan) ───────────────────────────────────

  /**
   * Locate an assignment by runId by scanning per-project directories.
   * Assignments are only written once per runId per project, so the first
   * hit wins.
   */
  private findPath(runId: string): string | null {
    if (!existsSync(this.baseDir)) return null;
    // Use a small scan — reviewer assignments are not high-cardinality.
    for (const project of readdirSync(this.baseDir)) {
      const dir = this.projectDir(project);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const candidate = this.assignmentPath(project, runId);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  private writeAssignment(a: ReviewerAssignment): ReviewerAssignment {
    ensureDir(this.projectDir(a.project));
    atomicWriteFileSync(
      this.assignmentPath(a.project, a.runId),
      JSON.stringify(a, null, 2),
    );
    return a;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /** Create a new reviewer assignment. */
  assign(input: AssignInput): ReviewerAssignment {
    const assignment: ReviewerAssignment = {
      runId: input.runId,
      project: input.project,
      reviewers: [...input.reviewers],
      approvalsRequired: Math.max(1, input.approvalsRequired),
      approvals: [],
      createdAt: new Date().toISOString(),
    };
    return this.writeAssignment(assignment);
  }

  /** Append an approval/rejection decision for a specific reviewer. */
  recordApproval(
    runId: string,
    user: string,
    action: 'approve' | 'reject',
    note?: string,
  ): ReviewerAssignment {
    const existing = this.get(runId);
    if (!existing) throw new Error(`reviewer assignment not found: ${runId}`);

    const approval: ReviewerApproval = {
      user,
      action,
      at: new Date().toISOString(),
      ...(note !== undefined ? { note } : {}),
    };

    // Replace any previous vote by the same user (one-vote-per-user).
    const approvals = existing.approvals.filter((a) => a.user !== user);
    approvals.push(approval);

    const next: ReviewerAssignment = { ...existing, approvals };
    return this.writeAssignment(next);
  }

  /** Fetch an assignment by runId across all projects. */
  get(runId: string): ReviewerAssignment | null {
    const path = this.findPath(runId);
    if (!path) return null;
    return readJsonSync<ReviewerAssignment>(path);
  }

  /** Load the assignment for a specific project/runId pair (fast path). */
  getByProject(project: string, runId: string): ReviewerAssignment | null {
    const path = this.assignmentPath(project, runId);
    if (!existsSync(path)) return null;
    return readJsonSync<ReviewerAssignment>(path);
  }

  /**
   * Replace the reviewer list and reset approvals. Used when escalating or
   * rerouting after CODEOWNERS changes. Preserves `createdAt` so the audit
   * chain can reason about the original assignment time.
   */
  reassign(
    runId: string,
    newReviewers: string[],
    _actor: string,
  ): ReviewerAssignment {
    const existing = this.get(runId);
    if (!existing) throw new Error(`reviewer assignment not found: ${runId}`);

    const next: ReviewerAssignment = {
      ...existing,
      reviewers: [...newReviewers],
      approvals: [],
    };
    return this.writeAssignment(next);
  }

  /** Quorum test: N distinct approve votes AND zero reject votes. */
  hasQuorum(assignment: ReviewerAssignment): boolean {
    const rejected = assignment.approvals.some((a) => a.action === 'reject');
    if (rejected) return false;
    const approvers = new Set(
      assignment.approvals
        .filter((a) => a.action === 'approve')
        .map((a) => a.user),
    );
    return approvers.size >= assignment.approvalsRequired;
  }
}
