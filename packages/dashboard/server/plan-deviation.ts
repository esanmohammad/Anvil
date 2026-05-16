/**
 * plan-deviation — capture what the Build stage actually did vs what the
 * plan claimed. Written after a plan-seeded pipeline run completes Build.
 *
 * Storage: `~/.anvil/features/<project>/<slug>/plan-deviation.json` (one per run).
 * Aggregated into `~/.anvil/projects/<project>/plan-learnings.json` over time.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Plan } from './plan-store.js';
import { planRepoTouchedPaths } from '@esankhan3/anvil-core-pipeline';

// ── Types ────────────────────────────────────────────────────────────────

export interface ContractDelta {
  name: string;
  kind: string;
  note: string;
}

export interface RepoDeviation {
  repo: string;
  addedFiles: string[];          // built but not planned
  skippedFiles: string[];        // planned but not built
  matchedFiles: string[];        // both planned and built
}

export interface PlanDeviation {
  planProject: string;
  planSlug: string;
  planVersion: number;
  capturedAt: string;
  branch: string;
  baseBranch: string;
  repos: RepoDeviation[];
  summary: {
    totalPlannedFiles: number;
    totalActualFiles: number;
    matchRate: number;           // 0..1
  };
}

export interface PlanLearnings {
  project: string;
  updatedAt: string;
  runs: number;                  // how many deviations aggregated
  /** Pattern: when plan mentions X, engineers also touch Y (≥3 occurrences). */
  coChangePatterns: Array<{
    trigger: string;             // file path
    co: string;                  // file path that follows
    occurrences: number;
  }>;
  /** Estimate calibration: plan says $X, actual was $Y. */
  costBias: { samples: number; ratio: number };   // actual / planned
  /** Most-commonly-forgotten files, for "heads up" hints. */
  frequentlyForgotten: Array<{ file: string; repo: string; count: number }>;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function atomicWriteJson(path: string, data: unknown): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T; } catch { return null; }
}

