/**
 * PipelinePauseStore — persistence for pipeline pause/resume state.
 *
 * Each paused run is captured in a per-project JSON file. A top-level
 * `index.json` holds a pointer list (runId, project, status, pausedAt)
 * for fast listing/filtering without hydrating every record.
 *
 * Storage layout:
 *   <anvilHome>/pipeline-pauses/
 *   ├── index.json                # PausePointer[] — newest-first
 *   └── <project>/
 *       └── <runId>.json          # one file per pause
 *
 * Atomic writes: every file is written as `<path>.tmp` and `renameSync`d into
 * place. The index is rewritten atomically on each mutation so a crash mid-
 * write can only leave a stray `.tmp` — the authoritative file is never
 * partially written.
 *
 * Index hydration: if `index.json` is missing or unreadable it is rebuilt by
 * scanning the per-project directories on demand.
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
  PauseQueryFilters,
  PausePointer,
  PauseState,
  ResumeDecision,
} from './pipeline-pause-types.js';

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

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function toPointer(state: PauseState): PausePointer {
  return {
    runId: state.runId,
    project: state.project,
    status: state.status,
    pausedAt: state.pausedAt,
  };
}

// ── PipelinePauseStore ───────────────────────────────────────────────────

export interface PauseCreateInput {
  runId: string;
  project: string;
  stage: PauseState['stage'];
  reason: string;
  matchedRules: string[];
  reviewers: string[];
  timeoutHours?: number;
}

class PipelinePauseStore {
  private baseDir: string;

  constructor(anvilHome: string) {
    this.baseDir = join(anvilHome, 'pipeline-pauses');
    ensureDir(this.baseDir);
  }

  // ── Path helpers ──────────────────────────────────────────────────────

  private projectDir(project: string): string {
    return join(this.baseDir, project);
  }

  private pausePath(project: string, runId: string): string {
    return join(this.projectDir(project), `${runId}.json`);
  }

  private indexPath(): string {
    return join(this.baseDir, 'index.json');
  }

  // ── Index ─────────────────────────────────────────────────────────────

  private readIndex(): PausePointer[] {
    const direct = readJsonSync<PausePointer[]>(this.indexPath());
    if (direct && Array.isArray(direct)) return direct;
    // Missing / corrupt — rebuild from disk scan.
    return this.rebuildIndex();
  }

  private rebuildIndex(): PausePointer[] {
    const pointers: PausePointer[] = [];
    if (!existsSync(this.baseDir)) return pointers;
    for (const entry of readdirSync(this.baseDir)) {
      const projectPath = join(this.baseDir, entry);
      if (!isDir(projectPath)) continue;
      for (const file of readdirSync(projectPath)) {
        if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
        const state = readJsonSync<PauseState>(join(projectPath, file));
        if (state && typeof state.runId === 'string') {
          pointers.push(toPointer(state));
        }
      }
    }
    pointers.sort((a, b) => b.pausedAt.localeCompare(a.pausedAt));
    this.writeIndex(pointers);
    return pointers;
  }

  private writeIndex(pointers: PausePointer[]): void {
    ensureDir(this.baseDir);
    const sorted = [...pointers].sort((a, b) => b.pausedAt.localeCompare(a.pausedAt));
    atomicWriteFileSync(this.indexPath(), JSON.stringify(sorted, null, 2));
  }

  private upsertIndex(state: PauseState): void {
    const pointers = this.readIndex();
    const idx = pointers.findIndex((p) => p.runId === state.runId);
    const pointer = toPointer(state);
    if (idx === -1) pointers.unshift(pointer);
    else pointers[idx] = pointer;
    this.writeIndex(pointers);
  }

  // ── Internal read/write ───────────────────────────────────────────────

  private writeState(state: PauseState): PauseState {
    ensureDir(this.projectDir(state.project));
    atomicWriteFileSync(
      this.pausePath(state.project, state.runId),
      JSON.stringify(state, null, 2),
    );
    this.upsertIndex(state);
    return state;
  }

  private findPointer(runId: string): PausePointer | null {
    const pointers = this.readIndex();
    return pointers.find((p) => p.runId === runId) ?? null;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Create a new pause record. Generates `pausedAt` (now) and computes
   * `timeoutAt` from `timeoutHours` if provided. Status is
   * `paused-awaiting-user`.
   */
  pause(input: PauseCreateInput): PauseState {
    const pausedAt = new Date();
    const timeoutAt = input.timeoutHours !== undefined
      ? new Date(pausedAt.getTime() + input.timeoutHours * 3_600_000).toISOString()
      : undefined;

    const state: PauseState = {
      runId: input.runId,
      project: input.project,
      stage: input.stage,
      reason: input.reason,
      matchedRules: input.matchedRules,
      reviewers: input.reviewers,
      pausedAt: pausedAt.toISOString(),
      timeoutAt,
      status: 'paused-awaiting-user',
    };
    return this.writeState(state);
  }

  /** Transition to `resumed`. Throws if not found or not awaiting. */
  resume(
    runId: string,
    decision: ResumeDecision,
    resumedBy?: string,
  ): PauseState {
    const existing = this.get(runId);
    if (!existing) throw new Error(`pause not found: ${runId}`);
    if (existing.status !== 'paused-awaiting-user') {
      throw new Error(
        `pause ${runId} is not awaiting user (status=${existing.status})`,
      );
    }
    const next: PauseState = {
      ...existing,
      status: 'resumed',
      resumeDecision: decision,
      resumedAt: new Date().toISOString(),
      resumedBy: resumedBy ?? 'unknown',
    };
    return this.writeState(next);
  }

  /** Mark as cancelled. Throws if not found or already terminal. */
  cancel(runId: string, resumedBy?: string): PauseState {
    const existing = this.get(runId);
    if (!existing) throw new Error(`pause not found: ${runId}`);
    if (existing.status !== 'paused-awaiting-user') {
      throw new Error(
        `pause ${runId} cannot be cancelled (status=${existing.status})`,
      );
    }
    const next: PauseState = {
      ...existing,
      status: 'cancelled',
      resumeDecision: { action: 'cancel' },
      resumedAt: new Date().toISOString(),
      resumedBy: resumedBy ?? 'unknown',
    };
    return this.writeState(next);
  }

  /** Mark as timed-out. Used by the sweeper. Idempotent on non-awaiting. */
  markTimedOut(runId: string): PauseState {
    const existing = this.get(runId);
    if (!existing) throw new Error(`pause not found: ${runId}`);
    if (existing.status !== 'paused-awaiting-user') return existing;
    const next: PauseState = {
      ...existing,
      status: 'timed-out',
      resumedAt: new Date().toISOString(),
      resumedBy: 'system',
    };
    return this.writeState(next);
  }

  /** Read a single record by runId, across all projects (via the index). */
  get(runId: string): PauseState | null {
    const pointer = this.findPointer(runId);
    if (!pointer) return null;
    return readJsonSync<PauseState>(this.pausePath(pointer.project, runId));
  }

  /** List hydrated records, optionally filtered. Newest-first. */
  list(filters: PauseQueryFilters = {}): PauseState[] {
    const pointers = this.readIndex();
    const results: PauseState[] = [];
    for (const pointer of pointers) {
      if (filters.project && pointer.project !== filters.project) continue;
      if (filters.status && pointer.status !== filters.status) continue;
      const state = readJsonSync<PauseState>(
        this.pausePath(pointer.project, pointer.runId),
      );
      if (!state) continue;
      if (filters.stage && state.stage !== filters.stage) continue;
      results.push(state);
    }
    return results;
  }
}

export { PipelinePauseStore };
