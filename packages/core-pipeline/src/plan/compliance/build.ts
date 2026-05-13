/**
 * Build-stage plan-compliance check.
 *
 * Runs after the build agent produces a diff in a repo. Verifies the
 * diff matches what the plan claimed: every `mustTouch` path appears
 * in the diff, every `mustExist` new file exists on disk + has
 * content, every `symbols[]` declaration is present in the diff,
 * every `mustNotBreak` path still exports the same surface.
 *
 * Pure function: takes a Plan repo + diff hunk paths + caller-supplied
 * existence/symbol probes and returns a `BuildComplianceReport`.
 * Dashboard-side wires the FS-backed probes (git diff, fs.existsSync,
 * AST symbol grep).
 */

import type {
  Plan,
  PlanRepoImpact,
  FileClaim,
  SymbolClaim,
} from '../../utils/plan-types.js';

export type GapKind =
  | 'must-touch-missing'
  | 'must-exist-missing'
  | 'must-exist-empty'
  | 'symbol-missing'
  | 'must-not-break-export-removed';

export interface ComplianceGap {
  kind: GapKind;
  /** JSON-path into the plan, e.g. `repos[1].mustTouch[3]`. */
  path: string;
  /** Free-text detail (file path, symbol name, exported member). */
  detail: string;
  /** "low" → informational, "high" → blocks the build stage. */
  severity: 'low' | 'med' | 'high';
}

export interface BuildComplianceReport {
  /** Slug + version of the plan we verified against. */
  planSlug: string;
  planVersion: number;
  planHash: string;
  /** Repos checked (subset where the build ran). */
  reposChecked: string[];
  gaps: ComplianceGap[];
  /** Pass-count / total claims (mustTouch + mustExist + symbols). */
  passed: number;
  total: number;
  /** Did the build produce changes for every claim? */
  fullCompliance: boolean;
}

export interface BuildComplianceProbes {
  /**
   * Files appearing in the diff for the named repo. Empty array means
   * "no diff for this repo".
   */
  changedFiles(repo: string): Set<string>;
  /** Whether a path exists + is non-empty on disk after build. */
  fileExistsNonEmpty(repo: string, path: string): boolean;
  /**
   * Whether a symbol declaration appears in the diff for the named
   * repo. Implementations typically grep `git diff --unified=0` for
   * a declaration pattern (`function|const|class|type|interface`).
   */
  symbolInDiff(repo: string, symbol: SymbolClaim): boolean;
  /**
   * Whether `mustNotBreak` path still exports the same set of public
   * members. Caller-defined heuristic — at minimum, returns false if
   * the file disappeared.
   */
  preservesPublicSurface(repo: string, path: string): boolean;
}

function gapFor(
  kind: GapKind,
  path: string,
  detail: string,
  severity: ComplianceGap['severity'] = 'high',
): ComplianceGap {
  return { kind, path, detail, severity };
}

function checkRepo(
  repoIndex: number,
  repo: PlanRepoImpact,
  probes: BuildComplianceProbes,
): {
  gaps: ComplianceGap[];
  passed: number;
  total: number;
} {
  const changed = probes.changedFiles(repo.name);
  const gaps: ComplianceGap[] = [];
  let passed = 0;
  let total = 0;

  // mustTouch
  for (let j = 0; j < repo.mustTouch.length; j++) {
    total++;
    const claim = repo.mustTouch[j];
    if (!claim.path) continue;
    if (!changed.has(claim.path)) {
      gaps.push(gapFor(
        'must-touch-missing',
        `repos[${repoIndex}].mustTouch[${j}]`,
        `repo "${repo.name}": file "${claim.path}" was claimed but not modified in the diff`,
      ));
    } else {
      passed++;
    }
  }

  // mustExist (new files)
  for (let j = 0; j < repo.mustExist.length; j++) {
    total++;
    const claim: FileClaim = repo.mustExist[j];
    if (!claim.path) continue;
    if (!probes.fileExistsNonEmpty(repo.name, claim.path)) {
      gaps.push(gapFor(
        'must-exist-missing',
        `repos[${repoIndex}].mustExist[${j}]`,
        `repo "${repo.name}": new file "${claim.path}" missing or empty after build`,
      ));
    } else {
      passed++;
    }
  }

  // symbols
  for (let j = 0; j < repo.symbols.length; j++) {
    total++;
    const sym = repo.symbols[j];
    if (!sym.name) continue;
    if (!probes.symbolInDiff(repo.name, sym)) {
      gaps.push(gapFor(
        'symbol-missing',
        `repos[${repoIndex}].symbols[${j}]`,
        `repo "${repo.name}": symbol "${sym.name}" (${sym.kind}) not declared in diff`,
        'med',
      ));
    } else {
      passed++;
    }
  }

  // mustNotBreak (non-counting — these are guard rails, not claims)
  for (let j = 0; j < repo.mustNotBreak.length; j++) {
    const path = repo.mustNotBreak[j];
    if (!path) continue;
    if (!probes.preservesPublicSurface(repo.name, path)) {
      gaps.push(gapFor(
        'must-not-break-export-removed',
        `repos[${repoIndex}].mustNotBreak[${j}]`,
        `repo "${repo.name}": public surface of "${path}" appears altered`,
      ));
    }
  }

  return { gaps, passed, total };
}

