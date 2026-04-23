/**
 * Conventions rule — check the plan against `enforced` rules learned by
 * convention-generator.ts. Very lightweight for MVP: only checks the
 * `avoid any type` / `require explicit types` style rules for TS repos,
 * plus transport mismatches (e.g. a plan proposes HTTP where the repo is
 * gRPC-only).
 */
import type { Plan } from '../plan-store.js';
import type { PlanIssue } from '../plan-validator.js';
export interface ConventionRule {
    id: string;
    description: string;
    severity?: 'info' | 'warn' | 'error';
    status?: 'detected' | 'validated' | 'enforced';
    /** Optional per-repo scoping */
    repo?: string;
    /** Free-text hint the plan must NOT match (simple substring). */
    avoidPattern?: string;
}
export interface ConventionRulesDeps {
    anvilHome: string;
    project: string;
}
export declare function checkConventions(plan: Plan, deps: ConventionRulesDeps): PlanIssue[];
//# sourceMappingURL=conventions.d.ts.map