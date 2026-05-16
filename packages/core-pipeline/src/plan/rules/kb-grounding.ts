/**
 * KB grounding rules — every file path / symbol / repo name claimed
 * in the plan must resolve in the KB index (or be explicitly marked
 * "new" with a parent dir that exists).
 *
 * Caller supplies `RuleContext.kbFiles` / `kbSymbols` per repo. An
 * empty Set for a repo means "no KB available" — rules downgrade to
 * `info` severity in that case so an un-indexed project doesn't
 * generate spurious errors.
 */

import type { Issue, PlanRule } from '../types.js';
import type { Plan } from '../../utils/plan-types.js';

export const repoExistsRule: PlanRule = (plan: Plan, ctx): Issue[] => {
  if (!ctx.projectRepos.length) return [];
  const issues: Issue[] = [];
  for (let i = 0; i < plan.repos.length; i++) {
    const r = plan.repos[i];
    if (!ctx.projectRepos.includes(r.name)) {
      issues.push({
        ruleId: 'KB.repo-exists',
        severity: 'error',
        path: `repos[${i}].name`,
        message: `Repo "${r.name}" is not registered in project "${ctx.project}". Known: ${ctx.projectRepos.join(', ')}.`,
        fixHint: `Replace with one of: ${ctx.projectRepos.join(', ')}.`,
        autoFixable: false,
      });
    }
  }
  return issues;
};

function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export const fileModifiedExistsRule: PlanRule = (plan: Plan, ctx): Issue[] => {
  const issues: Issue[] = [];
  for (let i = 0; i < plan.repos.length; i++) {
    const r = plan.repos[i];
    const kb = ctx.kbFiles[r.name];
    const haveKb = !!kb && kb.size > 0;
    for (let j = 0; j < r.mustTouch.length; j++) {
      const claim = r.mustTouch[j];
      if (!claim.path) continue;
      if (!haveKb) {
        issues.push({
          ruleId: 'KB.file-modified-exists',
          severity: 'info',
          path: `repos[${i}].mustTouch[${j}].path`,
          message: `No KB index for repo "${r.name}" — cannot verify "${claim.path}".`,
          fixHint: 'Run `anvil index` for this project to enable KB-grounded checks.',
          autoFixable: false,
        });
        continue;
      }
      if (!kb.has(claim.path)) {
        issues.push({
          ruleId: 'KB.file-modified-exists',
          severity: 'error',
          path: `repos[${i}].mustTouch[${j}].path`,
          message: `File "${claim.path}" (mustTouch) not found in KB for "${r.name}".`,
          fixHint: 'Either fix the path, change kind to "new", or move to mustExist.',
          autoFixable: false,
        });
      }
    }
  }
  return issues;
};

export const fileNewParentExistsRule: PlanRule = (plan: Plan, ctx): Issue[] => {
  const issues: Issue[] = [];
  for (let i = 0; i < plan.repos.length; i++) {
    const r = plan.repos[i];
    const kb = ctx.kbFiles[r.name];
    const haveKb = !!kb && kb.size > 0;
    if (!haveKb) continue;
    // Pre-compute set of dirs covered by KB so we can check parents
    // without rescanning per claim.
    const dirs = new Set<string>();
    for (const f of kb) {
      let d = parentDir(f);
      while (d.length > 0) {
        dirs.add(d);
        d = parentDir(d);
      }
    }
    for (let j = 0; j < r.mustExist.length; j++) {
      const claim = r.mustExist[j];
      if (!claim.path || claim.kind !== 'new') continue;
      const parent = parentDir(claim.path);
      if (parent && !dirs.has(parent)) {
        issues.push({
          ruleId: 'KB.file-new-parent-exists',
          severity: 'warning',
          path: `repos[${i}].mustExist[${j}].path`,
          message: `New file "${claim.path}": parent dir "${parent}" not seen in KB for "${r.name}".`,
          fixHint: 'Double-check the directory — agents commonly hallucinate sibling paths.',
          autoFixable: false,
        });
      }
    }
  }
  return issues;
};

export const symbolModifiedExistsRule: PlanRule = (plan: Plan, ctx): Issue[] => {
  const issues: Issue[] = [];
  for (let i = 0; i < plan.repos.length; i++) {
    const r = plan.repos[i];
    const kbSyms = ctx.kbSymbols[r.name];
    if (!kbSyms || kbSyms.size === 0) continue;
    for (let j = 0; j < r.symbols.length; j++) {
      const sym = r.symbols[j];
      if (!sym.name) continue;
      // Only "modified" semantics — for now, treat all symbols as
      // assertions to land. We don't have a "new" flag on SymbolClaim
      // yet; that's deliberate (verifier handles new symbols in the
      // build-compliance phase by checking diff hunks).
      const lookup = sym.name.toLowerCase();
      if (!kbSyms.has(lookup)) {
        issues.push({
          ruleId: 'KB.symbol-modified-exists',
          severity: 'info',
          path: `repos[${i}].symbols[${j}].name`,
          message: `Symbol "${sym.name}" not found in KB for "${r.name}" (may be new).`,
          autoFixable: false,
        });
      }
    }
  }
  return issues;
};
