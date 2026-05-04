/**
 * incident-stats-formatter — renders an `IncidentStats` snapshot as a
 * pretty, box-drawing-character ASCII table suitable for the Anvil CLI's
 * `incidents stats` command.
 *
 * The `IncidentStats` interface is *duplicated* here as a type-only local
 * definition rather than imported from the dashboard package. Reasons:
 *
 *  1. `@anvil-dev/dashboard` is not (and by design should not be) a
 *     runtime dependency of the CLI — the CLI bundles the built dashboard
 *     via `scripts/bundle-dashboard.mjs`, not via `node_modules`.
 *  2. The dashboard's `exports` map exposes `./server/*` but only in its
 *     built (`.js`) form, which doesn't carry a `.d.ts` at TypeScript-
 *     resolution time in a workspace that hasn't been built yet.
 *  3. Path-mapping `@anvil-dev/dashboard/server/incident-stats` ->
 *     `../dashboard/server/incident-stats.ts` would couple the CLI's
 *     tsconfig `composite` project to the dashboard project outside of
 *     the existing `references`, forcing callers to build the dashboard
 *     even when they only need CLI types.
 *
 * A type-only local duplication sidesteps all three problems at the cost
 * of a ~15-line interface that must stay in sync with `incident-stats.ts`.
 * If the shape drifts, the dashboard's aggregator stays the source of
 * truth; this file's interface is the CLI-facing contract.
 */

import pc from 'picocolors';

// ── Types (duplicated from packages/dashboard/server/incident-stats.ts) ──

/**
 * Keep this in sync with `IncidentStats` in the dashboard package. If the
 * dashboard ever becomes a direct dependency of the CLI, swap this for:
 *   import type { IncidentStats } from '@anvil-dev/dashboard/server/incident-stats';
 */
export interface IncidentStats {
  total: number;
  bySource: Record<string, number>;
  bySeverity: Record<string, number>;
  replayed: number;
  bound: number;
  confidenceHistogram: Record<string, number>;
  last30Days: number;
  last90Days: number;
  topCategories: Array<{ category: string; count: number }>;
}

// ── Layout constants ─────────────────────────────────────────────────────

const BAR_WIDTH = 28;
const BAR_CHAR = '█';
const BAR_EMPTY = '░';

/** Severity order for rendering — extra keys fall through alphabetically. */
const SEVERITY_ORDER = ['p1', 'p2', 'p3', 'p4', 'unknown'] as const;
/** Confidence order — matches the dashboard's ReplayConfidence enum. */
const CONFIDENCE_ORDER = ['high', 'med', 'low'] as const;

// ── Public API ───────────────────────────────────────────────────────────

export function formatIncidentStatsTable(stats: IncidentStats): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(pc.bold('Anvil — Incident Stats'));
  lines.push(pc.dim('─'.repeat(60)));
  lines.push('');

  // Totals line — count / replayed / bound, plus a compact confidence
  // histogram to save vertical real estate.
  lines.push(pc.bold('Overview'));
  lines.push(renderOverviewBox(stats));
  lines.push('');

  // Source histogram bar chart.
  lines.push(pc.bold('Incidents by source'));
  lines.push(renderHistogramTable(stats.bySource, sourceSort));
  lines.push('');

  // Severity histogram.
  lines.push(pc.bold('Incidents by severity'));
  lines.push(renderHistogramTable(stats.bySeverity, severitySort, colorSeverity));
  lines.push('');

  // Activity windows.
  lines.push(pc.bold('Activity'));
  lines.push(renderActivityBox(stats));
  lines.push('');

  // Top categories (from tags).
  lines.push(pc.bold('Top categories'));
  if (stats.topCategories.length === 0) {
    lines.push(pc.dim('  (no tagged incidents yet)'));
  } else {
    lines.push(renderCategoryTable(stats.topCategories));
  }
  lines.push('');

  return lines.join('\n');
}

// ── Overview ─────────────────────────────────────────────────────────────

function renderOverviewBox(stats: IncidentStats): string {
  const rows: Array<[string, string]> = [
    ['Total incidents', String(stats.total)],
    ['Replayed', `${stats.replayed} / ${stats.total}`],
    ['Bound tests', String(stats.bound)],
    ['Confidence', renderConfidenceInline(stats.confidenceHistogram)],
  ];
  return renderKvBox(rows);
}

