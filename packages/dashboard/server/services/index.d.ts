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
import { SyncEmitter } from '../events/sync-emitter.js';
import type { PayloadOf } from '../events/types.js';
import type { PlanStore, Plan, PlanApproval, PlanComment } from '../plan-store.js';
import type { PlanValidator, PlanValidation } from '../plan-validator.js';
import type { BoundTestsStore, BoundTest } from '../bound-tests.js';
import type { BoundTestsAuditLog } from '../bound-tests-audit.js';
import type { ReviewStore, Review } from '../review-store.js';
import type { IncidentStore } from '../incident-store.js';
import type { KnowledgeBaseManager } from '../knowledge-base-manager.js';
import type { CostBreachHandler } from '../cost-breach-handler.js';
import type { ReviewCalibrationStore } from '../review-calibration.js';
import type { ReviewDismissalStore } from '../review-dismissal-store.js';
import type { ProjectLoader } from '../project-loader.js';
import type * as Z from '../handlers/schemas.js';
interface RunEventMap {
    'run.started': PayloadOf<'run.started'>;
    'run.state-changed': PayloadOf<'run.state-changed'>;
    'run.completed': PayloadOf<'run.completed'>;
    'run.stopped': PayloadOf<'run.stopped'>;
    'run.rejected': PayloadOf<'run.rejected'>;
    'run.active-snapshot': PayloadOf<'run.active-snapshot'>;
    'runs.list': PayloadOf<'runs.list'>;
}
export declare class RunService extends SyncEmitter<RunEventMap> {
}
interface AgentEventMap {
    'agent.spawned': PayloadOf<'agent.spawned'>;
    'agent.output': PayloadOf<'agent.output'>;
    'agent.done': PayloadOf<'agent.done'>;
    'agent.error': PayloadOf<'agent.error'>;
}
export declare class AgentService extends SyncEmitter<AgentEventMap> {
}
interface PipelineEventMap {
    'pipeline.paused': PayloadOf<'pipeline.paused'>;
    'pipeline.resumed': PayloadOf<'pipeline.resumed'>;
    'pipeline.cancelled': PayloadOf<'pipeline.cancelled'>;
    'pipeline.waiting-for-input': PayloadOf<'pipeline.waiting-for-input'>;
    'pipeline.auth-required': PayloadOf<'pipeline.auth-required'>;
    'pipeline.interrupted-snapshot': PayloadOf<'pipeline.interrupted-snapshot'>;
}
export declare class PipelineService extends SyncEmitter<PipelineEventMap> {
}
interface ReviewEventMap {
    'review.created': PayloadOf<'review.created'>;
    'review.error': PayloadOf<'review.error'>;
    'review.started': PayloadOf<'review.started'>;
    'review.kb-summary': PayloadOf<'review.kb-summary'>;
    'review.persona-done': PayloadOf<'review.persona-done'>;
    'review.published': PayloadOf<'review.published'>;
    'review.finding-resolved': PayloadOf<'review.finding-resolved'>;
}
/**
 * Review-domain operations. Mutation methods land here as they migrate
 * out of `dashboard-server.ts`. The longer-running PR-review entry points
 * (`runPr`, `runIncremental`, `applyFix`) still depend on closures inside
 * `startDashboardServer` and will move when those closures get extracted
 * (Phase 2 of the decomposition plan).
 */
