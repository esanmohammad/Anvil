// Cost budget tracking and enforcement

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';

export interface BudgetConfig {
  maxPerRun: number;       // max USD per pipeline run
  maxPerDay: number;       // max USD per day
  alertThreshold: number;  // 0-1, alert at this % of budget
}

export interface BudgetStatus {
  todaySpent: number;
  runSpent: number;
  config: BudgetConfig;
  withinBudget: boolean;
  alertTriggered: boolean;
}

/**
 * Load budget config from factory.yaml.
 * Looks for a `budget:` section with max_per_run, max_per_day, alert_threshold.
 * Uses minimal regex-based YAML parsing.
 */
export function loadBudgetConfig(project: string): BudgetConfig {
  const anvilHome = join(homedir(), '.anvil');

  const candidatePaths = [
    join(anvilHome, 'projects', project, 'factory.yaml'),
    join(process.cwd(), 'factory.yaml'),
    join(anvilHome, 'config.yaml'),
  ];

  let content: string | null = null;
  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        content = readFileSync(p, 'utf-8');
        break;
      } catch {
        continue;
      }
    }
  }

  const defaultConfig: BudgetConfig = { maxPerRun: 100, maxPerDay: 200, alertThreshold: 0.4 };

  if (!content) return defaultConfig;

  // Find the budget: section using regex
  const budgetMatch = content.match(/^budget:\s*\n((?:[ \t]+\S[\s\S]*?)(?=\n\S|\n*$))/m);
  if (!budgetMatch) return defaultConfig;

  const block = budgetMatch[1];

  const maxPerRunMatch = block.match(/max_per_run:\s*([\d.]+)/);
  const maxPerDayMatch = block.match(/max_per_day:\s*([\d.]+)/);
  const alertThresholdMatch = block.match(/alert_threshold:\s*([\d.]+)/);

  // Defaults: $100/run, $200/day, alert at $80 (0.4 ratio of day)
  const maxPerRun = maxPerRunMatch ? parseFloat(maxPerRunMatch[1]) : 100;
  const maxPerDay = maxPerDayMatch ? parseFloat(maxPerDayMatch[1]) : 200;

  return {
    maxPerRun: maxPerRun > 0 ? maxPerRun : 100,
    maxPerDay: maxPerDay > 0 ? maxPerDay : 200,
    alertThreshold: alertThresholdMatch ? parseFloat(alertThresholdMatch[1]) : 0.4,
  };
}

/**
 * Get today's spending from run records.
 * Scans ~/.anvil/runs/index.jsonl for runs from today and sums their totalCost.estimatedCost.
 */
export function getTodaySpending(project: string): number {
  const anvilHome = join(homedir(), '.anvil');
  const indexPath = join(anvilHome, 'runs', 'index.jsonl');

  if (!existsSync(indexPath)) return 0;

  let content: string;
  try {
    content = readFileSync(indexPath, 'utf-8');
  } catch {
    return 0;
  }

  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let totalSpent = 0;

  const lines = content.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as {
        project?: string;
        createdAt?: string;
        totalCost?: { estimatedCost?: number };
      };

      // Filter by project if specified
      if (project && record.project && record.project !== project) continue;

      // Filter by today's date
      if (!record.createdAt || !record.createdAt.startsWith(todayStr)) continue;

      // Sum estimated cost
      if (record.totalCost?.estimatedCost && record.totalCost.estimatedCost > 0) {
        totalSpent += record.totalCost.estimatedCost;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return totalSpent;
}

/**
 * Check if a cost would exceed budget.
 * Returns null if no budget is configured for this project.
 */
export function checkBudget(project: string, additionalCost: number): BudgetStatus {
  const config = loadBudgetConfig(project);

  const todaySpent = getTodaySpending(project);
  const projectedDaySpend = todaySpent + additionalCost;

  const withinBudget =
    additionalCost <= config.maxPerRun && projectedDaySpend <= config.maxPerDay;

  const dayRatio = config.maxPerDay < Infinity ? projectedDaySpend / config.maxPerDay : 0;
  const runRatio = config.maxPerRun < Infinity ? additionalCost / config.maxPerRun : 0;
  const alertTriggered = dayRatio >= config.alertThreshold || runRatio >= config.alertThreshold;

  return {
    todaySpent,
    runSpent: additionalCost,
    config,
    withinBudget,
    alertTriggered,
  };
}

/**
 * Format budget status for display.
 * Shows a colored budget bar and status summary.
 */
export function formatBudgetStatus(status: BudgetStatus): string {
  const lines: string[] = [];

  lines.push(pc.bold('Budget Status'));
  lines.push(pc.dim('\u2500'.repeat(40)));

  // Daily budget bar
  if (status.config.maxPerDay < Infinity) {
    const dayRatio = Math.min(status.todaySpent / status.config.maxPerDay, 1);
    const projectedRatio = Math.min((status.todaySpent + status.runSpent) / status.config.maxPerDay, 1);
    const bar = renderBar(projectedRatio, 30);
    const color = projectedRatio >= 1 ? pc.red : projectedRatio >= status.config.alertThreshold ? pc.yellow : pc.green;

    lines.push(
      `  Daily:  ${bar} ${color(`$${(status.todaySpent + status.runSpent).toFixed(2)}`)} / $${status.config.maxPerDay.toFixed(2)}`,
    );
  }

  // Per-run budget
  if (status.config.maxPerRun < Infinity) {
    const runRatio = Math.min(status.runSpent / status.config.maxPerRun, 1);
    const bar = renderBar(runRatio, 30);
    const color = runRatio >= 1 ? pc.red : runRatio >= status.config.alertThreshold ? pc.yellow : pc.green;

    lines.push(
      `  Run:    ${bar} ${color(`$${status.runSpent.toFixed(2)}`)} / $${status.config.maxPerRun.toFixed(2)}`,
    );
  }

  // Status line
  lines.push('');
  if (!status.withinBudget) {
    lines.push(pc.red(`  \u2717 Budget exceeded — aborting to prevent overspend`));
  } else if (status.alertTriggered) {
    lines.push(pc.yellow(`  \u26A0 Approaching budget limit (threshold: ${(status.config.alertThreshold * 100).toFixed(0)}%)`));
  } else {
    lines.push(pc.green(`  \u2713 Within budget`));
  }

  return lines.join('\n');
}

/**
 * Render a progress bar of the given width.
 */
function renderBar(ratio: number, width: number): string {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const filledStr = '\u2588'.repeat(filled);
  const emptyStr = '\u2591'.repeat(empty);

  const color = ratio >= 1 ? pc.red : ratio >= 0.8 ? pc.yellow : pc.green;

  return `[${color(filledStr)}${pc.dim(emptyStr)}]`;
}
