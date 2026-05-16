/**
 * PlanValidator — bridge from the dashboard's legacy validation API
 * to the core-pipeline rule engine.
 *
 * The constructor + `validate(plan, options)` shape is preserved so
 * existing callers (`case 'validate-plan'` / `case 'execute-plan'` in
 * dashboard-server.ts, `pipeline-runner.ts`'s pre-flight check) keep
 * working unchanged. Internally we build a `RuleContext` from:
 *   - `projectLoader.getRepoLocalPaths(project)` — project repo set
 *   - Per-repo KB graph reads (paths + symbols)
 * …then dispatch to `runPlanRules(plan, ctx)`. The returned
 * `Issue[]` is reshaped to the legacy `PlanIssue[]` so the UI doesn't
 * need to know about the new vocabulary yet.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Plan } from '@esankhan3/anvil-core-pipeline';
import {
  runPlanRules,
  type Issue,
  type RuleContext,
} from '@esankhan3/anvil-core-pipeline';
import type { ProjectLoader } from './project-loader.js';
import { checkBudget } from './plan-validator-rules/budget.js';
import { checkPrConflicts } from './plan-validator-rules/pr-conflicts.js';

// ── Types preserved for back-compat ─────────────────────────────────────

export type IssueSeverity = 'error' | 'warn' | 'info';

export interface PlanIssue {
  severity: IssueSeverity;
  path: string;
  message: string;
  repo?: string;
  hint?: string;
  /** Plan v2 — surfaces the rule that fired so the UI can dedupe + dispatch auto-fix. */
  ruleId?: string;
  /** Plan v2 — true if the engine can patch the plan deterministically. */
  autoFixable?: boolean;
}

export interface RepoCoverage {
  repo: string;
  filesChecked: number;
  filesMissing: number;
  symbolsChecked: number;
  symbolsMissing: number;
  kbAvailable: boolean;
}

export interface PlanValidation {
  generatedAt: string;
  planVersion: number;
  /** Plan v2 — sha256 of the canonical plan JSON. */
  planHash?: string;
  issues: PlanIssue[];
  counts: { errors: number; warnings: number; infos: number };
  repoCoverage: RepoCoverage[];
}

export interface ValidateOptions {
  /** If true, run rules that hit the network (e.g. gh CLI for PR conflicts). */
  deep?: boolean;
  /** GitHub owner/repo mapping, keyed by plan-repo-name. */
  githubByRepoName?: Record<string, string>;
  /** Budget caps. */
  maxPerRun?: number;
  maxPerDay?: number;
}

// ── KB index helpers ─────────────────────────────────────────────────────

const ANVIL_HOME = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
const KB_DIR = join(ANVIL_HOME, 'knowledge-base');

function graphPath(project: string, repo: string): string {
  return join(KB_DIR, project, repo, 'graph.json');
}

interface GraphNode {
  id?: string;
  name?: string;
  label?: string;
  file?: string;
  path?: string;
  kind?: string;
}

interface GraphData {
  nodes?: GraphNode[];
}

function loadGraph(project: string, repo: string): GraphData | null {
  const p = graphPath(project, repo);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as GraphData;
  } catch {
    return null;
  }
}

function buildFileSet(graph: GraphData): Set<string> {
  const set = new Set<string>();
  for (const n of graph.nodes ?? []) {
    for (const v of [n.file, n.path, n.id]) {
      if (typeof v === 'string' && v.trim() && /[./]/.test(v)) {
        set.add(v);
      }
    }
  }
  return set;
}

function buildSymbolSet(graph: GraphData): Set<string> {
  const set = new Set<string>();
  for (const n of graph.nodes ?? []) {
    for (const v of [n.id, n.name, n.label]) {
      if (typeof v === 'string' && v.trim()) {
        set.add(v.toLowerCase());
        const stripped = v.replace(/^[^:]+::/, '').toLowerCase();
        if (stripped) set.add(stripped);
        const tail = v.split(/[./:]/).pop();
        if (tail) set.add(tail.toLowerCase());
      }
    }
  }
  return set;
}

