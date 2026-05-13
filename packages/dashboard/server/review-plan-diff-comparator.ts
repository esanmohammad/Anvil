/**
 * review-plan-diff-comparator — compare a structured Plan against a PR diff
 * and score scope fidelity and deliverable completeness.
 *
 * This module is a pure data transformation: it takes the plan's steps (a
 * flattening of plan.scope.inScope, plan.repos[].files/symbols, plan.tests.*,
 * plan.rollout.order) and a list of diff files with hunk snippets, and
 * returns a PRPlanComparison describing which steps were matched, which
 * appear to be missing from the diff, which files are unexpected, and an
 * overall scope-creep severity.
 *
 * Heuristics (kept deliberately simple — see module tests for behaviour):
 *   - each plan step is reduced to a set of keywords (length >= 4, no
 *     stop-words) from its description;
 *   - each diff file produces a haystack of its path plus the first 200
 *     chars of the added text across its hunks;
 *   - a file's score for a step is (matchedKeywords / totalKeywords); the
 *     step's matchedConfidence is the max over files, and missing = no file
 *     scored >= MATCH_THRESHOLD (0.2);
 *   - unexpectedFiles = diff files whose max score across every step was 0;
 *   - scopeCreepSeverity: high if unexpected files touch auth/** or
 *     migrations/**, medium if >50% of diff files are unexpected, low if
 *     there are any, else none.
 */

import type { Plan } from './plan-store.js';

// ── Public types ─────────────────────────────────────────────────────────

export interface PlanStepMatch {
  stepId: string;
  description: string;
  matchedFiles: string[];
  matchedConfidence: number;
  missing: boolean;
}

export interface PRPlanComparison {
  totalSteps: number;
  matchedSteps: number;
  missingSteps: PlanStepMatch[];
  unexpectedFiles: string[];
  scopeCreepSeverity: 'none' | 'low' | 'medium' | 'high';
}

export interface DiffHunk {
  addedLines: number;
  removedLines: number;
  snippet: string;
}

export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
}

// ── Tunables ─────────────────────────────────────────────────────────────

const MATCH_THRESHOLD = 0.2;
const HAYSTACK_MAX_CHARS = 200;
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /(^|\/)auth\//i,
  /(^|\/)migrations\//i,
];
const STOP_WORDS: ReadonlySet<string> = new Set([
  'that', 'this', 'with', 'from', 'into', 'onto', 'upon', 'than', 'then',
  'when', 'what', 'which', 'where', 'while', 'will', 'have', 'been', 'were',
  'their', 'there', 'these', 'those', 'some', 'such', 'into', 'about',
  'also', 'each', 'using', 'uses', 'make', 'made', 'over', 'plan', 'step',
  'must', 'should', 'shall', 'would', 'could', 'might', 'file', 'files',
  'feature', 'features', 'code', 'codebase', 'test', 'tests', 'unit',
  'ensure', 'ensures', 'added', 'added', 'update', 'updates', 'updated',
  'create', 'creates', 'created', 'change', 'changes', 'changed',
]);

// ── Plan flattening ──────────────────────────────────────────────────────

