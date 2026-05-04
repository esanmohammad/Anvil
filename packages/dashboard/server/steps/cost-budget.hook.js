/**
 * `cost-budget.hook` — bus subscriber that runs `CostBreachHandler.evaluate`
 * after each `step:completed`.
 *
 * Phase 4e of the dashboard consolidation. The plan §4.2.6 specifies this
 * as a hook subscriber at priority 30 — between `attachLearnersHook`
 * (priority 50) and `attachDashboardStateHook` (priority 10), so a breach
 * decision can mutate state the dashboard then broadcasts.
 *
 * Today's per-LLM-call breach evaluation lives inside
 * `dashboard-server.ts:agentManager.setCostHook()`. That path stays in
 * place — it's finer-grained (per-model-invocation) and catches breaches
 * mid-step. This bus hook is **additive**: it adds an end-of-step
 * checkpoint, useful for stages whose LLM calls don't all flow through
 * `agentManager` (e.g. headless adapter calls in Phase 4f's lifted
 * Steps). No flag — both paths can coexist; `breachHandler.evaluate` is
 * idempotent (it persists state and skips work when a breach already
 * exists).
 *
 * Phase 4f decides whether to drop the per-LLM-call hook in favor of
 * this one. Until then, both run.
 */
/**
 * Attach the cost-budget hook to a core-pipeline EventBus.
 *
 * Only `step:completed` events whose `runId` matches `opts.runId` trigger
 * an evaluation. Sub-step + pipeline:* events are ignored — breaches
 * are checkpoint-y and step-level granularity matches the legacy intent.
 */
export function attachCostBudgetHook(bus, opts) {
    const priority = opts.priority ?? 30;
    let evaluationCount = 0;
    const listener = async (event) => {
        if (event.runId !== opts.runId)
            return;
        let policy;
        try {
            policy = opts.resolvePolicy();
        }
        catch (error) {
            (opts.onError ?? defaultOnError)(error);
            return;
        }
        if (!policy)
            return;
        evaluationCount += 1;
        try {
            await opts.breachHandler.evaluate(opts.runId, opts.project, policy);
        }
        catch (error) {
            (opts.onError ?? defaultOnError)(error);
        }
    };
    const off = bus.on('step:completed', listener, { priority });
    return {
        unsubscribe: () => off(),
        get evaluationCount() {
            return evaluationCount;
        },
    };
}
function defaultOnError(error) {
    // eslint-disable-next-line no-console
    console.warn('[cost-budget-hook] breachHandler.evaluate threw:', error);
}
//# sourceMappingURL=cost-budget.hook.js.map