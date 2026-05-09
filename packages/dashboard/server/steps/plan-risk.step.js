/**
 * `plan-risk.step` — wraps `scorePlan()` + `computeRiskTier()` from
 * `plan-risk-scorer.ts` into a one-shot `Step<Plan, Plan>`.
 *
 * Phase 4c of the dashboard consolidation. Lifts
 * `pipeline-runner.ts:getPlanRisk()` so Phase 4f can register this step
 * once-per-run (after planning, before the pipeline body) without
 * touching the legacy runner yet.
 *
 * Step semantics:
 *   - input:  the `Plan` object the planning stage produced
 *   - output: the same `Plan`, untouched — risk scoring is a side effect.
 *             Pass-through keeps the step trivially insertable between
 *             two persona steps that operate on the plan.
 *   - emits:  `PLAN-RISK.json` artifact with the full `RiskScore`
 *             (overall / tier / factors / confidence / scopeBoundaryRisks
 *             / computedAt / scorerVersion). Bus subscribers (audit,
 *             dashboard-state, learners) read it via `ctx.artifacts`.
 *
 * No-ops cleanly when the input isn't a Plan-shaped object — mirrors
 * `getPlanRisk()`'s behavior of returning `{}` when `seed.plan` is
 * absent. Callers that want to *enforce* a plan should validate
 * upstream rather than rely on this step throwing.
 *
 * The legacy `cachedRisk` field on `PipelineRunner` becomes the artifact
 * itself: any consumer downstream reads `ctx.artifacts.read('PLAN-RISK.json')`
 * to get the same value the legacy code returned from `getPlanRisk()`.
 */
import { scorePlan } from '@esankhan3/anvil-core-pipeline';
export const PLAN_RISK_ARTIFACT_ID = 'PLAN-RISK.json';
/**
 * Build a one-shot plan-risk Step. Phase 4f registers a single instance
 * after the planning stage Step. Until then, callers can register it
 * directly inside their own `Pipeline` to verify behavior parity.
 */
export function createPlanRiskStep(opts = {}) {
    const id = opts.id ?? 'plan-risk';
    return {
        id,
        name: 'Plan risk scorer',
        parallelism: 'serial',
        async run(ctx) {
            const plan = ctx.input;
            if (!isPlan(plan))
                return plan;
            let score;
            try {
                score = scorePlan(plan, { fileCounts: opts.fileCounts });
            }
            catch (error) {
                // Match `getPlanRisk()`'s swallow-on-throw behavior — a broken
                // scorer must not block the run. Return the plan untouched.
                // eslint-disable-next-line no-console
                console.warn('[plan-risk] scorePlan threw; skipping artifact emit.', error);
                return plan;
            }
            if (opts.computedAt) {
                score.computedAt = opts.computedAt();
            }
            ctx.emit(PLAN_RISK_ARTIFACT_ID, score);
            opts.onScore?.(score, plan);
            return plan;
        },
    };
}
function isPlan(value) {
    if (!value || typeof value !== 'object')
        return false;
    const v = value;
    return typeof v.version === 'number'
        && typeof v.slug === 'string'
        && typeof v.project === 'string'
        && Array.isArray(v.repos);
}
//# sourceMappingURL=plan-risk.step.js.map