export interface ReviewServiceDeps {
    reviewStore: ReviewStore;
    reviewCalibrationStore: ReviewCalibrationStore;
    reviewDismissalStore: ReviewDismissalStore;
    projectLoader: ProjectLoader;
    anvilHome: string;
}
export declare class ReviewService extends SyncEmitter<ReviewEventMap> {
    private readonly deps?;
    constructor(deps?: ReviewServiceDeps | undefined);
    private requireDeps;
    /**
     * resolve-review-finding — set finding resolution + feed
     * calibration + suppression-key bookkeeping + emit. Returns the
     * updated review for chain callers; the handler ignores the return
     * because the bridge fans the emit out to subscribers already.
     */
    resolveFinding(input: Z.ResolveReviewFindingInput): {
        updated: Review;
    } | {
        error: 'finding-not-found';
    };
    /**
     * apply-review-patch — applies a proposed patch against the first
     * available repo clone for the project. Returns the `ApplyPatchResult`
     * straight from `review-patch-applier`; the handler echoes it on
     * `review-patch-applied`.
     */
    applyPatch(input: Z.ApplyReviewPatchInput): Promise<{
        result: Awaited<ReturnType<typeof import('../review-patch-applier.js').applyReviewPatch>>;
    } | {
        error: 'no-repo-clone';
    }>;
    /**
     * publish-review — render + post review comments to the PR. The
     * actual posting lives in `review-publisher.ts`; this method just
     * wraps store-read + call + emit, and returns the publish result so
     * the handler can echo on `review-published`.
     */
    publish(input: Z.PublishReviewInput): Promise<{
        result: Awaited<ReturnType<typeof import('../review-publisher.js').publishReview>>;
    } | {
        error: 'review-not-found';
    }>;
}
interface PlanEventMap {
    'plan.created': PayloadOf<'plan.created'>;
    'plan.updated': PayloadOf<'plan.updated'>;
    'plan.validation': PayloadOf<'plan.validation'>;
    'plan.lifecycle': PayloadOf<'plan.lifecycle'>;
    'plan.comment-added': PayloadOf<'plan.comment-added'>;
    'plan.comment-resolved': PayloadOf<'plan.comment-resolved'>;
    'plan.comment-deleted': PayloadOf<'plan.comment-deleted'>;
    'plan.approved': PayloadOf<'plan.approved'>;
    'plan.error': PayloadOf<'plan.error'>;
    'plan.variants-started': PayloadOf<'plan.variants-started'>;
    'plan.variant-created': PayloadOf<'plan.variant-created'>;
    'plan.auto-refine-progress': PayloadOf<'plan.auto-refine-progress'>;
}
/**
 * Plan-domain operations. Constructor deps are optional so emit-only
 * call sites (e.g. tests) can still `new PlanService()`. When deps are
 * present, the service owns plan-store mutation + the matching emit; the
 * handler shrinks to `await services.plans.<method>(parsed.data)`.
 *
 * Methods land tranche-by-tranche through Prereq B. Each maps 1:1 to a
 * Z.<Action>Input from `handlers/schemas.ts`. Side-effects that cross
 * the service boundary (e.g. lifecycle dispatch, pipeline spawn) stay
 * handler-side for now — those land as deps in a later tranche.
 */
