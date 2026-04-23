/**
 * TestCaseStore — persistence for TestCase arrays, keyed by TestSpec version.
 *
 * Test cases are the concrete code realisation of behaviors described in a
 * TestSpec. Each spec version owns exactly one `cases-v{N}.json` file
 * containing the TestCase[] generated against that spec snapshot. When the
 * spec is bumped, a new cases file is written alongside it — older versions
 * remain accessible for audit and regression replay.
 *
 * Storage layout (owned by this store):
 *   ~/.anvil/tests/<project>/<slug>/cases-v{N}.json
 *
 * The TestSpecStore is the source of truth for the slug/version identity.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { TestCase } from './test-types.js';

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

// ── TestCaseStore ────────────────────────────────────────────────────────

export class TestCaseStore {
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

  private casesPath(project: string, slug: string, specVersion: number): string {
    return join(this.specDir(project, slug), `cases-v${specVersion}.json`);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────

  /**
   * Write (overwrite) the full set of cases for a given spec version. This
   * is intentionally destructive — cases are derived from the spec snapshot,
   * so a rewrite mirrors a regeneration pass. Use `updateCase` for in-place
   * edits to a single case.
   */
  writeCases(project: string, slug: string, specVersion: number, cases: TestCase[]): void {
    ensureDir(this.specDir(project, slug));
    atomicWriteFileSync(
      this.casesPath(project, slug, specVersion),
      JSON.stringify(cases, null, 2),
    );
  }

  /** Read all cases for a given spec version (or empty array if none). */
  readCases(project: string, slug: string, specVersion: number): TestCase[] {
    return readJsonSync<TestCase[]>(this.casesPath(project, slug, specVersion)) ?? [];
  }

  /** Read a single case by id, or null if not found. */
  readCase(
    project: string,
    slug: string,
    specVersion: number,
    caseId: string,
  ): TestCase | null {
    const cases = this.readCases(project, slug, specVersion);
    return cases.find((c) => c.id === caseId) ?? null;
  }

  /**
   * Update a single case in-place. Returns the updated case, or null if no
   * case with that id exists. Identity fields (id, behaviorId, specSlug,
   * specVersion, createdAt) are preserved.
   */
  updateCase(
    project: string,
    slug: string,
    specVersion: number,
    caseId: string,
    updates: Partial<TestCase>,
  ): TestCase | null {
    const cases = this.readCases(project, slug, specVersion);
    const idx = cases.findIndex((c) => c.id === caseId);
    if (idx === -1) return null;

    const prev = cases[idx];
    const next: TestCase = {
      ...prev,
      ...updates,
      id: prev.id,
      behaviorId: prev.behaviorId,
      specSlug: prev.specSlug,
      specVersion: prev.specVersion,
      createdAt: prev.createdAt,
    };
    cases[idx] = next;

    atomicWriteFileSync(
      this.casesPath(project, slug, specVersion),
      JSON.stringify(cases, null, 2),
    );
    return next;
  }
}
