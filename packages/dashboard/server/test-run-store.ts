/**
 * TestRunStore — append-only history of TestRun executions.
 *
 * A TestRun is one execution of the TestCases belonging to a given TestSpec
 * version. Runs accumulate: we keep every run's results, coverage, mutation
 * score, and any findings raised during post-run analysis.
 *
 * Unlike TestSpecStore, runs are *not* versioned snapshots — each run is its
 * own immutable-ish artifact keyed by runId and written to:
 *
 *   ~/.anvil/tests/<project>/<slug>/runs/<runId>.json
 *
 * `appendFindings` and `setResolution` both mutate the run file (the review
 * store bumps a version on resolution change; we don't — the run's identity
 * is the execution, and run history is already append-only across files).
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
  TestFinding,
  TestResolution,
  TestRun,
} from './test-types.js';

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

function newRunId(): string {
  return `r-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function findingDedupKey(f: TestFinding): string {
  // Same shape as review-store: (category, primary-link, truncated description).
  const link = f.behaviorId ?? f.caseId ?? '';
  return `${f.category}:${link}:${(f.description ?? '').slice(0, 80)}`;
}

// ── TestRunStore ─────────────────────────────────────────────────────────

export class TestRunStore {
  private baseDir: string;

  constructor(anvilHome?: string) {
    const home = anvilHome ?? process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
    this.baseDir = join(home, 'tests');
    ensureDir(this.baseDir);
  }

  // ── Path helpers ──────────────────────────────────────────────────────

  private specDir(project: string, slug: string): string {
    return join(this.baseDir, project, slug);
  }

  private runsDir(project: string, slug: string): string {
    return join(this.specDir(project, slug), 'runs');
  }

  private runPath(project: string, slug: string, runId: string): string {
    return join(this.runsDir(project, slug), `${runId}.json`);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────

  /** Create a fresh run record in the `running` state. */
  createRun(
    project: string,
    slug: string,
    specVersion: number,
    trigger: TestRun['trigger'],
  ): TestRun {
    ensureDir(this.runsDir(project, slug));
    const now = new Date().toISOString();
    const run: TestRun = {
      id: newRunId(),
      specSlug: slug,
      specVersion,
      trigger,
      startedAt: now,
      status: 'running',
      results: [],
      flakyQuarantined: [],
      findings: [],
      verdict: 'warn',
    };
    atomicWriteFileSync(this.runPath(project, slug, run.id), JSON.stringify(run, null, 2));
    return run;
  }

  /**
   * Patch an existing run with partial updates. Identity fields (id,
   * specSlug, specVersion, startedAt, trigger) are preserved. Returns null
   * if the run does not exist.
   */
  updateRun(
    project: string,
    slug: string,
    runId: string,
    updates: Partial<TestRun>,
  ): TestRun | null {
    const current = this.readRun(project, slug, runId);
    if (!current) return null;

    const next: TestRun = {
      ...current,
      ...updates,
      id: current.id,
      specSlug: current.specSlug,
      specVersion: current.specVersion,
      trigger: current.trigger,
      startedAt: current.startedAt,
    };

    atomicWriteFileSync(this.runPath(project, slug, runId), JSON.stringify(next, null, 2));
    return next;
  }

  /** Read a run by id, or null if not found. */
  readRun(project: string, slug: string, runId: string): TestRun | null {
    return readJsonSync<TestRun>(this.runPath(project, slug, runId));
  }

  /**
   * List all runs for a spec, sorted newest-first by `startedAt`. Missing
   * or malformed run files are skipped silently.
   */
  listRuns(project: string, slug: string): TestRun[] {
    const dir = this.runsDir(project, slug);
    if (!existsSync(dir)) return [];
    const out: TestRun[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json') || entry.endsWith('.tmp')) continue;
      const run = readJsonSync<TestRun>(join(dir, entry));
      if (run) out.push(run);
    }
    out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return out;
  }

  /**
   * Append a batch of findings to a run, deduping by
   * (category, behaviorId || caseId, description.slice(0,80)) — identical
   * to review-store. Returns the updated run, or null if not found.
   */
  appendFindings(
    project: string,
    slug: string,
    runId: string,
    findings: TestFinding[],
  ): TestRun | null {
    const current = this.readRun(project, slug, runId);
    if (!current) return null;

    const existing = new Set(current.findings.map(findingDedupKey));
    const added: TestFinding[] = [];
    for (const f of findings) {
      const key = findingDedupKey(f);
      if (existing.has(key)) continue;
      existing.add(key);
      added.push(f);
    }
    if (!added.length) return current;

    const merged = [...current.findings, ...added];
    const next: TestRun = { ...current, findings: merged };
    atomicWriteFileSync(this.runPath(project, slug, runId), JSON.stringify(next, null, 2));
    return next;
  }

  /**
   * Update the resolution of a single finding on a run. Returns the updated
   * run, or null if the run or the finding does not exist.
   */
  setResolution(
    project: string,
    slug: string,
    runId: string,
    findingId: string,
    resolution: TestResolution,
  ): TestRun | null {
    const current = this.readRun(project, slug, runId);
    if (!current) return null;
    const idx = current.findings.findIndex((f) => f.id === findingId);
    if (idx === -1) return null;

    const updated = [...current.findings];
    updated[idx] = { ...updated[idx], resolution };
    const next: TestRun = { ...current, findings: updated };
    atomicWriteFileSync(this.runPath(project, slug, runId), JSON.stringify(next, null, 2));
    return next;
  }
}