function renderActivityBox(stats: IncidentStats): string {
  const rows: Array<[string, string]> = [
    ['Last 30 days', String(stats.last30Days)],
    ['Last 90 days', String(stats.last90Days)],
  ];
  return renderKvBox(rows);
}

function renderConfidenceInline(hist: Record<string, number>): string {
  const parts: string[] = [];
  for (const key of CONFIDENCE_ORDER) {
    const n = hist[key] ?? 0;
    parts.push(`${colorConfidence(key, `${key}:${n}`)}`);
  }
  // Any exotic confidence keys outside the canonical set.
  for (const [key, n] of Object.entries(hist)) {
    if ((CONFIDENCE_ORDER as readonly string[]).includes(key)) continue;
    parts.push(`${key}:${n}`);
  }
  return parts.join(pc.dim(' · '));
}

// ── Generic key/value box with box-drawing borders ───────────────────────

function renderKvBox(rows: Array<[string, string]>): string {
  if (rows.length === 0) return '';

  const keyW = Math.max(...rows.map(([k]) => visibleLen(k)));
  const valW = Math.max(...rows.map(([, v]) => visibleLen(v)));
  const totalInner = keyW + valW + 3; // " key │ val "

  const top = '┌' + '─'.repeat(totalInner) + '┐';
  const sep = '├' + '─'.repeat(keyW + 2) + '┬' + '─'.repeat(valW + 1) + '┤';
  const bot = '└' + '─'.repeat(keyW + 2) + '┴' + '─'.repeat(valW + 1) + '┘';

  const out: string[] = [];
  out.push(pc.dim(top));
  let first = true;
  for (const [k, v] of rows) {
    if (!first) {
      out.push(
        pc.dim(
          '├' + '─'.repeat(keyW + 2) + '┼' + '─'.repeat(valW + 1) + '┤',
        ),
      );
    }
    first = false;
    out.push(
      pc.dim('│ ') +
        padRight(k, keyW) +
        pc.dim(' │ ') +
        padRight(v, valW) +
        pc.dim('│'),
    );
  }
  // Replace the header top/sep/bot so we get rounded-ish corners.
  // (We already pushed the first row above, so reconstruct the box
  // deterministically to avoid drift.)
  const body: string[] = [];
  body.push(pc.dim(top));
  for (let i = 0; i < rows.length; i++) {
    const [k, v] = rows[i];
    body.push(
      pc.dim('│ ') +
        padRight(k, keyW) +
        pc.dim(' │ ') +
        padRight(v, valW) +
        pc.dim('│'),
    );
    if (i < rows.length - 1) body.push(pc.dim(sep.replace(/┬/g, '┼')));
  }
  body.push(pc.dim(bot));
  return body.join('\n');
}

// ── Histogram (horizontal bar chart) ─────────────────────────────────────

type SortFn = (a: [string, number], b: [string, number]) => number;
type ColorFn = (key: string, text: string) => string;

function renderHistogramTable(
  counts: Record<string, number>,
  sortFn: SortFn,
  colorFn: ColorFn = (_k, t) => t,
): string {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (entries.length === 0) {
    return pc.dim('  (none)');
  }
  entries.sort(sortFn);

  const total = entries.reduce((a, [, n]) => a + n, 0);
  const max = Math.max(...entries.map(([, n]) => n));
  const keyW = Math.max(...entries.map(([k]) => visibleLen(k)));
  const countW = Math.max(...entries.map(([, n]) => String(n).length));

  const lines: string[] = [];
  // Header.
  const header =
    pc.dim('┌') +
    pc.dim('─'.repeat(keyW + 2)) +
    pc.dim('┬') +
    pc.dim('─'.repeat(countW + 2)) +
    pc.dim('┬') +
    pc.dim('─'.repeat(BAR_WIDTH + 2)) +
    pc.dim('┬') +
    pc.dim('─'.repeat(7)) +
    pc.dim('┐');
  const footer =
    pc.dim('└') +
    pc.dim('─'.repeat(keyW + 2)) +
    pc.dim('┴') +
    pc.dim('─'.repeat(countW + 2)) +
    pc.dim('┴') +
    pc.dim('─'.repeat(BAR_WIDTH + 2)) +
    pc.dim('┴') +
    pc.dim('─'.repeat(7)) +
    pc.dim('┘');
  const sep =
    pc.dim('├') +
    pc.dim('─'.repeat(keyW + 2)) +
    pc.dim('┼') +
    pc.dim('─'.repeat(countW + 2)) +
    pc.dim('┼') +
    pc.dim('─'.repeat(BAR_WIDTH + 2)) +
    pc.dim('┼') +
    pc.dim('─'.repeat(7)) +
    pc.dim('┤');

  lines.push(header);
  for (let i = 0; i < entries.length; i++) {
    const [k, n] = entries[i];
    const bar = renderBar(n, max, BAR_WIDTH);
    const pct = total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0.0%';
    lines.push(
      pc.dim('│ ') +
        colorFn(k, padRight(k, keyW)) +
        pc.dim(' │ ') +
        padLeft(String(n), countW) +
        pc.dim(' │ ') +
        bar +
        pc.dim(' │ ') +
        padLeft(pct, 5) +
        pc.dim(' │'),
    );
    if (i < entries.length - 1) lines.push(sep);
  }
  lines.push(footer);
  return lines.join('\n');
}