interface FlatStep {
  stepId: string;
  description: string;
  keywords: Set<string>;
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  const matches = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const tok of matches) {
    if (tok.length < 4) continue;
    if (STOP_WORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

function flattenPlan(plan: Plan): FlatStep[] {
  const steps: FlatStep[] = [];

  plan.scope.inScope.forEach((s, i) => {
    // Plan v2: scope items are structured; surface description + acceptance.
    const desc = `${s.description}${s.acceptance.length ? ': ' + s.acceptance.join('; ') : ''}`;
    steps.push({ stepId: `scope.inScope[${i}]`, description: desc, keywords: tokenize(desc) });
  });

  plan.repos.forEach((r, ri) => {
    // Plan v2: iterate mustTouch + mustExist together so the comparator
    // sees every claimed path.
    const claims: { path: string; kind: 'modified' | 'new' }[] = [
      ...r.mustTouch.map((c) => ({ path: c.path, kind: c.kind as 'modified' })),
      ...r.mustExist.map((c) => ({ path: c.path, kind: 'new' as const })),
    ];
    claims.forEach((claim, fi) => {
      if (!claim.path) return;
      const desc = `${r.name}: ${claim.path}`;
      const pathTokens = new Set<string>();
      const segs = claim.path.split('/').filter(Boolean);
      for (const seg of segs.slice(-3)) {
        for (const tok of tokenize(seg.replace(/\.[a-z0-9]+$/i, ''))) pathTokens.add(tok);
      }
      const kws = tokenize(desc);
      pathTokens.forEach((t) => kws.add(t));
      steps.push({ stepId: `repos[${ri}].${claim.kind === 'new' ? 'mustExist' : 'mustTouch'}[${fi}]`, description: desc, keywords: kws });
    });
    r.symbols.forEach((sym, si) => {
      const display = sym.name;
      steps.push({
        stepId: `repos[${ri}].symbols[${si}]`,
        description: `${r.name}: ${display}`,
        keywords: tokenize(`${r.name} ${display}`),
      });
    });
  });

  plan.tests.unit.forEach((t, i) => {
    const desc = t.then || t.name;
    steps.push({ stepId: `tests.unit[${i}]`, description: desc, keywords: tokenize(desc) });
  });
  plan.tests.integration.forEach((t, i) => {
    const desc = t.then || t.name;
    steps.push({ stepId: `tests.integration[${i}]`, description: desc, keywords: tokenize(desc) });
  });

  plan.rollout.order.forEach((o, i) => {
    steps.push({ stepId: `rollout.order[${i}]`, description: o, keywords: tokenize(o) });
  });

  // Drop steps with no usable keywords — they can never score above zero
  // and only add noise to missingSteps.
  return steps.filter((s) => s.keywords.size > 0);
}

// ── Diff -> haystack ─────────────────────────────────────────────────────

function buildFileHaystack(file: DiffFile): string {
  let added = '';
  for (const h of file.hunks) {
    if (!h.snippet) continue;
    // Only count lines starting with '+' (added). Fall back to full snippet
    // if the snippet isn't a unified diff.
    const lines = h.snippet.split(/\r?\n/);
    const plus = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    added += (plus.length > 0 ? plus.join('\n') : h.snippet) + '\n';
    if (added.length >= HAYSTACK_MAX_CHARS) break;
  }
  return `${file.path}\n${added.slice(0, HAYSTACK_MAX_CHARS)}`;
}

function scoreFileAgainstStep(haystackTokens: Set<string>, step: FlatStep): number {
  if (step.keywords.size === 0) return 0;
  let hit = 0;
  for (const kw of step.keywords) {
    if (haystackTokens.has(kw)) hit++;
  }
  return hit / step.keywords.size;
}

function isSensitive(path: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(path));
}

// ── Main ─────────────────────────────────────────────────────────────────

export function comparePlanAgainstDiff(plan: Plan, diffFiles: DiffFile[]): PRPlanComparison {
  const steps = flattenPlan(plan);
  const fileTokens = diffFiles.map((f) => ({ path: f.path, tokens: tokenize(buildFileHaystack(f)) }));

  // Per-file: max score across steps (used to find unexpected files).
  const fileBestScore = new Map<string, number>();
  for (const ft of fileTokens) fileBestScore.set(ft.path, 0);

  const stepResults: PlanStepMatch[] = [];
  for (const step of steps) {
    let bestScore = 0;
    const matchedFiles: string[] = [];
    for (const ft of fileTokens) {
      const score = scoreFileAgainstStep(ft.tokens, step);
      if (score >= MATCH_THRESHOLD) matchedFiles.push(ft.path);
      if (score > bestScore) bestScore = score;
      const prev = fileBestScore.get(ft.path) ?? 0;
      if (score > prev) fileBestScore.set(ft.path, score);
    }
    stepResults.push({
      stepId: step.stepId,
      description: step.description,
      matchedFiles,
      matchedConfidence: Math.round(bestScore * 1000) / 1000,
      missing: bestScore < MATCH_THRESHOLD,
    });
  }

  const missingSteps = stepResults.filter((s) => s.missing);
  const matchedSteps = stepResults.length - missingSteps.length;

  const unexpectedFiles: string[] = [];
  for (const [path, score] of fileBestScore) {
    if (score === 0) unexpectedFiles.push(path);
  }

  let severity: PRPlanComparison['scopeCreepSeverity'] = 'none';
  if (unexpectedFiles.length > 0) {
    const sensitiveHit = unexpectedFiles.some(isSensitive);
    const ratio = diffFiles.length > 0 ? unexpectedFiles.length / diffFiles.length : 0;
    if (sensitiveHit) severity = 'high';
    else if (ratio > 0.5) severity = 'medium';
    else severity = 'low';
  }

  return {
    totalSteps: stepResults.length,
    matchedSteps,
    missingSteps,
    unexpectedFiles,
    scopeCreepSeverity: severity,
  };
}