export interface PlanServiceDeps {
    planStore: PlanStore;
    planValidator: PlanValidator;
}
export declare class PlanService extends SyncEmitter<PlanEventMap> {
    private readonly deps?;
    constructor(deps?: PlanServiceDeps | undefined);
    private requireDeps;
    /** add-plan-comment — append a comment + emit. */
    addComment(input: Z.AddPlanCommentInput): {
        comment: PlanComment;
    };
    /** resolve-plan-comment — mark resolved + emit. */
    resolveComment(input: Z.ResolvePlanCommentInput): {
        ok: boolean;
    };
    /** delete-plan-comment — remove comment + emit. */
    deleteComment(input: Z.DeletePlanCommentInput): {
        ok: boolean;
    };
    /**
     * approve-plan — append approval record + emit. The dashboard's
     * `dispatchLifecycle({ kind: 'approve' })` call stays handler-side
     * because lifecycle dispatch is owned outside the plan store. Recipe 7
     * will inject `dispatchLifecycle` as a dep so this returns to one line.
     */
    approve(input: Z.ApprovePlanInput, user: string): {
        approval: PlanApproval;
    };
    /**
     * adopt-plan-variant — clone a variant into a fresh canonical plan,
     * validate, and persist the validation. The handler echoes the
     * adopted plan + validation + originating slug back to the caller.
     */
    adoptVariant(input: Z.AdoptPlanVariantInput): {
        plan: Plan;
        validation: PlanValidation;
        adoptedFrom: string;
    } | {
        error: 'variant-not-found';
    };
    /**
     * validate-plan — re-run the validator with optional deep checks
     * (budget caps + gh repo mapping are looked up by the handler since
     * they cross service boundaries into `projectLoader`).
     */
    validate(input: Z.ValidatePlanInput, extra: {
        maxPerRun?: number;
        maxPerDay?: number;
        githubByRepoName: Record<string, string>;
    }): {
        validation: PlanValidation;
    } | {
        error: 'plan-not-found';
    };
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
    save(input: Z.SavePlanInput): {
        plan: Plan;
        validation: PlanValidation;
    };
    /**
     * share-plan — mint a signed share-token + URL for the current
     * plan version. The handler owns the share-secret resolution
     * (`getOrCreateShareSecret(anvilHome)`) so the service stays pure-data.
     */
    share(input: Z.SharePlanInput, deps: {
        anvilHome: string;
        defaultTtlMs: number;
    }): {
        token: string;
        url: string;
        expiresAt: number;
    } | {
        error: 'plan-not-found';
    };
    estimate(input: Z.EstimatePlanInput): {
        estimate: {
            usd: number;
            minutes: number;
            prs: number;
        };
        excludedRepos: string[];
        modelTier: 'fast' | 'balanced' | 'thorough';
        keptRepoCount: number;
    } | {
        error: 'plan-not-found';
    };
}
interface TestEventMap {
    'test.run-log': PayloadOf<'test.run-log'>;
    'test.specs': PayloadOf<'test.specs'>;
    'test.spec-created': PayloadOf<'test.spec-created'>;
    'test.review-persona-start': PayloadOf<'test.review-persona-start'>;
    'test.review-persona-done': PayloadOf<'test.review-persona-done'>;
    'test.review-persona-error': PayloadOf<'test.review-persona-error'>;
    'test.mutation-log': PayloadOf<'test.mutation-log'>;
    'test.polish-case-start': PayloadOf<'test.polish-case-start'>;
    'test.polish-case-done': PayloadOf<'test.polish-case-done'>;
    'test.polish-case-error': PayloadOf<'test.polish-case-error'>;
    'test.regen-complete': PayloadOf<'test.regen-complete'>;
    'test.contract-complete': PayloadOf<'test.contract-complete'>;
    'test.scenarios-complete': PayloadOf<'test.scenarios-complete'>;
    'test.flakiness-case-start': PayloadOf<'test.flakiness-case-start'>;
    'test.flakiness-case-done': PayloadOf<'test.flakiness-case-done'>;
    'test.flakiness-case-error': PayloadOf<'test.flakiness-case-error'>;
    'test.flakiness-complete': PayloadOf<'test.flakiness-complete'>;
    'test.review-complete': PayloadOf<'test.review-complete'>;
    'test.finding-resolved': PayloadOf<'test.finding-resolved'>;
}
export declare class TestService extends SyncEmitter<TestEventMap> {
}
interface BindEventMap {
    'bind.overridden': PayloadOf<'bind.overridden'>;
    'bind.override-applied': PayloadOf<'bind.override-applied'>;
}
/**
 * Bind-domain operations. Two override paths:
 *   - `overrideByReplayId` — looks up by replayId (back-compat for the
 *     `override-bind` action; emits `bind.overridden`).
 *   - `overrideByFilePath` — direct file lookup + audit-log entry +
 *     `bind.override-applied`. Recipe 7 will fold both into one shape.
 */
