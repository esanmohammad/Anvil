/**
 * Plan risk scorer — Phase 1 of the confidence-gated pipeline.
 *
 * Pure, side-effect-free scoring over a Plan. Given a plan (and optionally
 * external file-size hints), produces a RiskScore with per-factor weights and
 * an aggregated `overall` score + tier.
 *
 * Aggregation rationale:
 *   A naive weighted average lets many low-signal factors mask a single
 *   critical one (e.g., `auth/` touched). Instead we take the MAX factor
 *   weight and nudge it up by +10% for every *additional* factor >0.5, capped
 *   at 1. This preserves the "one critical factor is enough" property while
 *   still making accumulations of risk visible.
 */

import type { Plan } from '@esankhan3/anvil-core-pipeline';
import {
  SCORER_VERSION,
  SENSITIVE_PATH_PATTERNS,
  type RiskFactor,
  type RiskScore,
  type RiskTier,
} from '@esankhan3/anvil-core-pipeline';

// ── Optional plan fields ─────────────────────────────────────────────────
//
// The canonical Plan type does not yet carry these fields; the planner will
// emit them in a later integration step. We read them via a narrow helper
// type so we never widen `Plan` itself from this module.

interface OptionalPlanFields {
  touchedFiles?: unknown;        // string[] expected
  confidence?: unknown;          // number in [0,1] expected
  scopeBoundaryRisks?: unknown;  // string[] expected
  estimatedLoc?: unknown;        // number expected
}

// ── Helpers (pure) ───────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function readOptional(plan: Plan): OptionalPlanFields {
  // Plan is a structural object; accessing unknown fields is safe at runtime.
  return plan as unknown as OptionalPlanFields;
}

/** Union of all files touched, dedup'd. Falls back to plan.repos[].files. */
function collectTouchedFiles(plan: Plan): string[] {
  const opt = readOptional(plan);
  const fromOpt = isStringArray(opt.touchedFiles) ? opt.touchedFiles : [];
  const fromRepos: string[] = [];
  for (const r of plan.repos ?? []) {
    for (const f of r.files ?? []) {
      if (typeof f === 'string') fromRepos.push(f);
    }
  }
  return Array.from(new Set([...fromOpt, ...fromRepos]));
}

function readConfidence(plan: Plan): number {
  const opt = readOptional(plan);
  if (typeof opt.confidence === 'number' && Number.isFinite(opt.confidence)) {
    return clamp(opt.confidence, 0, 1);
  }
  return 0.5; // default when the planner hasn't reported confidence yet
}

function readScopeBoundaryRisks(plan: Plan): string[] {
  const opt = readOptional(plan);
  return isStringArray(opt.scopeBoundaryRisks) ? opt.scopeBoundaryRisks : [];
}

function readEstimatedLoc(
  plan: Plan,
  fileCounts?: Record<string, number>,
): number {
  const opt = readOptional(plan);
  if (typeof opt.estimatedLoc === 'number' && Number.isFinite(opt.estimatedLoc)) {
    return Math.max(0, opt.estimatedLoc);
  }
  // Fall back to a sum of caller-supplied per-file LOC if available.
  if (fileCounts) {
    let total = 0;
    for (const v of Object.values(fileCounts)) {
      if (typeof v === 'number' && Number.isFinite(v)) total += Math.max(0, v);
    }
    if (total > 0) return total;
  }
  return 0;
}

/** Count unique top-level directories across touched files. */
function countTopLevelDirs(files: string[]): number {
  const dirs = new Set<string>();
  for (const f of files) {
    if (!f) continue;
    const normalized = f.replace(/^\.?\/+/, '');
    const first = normalized.split('/')[0] ?? '';
    if (first) dirs.add(first);
  }
  return dirs.size;
}

// ── Individual factor computations (each returns 0..1) ───────────────────

/** Smooth curve: ~0.3 at 5 files, ~0.6 at 15, ~0.9 at 40+. */
function fileCountWeight(n: number): number {
  if (n <= 0) return 0;
  // log10(n+1)/2 gives 0.39 at 5, 0.60 at 15, 0.82 at 40, 1.0 at 100.
  return clamp(Math.log10(n + 1) / 2, 0, 1);
}

/** LOC delta: 0.2 at 100, 0.5 at 500, 0.9 at 2000+. Piecewise linear. */
function locDeltaWeight(loc: number): number {
  if (loc <= 0) return 0;
  if (loc <= 100) return clamp((loc / 100) * 0.2, 0, 0.2);
  if (loc <= 500) return clamp(0.2 + ((loc - 100) / 400) * 0.3, 0, 0.5);
  if (loc <= 2000) return clamp(0.5 + ((loc - 500) / 1500) * 0.4, 0, 0.9);
  return 0.9;
}

interface SensitiveMatch {
  label: string;
  weight: number;
  file: string;
}

function scanSensitivePaths(files: string[]): SensitiveMatch[] {
  const matches: SensitiveMatch[] = [];
  for (const f of files) {
    for (const entry of SENSITIVE_PATH_PATTERNS) {
      if (entry.pattern.test(f)) {
        matches.push({ label: entry.label, weight: entry.weight, file: f });
      }
    }
  }
  return matches;
}

