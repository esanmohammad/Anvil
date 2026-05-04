/**
 * ReplayStore — persistence for bug-to-test replay attempts.
 *
 * A ReplayAttempt ties an IncidentRecord to a generated TestSpec behavior +
 * test case, capturing the pre-fix (should fail) and post-fix (should pass)
 * run results plus a confidence rating. Volume is low (a handful per
 * incident), so we store one file per attempt and scan the directory on
 * `list` rather than maintaining an index.
 *
 * Storage layout:
 *   ~/.anvil/incidents/<project>/replays/
 *   └── <replayId>.json              # one file per attempt
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

import type { ReplayAttempt } from './incident-types.js';

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

function newReplayId(): string {
  return `replay-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

// ── ReplayStore ──────────────────────────────────────────────────────────

class ReplayStore {
  private baseDir: string;

  constructor(anvilHome?: string) {
    const home = anvilHome ?? process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
    this.baseDir = join(home, 'incidents');
    ensureDir(this.baseDir);
  }

  // ── Path helpers ──────────────────────────────────────────────────────

  getReplayDir(project: string): string {
    return join(this.baseDir, project, 'replays');
  }

  private replayPath(project: string, replayId: string): string {
    return join(this.getReplayDir(project), `${replayId}.json`);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────

  /** Write the attempt to disk. */
  save(attempt: ReplayAttempt): ReplayAttempt {
    ensureDir(this.getReplayDir(attempt.project));
    atomicWriteFileSync(
      this.replayPath(attempt.project, attempt.id),
      JSON.stringify(attempt, null, 2),
    );
    return attempt;
  }

  /** Initialize a fresh replay attempt in the `pending` state. */
  create(
    project: string,
    incidentId: string,
    specSlug: string,
    specVersion: number,
    behaviorId: string,
    caseId: string,
  ): ReplayAttempt {
    const now = new Date().toISOString();
    const attempt: ReplayAttempt = {
      id: newReplayId(),
      project,
      incidentId,
      specSlug,
      specVersion,
      behaviorId,
      caseId,
      status: 'pending',
      confidence: 'low',
      notes: [],
      createdAt: now,
    };
    return this.save(attempt);
  }

  read(project: string, replayId: string): ReplayAttempt | null {
    return readJsonSync<ReplayAttempt>(this.replayPath(project, replayId));
  }

  /** List attempts for a project (optionally filtered by incident), newest-first. */
  list(project: string, incidentId?: string): ReplayAttempt[] {
    const dir = this.getReplayDir(project);
    if (!existsSync(dir)) return [];

    const out: ReplayAttempt[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json') || entry.endsWith('.tmp')) continue;
      const attempt = readJsonSync<ReplayAttempt>(join(dir, entry));
      if (!attempt) continue;
      if (incidentId && attempt.incidentId !== incidentId) continue;
      out.push(attempt);
    }

    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  /**
   * Merge partial updates into an existing attempt. Identity fields — `id`,
   * `project`, `incidentId`, `specSlug`, `specVersion`, `behaviorId`,
   * `caseId`, `createdAt` — are immutable and always preserved from the
   * stored record.
   */
  update(
    project: string,
    replayId: string,
    updates: Partial<ReplayAttempt>,
  ): ReplayAttempt | null {
    const current = this.read(project, replayId);
    if (!current) return null;

    const next: ReplayAttempt = {
      ...current,
      ...updates,
      // Preserve identity fields regardless of what the caller passed.
      id: current.id,
      project: current.project,
      incidentId: current.incidentId,
      specSlug: current.specSlug,
      specVersion: current.specVersion,
      behaviorId: current.behaviorId,
      caseId: current.caseId,
      createdAt: current.createdAt,
    };
    return this.save(next);
  }

  /** Append a note to the audit trail. */
  appendNote(project: string, replayId: string, note: string): ReplayAttempt | null {
    const current = this.read(project, replayId);
    if (!current) return null;
    return this.update(project, replayId, { notes: [...current.notes, note] });
  }
}

export { ReplayStore };
