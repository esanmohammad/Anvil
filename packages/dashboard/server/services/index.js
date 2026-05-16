/**
 * Service skeletons — one Emittery subclass per domain.
 *
 * Phase 2 ships the shells; Phase 3 tranches migrate `broadcast()`
 * call sites into typed `service.emit(kind, payload)` calls and add
 * domain-method APIs (e.g. `runs.start(input)`).
 *
 * Each service `extends SyncEmitter<EventMap>` where `EventMap` selects
 * the subset of `DashboardEvent` kinds that service owns. Strongly-typed
 * `emit` / `on` flow downstream:
 *
 *   runs.emit('run.started', { runId, project, type, description, model });
 *   //          ^^^^^^^^^^^^   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *   //          discriminator    typed payload (PayloadOf<'run.started'>)
 *
 *   runs.on('run.started', (payload) => { … });  // typed payload
 *
 * The service-bridge (Phase 3) wires each service's `onAny` listener
 * to the EventReplay buffer + (Phase 4) socket.io room emitter.
 *
 * Why one class per domain instead of one giant bus:
 *   - Smaller blast radius on refactor — migrating reviews doesn't touch
 *     plans.
 *   - Single ownership of event vocabulary per domain.
 *   - Test seam — scenarios can hand-roll a fake service per group.
 */
