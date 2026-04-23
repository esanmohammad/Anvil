/**
 * PlanValidator — cheap (no-LLM) validation of a Plan against the KB.
 *
 * Validates that every repo/file/symbol referenced in the plan actually
 * exists in the knowledge graph + on disk. Catches hallucinated references
 * BEFORE the pipeline spends a dollar building them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Plan } from './plan-store.js';
import type { ProjectLoader } from './project-loader.js';
import { checkBudget } from './plan-validator-rules/budget.js';
import { checkConventions } from './plan-validator-rules/conventions.js';
import { checkPrConflicts } from './plan-validator-rules/pr-conflicts.js';

// ── Types ────────────────────────────────────────────────────────────────

export type IssueSeverity = 'error' | 'warn' | 'info';

export interface PlanIssue {
  severity: IssueSeverity;
  path: string;
  message: string;
  repo?: string;
  hint?: string;
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

// ── Helpers ──────────────────────────────────────────────────────────────

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

/**
 * Build a lookup set of every string that could match a "symbol" reference:
 * node ids, labels, names, plus the basename of any referenced file.
 * Matching is case-insensitive and strips common suffixes.
 */
function buildSymbolSet(graph: GraphData): Set<string> {
  const set = new Set<string>();
  for (const n of graph.nodes ?? []) {
    for (const v of [n.id, n.name, n.label]) {
      if (typeof v === 'string' && v.trim()) {
        set.add(v.toLowerCase());
        // Strip common prefixes: "repo::", "file::"
        const stripped = v.replace(/^[^:]+::/, '').toLowerCase();
        if (stripped) set.add(stripped);
        // Last component after '.' or '/' or ':'
        const tail = v.split(/[./:]/).pop();
        if (tail) set.add(tail.toLowerCase());
      }
    }
  }
  return set;
}

function buildFileSet(graph: GraphData): Set<string> {
  const set = new Set<string>();
  for (const n of graph.nodes ?? []) {
    for (const v of [n.file, n.path, n.id]) {
      if (typeof v === 'string' && v.trim() && /[./]/.test(v)) {
        set.add(v.toLowerCase());
      }
    }
  }
  return set;
}

// ── Validator ────────────────────────────────────────────────────────────

export class PlanValidator {
  constructor(private projectLoader: ProjectLoader) {}