export interface BindServiceDeps {
    boundTestsStore: BoundTestsStore;
    boundAuditLog: BoundTestsAuditLog;
}
export declare class BindService extends SyncEmitter<BindEventMap> {
    private readonly deps?;
    constructor(deps?: BindServiceDeps | undefined);
    private requireDeps;
    /**
     * override-bind — remove a bound test by replayId. Returns the
     * removed BoundTest record so the handler can plumb it into Slack
     * notifiers. The handler still owns the Slack call because
     * `notifyBindOverride` lives outside the bind domain.
     */
    overrideByReplayId(input: Z.OverrideBindInput): {
        removed: BoundTest;
    } | {
        error: 'bound-not-found' | 'override-failed';
    };
    /**
     * override-bound-test — remove + write audit-log entry + emit.
     * Returns the audit-log entry so the handler can echo it back over
     * the wire as `bound-override-applied`.
     */
    overrideByFilePath(input: Z.OverrideBoundTestInput): {
        entry: ReturnType<BoundTestsAuditLog['record']>;
    };
}
interface IncidentEventMap {
    'incident.ingested': PayloadOf<'incident.ingested'>;
    'replay.queued': PayloadOf<'replay.queued'>;
    'replay.step': PayloadOf<'replay.step'>;
    'replay.complete': PayloadOf<'replay.complete'>;
}
/**
 * Incident-domain operations. `ingest` parses the source-specific event
 * shape, normalizes it, and writes to the store. `replay-incident` stays
 * handler-side for now because it spawns the replay pipeline (which has
 * a fat dep surface — agent manager, test stores, project loader, etc.)
 * — that lands in a later tranche.
 */
export interface IncidentServiceDeps {
    incidentStore: IncidentStore;
}
export declare class IncidentService extends SyncEmitter<IncidentEventMap> {
    private readonly deps?;
    constructor(deps?: IncidentServiceDeps | undefined);
    private requireDeps;
    /**
     * ingest-incident — parse a source-specific event, normalize, persist,
     * emit. Throws `unsupported-source` for sources the parsers don't know,
     * `parse-failed` for parser exceptions; the handler maps both to the
     * legacy `incident-error` wire type.
     */
    ingest(input: Z.IngestIncidentInput): Promise<{
        incident: ReturnType<IncidentStore['ingest']>;
    } | {
        error: string;
    }>;
}
interface KbEventMap {
    'kb.progress': PayloadOf<'kb.progress'>;
    'kb.status': PayloadOf<'kb.status'>;
}
/**
 * KB-domain operations. `refresh` is the only mutation (kicks off an
 * async index rebuild + streams progress through the service emit). Read
 * paths (`get-kb-data`, `query-kb`, `get-kb-index`, `get-kb-status`)
 * stay handler-side because they're pure reads through `kbManager`.
 */
export interface KbServiceDeps {
    kbManager: KnowledgeBaseManager;
}
export declare class KbService extends SyncEmitter<KbEventMap> {
    private readonly deps?;
    constructor(deps?: KbServiceDeps | undefined);
    private requireDeps;
    /**
     * refresh-knowledge-base — async fire-and-forget rebuild. Returns
     * synchronously after starting the job. Progress + terminal status
     * stream through `this.emit('kb.progress' | 'kb.status', ...)`. The
     * handler echoes `kb-refresh-started` so the UI can flip its badge.
     *
     * Returns `{ inProgress: true }` if a refresh is already underway —
     * the handler maps that to the legacy `error` wire type.
     */
    refresh(input: Z.RefreshKnowledgeBaseInput): {
        started: true;
    } | {
        inProgress: true;
    };
}
interface CostEventMap {
    'cost.breach': PayloadOf<'cost.breach'>;
    'cost.snapshot': PayloadOf<'cost.snapshot'>;
}
/**
 * Cost-domain operations. `respondBreach` is the only mutation today —
 * the operator decides to raise/reject/extend a breach. The handler
 * still owns `broadcastCostSnapshot` because that closure lives inside
 * `startDashboardServer` and depends on the live runner registry; once
 * the registry is extracted (Phase 2) it folds into a dep here.
 *
 * Telemetry NDJSON append lives in the service since it's pure-disk
 * with no other deps — the file path comes through as `breachLogDir`.
 */
