/**
 * Budget rule — warn if the plan's estimated spend pushes the user over
 * per-run / per-day budget limits.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../plan-store.js';
import type { PlanIssue } from '../plan-validator.js';

export interface BudgetRuleDeps {
  anvilHome: string;
  maxPerRun?: number;
  maxPerDay?: number;
}

/** Sum today's UTC spend from runs/index.jsonl. */
function todaySpend(anvilHome: string): number {
  const indexPath = join(anvilHome, 'runs', 'index.jsonl');
  if (!existsSync(indexPath)) return 0;
  try {
    const content = readFileSync(indexPath, 'utf-8');
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    let total = 0;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { createdAt?: string; totalCost?: number };
        if (!record.createdAt || !record.totalCost) continue;
        if (new Date(record.createdAt).getTime() >= dayStart.getTime()) {
          total += record.totalCost;
        }
      } catch { /* skip malformed lines */ }
    }
    return total;
  } catch {
    return 0;
  }
}

export function checkBudget(plan: Plan, deps: BudgetRuleDeps): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const estimate = plan.estimate.usd;
  if (estimate <= 0) return issues;

  if (deps.maxPerRun && estimate > deps.maxPerRun) {
    issues.push({
      severity: 'error',
      path: 'estimate.usd',
      message: `Estimated spend $${estimate.toFixed(2)} exceeds per-run budget of $${deps.maxPerRun.toFixed(2)}. Narrow scope, reduce repos, or raise the budget.`,
    });
  }

  if (deps.maxPerDay) {
    const alreadySpent = todaySpend(deps.anvilHome);
    const wouldSpend = alreadySpent + estimate;
    if (wouldSpend > deps.maxPerDay) {
      issues.push({
        severity: 'error',
        path: 'estimate.usd',
        message: `Running this would push today's spend to $${wouldSpend.toFixed(2)} (over daily cap $${deps.maxPerDay.toFixed(2)}). Already spent $${alreadySpent.toFixed(2)} today.`,
      });
    } else if (wouldSpend > deps.maxPerDay * 0.8) {
      issues.push({
        severity: 'warn',
        path: 'estimate.usd',
        message: `Running this will bring today's spend to $${wouldSpend.toFixed(2)} — within 80% of daily cap $${deps.maxPerDay.toFixed(2)}.`,
      });
    }
  }

  return issues;
}