/** `git diff --name-only <base>..HEAD` inside a repo path. */
function gitChangedFiles(repoPath: string, baseBranch: string): string[] {
  try {
    const out = execFileSync('git', [
      'diff', '--name-only', `${baseBranch}...HEAD`,
    ], { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function normalise(p: string): string {
  return p.replace(/^\.?\//, '').toLowerCase();
}

// ── Compute & persist deviation ─────────────────────────────────────────

export interface CaptureDeps {
  featureDir: string;                      // feature dir where to write deviation JSON
  repoLocalPaths: Record<string, string>;  // repo name → local filesystem path
  baseBranch: string;
  branch: string;
}

export function captureDeviation(plan: Plan, deps: CaptureDeps): PlanDeviation {
  const repos: RepoDeviation[] = [];

  for (const planRepo of plan.repos) {
    const repoPath = deps.repoLocalPaths[planRepo.name];
    if (!repoPath) continue;
    const actualFiles = gitChangedFiles(repoPath, deps.baseBranch).map(normalise);
    // Plan v2: collect mustTouch + mustExist paths.
    const plannedFiles = planRepoTouchedPaths(planRepo).map(normalise);
    const plannedSet = new Set(plannedFiles);
    const actualSet = new Set(actualFiles);

    repos.push({
      repo: planRepo.name,
      addedFiles: actualFiles.filter((f) => !plannedSet.has(f)),
      skippedFiles: plannedFiles.filter((f) => !actualSet.has(f)),
      matchedFiles: plannedFiles.filter((f) => actualSet.has(f)),
    });
  }

  const totalPlanned = repos.reduce((s, r) => s + r.matchedFiles.length + r.skippedFiles.length, 0);
  const totalActual  = repos.reduce((s, r) => s + r.matchedFiles.length + r.addedFiles.length, 0);
  const matched      = repos.reduce((s, r) => s + r.matchedFiles.length, 0);
  const matchRate    = totalPlanned ? matched / totalPlanned : 0;

  const deviation: PlanDeviation = {
    planProject: plan.project,
    planSlug: plan.slug,
    planVersion: plan.version,
    capturedAt: new Date().toISOString(),
    branch: deps.branch,
    baseBranch: deps.baseBranch,
    repos,
    summary: {
      totalPlannedFiles: totalPlanned,
      totalActualFiles: totalActual,
      matchRate,
    },
  };

  atomicWriteJson(join(deps.featureDir, 'plan-deviation.json'), deviation);
  return deviation;
}

// ── Aggregate learnings ─────────────────────────────────────────────────

const MIN_SUPPORT = 3;

export function updateLearnings(
  anvilHome: string,
  project: string,
  deviation: PlanDeviation,
  actualCost?: number,
  plannedCost?: number,
): PlanLearnings {
  const path = join(anvilHome, 'projects', project, 'plan-learnings.json');
  const prev = readJson<PlanLearnings>(path);

  // Running raw counters — full aggregation lives in a shadow file to stay lean.
  const rawPath = join(anvilHome, 'projects', project, 'plan-learnings-raw.json');
  interface Raw {
    coChange: Record<string, Record<string, number>>;
    forgotten: Record<string, Record<string, number>>;  // repo → file → count
    costSamples: Array<{ planned: number; actual: number }>;
    runs: number;
  }
  const raw: Raw = readJson<Raw>(rawPath) ?? {
    coChange: {}, forgotten: {}, costSamples: [], runs: 0,
  };

  raw.runs += 1;

  // Co-change patterns: within each repo, for every pair (planned file, added file)
  // increment count in coChange[planned][added].
  for (const r of deviation.repos) {
    for (const trigger of r.matchedFiles) {
      for (const co of r.addedFiles) {
        const key = `${r.repo}:${trigger}`;
        const target = `${r.repo}:${co}`;
        (raw.coChange[key] ??= {})[target] = ((raw.coChange[key] ??= {})[target] ?? 0) + 1;
      }
    }
    // Frequently forgotten
    for (const f of r.skippedFiles) {
      (raw.forgotten[r.repo] ??= {})[f] = ((raw.forgotten[r.repo] ??= {})[f] ?? 0) + 1;
    }
  }

  if (plannedCost && plannedCost > 0 && actualCost && actualCost > 0) {
    raw.costSamples.push({ planned: plannedCost, actual: actualCost });
    if (raw.costSamples.length > 100) raw.costSamples.splice(0, raw.costSamples.length - 100);
  }

  atomicWriteJson(rawPath, raw);

  // Distill raw into supported learnings.
  const coChangePatterns: PlanLearnings['coChangePatterns'] = [];
  for (const [trigger, cos] of Object.entries(raw.coChange)) {
    for (const [co, n] of Object.entries(cos)) {
      if (n >= MIN_SUPPORT) coChangePatterns.push({ trigger, co, occurrences: n });
    }
  }
  coChangePatterns.sort((a, b) => b.occurrences - a.occurrences);

  const frequentlyForgotten: PlanLearnings['frequentlyForgotten'] = [];
  for (const [repo, files] of Object.entries(raw.forgotten)) {
    for (const [file, count] of Object.entries(files)) {
      if (count >= MIN_SUPPORT) frequentlyForgotten.push({ repo, file, count });
    }
  }
  frequentlyForgotten.sort((a, b) => b.count - a.count);

  const avgRatio = raw.costSamples.length
    ? raw.costSamples.reduce((s, x) => s + (x.actual / x.planned), 0) / raw.costSamples.length
    : 1;

  const learnings: PlanLearnings = {
    project,
    updatedAt: new Date().toISOString(),
    runs: raw.runs,
    coChangePatterns: coChangePatterns.slice(0, 100),
    costBias: { samples: raw.costSamples.length, ratio: Number(avgRatio.toFixed(3)) },
    frequentlyForgotten: frequentlyForgotten.slice(0, 50),
  };

  atomicWriteJson(path, learnings);

  // Suppress unused-var complaint; `prev` is reserved for future merge strategies.
  void prev;

  return learnings;
}

export function loadLearnings(anvilHome: string, project: string): PlanLearnings | null {
  return readJson<PlanLearnings>(join(anvilHome, 'projects', project, 'plan-learnings.json'));
}