/**
 * Run the build-compliance check against every repo in the plan that
 * matches `reposChecked` (so single-repo builds don't get false
 * negatives for repos they didn't touch).
 *
 * Pure — no FS reads of its own. The caller supplies probes.
 */
export function checkBuildCompliance(
  plan: Plan,
  reposChecked: string[],
  probes: BuildComplianceProbes,
): BuildComplianceReport {
  const allGaps: ComplianceGap[] = [];
  let passed = 0;
  let total = 0;

  for (let i = 0; i < plan.repos.length; i++) {
    const repo = plan.repos[i];
    if (!reposChecked.includes(repo.name)) continue;
    const sub = checkRepo(i, repo, probes);
    allGaps.push(...sub.gaps);
    passed += sub.passed;
    total += sub.total;
  }

  return {
    planSlug: plan.slug,
    planVersion: plan.version,
    planHash: plan.contentHash,
    reposChecked,
    gaps: allGaps,
    passed,
    total,
    fullCompliance: allGaps.length === 0,
  };
}

/**
 * Render a `BuildComplianceReport` as a `BUILD_COMPLIANCE.md` artifact.
 * Emitted alongside the build stage's artifact so reviewers can audit
 * exactly what claims the build did and didn't satisfy.
 */
export function renderBuildComplianceMarkdown(report: BuildComplianceReport): string {
  const lines: string[] = [];
  lines.push('# Build compliance');
  lines.push(`Plan: \`${report.planSlug}\` v${report.planVersion} (hash: \`${report.planHash.slice(0, 12)}\`)`);
  lines.push(`Repos checked: ${report.reposChecked.join(', ') || '(none)'}`);
  lines.push(`Passed: ${report.passed}/${report.total}${report.fullCompliance ? '  ✅' : '  ❌'}`);
  lines.push('');
  if (report.gaps.length === 0) {
    lines.push('All plan claims met. Build matches the approved contract.');
    return lines.join('\n');
  }
  lines.push('## Gaps');
  for (const g of report.gaps) {
    lines.push(`- **[${g.severity.toUpperCase()}] ${g.kind}** — \`${g.path}\` · ${g.detail}`);
  }
  return lines.join('\n');
}

/**
 * Build a fix prompt the fix-loop can hand to the build agent when
 * compliance < 100%. Lists the specific claims that weren't met so the
 * agent can target them in the next iteration.
 */
export function buildComplianceFixPrompt(report: BuildComplianceReport): string {
  if (report.fullCompliance) return '';
  const lines: string[] = [];
  lines.push(`Plan compliance check failed (${report.passed}/${report.total} claims met).`);
  lines.push('Please address the following:');
  for (const g of report.gaps) {
    lines.push(`- ${g.detail}`);
  }
  lines.push('');
  lines.push('Re-run only the changes needed to satisfy these claims; do not introduce unrelated edits.');
  return lines.join('\n');
}
