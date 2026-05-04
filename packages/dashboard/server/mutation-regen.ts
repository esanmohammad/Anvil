/**
 * mutation-regen — Phase 3 mutation-targeted test regeneration.
 *
 * After a Stryker mutation run, some mutants survive (or are never covered)
 * because the existing tests don't exercise that branch/boundary. This module
 * walks the Stryker JSON report, picks out the survivors, and produces new
 * `Behavior` entries whose sole job is to kill those mutants. A companion
 * helper bumps the `TestSpec` to include the new behaviors and emits the
 * deterministic test-case scaffolds via `test-code-emitter`.
 *
 * No LLM in this module — everything here is deterministic and side-effect
 * free except for the explicit `applyRegenToSpec` which writes through the
 * injected stores.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { emitTestCase } from './test-code-emitter.js';
import type { TestSpecStore } from './test-spec-store.js';
import type { TestCaseStore } from './test-case-store.js';
import type {
  Behavior,
  ConventionFingerprint,
  TestCase,
  TestSpec,
} from './test-types.js';

// ── Public types ─────────────────────────────────────────────────────────

export interface SurvivingMutant {
  id: string;
  file: string;
  line: number;
  column?: number;
  mutator: string;
  original: string;
  mutated: string;
  status: 'Survived' | 'NoCoverage';
}

export interface RegenOptions {
  repoLocalPath: string;
  reportJsonPath: string;
  scoreThreshold?: number;
  maxNewBehaviors?: number;
  conventions: ConventionFingerprint;
}

export interface RegenResult {
  mutants: SurvivingMutant[];
  newBehaviors: Behavior[];
  summary: {
    targetedFiles: string[];
    mutantsByFile: Record<string, number>;
    mutantsByMutator: Record<string, number>;
  };
}

export interface ApplyRegenOptions {
  specStore: TestSpecStore;
  caseStore: TestCaseStore;
  project: string;
  specSlug: string;
  newBehaviors: Behavior[];
  conventions: ConventionFingerprint;
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_SCORE_THRESHOLD = 0.75;
const DEFAULT_MAX_NEW_BEHAVIORS = 20;

/**
 * Mutators whose survival almost always indicates a real hole in branch or
 * boundary coverage — worth bumping to `critical`. Compared against Stryker's
 * `mutatorName` field (case-insensitive).
 */
const CRITICAL_MUTATORS: ReadonlySet<string> = new Set([
  'conditionalexpression',
  'booleanliteral',
  'equalityoperator',
  'logicaloperator',
  'conditionalboundary',
]);

// ── Stryker JSON shapes ──────────────────────────────────────────────────
// Deliberately narrow — we only read what we need. Everything is optional so
// a malformed/partial report can't crash us. This is the sole place we allow
// inline loose typing against the Stryker file format.

interface StrykerLocationPoint {
  line?: number;
  column?: number;
}

interface StrykerLocation {
  start?: StrykerLocationPoint;
  end?: StrykerLocationPoint;
}

interface StrykerMutantRaw {
  id?: string | number;
  mutatorName?: string;
  mutator?: { name?: string };
  status?: string;
  location?: StrykerLocation;
  replacement?: string;
  originalLines?: string;
  mutatedLines?: string;
}

interface StrykerFileReportRaw {
  mutants?: StrykerMutantRaw[];
  source?: string;
}

