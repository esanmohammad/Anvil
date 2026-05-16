/**
 * Plan-pipeline + plan-section routes (Phase 2.6 migration).
 *
 * Migrated:
 *   - run-plan
 *   - run-plan-variants
 *   - regen-plan-section
 *   - auto-refine-plan
 *   - execute-plan
 *
 * Each handler thin-wraps a closure (`spawnPlanAgent`,
 * `spawnPlanSectionRegen`, `dispatchLifecycle`, `executeLifecycleRefine`,
 * `startPipeline`) that's still owned by `dashboard-server.ts`.
 */
import { route } from './route.js';
import * as Z from './schemas.js';
import { bindPlan } from '@esankhan3/anvil-core-pipeline';
export function plansSpawnRoutes() {
    return {
        'run-plan': route({
            input: Z.RunPlan,
            onParseFail: 'silent',
            handle: (input, deps) => {
                const actions = deps.extras.pipelineActions;
                if (!actions)
                    return;
                actions.spawnPlanAgent(input.project, input.feature, input.options?.model);
            },
        }),
        'run-plan-variants': route({
            input: Z.RunPlanVariants,
            handle: (input, deps) => {
                const actions = deps.extras.pipelineActions;
                if (!actions)
                    return;
                const { project, feature, variants, options } = input;
                actions.spawnPlanVariants(project, feature, variants, options?.model);
            },
        }),
        'regen-plan-section': route({
            // The legacy case body destructures from `msg` directly; no
            // dedicated schema. Use `Unknown` (passthrough) and field-check.
            input: Z.RegenPlanSection,
            onParseFail: 'silent',
            handle: (input, deps) => {
                const actions = deps.extras.pipelineActions;
                const planStore = deps.extras.unsafeStores?.planStore;
                if (!actions || !planStore)
                    return;
                const plan = planStore.readCurrent(input.project, input.planSlug);
                if (!plan) {
                    deps.ws.send(JSON.stringify({
                        type: 'error',
                        payload: { message: `Plan ${input.project}/${input.planSlug} not found` },
                    }));
                    return;
                }
                actions.spawnPlanSectionRegen(plan, input.section, input.options?.model);
            },
        }),
        'auto-refine-plan': route({
            input: Z.AutoRefinePlan,
            onParseFail: 'silent',
            handle: async (input, deps) => {
                const planStore = deps.extras.unsafeStores?.planStore;
                const validator = deps.extras.planValidator;
                const dispatch = deps.extras.dispatchLifecycle;
                const refine = deps.extras.executeLifecycleRefine;
                if (!planStore || !validator || !dispatch || !refine)
                    return;
                const plan = planStore.readCurrent(input.project, input.planSlug);
                if (!plan) {
                    deps.ws.send(JSON.stringify({
                        type: 'error',
                        payload: { message: `Plan ${input.project}/${input.planSlug} not found` },
                    }));
                    return;
                }
                try {
                    const validation = validator.validate(plan);
                    if (validation.counts.errors === 0) {
                        deps.ws.send(JSON.stringify({
                            type: 'auto-refine-progress',
                            payload: { summary: 'Nothing to refine — plan is clean.' },
                        }));
                        return;
                    }
                    await dispatch(input.project, input.planSlug, {
                        kind: 'verify-complete',
                        errors: validation.counts.errors,
                        autoFixableCount: validation.issues.filter((i) => i.autoFixable).length,
                        canTargetedRegen: validation.issues.some((i) => i.hint),
                    });
                    await refine(input.project, input.planSlug);
                }
                catch (err) {
                    deps.ws.send(JSON.stringify({
                        type: 'plan-error',
                        payload: { message: `Auto-refine failed: ${err instanceof Error ? err.message : String(err)}` },
                    }));
                }
            },
        }),
        'execute-plan': route({
            input: Z.ExecutePlan,
            handle: async (input, deps) => {
                const actions = deps.extras.pipelineActions;
                const planStore = deps.extras.unsafeStores?.planStore;
                const validator = deps.extras.planValidator;
                const dispatch = deps.extras.dispatchLifecycle;
                if (!actions || !planStore || !validator || !dispatch)
                    return;
                const { project, planSlug, options } = input;
                const force = !!input.force;
                const plan = planStore.readCurrent(project, planSlug);
                if (!plan) {
                    deps.ws.send(JSON.stringify({
                        type: 'error',
                        payload: { message: `Plan ${project}/${planSlug} not found` },
                    }));
                    return;
                }
                const validation = validator.validate(plan);
                planStore.writeValidation(project, planSlug, validation);
                if (validation.counts.errors > 0 && !force) {
                    deps.ws.send(JSON.stringify({
                        type: 'plan-validation',
                        payload: {
                            validation,
                            planSlug,
                            blocked: true,
                            reason: 'errors',
                            message: `Plan has ${validation.counts.errors} error(s). Fix them or pass force=true to execute anyway.`,
                        },
                    }));
                    return;
                }
                const approvalValid = !!plan.approval && plan.approval.planHash === plan.contentHash;
                if (!approvalValid && !force) {
                    deps.ws.send(JSON.stringify({
                        type: 'plan-validation',
                        payload: {
                            validation,
                            planSlug,
                            blocked: true,
                            reason: plan.approval ? 'approval-stale' : 'unapproved',
                            message: plan.approval
                                ? `Plan was approved against hash ${plan.approval.planHash.slice(0, 12)} but is now ${plan.contentHash.slice(0, 12)}. Re-approve or pass force=true.`
                                : 'Plan must be approved before execute. Click "Approve plan" or pass force=true.',
                        },
                    }));
                    return;
                }
                const planBinding = bindPlan(plan);
                const planMarkdown = planStore.renderMarkdown(plan);
                const rawShort = (plan.title && plan.title.trim()) || plan.feature || 'Plan execution';
                const shortFeature = rawShort.length > 120 ? rawShort.slice(0, 117).trimEnd() + '…' : rawShort;
                actions.startPipeline(project, shortFeature, {
                    model: options?.model ?? plan.model ?? 'sonnet',
                    modelTier: options?.modelTier,
                    baseBranch: options?.baseBranch,
                    skipClarify: true,
                    clarifySeedArtifact: `<!-- Generated from Anvil Plan v${plan.version} (${plan.slug}) hash:${planBinding.hashShort} -->\n\n${planMarkdown}`,
                    planSeed: {
                        project: plan.project,
                        slug: plan.slug,
                        version: plan.version,
                        plan,
                    },
                    planBinding,
                });
                deps.ws.send(JSON.stringify({
                    type: 'plan-execute-started',
                    payload: {
                        planSlug,
                        planVersion: plan.version,
                        planHash: planBinding.hash,
                        forced: force && (validation.counts.errors > 0 || !approvalValid),
                        stagesSkipped: ['clarify', 'requirements', 'repo-requirements', 'specs', 'tasks'],
                    },
                }));
                void dispatch(project, planSlug, { kind: 'execute-started' });
            },
        }),
    };
}
//# sourceMappingURL=plans-spawn.js.map