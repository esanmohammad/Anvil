/**
 * coverage-sla — per-project Service Level Agreement gate for TestRun coverage.
 *
 * Compares a TestRun's coverage metrics (lines / branches / statements) against
 * a configured per-project SLA and, optionally, against the previous run to
 * catch slow erosion. Used by the CI pipeline to fail a build when coverage
 * drops below an agreed floor, or drops too fast between runs.
 *
 * Storage layout:
 *   ${anvilHome}/tests/<project>/sla.json
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { TestRun } from './test-types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface CoverageSLA {
  minLines?: number; // 0..1, e.g. 0.8
  minBranches?: number;
  minStatements?: number;
  /** Max allowed drop vs previous run (in percentage points). */
  maxDrop?: number; // e.g. 0.02 = 2pp
}

export interface SLAReport {
  pass: boolean;
  violations: string[];
  current?: { lines: number; branches: number; statements: number };
  previous?: { lines: number; branches: number; statements: number };
  delta?: { lines: number; branches: number; statements: number };
}

// ── Internal helpers ─────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function atomicWriteFileSync(filePath: string, data: string): void {
  ensureDir(dirname(filePath));
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

function slaPath(anvilHome: string, project: string): string {
  return join(anvilHome, 'tests', project, 'sla.json');
}

function isFiniteNumberInUnit(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function pp(x: number): string {
  return `${(x * 100).toFixed(1)}pp`;
}

function validateSLAShape(raw: unknown): CoverageSLA | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const out: CoverageSLA = {};
  for (const key of ['minLines', 'minBranches', 'minStatements', 'maxDrop'] as const) {
    const v = obj[key];
    if (v === undefined) continue;
    if (!isFiniteNumberInUnit(v)) return null;
    out[key] = v;
  }
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────

/** Read the SLA for a project. Returns null if missing or malformed. */
export function readProjectSLA(anvilHome: string, project: string): CoverageSLA | null {
  const p = slaPath(anvilHome, project);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    return validateSLAShape(raw);
  } catch {
    return null;
  }
}

/** Atomically write the SLA for a project. Ensures parent directory exists. */
export function writeProjectSLA(anvilHome: string, project: string, sla: CoverageSLA): void {
  atomicWriteFileSync(slaPath(anvilHome, project), JSON.stringify(sla, null, 2));
}

/**
 * Compare a TestRun's coverage against the SLA and return a pass/fail report.
 *
 * Edge cases:
 *   - No coverage in the run → pass but emit a warning in `violations`.
 *   - Missing previous run OR previous run without coverage → skip the drop check.
 */
export function checkCoverageSLA(
  run: TestRun,
  previous: TestRun | null,
  sla: CoverageSLA,
): SLAReport {
  if (!run.coverage) {
    return {
      pass: true,
      violations: ['No coverage data in run — SLA skipped.'],
    };
  }

  const current = {
    lines: run.coverage.lines,
    branches: run.coverage.branches,
    statements: run.coverage.statements,
  };

  const violations: string[] = [];

  if (sla.minLines !== undefined && current.lines < sla.minLines) {
    violations.push(`lines coverage ${pct(current.lines)} below SLA ${pct(sla.minLines)}`);
  }
  if (sla.minBranches !== undefined && current.branches < sla.minBranches) {
    violations.push(`branches coverage ${pct(current.branches)} below SLA ${pct(sla.minBranches)}`);
  }
  if (sla.minStatements !== undefined && current.statements < sla.minStatements) {
    violations.push(
      `statements coverage ${pct(current.statements)} below SLA ${pct(sla.minStatements)}`,
    );
  }

  const report: SLAReport = {
    pass: false,
    violations,
    current,
  };

  if (previous && previous.coverage) {
    const prev = {
      lines: previous.coverage.lines,
      branches: previous.coverage.branches,
      statements: previous.coverage.statements,
    };
    const delta = {
      lines: current.lines - prev.lines,
      branches: current.branches - prev.branches,
      statements: current.statements - prev.statements,
    };
    report.previous = prev;
    report.delta = delta;

    if (sla.maxDrop !== undefined) {
      const maxDrop = sla.maxDrop;
      const dropLines = prev.lines - current.lines;
      const dropBranches = prev.branches - current.branches;
      const dropStatements = prev.statements - current.statements;
      if (dropLines > maxDrop) {
        violations.push(
          `lines coverage dropped ${pp(dropLines)} (max allowed ${pp(maxDrop)})`,
        );
      }
      if (dropBranches > maxDrop) {
        violations.push(
          `branches coverage dropped ${pp(dropBranches)} (max allowed ${pp(maxDrop)})`,
        );
      }
      if (dropStatements > maxDrop) {
        violations.push(
          `statements coverage dropped ${pp(dropStatements)} (max allowed ${pp(maxDrop)})`,
        );
      }
    }
  }

  report.pass = violations.length === 0;
  return report;
}
