/**
 * `handlerExtras` builder (Phase 3 round-10 extraction from
 * `dashboard-server.ts`).
 *
 * `buildHandlerExtras(deps)` returns the fully-populated
 * `HandlerExtras` bag that the registry threads through every WS
 * action handler. The bag itself isn't doing anything clever — most
 * fields are 1:1 passthroughs of the boot-scope stores + services.
 * The factory just hides the field-by-field assignment + a handful
 * of structural casts behind one call so `dashboard-server.ts`
 * stops being the file that knows every handler's dependency.
 *
 * Mutable refs (`activePipelineRunner`, `activeChild`) are reached
 * through getter/setter callbacks so the boot scope keeps owning the
 * canonical `let` bindings.
 */
export function buildHandlerExtras(deps) {
    return {
        anvilHome: deps.anvilHome,
        shareTokenTtlMs: deps.shareTokenTtlMs,
        defaultUser: deps.defaultUser,
        dispatchLifecycle: (project, planSlug, event) => deps.dispatchLifecycle(project, planSlug, event),
        projectLoader: deps.projectLoader,
        planStore: deps.planStore,
        broadcastCostSnapshot: (project, runId) => deps.broadcastCostSnapshot(project, runId ?? undefined),
        getPlanLifecycleSnapshot: (project, planSlug) => deps.getLifecycleSnapshot(project, planSlug),
        incidentStore: deps.incidentStore,
        replayStore: deps.replayStore,
        boundTestsStore: deps.boundTestsStore,
        boundAuditLog: deps.boundAuditLog,
        autoReplayQueue: deps.autoReplayQueue,
        reviewStore: deps.reviewStore,
        reviewCalibrationStore: deps.reviewCalibrationStore,
        reviewDismissalStore: deps.reviewDismissalStore,
        testSpecStore: deps.testSpecStore,
        testCaseStore: deps.testCaseStore,
        testRunStore: deps.testRunStore,
        kbManager: deps.kbManager,
        conventionPaths: deps.conventionPaths,
        memoryStore: deps.memoryStore,
        costLedger: deps.costLedger,
        costBreachHandler: deps.costBreachHandler,
        pauseStore: deps.pauseStore,
        // PipelineLearningsStore.list narrows `outcome` to a `PlanOutcome`
        // enum, but the registry's `LearningsStoreShape` keeps it as plain
        // `string` (Zod already validates the literal). Cast at the boundary.
        learningsStore: deps.learningsStore,
        checkpointStore: deps.checkpointStore,
        discoverAvailableModels: deps.discoverAvailableModels,
        testLearningsStore: deps.testLearningsStore,
        ciTriageStore: deps.ciTriageStore,
        getWorkspaceFromConfig: deps.getWorkspaceFromConfig,
        buildProjectOverview: deps.buildProjectOverview,
        memoryWriter: deps.memoryStore,
        broadcastActiveRuns: deps.broadcastActiveRuns,
        loadRunsSync: deps.loadRunsSync,
        featureStore: deps.featureStore,
        refreshTrackedPRs: deps.refreshTrackedPRs,
        trackedPRsForBroadcast: deps.trackedPRsForBroadcast,
        activeRuns: deps.activeRuns,
        sendInit: deps.sendInit,
        killAgent: (agentId) => { try {
            deps.agentManager.kill(agentId);
        }
        catch { /* ok */ } },
        sendInput: (text, agentId) => {
            // Mirror the legacy three-way dispatch: pipeline runner → named
            // agent → legacy child stdin. Phase 3 collapses this into a
            // single service method.
            const runner = deps.getActivePipelineRunner();
            if (runner) {
                runner.provideInput(text);
            }
            else if (agentId) {
                try {
                    deps.agentManager.sendInput(agentId, text);
                }
                catch { /* ok */ }
            }
            else {
                const child = deps.getActiveChild();
                if (child?.stdin) {
                    child.stdin.write(text + '\n');
                }
                else {
                    // No active pipeline runner, no named agent, no legacy child stdin —
                    // the input has nowhere to go. This was previously a silent drop
                    // (the canonical "I answered clarify but it stayed stuck" symptom).
                    console.warn('[dashboard] send-input dropped — no active pipeline runner, no agentId, no legacy child stdin');
                }
            }
        },
        cancelPipeline: () => {
            const runner = deps.getActivePipelineRunner();
            if (runner) {
                runner.cancel();
                deps.setActivePipelineRunner(null);
            }
            else {
                deps.cancelLegacyPipeline();
            }
        },
        broadcastRuns: deps.broadcastRuns,
        auditLog: deps.auditLog,
        // Phase 2.6 — closure-dependent pipeline + spawn migrations
        pipelineActions: {
            startPipeline: (project, feature, options) => deps.startPipeline(project, feature, options),
            spawnQuickAction: (action, project, feature, model) => deps.spawnQuickAction(action, project, feature, model),
            spawnPlanAgent: (project, feature, model) => deps.spawnPlanAgent(project, feature, model),
            spawnPlanVariants: (project, feature, variants, model) => deps.spawnPlanVariants(project, feature, variants, model),
            spawnPlanSectionRegen: (plan, section, model) => deps.spawnPlanSectionRegen(plan, section, model),
            startReviewRun: async (project, prUrl, trigger, personas, model, prior) => {
                await deps.startReviewRun(project, prUrl, trigger, personas, model, prior);
            },
            applyReviewFix: (project, reviewId, findingId) => deps.applyReviewFix(project, reviewId, findingId),
        },
        unsafeStores: {
            planStore: deps.planStore,
            reviewStore: deps.reviewStore,
            testSpecStore: deps.testSpecStore,
            testCaseStore: deps.testCaseStore,
            testRunStore: deps.testRunStore,
            testLearningsStore: deps.testLearningsStore,
            incidentStore: deps.incidentStore,
            replayStore: deps.replayStore,
            boundTestsStore: deps.boundTestsStore,
        },
        agentManagerHandle: deps.agentManager,
        agentToRunId: deps.agentToRunId,
        runsDir: deps.runsDir,
        runsIndex: deps.runsIndex,
        getActivePipelineRunner: deps.getActivePipelineRunner,
        planValidator: deps.planValidator,
        executeLifecycleRefine: (project, planSlug) => deps.executeLifecycleRefine(project, planSlug),
        kbManagerRich: {
            getIndexForPrompt: (project) => deps.kbManager.getIndexForPrompt(project),
            getQueryContextForPrompt: (project, feature) => deps.kbManager.getQueryContextForPrompt(project, feature),
            getAllGraphReports: (project) => deps.kbManager.getAllGraphReports(project),
        },
    };
}
//# sourceMappingURL=extras-builder.js.map