// We use a synchronous emitter (not Emittery) because the legacy bridge
// must call `broadcast(...)` in the same tick as the original handler so
// today's wire-level ordering is preserved through migration. See
// `events/sync-emitter.ts` for the rationale.
import { SyncEmitter } from '../events/sync-emitter.js';
import { recordResolution } from '../review-learner.js';
import { signShareToken, getOrCreateShareSecret } from '../plan-share.js';
export class RunService extends SyncEmitter {
}
export class AgentService extends SyncEmitter {
}
export class PipelineService extends SyncEmitter {
}
export class ReviewService extends SyncEmitter {
    deps;
    constructor(deps) {
        super();
        this.deps = deps;
    }
    requireDeps(method) {
        if (!this.deps) {
            throw new Error(`ReviewService.${method} called without deps. Construct via createServices({ reviews }).`);
        }
        return this.deps;
    }
    /**
     * resolve-review-finding — set finding resolution + feed
     * calibration + suppression-key bookkeeping + emit. Returns the
     * updated review for chain callers; the handler ignores the return
     * because the bridge fans the emit out to subscribers already.
     */
    resolveFinding(input) {
        const { reviewStore, reviewCalibrationStore, reviewDismissalStore, anvilHome } = this.requireDeps('resolveFinding');
        const { project, reviewId, findingId, resolution } = input;
        const prior = reviewStore.readCurrent(project, reviewId);
        const priorFinding = prior?.findings.find((f) => f.id === findingId);
        const updated = reviewStore.setResolution(project, reviewId, findingId, resolution);
        if (!updated)
            return { error: 'finding-not-found' };
        const updatedFinding = updated.findings.find((f) => f.id === findingId);
        if (updatedFinding && priorFinding) {
            // Learner: log the transition for offline tuning.
            try {
                recordResolution(anvilHome, project, updated, updatedFinding, priorFinding.resolution);
            }
            catch (err) {
                console.warn('[review] recordResolution failed:', err);
            }
            // Calibration: feed empirical outcome into the per-persona store.
            try {
                const outcome = resolution === 'addressed' ? 'accepted'
                    : resolution === 'wont-fix' ? 'wontFix'
                        : resolution === 'dismissed' ? 'dismissed'
                            : 'pending';
                reviewCalibrationStore.recordOutcome(project, {
                    personaId: updatedFinding.persona ?? 'unknown',
                    statedConfidence: updatedFinding.confidence === 'high' ? 0.9
                        : updatedFinding.confidence === 'med' ? 0.6
                            : 0.3,
                    outcome,
                });
            }
            catch { /* opportunistic */ }
            // Dismissal-loop: record suppression key when applicable.
            if (resolution === 'dismissed' || resolution === 'wont-fix') {
                try {
                    const fp = updatedFinding.file ?? '';
                    const segs = fp.split('/');
                    const filePattern = segs.length > 1
                        ? `${segs.slice(0, 2).join('/')}/**/*${fp.match(/\.[^./]+$/)?.[0] ?? ''}`
                        : fp;
                    reviewDismissalStore.record(project, {
                        personaId: updatedFinding.persona ?? 'unknown',
                        claimType: (updatedFinding.category ?? 'other'),
                        filePattern,
                    });
                }
                catch { /* opportunistic */ }
            }
        }
        this.emit('review.finding-resolved', { reviewId, findingId, resolution, review: updated });
        return { updated };
    }
    /**
     * apply-review-patch — applies a proposed patch against the first
     * available repo clone for the project. Returns the `ApplyPatchResult`
     * straight from `review-patch-applier`; the handler echoes it on
     * `review-patch-applied`.
     */
    async applyPatch(input) {
        const { projectLoader } = this.requireDeps('applyPatch');
        const repoPaths = projectLoader.getRepoLocalPaths(input.project);
        const fsMod = await import('node:fs');
        const repoPath = Object.values(repoPaths).find((p) => p && fsMod.existsSync(p));
        if (!repoPath)
            return { error: 'no-repo-clone' };
        const { applyReviewPatch } = await import('../review-patch-applier.js');
        const result = await applyReviewPatch(input, { repoLocalPath: repoPath });
        return { result };
    }
    /**
     * publish-review — render + post review comments to the PR. The
     * actual posting lives in `review-publisher.ts`; this method just
     * wraps store-read + call + emit, and returns the publish result so
     * the handler can echo on `review-published`.
     */
    async publish(input) {
        const { reviewStore } = this.requireDeps('publish');
        const review = reviewStore.readCurrent(input.project, input.reviewId);
        if (!review)
            return { error: 'review-not-found' };
        const { publishReview } = await import('../review-publisher.js');
        const result = await publishReview(review);
        return { result };
    }
}
export class PlanService extends SyncEmitter {
    deps;
    constructor(deps) {
        super();
        this.deps = deps;
    }
    requireDeps(method) {
        if (!this.deps) {
            throw new Error(`PlanService.${method} called without deps. Construct via createServices({ planStore }).`);
        }
        return this.deps;
    }
    /** add-plan-comment — append a comment + emit. */
    addComment(input) {
        const { planStore } = this.requireDeps('addComment');
        const comment = planStore.addComment(input.project, input.planSlug, input.sectionPath, input.body, input.author);
        this.emit('plan.comment-added', { planSlug: input.planSlug, comment });
        return { comment };
    }
    /** resolve-plan-comment — mark resolved + emit. */
    resolveComment(input) {
        const { planStore } = this.requireDeps('resolveComment');
        const ok = planStore.resolveComment(input.project, input.planSlug, input.commentId);
        this.emit('plan.comment-resolved', { planSlug: input.planSlug, commentId: input.commentId, ok });
        return { ok };
    }
    /** delete-plan-comment — remove comment + emit. */
    deleteComment(input) {
        const { planStore } = this.requireDeps('deleteComment');
        const ok = planStore.deleteComment(input.project, input.planSlug, input.commentId);
        this.emit('plan.comment-deleted', { planSlug: input.planSlug, commentId: input.commentId, ok });
        return { ok };
    }
    /**
     * approve-plan — append approval record + emit. The dashboard's
     * `dispatchLifecycle({ kind: 'approve' })` call stays handler-side
     * because lifecycle dispatch is owned outside the plan store. Recipe 7
     * will inject `dispatchLifecycle` as a dep so this returns to one line.
     */
    approve(input, user) {
        const { planStore } = this.requireDeps('approve');
        const approval = planStore.addApproval(input.project, input.planSlug, user, input.note);
        this.emit('plan.approved', { planSlug: input.planSlug, approval });
        return { approval };
    }
    /**
     * adopt-plan-variant — clone a variant into a fresh canonical plan,
     * validate, and persist the validation. The handler echoes the
     * adopted plan + validation + originating slug back to the caller.
     */
    adoptVariant(input) {
        const { planStore, planValidator } = this.requireDeps('adoptVariant');
        const variant = planStore.readCurrent(input.project, input.planSlug);
        if (!variant)
            return { error: 'variant-not-found' };
        // Strip generated fields so createPlan resets them on the clone.
        const { slug: _s, version: _v, createdAt: _c, updatedAt: _u, project: _p, ...rest } = variant;
        void _s;
        void _v;
        void _c;
        void _u;
        void _p;
        const adopted = planStore.createPlan(input.project, variant.feature, variant.model, rest);
        const validation = planValidator.validate(adopted);
        planStore.writeValidation(input.project, adopted.slug, validation);
        return { plan: adopted, validation, adoptedFrom: variant.slug };
    }
    /**
     * validate-plan — re-run the validator with optional deep checks
     * (budget caps + gh repo mapping are looked up by the handler since
     * they cross service boundaries into `projectLoader`).
     */
    validate(input, extra) {
        const { planStore, planValidator } = this.requireDeps('validate');
        const plan = planStore.readCurrent(input.project, input.planSlug);
        if (!plan)
            return { error: 'plan-not-found' };
        const validation = planValidator.validate(plan, {
            deep: !!input.deep,
            maxPerRun: extra.maxPerRun,
            maxPerDay: extra.maxPerDay,
            githubByRepoName: extra.githubByRepoName,
        });
        planStore.writeValidation(input.project, input.planSlug, validation);
        return { validation };
    }
    /**
     * estimate-plan — deterministic what-if estimate; no LLM, no store
     * write. Pure compute over the persisted plan + overrides.
     */
    /**
     * save-plan — bump the plan version with a partial update + validate +
     * persist. Returns the new plan + validation so the handler can echo
     * `plan-updated` and fire lifecycle ticks (which stay handler-side
     * because `dispatchLifecycle` lives outside the plan domain).
     */
    save(input) {
        const { planStore, planValidator } = this.requireDeps('save');
        const next = planStore.bumpVersion(input.project, input.planSlug, input.plan);
        const validation = planValidator.validate(next);
        planStore.writeValidation(input.project, input.planSlug, validation);
        return { plan: next, validation };
    }
    /**
     * share-plan — mint a signed share-token + URL for the current
     * plan version. The handler owns the share-secret resolution
     * (`getOrCreateShareSecret(anvilHome)`) so the service stays pure-data.
     */
    share(input, deps) {
        const { planStore } = this.requireDeps('share');
        const plan = planStore.readCurrent(input.project, input.planSlug);
        if (!plan)
            return { error: 'plan-not-found' };
        const ttl = input.ttlMs ?? deps.defaultTtlMs;
        const expiresAt = Date.now() + ttl;
        const secret = getOrCreateShareSecret(deps.anvilHome);
        const token = signShareToken({
            project: plan.project,
            slug: plan.slug,
            version: plan.version,
            expiresAt,
        }, secret);
        const url = input.httpPort
            ? `http://localhost:${input.httpPort}/share/plan/${token}`
            : `/share/plan/${token}`;
        return { token, url, expiresAt };
    }
    estimate(input) {
        const { planStore } = this.requireDeps('estimate');
        const base = planStore.readCurrent(input.project, input.planSlug);
        if (!base)
            return { error: 'plan-not-found' };
        const excludeRepos = input.excludeRepos ?? [];
        const tier = input.modelTier ?? 'balanced';
        const tierMultiplier = { fast: 0.35, balanced: 1, thorough: 2.2 }[tier];
        const keptRepos = base.repos.filter((r) => !excludeRepos.includes(r.name));
        const perRepoUsd = base.repos.length ? base.estimate.usd / base.repos.length : 0;
        const perRepoMin = base.repos.length ? base.estimate.minutes / base.repos.length : 0;
        const estimate = {
            usd: Number((perRepoUsd * keptRepos.length * tierMultiplier).toFixed(2)),
            minutes: Math.round(perRepoMin * keptRepos.length * tierMultiplier),
            prs: keptRepos.length,
        };
        return { estimate, excludedRepos: excludeRepos, modelTier: tier, keptRepoCount: keptRepos.length };
    }
}
export class TestService extends SyncEmitter {
}
export class BindService extends SyncEmitter {
    deps;
    constructor(deps) {
        super();
        this.deps = deps;
    }
    requireDeps(method) {
        if (!this.deps) {
            throw new Error(`BindService.${method} called without deps. Construct via createServices({ bind }).`);
        }
        return this.deps;
    }
    /**
     * override-bind — remove a bound test by replayId. Returns the
     * removed BoundTest record so the handler can plumb it into Slack
     * notifiers. The handler still owns the Slack call because
     * `notifyBindOverride` lives outside the bind domain.
     */
    overrideByReplayId(input) {
        const { boundTestsStore } = this.requireDeps('overrideByReplayId');
        const bound = boundTestsStore.listBound(input.project).find((b) => b.replayId === input.replayId);
        if (!bound)
            return { error: 'bound-not-found' };
        const removed = boundTestsStore.removeBound(input.project, bound.filePath, input.reason);
        if (!removed)
            return { error: 'override-failed' };
        this.emit('bind.overridden', {
            replayId: input.replayId,
            filePath: removed.filePath,
            incidentId: removed.incidentId,
        });
        return { removed };
    }
    /**
     * override-bound-test — remove + write audit-log entry + emit.
     * Returns the audit-log entry so the handler can echo it back over
     * the wire as `bound-override-applied`.
     */
    overrideByFilePath(input) {
        const { boundTestsStore, boundAuditLog } = this.requireDeps('overrideByFilePath');
        boundTestsStore.removeBound(input.project, input.filePath, input.reason);
        const entry = boundAuditLog.record({
            project: input.project,
            filePath: input.filePath,
            event: 'overridden',
            actor: 'dashboard-user',
            details: { reason: input.reason },
        });
        this.emit('bind.override-applied', { entry });
        return { entry };
    }
}
export class IncidentService extends SyncEmitter {
    deps;
    constructor(deps) {
        super();
        this.deps = deps;
    }
    requireDeps(method) {
        if (!this.deps) {
            throw new Error(`IncidentService.${method} called without deps. Construct via createServices({ incidents }).`);
        }
        return this.deps;
    }
    /**
     * ingest-incident — parse a source-specific event, normalize, persist,
     * emit. Throws `unsupported-source` for sources the parsers don't know,
     * `parse-failed` for parser exceptions; the handler maps both to the
     * legacy `incident-error` wire type.
     */
    async ingest(input) {
        const { incidentStore } = this.requireDeps('ingest');
        const parsers = await import('../incident-parsers/index.js');
        let parsed;
        try {
            switch (input.source) {
                case 'sentry':
                    parsed = parsers.parseSentryEvent(input.payload);
                    break;
                case 'incident.io':
                    parsed = parsers.parseIncidentIoEvent(input.payload);
                    break;
                case 'datadog':
                    parsed = parsers.parseDatadogAlert(input.payload);
                    break;
                case 'manual': {
                    const p = input.payload;
                    if (!p.stackTrace)
                        throw new Error('manual source requires stackTrace');
                    parsed = parsers.parseGenericStackTrace({
                        stackTrace: p.stackTrace, title: p.title, url: p.url, summary: p.summary,
                    });
                    break;
                }
                default: {
                    // ts-pattern would flag this; using exhaustive switch by hand for now.
                    const exhaustive = input.source;
                    return { error: `Unsupported source: ${exhaustive}` };
                }
            }
        }
        catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
        }
        const incident = incidentStore.ingest(input.project, input.source, parsed.externalId, parsed);
        this.emit('incident.ingested', { incident });
        return { incident };
    }
}
export class KbService extends SyncEmitter {
    deps;
    constructor(deps) {
        super();
        this.deps = deps;
    }
    requireDeps(method) {
        if (!this.deps) {
            throw new Error(`KbService.${method} called without deps. Construct via createServices({ kb }).`);
        }
        return this.deps;
    }
    /**
     * refresh-knowledge-base — async fire-and-forget rebuild. Returns
     * synchronously after starting the job. Progress + terminal status
     * stream through `this.emit('kb.progress' | 'kb.status', ...)`. The
     * handler echoes `kb-refresh-started` so the UI can flip its badge.
     *
     * Returns `{ inProgress: true }` if a refresh is already underway —
     * the handler maps that to the legacy `error` wire type.
     */
    refresh(input) {
        const { kbManager } = this.requireDeps('refresh');
        if (kbManager.isRefreshing())
            return { inProgress: true };
        const { project } = input;
        kbManager.refreshProject(project, (progress) => {
            this.emit('kb.progress', { progress });
        }).then((status) => {
            this.emit('kb.status', { status });
        }).catch((err) => {
            this.emit('kb.status', {
                status: {
                    project,
                    repos: [],
                    overallStatus: 'unavailable',
                    lastRefreshed: null,
                    currentProgress: null,
                    error: err.message,
                },
            });
        });
        return { started: true };
    }
}
export class CostService extends SyncEmitter {
    /**
     * Cost has a circular dep: `CostBreachHandler.onNotify` calls
     * `services.cost.emit('cost.breach', ...)`, but `respondBreach` needs
     * the handler. We resolve this by exposing `setDeps(...)` — the caller
     * constructs `services` first (without cost deps), wires the handler
     * with a closure over `services.cost.emit`, then back-fills the deps.
     */
    deps;
    constructor(deps) {
        super();
        if (deps)
            this.deps = deps;
    }
    /** Late-bind the cost-breach handler — see class docstring. */
    setDeps(deps) {
        this.deps = deps;
    }
    requireDeps(method) {
        if (!this.deps) {
            throw new Error(`CostService.${method} called without deps. Call services.cost.setDeps(...) after construction.`);
        }
        return this.deps;
    }
    /**
     * respond-cost-breach — `raise` (cap up by deltaUsd), `reject` (kill
     * the run), `extend` (grace window by extendSeconds). Emits
     * `cost.breach` with the updated record, appends to telemetry log,
     * and returns `{ breach, project }` so the handler can drive the
     * downstream `broadcastCostSnapshot(project, runId)`.
     */
    async respondBreach(input) {
        const { costBreachHandler, breachLogDir } = this.requireDeps('respondBreach');
        const { runId, decision, deltaUsd, extendSeconds } = input;
        const updated = await costBreachHandler.respond(runId, decision, deltaUsd, extendSeconds);
        this.emit('cost.breach', { breach: updated });
        // Telemetry: append decision row to NDJSON for tuning hints. Failures
        // are non-fatal — telemetry shouldn't block the operator's decision.
        try {
            const { existsSync, mkdirSync, appendFileSync } = await import('node:fs');
            const { join } = await import('node:path');
            if (!existsSync(breachLogDir))
                mkdirSync(breachLogDir, { recursive: true });
            const dec = {
                runId,
                project: updated.project,
                decision,
                deltaUsdApproved: decision === 'raise' ? (deltaUsd ?? 0) : 0,
                autoResolved: false,
                decisionLatencyMs: Math.max(0, Date.parse(updated.decisionAt ?? new Date().toISOString()) - Date.parse(updated.breachedAt)),
                at: new Date().toISOString(),
            };
            appendFileSync(join(breachLogDir, 'decisions.ndjson'), JSON.stringify(dec) + '\n', 'utf-8');
        }
        catch { /* telemetry best-effort */ }
        return { breach: updated, project: updated.project };
    }
}
export class ProjectGraphService extends SyncEmitter {
    deps;
    constructor(deps) {
        super();
        this.deps = deps;
    }
    requireDeps(method) {
        if (!this.deps) {
            throw new Error(`ProjectGraphService.${method} called without deps. Construct via createServices({ projectGraph }).`);
        }
        return this.deps;
    }
    /**
     * build-project-graph — fire-and-forget kickoff. Emits 'started'
     * immediately, then 'progress' over the build, ending in either
     * 'complete' or 'error'. Errors during the run are caught and emitted
     * rather than thrown.
     */
    build(input) {
        const { anvilHome } = this.requireDeps('build');
        const { project } = input;
        this.emit('project-graph.started', { project });
        void (async () => {
            try {
                const { buildProjectGraph } = await import('@esankhan3/anvil-knowledge-core');
                const { existsSync } = await import('node:fs');
                const { join } = await import('node:path');
                const factoryPath = [
                    join(anvilHome, 'projects', project, 'factory.yaml'),
                    join(anvilHome, 'projects', project, 'project.yaml'),
                ].find((p) => existsSync(p));
                if (!factoryPath) {
                    throw new Error(`No factory.yaml found for project "${project}"`);
                }
                const graph = await buildProjectGraph(project, factoryPath, {
                    provider: input.provider,
                    model: input.model,
                    onProgress: (message) => {
                        this.emit('project-graph.progress', { project, message });
                    },
                });
                this.emit('project-graph.complete', {
                    project,
                    generatedAt: graph.meta.generatedAt,
                    model: graph.meta.model,
                    provider: graph.meta.provider,
                    costUsd: graph.meta.costUsd,
                    repoRoles: Object.keys(graph.repoRoles).length,
                    relationships: graph.relationships.length,
                    keyFlows: graph.keyFlows.length,
                });
            }
            catch (err) {
                this.emit('project-graph.error', {
                    project,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        })();
    }
}
export class SystemService extends SyncEmitter {
}
/**
 * Construct a fresh service bundle. Each service starts with zero
 * subscribers — the bridge attaches them in Phase 3.
 *
 * Pass `methodDeps` to enable mutation methods on individual services.
 * Tests that only need emit/on can omit the argument.
 */
export function createServices(methodDeps) {
    return {
        runs: new RunService(),
        agents: new AgentService(),
        pipeline: new PipelineService(),
        reviews: new ReviewService(methodDeps?.reviews),
        plans: new PlanService(methodDeps?.plans),
        tests: new TestService(),
        bind: new BindService(methodDeps?.bind),
        incidents: new IncidentService(methodDeps?.incidents),
        kb: new KbService(methodDeps?.kb),
        cost: new CostService(methodDeps?.cost),
        projectGraph: new ProjectGraphService(methodDeps?.projectGraph),
        system: new SystemService(),
    };
}
//# sourceMappingURL=index.js.map