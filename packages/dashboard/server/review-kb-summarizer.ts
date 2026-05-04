/**
 * Review KB Summarizer — renders a `KbContextReport` (produced by
 * `computeKbContext`) as a compact text block suitable for injection into a
 * review persona's system prompt.
 *
 * The output is intentionally bounded:
 *   - `maxSymbols` caps the number of symbol stanzas (default 8).
 *   - `maxLineBudget` caps the total line count (default 40).
 * When over budget, the lowest-ripple symbols are dropped first so the
 * reviewer always sees the highest-impact entries. Orphans are summarized on
 * a single line.
 *
 * Target size is roughly ~500 tokens (well under the ~3-5K shared-context
 * ceiling used elsewhere in the pipeline).
 */

import type { KbContextReport, SymbolImpact } from './review-kb-context.js';

export interface SummarizeOptions {
  maxSymbols?: number;
  maxLineBudget?: number;
}

const DEFAULT_MAX_SYMBOLS = 8;
const DEFAULT_MAX_LINES = 40;

// Per-symbol inline caps so one mega-symbol can't swallow the whole budget.
const MAX_CALLERS_INLINE = 3;
const MAX_CALLEES_INLINE = 3;
const MAX_XREPO_INLINE = 3;

// ── Ordering ─────────────────────────────────────────────────────────────

const RIPPLE_RANK: Record<SymbolImpact['rippleEstimate'], number> = {
  large: 3,
  medium: 2,
  small: 1,
};

function rippleWeight(s: SymbolImpact): number {
  const hits = s.callers.length + s.crossRepoConsumers.length;
  // Ripple tier is the dominant signal; total hits is the tiebreaker so two
  // `small` symbols still sort by absolute blast-radius.
  return RIPPLE_RANK[s.rippleEstimate] * 1000 + hits;
}

// ── Formatters ───────────────────────────────────────────────────────────

function formatCallerList(callers: SymbolImpact['callers']): string {
  if (callers.length === 0) return '(none)';
  const shown = callers.slice(0, MAX_CALLERS_INLINE).map((c) => {
    const loc = c.line !== undefined ? `${c.file}:${c.line}` : c.file;
    return c.context ? `${c.context} in ${loc}` : loc;
  });
  const suffix = callers.length > MAX_CALLERS_INLINE
    ? ` (+${callers.length - MAX_CALLERS_INLINE} more)`
    : '';
  return `[${shown.join(', ')}]${suffix}`;
}

function formatCalleeList(callees: SymbolImpact['callees']): string {
  if (callees.length === 0) return '(none)';
  const shown = callees.slice(0, MAX_CALLEES_INLINE).map((c) => c.context ?? c.file);
  const suffix = callees.length > MAX_CALLEES_INLINE
    ? ` (+${callees.length - MAX_CALLEES_INLINE} more)`
    : '';
  return `[${shown.join(', ')}]${suffix}`;
}

function formatCrossRepo(xs: SymbolImpact['crossRepoConsumers']): string {
  if (xs.length === 0) return '';
  const shown = xs.slice(0, MAX_XREPO_INLINE).map((x) => `${x.repoName}:${x.file}`);
  const suffix = xs.length > MAX_XREPO_INLINE
    ? ` (+${xs.length - MAX_XREPO_INLINE} more)`
    : '';
  return `[${shown.join(', ')}]${suffix}`;
}

function renderSymbol(sym: SymbolImpact): string[] {
  const lines: string[] = [];
  lines.push(`- ${sym.symbol} (${sym.repoName}/${sym.filePath}):`);
  lines.push(`    callers: ${formatCallerList(sym.callers)}`);
  lines.push(`    callees: ${formatCalleeList(sym.callees)}`);
  const xrepo = formatCrossRepo(sym.crossRepoConsumers);
  if (xrepo) {
    lines.push(`    cross-repo consumers: ${xrepo}`);
  }
  const rippleDetail = `${sym.callers.length} callers, ${sym.crossRepoConsumers.length} cross-repo consumers`;
  lines.push(`    ripple: ${sym.rippleEstimate} (${rippleDetail})`);
  lines.push(`    public API: ${sym.isPublicApi ? 'yes' : 'no'}`);
  return lines;
}

// ── Budget enforcement ───────────────────────────────────────────────────

function takeWithinBudget(
  symbols: SymbolImpact[],
  maxLines: number,
): { rendered: string[]; usedCount: number } {
  const rendered: string[] = [];
  let usedCount = 0;
  for (const sym of symbols) {
    const block = renderSymbol(sym);
    // +1 accounts for the header line written by the caller once the first
    // symbol is accepted. We're conservative: only add when it fits.
    if (rendered.length + block.length > maxLines) break;
    rendered.push(...block);
    usedCount += 1;
  }
  return { rendered, usedCount };
}

// ── Public API ───────────────────────────────────────────────────────────

export function summarizeForPrompt(
  report: KbContextReport,
  opts?: SummarizeOptions,
): string {
  const maxSymbols = opts?.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const maxLines = opts?.maxLineBudget ?? DEFAULT_MAX_LINES;

  const all = [...report.changedSymbols].sort((a, b) => rippleWeight(b) - rippleWeight(a));

  if (all.length === 0 && report.orphans.length === 0) {
    return 'Changed symbols (0): no AST-graph impact could be computed for this diff.';
  }

  const header = `Changed symbols (${all.length}):`;
  // Reserve one line for the header (and possibly one for the truncation /
  // orphan footer). We aim for maxLines total.
  const footerReserve = (all.length > maxSymbols ? 1 : 0) + (report.orphans.length > 0 ? 1 : 0);
  const availableForBody = Math.max(0, maxLines - 1 - footerReserve);

  const capped = all.slice(0, maxSymbols);
  const { rendered, usedCount } = takeWithinBudget(capped, availableForBody);

  const lines: string[] = [header];
  lines.push(...rendered);

  const droppedByCap = all.length - usedCount;
  if (droppedByCap > 0) {
    lines.push(`... (+${droppedByCap} lower-ripple symbols omitted)`);
  }

  if (report.orphans.length > 0) {
    lines.push(`Unresolved files: ${report.orphans.length} (see report.orphans for details)`);
  }

  return lines.join('\n');
}