function renderBar(value: number, max: number, width: number): string {
  if (max <= 0) return BAR_EMPTY.repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return pc.cyan(BAR_CHAR.repeat(filled)) + pc.dim(BAR_EMPTY.repeat(width - filled));
}

// ── Categories ───────────────────────────────────────────────────────────

function renderCategoryTable(
  rows: Array<{ category: string; count: number }>,
): string {
  const keyW = Math.max('Category'.length, ...rows.map((r) => visibleLen(r.category)));
  const countW = Math.max('Count'.length, ...rows.map((r) => String(r.count).length));

  const top =
    pc.dim('┌') +
    pc.dim('─'.repeat(keyW + 2)) +
    pc.dim('┬') +
    pc.dim('─'.repeat(countW + 2)) +
    pc.dim('┐');
  const mid =
    pc.dim('├') +
    pc.dim('─'.repeat(keyW + 2)) +
    pc.dim('┼') +
    pc.dim('─'.repeat(countW + 2)) +
    pc.dim('┤');
  const bot =
    pc.dim('└') +
    pc.dim('─'.repeat(keyW + 2)) +
    pc.dim('┴') +
    pc.dim('─'.repeat(countW + 2)) +
    pc.dim('┘');

  const lines: string[] = [];
  lines.push(top);
  lines.push(
    pc.dim('│ ') +
      pc.bold(padRight('Category', keyW)) +
      pc.dim(' │ ') +
      pc.bold(padLeft('Count', countW)) +
      pc.dim(' │'),
  );
  lines.push(mid);
  for (const r of rows) {
    lines.push(
      pc.dim('│ ') +
        padRight(r.category, keyW) +
        pc.dim(' │ ') +
        padLeft(String(r.count), countW) +
        pc.dim(' │'),
    );
  }
  lines.push(bot);
  return lines.join('\n');
}

// ── Sort + color helpers ─────────────────────────────────────────────────

const severitySort: SortFn = (a, b) => {
  const ai = (SEVERITY_ORDER as readonly string[]).indexOf(a[0]);
  const bi = (SEVERITY_ORDER as readonly string[]).indexOf(b[0]);
  const ar = ai === -1 ? SEVERITY_ORDER.length : ai;
  const br = bi === -1 ? SEVERITY_ORDER.length : bi;
  if (ar !== br) return ar - br;
  return a[0].localeCompare(b[0]);
};

const sourceSort: SortFn = (a, b) => {
  if (b[1] !== a[1]) return b[1] - a[1];
  return a[0].localeCompare(b[0]);
};

function colorSeverity(key: string, text: string): string {
  switch (key) {
    case 'p1':
      return pc.red(pc.bold(text));
    case 'p2':
      return pc.red(text);
    case 'p3':
      return pc.yellow(text);
    case 'p4':
      return pc.blue(text);
    default:
      return pc.dim(text);
  }
}

function colorConfidence(key: string, text: string): string {
  switch (key) {
    case 'high':
      return pc.green(text);
    case 'med':
      return pc.yellow(text);
    case 'low':
      return pc.red(text);
    default:
      return text;
  }
}

// ── String helpers (ANSI-aware) ──────────────────────────────────────────

const ANSI_RE = /\u001b\[[0-9;]*m/g;

function visibleLen(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

function padRight(s: string, width: number): string {
  const diff = width - visibleLen(s);
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

function padLeft(s: string, width: number): string {
  const diff = width - visibleLen(s);
  return diff > 0 ? ' '.repeat(diff) + s : s;
}