function mapSeverity(s: Issue['severity']): IssueSeverity {
  return s === 'warning' ? 'warn' : s;
}

// ── Validator ────────────────────────────────────────────────────────────

export class PlanValidator {
  constructor(private projectLoader: ProjectLoader) {}

  validate(plan: Plan, options: ValidateOptions = {}): PlanValidation {
    let projectRepos: string[] = [];
    try {
      projectRepos = Object.keys(this.projectLoader.getRepoLocalPaths(plan.project));
    } catch { /* project may not be loadable — rules degrade gracefully */ }

    // Per-repo KB indices — fed into the rule engine for KB-grounded checks.
    const kbFiles: Record<string, Set<string>> = {};
    const kbSymbols: Record<string, Set<string>> = {};
    const repoCoverage: RepoCoverage[] = [];
    for (const r of plan.repos) {
      const graph = loadGraph(plan.project, r.name);
      kbFiles[r.name] = graph ? buildFileSet(graph) : new Set();
      kbSymbols[r.name] = graph ? buildSymbolSet(graph) : new Set();
      repoCoverage.push({
        repo: r.name,
        filesChecked: (r.mustTouch?.length ?? 0) + (r.mustExist?.length ?? 0),
        filesMissing: 0, // computed below by counting issues per repo
        symbolsChecked: r.symbols?.length ?? 0,
        symbolsMissing: 0,
        kbAvailable: !!graph,
      });
    }

    const ctx: RuleContext = {
      project: plan.project,
      projectRepos,
      kbFiles,
      kbSymbols,
      budget: {
        medianUsdPerSimilarPlan: null,
        maxPerRunUsd: options.maxPerRun,
      },
    };

    const report = runPlanRules(plan, ctx);

    // Re-shape into the legacy PlanIssue list the UI consumes.
    const issues: PlanIssue[] = report.issues.map((i) => {
      const repoMatch = i.path.match(/^repos\[(\d+)\]/);
      const repoName = repoMatch ? plan.repos[parseInt(repoMatch[1], 10)]?.name : undefined;
      return {
        severity: mapSeverity(i.severity),
        path: i.path,
        message: i.message,
        ruleId: i.ruleId,
        autoFixable: i.autoFixable,
        ...(repoName ? { repo: repoName } : {}),
        ...(i.fixHint ? { hint: i.fixHint } : {}),
      };
    });

    // Bump per-repo missing counts so the UI's coverage card stays useful.
    for (const i of issues) {
      if (!i.repo) continue;
      const cov = repoCoverage.find((c) => c.repo === i.repo);
      if (!cov) continue;
      if (i.ruleId?.startsWith('KB.file-')) cov.filesMissing++;
      if (i.ruleId?.startsWith('KB.symbol-')) cov.symbolsMissing++;
    }

    // ── Add-on rules (budget / PR conflicts) — non-fatal, additive ──────
    if (options.maxPerRun || options.maxPerDay) {
      try {
        const budgetIssues = checkBudget(plan, {
          anvilHome: ANVIL_HOME,
          maxPerRun: options.maxPerRun,
          maxPerDay: options.maxPerDay,
        });
        for (const b of budgetIssues) issues.push({ ...b, ruleId: 'BUDGET.guard' });
      } catch { /* non-fatal */ }
    }
    if (options.deep && options.githubByRepoName) {
      try {
        const prIssues = checkPrConflicts(plan, { githubByRepoName: options.githubByRepoName });
        for (const p of prIssues) issues.push({ ...p, ruleId: 'PR.conflict' });
      } catch { /* non-fatal */ }
    }

    const counts = {
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warn').length,
      infos: issues.filter((i) => i.severity === 'info').length,
    };

    return {
      generatedAt: new Date().toISOString(),
      planVersion: plan.version,
      planHash: plan.contentHash,
      issues,
      counts,
      repoCoverage,
    };
  }
}
