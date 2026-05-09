/**
 * Types for plan risk scoring (Phase 1 of the confidence-gated pipeline).
 *
 * A RiskScore is attached to a Plan before the pipeline executes; downstream
 * policy uses `tier` + `factors` to decide whether to pause for human review.
 *
 * Phase F9 — promoted from `packages/dashboard/server/plan-risk-types.ts`
 * into `core-pipeline/utils`. Pure data + types; zero runtime side
 * effects. cli + dashboard share one canonical risk vocabulary.
 */

export type RiskTier = 'low' | 'med' | 'high';

export interface RiskFactor {
  key: string;            // e.g. 'file-count', 'sensitive-paths'
  label: string;          // human-readable
  weight: number;         // 0..1
  detail?: string;        // explanation, e.g. "touches auth/**"
}

export interface RiskScore {
  overall: number;        // 0..1
  tier: RiskTier;
  factors: RiskFactor[];  // ordered by contribution desc
  confidence: number;     // 0..1 — agent self-reported, defaults to 0.5
  scopeBoundaryRisks: string[]; // planner-emitted list
  computedAt: string;     // ISO timestamp
  scorerVersion: string;  // bump when formula changes
}

// Bump whenever factor weights, thresholds, or the aggregation formula change
// so historical scores can be invalidated / recomputed deterministically.
export const SCORER_VERSION = '1.0.0';

// Sensitive path patterns (globs -> regex). Extend freely.
// The `weight` field is used both as the factor contribution when matched
// and (indirectly) to label the match in `detail`.
export const SENSITIVE_PATH_PATTERNS: Array<{ pattern: RegExp; label: string; weight: number }> = [
  { pattern: /(^|\/)auth\//i, label: 'auth', weight: 0.9 },
  { pattern: /(^|\/)migrations?\//i, label: 'migrations', weight: 0.95 },
  { pattern: /(^|\/)infra\//i, label: 'infra', weight: 0.85 },
  { pattern: /\.env(\.|$)/i, label: 'env files', weight: 0.9 },
  { pattern: /(^|\/)secrets?\//i, label: 'secrets', weight: 0.95 },
  { pattern: /(^|\/)k8s\/|(^|\/)kubernetes\//i, label: 'kubernetes', weight: 0.85 },
  { pattern: /(^|\/)terraform\/|\.tf$/i, label: 'terraform', weight: 0.85 },
  { pattern: /(^|\/)billing\//i, label: 'billing', weight: 0.8 },
  { pattern: /openapi|swagger|\.proto$/i, label: 'api contracts', weight: 0.7 },
];