interface StrykerJsonReportRaw {
  files?: Record<string, StrykerFileReportRaw>;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function lowerMutator(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function priorityForMutator(mutatorName: string): 'critical' | 'normal' {
  return CRITICAL_MUTATORS.has(lowerMutator(mutatorName)) ? 'critical' : 'normal';
}

function readFileLine(absPath: string, line: number): string | null {
  try {
    const raw = readFileSync(absPath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    if (line >= 1 && line <= lines.length) {
      return lines[line - 1];
    }
    return null;
  } catch {
    return null;
  }
}

function extractOriginalLine(
  repoLocalPath: string,
  relFile: string,
  line: number,
  sourceFromReport: string | undefined,
): string {
  // Prefer the embedded source in the report (Stryker sometimes inlines it).
  if (sourceFromReport) {
    const lines = sourceFromReport.split(/\r?\n/);
    if (line >= 1 && line <= lines.length) {
      return lines[line - 1].trim();
    }
  }
  const abs = join(repoLocalPath, relFile);
  const fromDisk = readFileLine(abs, line);
  return (fromDisk ?? '').trim();
}

/**
 * Walk upward from `line` inside the given file and return the nearest
 * declaration-like symbol name. Best-effort — if nothing looks like a symbol,
 * fall back to `line${N}`.
 */
function findEnclosingSymbol(
  repoLocalPath: string,
  relFile: string,
  line: number,
  sourceFromReport: string | undefined,
): string {
  let raw: string | null = sourceFromReport ?? null;
  if (!raw) {
    const abs = join(repoLocalPath, relFile);
    if (existsSync(abs)) {
      try {
        raw = readFileSync(abs, 'utf-8');
      } catch {
        raw = null;
      }
    }
  }

  if (raw) {
    const lines = raw.split(/\r?\n/);
    const start = Math.min(Math.max(line, 1), lines.length) - 1;
    // A short list of declaration patterns across the languages Stryker can
    // plausibly report on (even though Stryker itself is JS/TS-first, the
    // regex costs us nothing and makes the helper reusable).
    const patterns: RegExp[] = [
      /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
      /\b(?:export\s+)?(?:async\s+)?function\*\s+([A-Za-z_$][\w$]*)/,
      /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
      /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
      /\b(?:public|private|protected|static|async|\s)*\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
      /\bdef\s+([A-Za-z_][\w]*)\s*\(/,
      /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/,
    ];
    for (let i = start; i >= 0; i--) {
      const text = lines[i];
      for (const re of patterns) {
        const m = text.match(re);
        if (m && m[1]) return m[1];
      }
    }
  }
  return `line${line}`;
}

function normalizeStatus(raw: string | undefined): 'Survived' | 'NoCoverage' | null {
  if (raw === 'Survived') return 'Survived';
  if (raw === 'NoCoverage') return 'NoCoverage';
  return null;
}

function mutatorNameOf(m: StrykerMutantRaw): string {
  if (typeof m.mutatorName === 'string' && m.mutatorName.length > 0) return m.mutatorName;
  if (m.mutator && typeof m.mutator.name === 'string' && m.mutator.name.length > 0) {
    return m.mutator.name;
  }
  return 'UnknownMutator';
}

function mutantIdOf(m: StrykerMutantRaw, fallback: string): string {
  if (typeof m.id === 'string' && m.id.length > 0) return m.id;
  if (typeof m.id === 'number' && Number.isFinite(m.id)) return String(m.id);
  return fallback;
}

function mutatedTextOf(m: StrykerMutantRaw): string {
  if (typeof m.replacement === 'string' && m.replacement.length > 0) return m.replacement;
  if (typeof m.mutatedLines === 'string' && m.mutatedLines.length > 0) {
    return m.mutatedLines.trim();
  }
  return '(no replacement captured)';
}

// ── parseStrykerReport ───────────────────────────────────────────────────

export function parseStrykerReport(reportJsonPath: string): SurvivingMutant[] {
  let raw: string;
  try {
    raw = readFileSync(reportJsonPath, 'utf-8');
  } catch {
    return [];
  }
  let parsed: StrykerJsonReportRaw;
  try {
    parsed = JSON.parse(raw) as StrykerJsonReportRaw;
  } catch {
    return [];
  }

  const files = parsed.files ?? {};
  const repoRoot = findRepoRootFromReport(reportJsonPath);

  const out: SurvivingMutant[] = [];
  for (const [rawPath, fileReport] of Object.entries(files)) {
    if (!fileReport || !Array.isArray(fileReport.mutants)) continue;
    const file = normalizePath(rawPath);
    for (const m of fileReport.mutants) {
      const status = normalizeStatus(m?.status);
      if (!status) continue;

      const line = m.location?.start?.line;
      if (typeof line !== 'number' || !Number.isFinite(line) || line <= 0) continue;
      const column = m.location?.start?.column;
      const mutator = mutatorNameOf(m);
      const id = mutantIdOf(m, `${file}:${line}:${mutator}:${out.length}`);

      const original = extractOriginalLine(repoRoot, file, line, fileReport.source);
      const mutated = mutatedTextOf(m);

      const mutant: SurvivingMutant = {
        id,
        file,
        line,
        mutator,
        original,
        mutated,
        status,
      };
      if (typeof column === 'number' && Number.isFinite(column)) mutant.column = column;

      out.push(mutant);
    }
  }
  return out;
}

/**
 * Stryker reports are usually written to `<repo>/reports/mutation/mutation.json`.
 * When we only have the report path, peel off the trailing `reports/...` segment
 * so we can read the real source files next to it.
 */
function findRepoRootFromReport(reportPath: string): string {
  const normalized = normalizePath(reportPath);
  const idx = normalized.lastIndexOf('/reports/');
  if (idx > 0) return normalized.slice(0, idx);
  // Fallback: parent directory of the report.
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash > 0 ? normalized.slice(0, lastSlash) : '.';
}

// ── identifyTargetFiles ──────────────────────────────────────────────────

export function identifyTargetFiles(
  report: SurvivingMutant[],
  byFileScores: Record<string, number>,
  threshold: number,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of report) {
    const file = m.file;
    if (seen.has(file)) continue;
    const score = byFileScores[file];
    const targeted = typeof score !== 'number' || score < threshold;
    if (targeted) {
      seen.add(file);
      out.push(file);
    }
  }
  return out;
}

// ── generateRegenBehaviors ───────────────────────────────────────────────

export function generateRegenBehaviors(
  mutants: SurvivingMutant[],
  _conventions: ConventionFingerprint,
  opts: { maxNewBehaviors?: number; repoLocalPath?: string } = {},
): Behavior[] {
  const cap = typeof opts.maxNewBehaviors === 'number' && opts.maxNewBehaviors >= 0
    ? opts.maxNewBehaviors
    : DEFAULT_MAX_NEW_BEHAVIORS;

  // Sort: critical-priority mutants first, then by file (stable alphabetical),
  // then by line. This gives deterministic output for equal-priority mutants.
  const ranked = mutants.slice().sort((a, b) => {
    const pa = priorityForMutator(a.mutator);
    const pb = priorityForMutator(b.mutator);
    if (pa !== pb) return pa === 'critical' ? -1 : 1;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    return a.id.localeCompare(b.id);
  });

  const limited = ranked.slice(0, cap);
  const epoch = Date.now().toString(36);
  const repoRoot = opts.repoLocalPath ?? '';

  return limited.map((mutant, i) => {
    const priority = priorityForMutator(mutant.mutator);
    const symbol = repoRoot
      ? findEnclosingSymbol(repoRoot, mutant.file, mutant.line, undefined)
      : `line${mutant.line}`;
    const intent =
      `Kill ${mutant.mutator} mutant at ${mutant.file}:${mutant.line} ` +
      `(${mutant.original} → ${mutant.mutated})`;

    const behavior: Behavior = {
      id: `b-regen-${epoch}-${i}`,
      kind: 'regression',
      intent,
      target: { file: mutant.file, symbol },
      preconditions: [],
      inputs: { description: `Input that reaches line ${mutant.line}` },
      expected: {
        description:
          `Assertion that distinguishes original '${mutant.original}' ` +
          `from mutated '${mutant.mutated}'`,
        assertion: 'behavioral distinction between original and mutated outputs',
      },
      priority,
      ground: {
        files: [mutant.file],
        typesSeen: [],
        confidence: 0.8,
      },
      mutationTargets: [mutant.id],
    };
    return behavior;
  });
}

// ── runMutationRegen ─────────────────────────────────────────────────────

/**
 * Reconstruct per-file mutation scores straight from the Stryker JSON — same
 * formula as `mutation-runner.ts`:
 *   score = killed / (killed + survived + timeout)
 * NoCoverage/Ignored/CompileError/RuntimeError/Pending are excluded from both
 * numerator and denominator. Files with zero valid mutants are omitted so the
 * caller treats them as "unknown" (→ targeted).
 */
function byFileScoresFromReport(reportJsonPath: string): Record<string, number> {
  let raw: string;
  try {
    raw = readFileSync(reportJsonPath, 'utf-8');
  } catch {
    return {};
  }
  let parsed: StrykerJsonReportRaw;
  try {
    parsed = JSON.parse(raw) as StrykerJsonReportRaw;
  } catch {
    return {};
  }

  const out: Record<string, number> = {};
  const files = parsed.files ?? {};
  for (const [rawPath, fileReport] of Object.entries(files)) {
    const mutants = fileReport?.mutants ?? [];
    let k = 0;
    let s = 0;
    let t = 0;
    for (const m of mutants) {
      switch (m?.status) {
        case 'Killed':
          k++;
          break;
        case 'Survived':
          s++;
          break;
        case 'Timeout':
          t++;
          break;
        default:
          break;
      }
    }
    const denom = k + s + t;
    if (denom > 0) {
      out[normalizePath(rawPath)] = k / denom;
    }
  }
  return out;
}

export async function runMutationRegen(opts: RegenOptions): Promise<RegenResult> {
  const threshold = typeof opts.scoreThreshold === 'number'
    ? opts.scoreThreshold
    : DEFAULT_SCORE_THRESHOLD;
  const maxNewBehaviors = typeof opts.maxNewBehaviors === 'number'
    ? opts.maxNewBehaviors
    : DEFAULT_MAX_NEW_BEHAVIORS;

  const allMutants = parseStrykerReport(opts.reportJsonPath);
  const byFileScores = byFileScoresFromReport(opts.reportJsonPath);
  const targetedFiles = identifyTargetFiles(allMutants, byFileScores, threshold);
  const targetedSet = new Set(targetedFiles);

  const targetedMutants = allMutants.filter((m) => targetedSet.has(m.file));

  // Resolve enclosing symbols against the real source tree now that we know
  // which file each mutant belongs to.
  const newBehaviors = generateRegenBehaviors(targetedMutants, opts.conventions, {
    maxNewBehaviors,
    repoLocalPath: opts.repoLocalPath,
  });

  const mutantsByFile: Record<string, number> = {};
  const mutantsByMutator: Record<string, number> = {};
  for (const m of targetedMutants) {
    mutantsByFile[m.file] = (mutantsByFile[m.file] ?? 0) + 1;
    mutantsByMutator[m.mutator] = (mutantsByMutator[m.mutator] ?? 0) + 1;
  }

  return {
    mutants: targetedMutants,
    newBehaviors,
    summary: {
      targetedFiles,
      mutantsByFile,
      mutantsByMutator,
    },
  };
}

// ── applyRegenToSpec ─────────────────────────────────────────────────────

export function applyRegenToSpec(
  opts: ApplyRegenOptions,
): { spec: TestSpec; cases: TestCase[] } {
  const { specStore, caseStore, project, specSlug, newBehaviors, conventions } = opts;

  const current = specStore.readCurrent(project, specSlug);
  if (!current) {
    throw new Error(`TestSpec not found: ${project}/${specSlug}`);
  }

  const existingCases = caseStore.readCases(project, specSlug, current.version);

  const nextSpec = specStore.bumpVersion(project, specSlug, {
    behaviors: [...current.behaviors, ...newBehaviors],
  });

  const newCases: TestCase[] = newBehaviors.map((b) =>
    emitTestCase(b, conventions, {
      specSlug: nextSpec.slug,
      specVersion: nextSpec.version,
      projectSlug: nextSpec.project,
    }),
  );

  const allCases = [...existingCases, ...newCases];
  caseStore.writeCases(project, specSlug, nextSpec.version, allCases);

  return { spec: nextSpec, cases: allCases };
}
