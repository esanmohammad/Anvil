/**
 * Budget rule — warn if the plan's estimated spend pushes the user over
 * per-run / per-day budget limits.
 */
import type { Plan } from '../plan-store.js';
import type { PlanIssue } from '../plan-validator.js';
export interface BudgetRuleDeps {
    anvilHome: string;
    maxPerRun?: number;
    maxPerDay?: number;
}
export declare function checkBudget(plan: Plan, deps: BudgetRuleDeps): PlanIssue[];
//# sourceMappingURL=budget.d.ts.map