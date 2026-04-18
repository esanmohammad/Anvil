// Stats formatter — Wave 9, Section C
// Renders rich CLI table with sparklines

import pc from 'picocolors';
import type { AggregatedStats } from './stats-aggregator.js';

const SPARKLINE_CHARS = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

/**
 * Render a sparkline from an array of numbers.
 */
export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;

  return values
    .map((v) => {
      const idx = Math.round(((v - min) / range) * (SPARKLINE_CHARS.length - 1));
      return SPARKLINE_CHARS[idx];
    })
    .join('');
}

/**
 * Format a duration in ms to human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

/**
 * Format a cost value.
 */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/**
 * Pad a string to a fixed width.
 */
function pad(str: string, width: number, align: 'left' | 'right' = 'left'): string {
  const stripped = str.replace(/\u001b\[[0-9;]*m/g, '');
  const diff = width - stripped.length;
  if (diff <= 0) return str;
  const padding = ' '.repeat(diff);
  return align === 'right' ? padding + str : str + padding;
}

/**
 * Format aggregated stats as a rich CLI table.
 */
export function formatStats(stats: AggregatedStats): string {
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push(pc.bold('Anvil Statistics'));
  lines.push(pc.dim('─'.repeat(50)));
  lines.push('');

  // Overview table
  lines.push(pc.bold('Overview'));
  lines.push(`  Total Runs:     ${pc.bold(String(stats.totalRuns))}`);
  lines.push(`  Completed:      ${pc.green(String(stats.completedRuns))}`);
  lines.push(`  Failed:         ${pc.red(String(stats.failedRuns))}`);
  lines.push(`  Cancelled:      ${pc.yellow(String(stats.cancelledRuns))}`);
  lines.push(`  Running:        ${pc.blue(String(stats.runningRuns))}`);
  lines.push(`  Success Rate:   ${colorRate(stats.successRate)}`);
  lines.push('');

  // Cost breakdown
  lines.push(pc.bold('Cost'));
  lines.push(`  Total Cost:     ${formatCost(stats.totalCost.estimatedCost)}`);
  lines.push(`  Avg per Run:    ${formatCost(stats.avgCostPerRun.estimatedCost)}`);
  lines.push(`  Total Tokens:   ${formatTokens(stats.totalCost.inputTokens)} in / ${formatTokens(stats.totalCost.outputTokens)} out`);
  lines.push('');

  // Duration
  lines.push(pc.bold('Duration'));
  lines.push(`  Avg Duration:   ${formatDuration(stats.avgDurationMs)}`);
  lines.push('');

  // Failure breakdown
  if (stats.failureBreakdown.length > 0) {
    lines.push(pc.bold('Failure Breakdown'));
    for (const fb of stats.failureBreakdown) {
      const bar = pc.red('\u2588'.repeat(Math.max(1, Math.round(fb.percentage / 5))));
      lines.push(`  ${pad(fb.stage, 20)} ${bar} ${fb.count} (${fb.percentage}%)`);
    }
    lines.push('');
  }

  // Project breakdown
  if (stats.projectBreakdown.size > 0) {
    lines.push(pc.bold('Runs by Project'));
    for (const [project, count] of stats.projectBreakdown) {
      lines.push(`  ${pad(project, 20)} ${count} runs`);
    }
    lines.push('');
  }

  // Recent activity sparkline (based on recent run statuses)
  if (stats.recentRuns.length > 0) {
    const values = stats.recentRuns.map((r) => (r.status === 'completed' ? 1 : 0));
    lines.push(pc.bold('Recent Activity'));
    lines.push(`  ${sparkline(values)} (last ${values.length} runs)`);
    lines.push('');
  }

  return lines.join('\n');
}

function colorRate(rate: number): string {
  const str = `${rate}%`;
  if (rate >= 80) return pc.green(str);
  if (rate >= 50) return pc.yellow(str);
  return pc.red(str);
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}