/** Cross-package: 0.3 at 2, 0.6 at 3+, 0.9 at 5+. */
function crossPackageWeight(numPackages: number): number {
  if (numPackages <= 1) return 0;
  if (numPackages === 2) return 0.3;
  if (numPackages < 5) return 0.6;
  return 0.9;
}

/** Detect a "new dependency" signal by manifest file touches. */
function touchesDependencyManifest(files: string[]): string | null {
  for (const f of files) {
    const name = f.split('/').pop() ?? '';
    if (name === 'package.json') return f;
    if (name === 'pyproject.toml' || name === 'requirements.txt') return f;
    if (name === 'go.mod' || name === 'go.sum') return f;
    if (name === 'Cargo.toml') return f;
    if (name === 'Gemfile' || name === 'Gemfile.lock') return f;
  }
  return null;
}

// ── Aggregation ──────────────────────────────────────────────────────────

/**
 * weighted_max: start from max factor weight; nudge up +10% per additional
 * factor >0.5. Keeps a single critical factor from being averaged away while
 * still reflecting stacked risk.
 */
function aggregate(factors: RiskFactor[]): number {
  if (factors.length === 0) return 0;
  const weights = factors.map((f) => f.weight);
  const maxW = Math.max(...weights);
  const highCount = factors.filter((f) => f.weight > 0.5).length;
  const additionalHigh = Math.max(0, highCount - 1);
  const boosted = maxW * (1 + 0.1 * additionalHigh);
  return clamp(boosted, 0, 1);
}

export function computeRiskTier(overall: number): RiskTier {
  if (overall < 0.3) return 'low';
  if (overall < 0.65) return 'med';
  return 'high';
}

// ── Public API ───────────────────────────────────────────────────────────

export interface ScorePlanOpts {
  kbManager?: unknown;                 // reserved for future KB-aware lookups
  fileCounts?: Record<string, number>; // optional per-file LOC hints
}

export function scorePlan(plan: Plan, opts?: ScorePlanOpts): RiskScore {
  const touched = collectTouchedFiles(plan);
  const confidence = readConfidence(plan);
  const scopeBoundaryRisks = readScopeBoundaryRisks(plan);
  const loc = readEstimatedLoc(plan, opts?.fileCounts);

  const factors: RiskFactor[] = [];

  // file-count
  {
    const w = fileCountWeight(touched.length);
    if (w > 0) {
      factors.push({
        key: 'file-count',
        label: 'File count',
        weight: w,
        detail: `${touched.length} file(s) touched`,
      });
    }
  }

  // loc-delta
  {
    const w = locDeltaWeight(loc);
    if (w > 0) {
      factors.push({
        key: 'loc-delta',
        label: 'LOC delta',
        weight: w,
        detail: `~${loc} LOC estimated`,
      });
    }
  }

  // sensitive-paths (max weight of any matched pattern)
  const sensitiveMatches = scanSensitivePaths(touched);
  if (sensitiveMatches.length > 0) {
    const top = sensitiveMatches.reduce((a, b) => (b.weight > a.weight ? b : a));
    const uniqueLabels = Array.from(new Set(sensitiveMatches.map((m) => m.label)));
    factors.push({
      key: 'sensitive-paths',
      label: 'Sensitive paths',
      weight: top.weight,
      detail: `matched: ${uniqueLabels.join(', ')}`,
    });
  }

  // touches-contracts (fixed weight if any "api contracts" match)
  const contractMatch = sensitiveMatches.find((m) => m.label === 'api contracts');
  if (contractMatch) {
    factors.push({
      key: 'touches-contracts',
      label: 'Touches API contracts',
      weight: 0.7,
      detail: `e.g. ${contractMatch.file}`,
    });
  }

  // new-dependency
  const depManifest = touchesDependencyManifest(touched);
  if (depManifest) {
    factors.push({
      key: 'new-dependency',
      label: 'Dependency manifest changed',
      weight: 0.6,
      detail: `touches ${depManifest}`,
    });
  }

  // cross-package
  {
    const pkgs = countTopLevelDirs(touched);
    const w = crossPackageWeight(pkgs);
    if (w > 0) {
      factors.push({
        key: 'cross-package',
        label: 'Cross-package blast radius',
        weight: w,
        detail: `${pkgs} top-level dirs`,
      });
    }
  }

  // confidence-inverse: lower self-reported confidence => higher risk
  {
    const w = (1 - confidence) * 0.5;
    if (w > 0) {
      factors.push({
        key: 'confidence-inverse',
        label: 'Low planner confidence',
        weight: clamp(w, 0, 1),
        detail: `confidence=${confidence.toFixed(2)}`,
      });
    }
  }

  // Sort desc by weight, drop trivial contributors.
  factors.sort((a, b) => b.weight - a.weight);
  const kept = factors.filter((f) => f.weight > 0.1);

  const overall = aggregate(kept);
  const tier = computeRiskTier(overall);

  return {
    overall,
    tier,
    factors: kept,
    confidence,
    scopeBoundaryRisks,
    computedAt: new Date().toISOString(),
    scorerVersion: SCORER_VERSION,
  };
}