  validate(plan: Plan, options: ValidateOptions = {}): PlanValidation {
    const issues: PlanIssue[] = [];
    const coverage: RepoCoverage[] = [];

    // 1. Plan-level sanity
    if (!plan.problem || plan.problem.trim().length < 20) {
      issues.push({
        severity: 'warn', path: 'problem',
        message: 'Problem statement is very short (< 20 chars) — expand for better pipeline output.',
      });
    }
    if (!plan.repos.length) {
      issues.push({
        severity: 'error', path: 'repos',
        message: 'Plan has no affected repositories. Add at least one.',
      });
    }
    if (plan.estimate.usd > 0 && plan.estimate.usd > 100) {
      issues.push({
        severity: 'warn', path: 'estimate.usd',
        message: `Estimated spend is $${plan.estimate.usd.toFixed(2)}. Review scope before executing.`,
      });
    }

    // 2. Repo existence — against the project config
    let projectRepos: string[] = [];
    try {
      projectRepos = Object.keys(this.projectLoader.getRepoLocalPaths(plan.project));
    } catch {
      issues.push({
        severity: 'warn', path: 'project',
        message: `Could not load project "${plan.project}" repo list — skipping repo membership checks.`,
      });
    }

    const repoPathMap: Record<string, string> = (() => {
      try { return this.projectLoader.getRepoLocalPaths(plan.project); } catch { return {}; }
    })();

    for (let i = 0; i < plan.repos.length; i++) {
      const r = plan.repos[i];
      const repoLocalPath = repoPathMap[r.name];

      if (projectRepos.length && !projectRepos.includes(r.name)) {
        issues.push({
          severity: 'error',
          path: `repos[${i}].name`,
          repo: r.name,
          message: `Repo "${r.name}" is not registered in the project. Known repos: ${projectRepos.join(', ') || '(none)'}`,
        });
      }

      // 3. Per-repo validation (files + symbols via KB)
      const graph = loadGraph(plan.project, r.name);
      const cov: RepoCoverage = {
        repo: r.name,
        filesChecked: r.files.length,
        filesMissing: 0,
        symbolsChecked: r.symbols.length,
        symbolsMissing: 0,
        kbAvailable: !!graph,
      };

      // File existence — prefer disk check (authoritative); fall back to KB.
      const kbFileSet = graph ? buildFileSet(graph) : null;
      for (let j = 0; j < r.files.length; j++) {
        const f = r.files[j];
        if (!f) continue;
        let exists = false;
        if (repoLocalPath) {
          exists = existsSync(join(repoLocalPath, f));
        } else if (kbFileSet) {
          const needle = f.toLowerCase();
          for (const entry of kbFileSet) {
            if (entry === needle || entry.endsWith('/' + needle) || entry.endsWith(needle)) {
              exists = true; break;
            }
          }
        } else {
          // Nothing to check against — info only
          issues.push({
            severity: 'info',
            path: `repos[${i}].files[${j}]`,
            repo: r.name,
            message: `Cannot verify file "${f}" — no local repo path and no KB.`,
          });
          continue;
        }
        if (!exists) {
          const isNew = /\/(new|add|create)/.test(r.changes.toLowerCase())
            || f.toLowerCase().includes('new');
          issues.push({
            severity: isNew ? 'info' : 'warn',
            path: `repos[${i}].files[${j}]`,
            repo: r.name,
            message: `File "${f}" not found in ${r.name}.${isNew ? ' (may be intentional if new.)' : ''}`,
            hint: isNew ? undefined : 'Check the path or add as new file in changes description.',
          });
          cov.filesMissing++;
        }
      }

      // Symbol existence — KB only.
      if (graph) {
        const symbolSet = buildSymbolSet(graph);
        for (let j = 0; j < r.symbols.length; j++) {
          const s = r.symbols[j];
          if (!s) continue;
          const needle = s.toLowerCase();
          const tail = needle.split(/[./:]/).pop() ?? needle;
          if (!symbolSet.has(needle) && !symbolSet.has(tail)) {
            issues.push({
              severity: 'info',
              path: `repos[${i}].symbols[${j}]`,
              repo: r.name,
              message: `Symbol "${s}" not found in KB for ${r.name} (may be a new symbol).`,
            });
            cov.symbolsMissing++;
          }
        }
      } else if (r.symbols.length > 0) {
        issues.push({
          severity: 'info',
          path: `repos[${i}].symbols`,
          repo: r.name,
          message: `No KB available for ${r.name} — cannot validate ${r.symbols.length} symbol(s). Run Knowledge Base refresh.`,
        });
      }

      coverage.push(cov);
    }

    // 4. Contract consistency
    for (let i = 0; i < plan.contracts.length; i++) {
      const c = plan.contracts[i];
      const planRepoNames = plan.repos.map((r) => r.name);
      if (c.producer && !planRepoNames.includes(c.producer)) {
        issues.push({
          severity: 'warn',
          path: `contracts[${i}].producer`,
          message: `Producer "${c.producer}" for contract "${c.name}" is not in the plan's affected repos.`,
        });
      }
      for (let j = 0; j < c.consumers.length; j++) {
        const con = c.consumers[j];
        if (con && !planRepoNames.includes(con)) {
          issues.push({
            severity: 'warn',
            path: `contracts[${i}].consumers[${j}]`,
            message: `Consumer "${con}" for contract "${c.name}" is not in the plan's affected repos.`,
          });
        }
      }
    }

    // ── Phase-2 extension rules ──────────────────────────────────────────
    // Each rule is additive — failures/absence never break the core validation.

    // 5. Budget
    if (options.maxPerRun || options.maxPerDay) {
      try {
        issues.push(...checkBudget(plan, {
          anvilHome: ANVIL_HOME,
          maxPerRun: options.maxPerRun,
          maxPerDay: options.maxPerDay,
        }));
      } catch { /* rule failure is non-fatal */ }
    }

    // 6. Conventions (enforced rules only)
    try {
      issues.push(...checkConventions(plan, {
        anvilHome: ANVIL_HOME,
        project: plan.project,
      }));
    } catch { /* non-fatal */ }

    // 7. Open-PR conflicts (deep only — hits gh CLI)
    if (options.deep && options.githubByRepoName) {
      try {
        issues.push(...checkPrConflicts(plan, {
          githubByRepoName: options.githubByRepoName,
        }));
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
      issues,
      counts,
      repoCoverage: coverage,
    };
  }
}