export interface CostServiceDeps {
    costBreachHandler: CostBreachHandler;
    /** Directory to append `decisions.ndjson` to — typically `<anvilHome>/cost-breaches`. */
    breachLogDir: string;
}
export declare class CostService extends SyncEmitter<CostEventMap> {
    /**
     * Cost has a circular dep: `CostBreachHandler.onNotify` calls
     * `services.cost.emit('cost.breach', ...)`, but `respondBreach` needs
     * the handler. We resolve this by exposing `setDeps(...)` — the caller
     * constructs `services` first (without cost deps), wires the handler
     * with a closure over `services.cost.emit`, then back-fills the deps.
     */
    private deps?;
    constructor(deps?: CostServiceDeps);
    /** Late-bind the cost-breach handler — see class docstring. */
    setDeps(deps: CostServiceDeps): void;
    private requireDeps;
    /**
     * respond-cost-breach — `raise` (cap up by deltaUsd), `reject` (kill
     * the run), `extend` (grace window by extendSeconds). Emits
     * `cost.breach` with the updated record, appends to telemetry log,
     * and returns `{ breach, project }` so the handler can drive the
     * downstream `broadcastCostSnapshot(project, runId)`.
     */
    respondBreach(input: Z.RespondCostBreachInput): Promise<{
        breach: Awaited<ReturnType<CostBreachHandler['respond']>>;
        project: string;
    }>;
}
interface ProjectGraphEventMap {
    'project-graph.started': PayloadOf<'project-graph.started'>;
    'project-graph.progress': PayloadOf<'project-graph.progress'>;
    'project-graph.complete': PayloadOf<'project-graph.complete'>;
    'project-graph.error': PayloadOf<'project-graph.error'>;
}
/**
 * Project-graph operations. `build` kicks off the async LLM-driven
 * cross-repo graph build (knowledge-core's `buildProjectGraph`). Progress
 * + terminal status stream through `this.emit(...)`. Read paths
 * (`get-project-graph-status`, `get-graph-nodes`) stay handler-side.
 */
export interface ProjectGraphServiceDeps {
    anvilHome: string;
}
export declare class ProjectGraphService extends SyncEmitter<ProjectGraphEventMap> {
    private readonly deps?;
    constructor(deps?: ProjectGraphServiceDeps | undefined);
    private requireDeps;
    /**
     * build-project-graph — fire-and-forget kickoff. Emits 'started'
     * immediately, then 'progress' over the build, ending in either
     * 'complete' or 'error'. Errors during the run are caught and emitted
     * rather than thrown.
     */
    build(input: Z.BuildProjectGraphInput): void;
}
interface SystemEventMap {
    'state': PayloadOf<'state'>;
    'prs.updated': PayloadOf<'prs.updated'>;
    'artifact': PayloadOf<'artifact'>;
}
export declare class SystemService extends SyncEmitter<SystemEventMap> {
}
/**
 * The full set of dashboard services. Phase 3 will pass this struct as
 * `deps.services` into handler factories so handlers emit through the
 * right domain owner. The service-bridge (Phase 3) wires each service's
 * `onAny` to the EventReplay + (Phase 4) socket.io rooms.
 */
export interface DashboardServices {
    runs: RunService;
    agents: AgentService;
    pipeline: PipelineService;
    reviews: ReviewService;
    plans: PlanService;
    tests: TestService;
    bind: BindService;
    incidents: IncidentService;
    kb: KbService;
    cost: CostService;
    projectGraph: ProjectGraphService;
    system: SystemService;
}
/**
 * Optional method deps. When omitted, every service is emit-only — fine
 * for tests + the bridge. When the dashboard boots, it threads stores +
 * managers in so method calls work end-to-end.
 *
 * Each service has its own dep slot; Prereq B adds them tranche-by-tranche
 * as methods migrate off `dashboard-server.ts`.
 */
export interface ServiceMethodDeps {
    plans?: PlanServiceDeps;
    bind?: BindServiceDeps;
    reviews?: ReviewServiceDeps;
    incidents?: IncidentServiceDeps;
    kb?: KbServiceDeps;
    cost?: CostServiceDeps;
    projectGraph?: ProjectGraphServiceDeps;
}
/**
 * Construct a fresh service bundle. Each service starts with zero
 * subscribers — the bridge attaches them in Phase 3.
 *
 * Pass `methodDeps` to enable mutation methods on individual services.
 * Tests that only need emit/on can omit the argument.
 */
export declare function createServices(methodDeps?: ServiceMethodDeps): DashboardServices;
export {};
//# sourceMappingURL=index.d.ts.map