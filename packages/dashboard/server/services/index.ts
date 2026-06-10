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
import type { PayloadOf } from '../events/types.js';
import type { PlanStore, Plan, PlanApproval, PlanComment } from '../plan-store.js';
import type { PlanValidator, PlanValidation } from '../plan-validator.js';
import type { BoundTestsStore, BoundTest } from '../bound-tests.js';
import type { BoundTestsAuditLog } from '../bound-tests-audit.js';
import type { ReviewStore, Review, Resolution } from '../review-store.js';
import type { IncidentStore } from '../incident-store.js';
import type { IncidentSource } from '../incident-types.js';
import type { KnowledgeBaseManager, KBRefreshProgress } from '../knowledge-base-manager.js';
import type { CostBreachHandler } from '../cost-breach-handler.js';
import { recordResolution } from '../review-learner.js';
import { signShareToken, getOrCreateShareSecret } from '../plan-share.js';
import type { ReviewCalibrationStore } from '../review-calibration.js';
import type { ReviewDismissalStore } from '../review-dismissal-store.js';
import type { ProjectLoader } from '../project-loader.js';
import type * as Z from '../handlers/schemas.js';

// ── Run lifecycle ────────────────────────────────────────────────────────

interface RunEventMap {
  'run.started':            PayloadOf<'run.started'>;
  'run.state-changed':      PayloadOf<'run.state-changed'>;
  'run.completed':          PayloadOf<'run.completed'>;
  'run.stopped':            PayloadOf<'run.stopped'>;
  'run.rejected':           PayloadOf<'run.rejected'>;
  'run.active-snapshot':    PayloadOf<'run.active-snapshot'>;
  'runs.list':              PayloadOf<'runs.list'>;
}

export class RunService extends SyncEmitter<RunEventMap> {}

// ── Agent stream ─────────────────────────────────────────────────────────

interface AgentEventMap {
  'agent.spawned':   PayloadOf<'agent.spawned'>;
  'agent.output':    PayloadOf<'agent.output'>;
  'agent.done':      PayloadOf<'agent.done'>;
  'agent.error':     PayloadOf<'agent.error'>;
}

export class AgentService extends SyncEmitter<AgentEventMap> {}

// ── Pipeline lifecycle ───────────────────────────────────────────────────

interface PipelineEventMap {
  'pipeline.paused':                  PayloadOf<'pipeline.paused'>;
  'pipeline.resumed':                 PayloadOf<'pipeline.resumed'>;
  'pipeline.cancelled':               PayloadOf<'pipeline.cancelled'>;
  'pipeline.waiting-for-input':       PayloadOf<'pipeline.waiting-for-input'>;
  'pipeline.step-cost':               PayloadOf<'pipeline.step-cost'>;
  'pipeline.auth-required':           PayloadOf<'pipeline.auth-required'>;
  'pipeline.interrupted-snapshot':    PayloadOf<'pipeline.interrupted-snapshot'>;
}

export class PipelineService extends SyncEmitter<PipelineEventMap> {}

// ── Reviews ──────────────────────────────────────────────────────────────

interface ReviewEventMap {
  'review.created':           PayloadOf<'review.created'>;
  'review.error':             PayloadOf<'review.error'>;
  'review.started':           PayloadOf<'review.started'>;
  'review.kb-summary':        PayloadOf<'review.kb-summary'>;
  'review.persona-done':      PayloadOf<'review.persona-done'>;
  'review.published':         PayloadOf<'review.published'>;
  'review.finding-resolved':  PayloadOf<'review.finding-resolved'>;
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

export class ReviewService extends SyncEmitter<ReviewEventMap> {
  constructor(private readonly deps?: ReviewServiceDeps) {
    super();
  }

  private requireDeps(method: string): ReviewServiceDeps {
    if (!this.deps) {
      throw new Error(
        `ReviewService.${method} called without deps. Construct via createServices({ reviews }).`,
      );
    }
    return this.deps;
  }

  /**
   * resolve-review-finding — set finding resolution + feed
   * calibration + suppression-key bookkeeping + emit. Returns the
   * updated review for chain callers; the handler ignores the return
   * because the bridge fans the emit out to subscribers already.
   */
  resolveFinding(input: Z.ResolveReviewFindingInput):
    | { updated: Review }
    | { error: 'finding-not-found' }
  {
    const { reviewStore, reviewCalibrationStore, reviewDismissalStore, anvilHome } =
      this.requireDeps('resolveFinding');
    const { project, reviewId, findingId, resolution } = input;

    const prior = reviewStore.readCurrent(project, reviewId);
    const priorFinding = prior?.findings.find((f) => f.id === findingId);
    const updated = reviewStore.setResolution(project, reviewId, findingId, resolution);
    if (!updated) return { error: 'finding-not-found' };

    const updatedFinding = updated.findings.find((f) => f.id === findingId);
    if (updatedFinding && priorFinding) {
      // Learner: log the transition for offline tuning.
      try {
        recordResolution(anvilHome, project, updated, updatedFinding, priorFinding.resolution);
      } catch (err) {
        console.warn('[review] recordResolution failed:', err);
      }
      // Calibration: feed empirical outcome into the per-persona store.
      try {
        const outcome: 'accepted' | 'wontFix' | 'dismissed' | 'pending' =
          resolution === 'addressed' ? 'accepted'
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
      } catch { /* opportunistic */ }
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
        } catch { /* opportunistic */ }
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
  async applyPatch(input: Z.ApplyReviewPatchInput):
    Promise<{ result: Awaited<ReturnType<typeof import('../review-patch-applier.js').applyReviewPatch>> }
            | { error: 'no-repo-clone' }>
  {
    const { projectLoader } = this.requireDeps('applyPatch');
    const repoPaths = projectLoader.getRepoLocalPaths(input.project);
    const fsMod = await import('node:fs');
    const repoPath = Object.values(repoPaths).find((p) => p && fsMod.existsSync(p));
    if (!repoPath) return { error: 'no-repo-clone' };

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
  async publish(input: Z.PublishReviewInput):
    Promise<{ result: Awaited<ReturnType<typeof import('../review-publisher.js').publishReview>> }
            | { error: 'review-not-found' }>
  {
    const { reviewStore } = this.requireDeps('publish');
    const review = reviewStore.readCurrent(input.project, input.reviewId);
    if (!review) return { error: 'review-not-found' };
    const { publishReview } = await import('../review-publisher.js');
    const result = await publishReview(review);
    return { result };
  }
}

// ── Plans ────────────────────────────────────────────────────────────────

interface PlanEventMap {
  'plan.created':                PayloadOf<'plan.created'>;
  'plan.updated':                PayloadOf<'plan.updated'>;
  'plan.validation':             PayloadOf<'plan.validation'>;
  'plan.lifecycle':              PayloadOf<'plan.lifecycle'>;
  'plan.comment-added':          PayloadOf<'plan.comment-added'>;
  'plan.comment-resolved':       PayloadOf<'plan.comment-resolved'>;
  'plan.comment-deleted':        PayloadOf<'plan.comment-deleted'>;
  'plan.approved':               PayloadOf<'plan.approved'>;
  'plan.error':                  PayloadOf<'plan.error'>;
  'plan.variants-started':       PayloadOf<'plan.variants-started'>;
  'plan.variant-created':        PayloadOf<'plan.variant-created'>;
  'plan.auto-refine-progress':   PayloadOf<'plan.auto-refine-progress'>;
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

export class PlanService extends SyncEmitter<PlanEventMap> {
  constructor(private readonly deps?: PlanServiceDeps) {
    super();
  }

  private requireDeps(method: string): PlanServiceDeps {
    if (!this.deps) {
      throw new Error(
        `PlanService.${method} called without deps. Construct via createServices({ planStore }).`,
      );
    }
    return this.deps;
  }

  /** add-plan-comment — append a comment + emit. */
  addComment(input: Z.AddPlanCommentInput): { comment: PlanComment } {
    const { planStore } = this.requireDeps('addComment');
    const comment = planStore.addComment(
      input.project, input.planSlug, input.sectionPath, input.body, input.author,
    );
    this.emit('plan.comment-added', { planSlug: input.planSlug, comment });
    return { comment };
  }

  /** resolve-plan-comment — mark resolved + emit. */
  resolveComment(input: Z.ResolvePlanCommentInput): { ok: boolean } {
    const { planStore } = this.requireDeps('resolveComment');
    const ok = planStore.resolveComment(input.project, input.planSlug, input.commentId);
    this.emit('plan.comment-resolved', { planSlug: input.planSlug, commentId: input.commentId, ok });
    return { ok };
  }

  /** delete-plan-comment — remove comment + emit. */
  deleteComment(input: Z.DeletePlanCommentInput): { ok: boolean } {
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
  approve(input: Z.ApprovePlanInput, user: string): { approval: PlanApproval } {
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
  adoptVariant(input: Z.AdoptPlanVariantInput):
    | { plan: Plan; validation: PlanValidation; adoptedFrom: string }
    | { error: 'variant-not-found' }
  {
    const { planStore, planValidator } = this.requireDeps('adoptVariant');
    const variant = planStore.readCurrent(input.project, input.planSlug);
    if (!variant) return { error: 'variant-not-found' };
    // Strip generated fields so createPlan resets them on the clone.
    const { slug: _s, version: _v, createdAt: _c, updatedAt: _u, project: _p, ...rest } = variant;
    void _s; void _v; void _c; void _u; void _p;
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
  validate(
    input: Z.ValidatePlanInput,
    extra: { maxPerRun?: number; maxPerDay?: number; githubByRepoName: Record<string, string> },
  ): { validation: PlanValidation } | { error: 'plan-not-found' } {
    const { planStore, planValidator } = this.requireDeps('validate');
    const plan = planStore.readCurrent(input.project, input.planSlug);
    if (!plan) return { error: 'plan-not-found' };
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
  save(input: Z.SavePlanInput): { plan: Plan; validation: PlanValidation } {
    const { planStore, planValidator } = this.requireDeps('save');
    const next = planStore.bumpVersion(input.project, input.planSlug, input.plan as Partial<Plan>);
    const validation = planValidator.validate(next);
    planStore.writeValidation(input.project, input.planSlug, validation);
    return { plan: next, validation };
  }

  /**
   * share-plan — mint a signed share-token + URL for the current
   * plan version. The handler owns the share-secret resolution
   * (`getOrCreateShareSecret(anvilHome)`) so the service stays pure-data.
   */
  share(input: Z.SharePlanInput, deps: { anvilHome: string; defaultTtlMs: number }):
    | { token: string; url: string; expiresAt: number }
    | { error: 'plan-not-found' }
  {
    const { planStore } = this.requireDeps('share');
    const plan = planStore.readCurrent(input.project, input.planSlug);
    if (!plan) return { error: 'plan-not-found' };
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

  estimate(input: Z.EstimatePlanInput): {
    estimate: { usd: number; minutes: number; prs: number };
    excludedRepos: string[];
    modelTier: 'fast' | 'balanced' | 'thorough';
    keptRepoCount: number;
  } | { error: 'plan-not-found' } {
    const { planStore } = this.requireDeps('estimate');
    const base = planStore.readCurrent(input.project, input.planSlug);
    if (!base) return { error: 'plan-not-found' };
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

// ── Tests ────────────────────────────────────────────────────────────────

interface TestEventMap {
  'test.run-log':                  PayloadOf<'test.run-log'>;
  'test.specs':                    PayloadOf<'test.specs'>;
  'test.spec-created':             PayloadOf<'test.spec-created'>;
  'test.review-persona-start':     PayloadOf<'test.review-persona-start'>;
  'test.review-persona-done':      PayloadOf<'test.review-persona-done'>;
  'test.review-persona-error':     PayloadOf<'test.review-persona-error'>;
  'test.mutation-log':             PayloadOf<'test.mutation-log'>;
  'test.polish-case-start':        PayloadOf<'test.polish-case-start'>;
  'test.polish-case-done':         PayloadOf<'test.polish-case-done'>;
  'test.polish-case-error':        PayloadOf<'test.polish-case-error'>;
  'test.regen-complete':           PayloadOf<'test.regen-complete'>;
  'test.contract-complete':        PayloadOf<'test.contract-complete'>;
  'test.scenarios-complete':       PayloadOf<'test.scenarios-complete'>;
  'test.flakiness-case-start':     PayloadOf<'test.flakiness-case-start'>;
  'test.flakiness-case-done':      PayloadOf<'test.flakiness-case-done'>;
  'test.flakiness-case-error':     PayloadOf<'test.flakiness-case-error'>;
  'test.flakiness-complete':       PayloadOf<'test.flakiness-complete'>;
  'test.review-complete':          PayloadOf<'test.review-complete'>;
  'test.finding-resolved':         PayloadOf<'test.finding-resolved'>;
}

export class TestService extends SyncEmitter<TestEventMap> {}

interface BindEventMap {
  'bind.overridden':         PayloadOf<'bind.overridden'>;
  'bind.override-applied':   PayloadOf<'bind.override-applied'>;
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

export class BindService extends SyncEmitter<BindEventMap> {
  constructor(private readonly deps?: BindServiceDeps) {
    super();
  }

  private requireDeps(method: string): BindServiceDeps {
    if (!this.deps) {
      throw new Error(
        `BindService.${method} called without deps. Construct via createServices({ bind }).`,
      );
    }
    return this.deps;
  }

  /**
   * override-bind — remove a bound test by replayId. Returns the
   * removed BoundTest record so the handler can plumb it into Slack
   * notifiers. The handler still owns the Slack call because
   * `notifyBindOverride` lives outside the bind domain.
   */
  overrideByReplayId(input: Z.OverrideBindInput):
    | { removed: BoundTest }
    | { error: 'bound-not-found' | 'override-failed' }
  {
    const { boundTestsStore } = this.requireDeps('overrideByReplayId');
    const bound = boundTestsStore.listBound(input.project).find((b) => b.replayId === input.replayId);
    if (!bound) return { error: 'bound-not-found' };
    const removed = boundTestsStore.removeBound(input.project, bound.filePath, input.reason);
    if (!removed) return { error: 'override-failed' };
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
  overrideByFilePath(input: Z.OverrideBoundTestInput): {
    entry: ReturnType<BoundTestsAuditLog['record']>;
  } {
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

// ── Incidents ────────────────────────────────────────────────────────────

interface IncidentEventMap {
  'incident.ingested':  PayloadOf<'incident.ingested'>;
  'replay.queued':      PayloadOf<'replay.queued'>;
  'replay.step':        PayloadOf<'replay.step'>;
  'replay.complete':    PayloadOf<'replay.complete'>;
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

export class IncidentService extends SyncEmitter<IncidentEventMap> {
  constructor(private readonly deps?: IncidentServiceDeps) {
    super();
  }

  private requireDeps(method: string): IncidentServiceDeps {
    if (!this.deps) {
      throw new Error(
        `IncidentService.${method} called without deps. Construct via createServices({ incidents }).`,
      );
    }
    return this.deps;
  }

  /**
   * ingest-incident — parse a source-specific event, normalize, persist,
   * emit. Throws `unsupported-source` for sources the parsers don't know,
   * `parse-failed` for parser exceptions; the handler maps both to the
   * legacy `incident-error` wire type.
   */
  async ingest(input: Z.IngestIncidentInput):
    Promise<{ incident: ReturnType<IncidentStore['ingest']> } | { error: string }>
  {
    const { incidentStore } = this.requireDeps('ingest');
    const parsers = await import('../incident-parsers/index.js');
    let parsed;
    try {
      switch (input.source) {
        case 'sentry':       parsed = parsers.parseSentryEvent(input.payload); break;
        case 'incident.io':  parsed = parsers.parseIncidentIoEvent(input.payload); break;
        case 'datadog':      parsed = parsers.parseDatadogAlert(input.payload); break;
        case 'manual': {
          const p = input.payload as { stackTrace?: string; title?: string; url?: string; summary?: string };
          if (!p.stackTrace) throw new Error('manual source requires stackTrace');
          parsed = parsers.parseGenericStackTrace({
            stackTrace: p.stackTrace, title: p.title, url: p.url, summary: p.summary,
          });
          break;
        }
        default: {
          // ts-pattern would flag this; using exhaustive switch by hand for now.
          const exhaustive: never = input.source;
          return { error: `Unsupported source: ${exhaustive as string}` };
        }
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const incident = incidentStore.ingest(input.project, input.source as IncidentSource, parsed.externalId, parsed);
    this.emit('incident.ingested', { incident });
    return { incident };
  }
}

// ── KB ───────────────────────────────────────────────────────────────────

interface KbEventMap {
  'kb.progress':  PayloadOf<'kb.progress'>;
  'kb.status':    PayloadOf<'kb.status'>;
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

export class KbService extends SyncEmitter<KbEventMap> {
  constructor(private readonly deps?: KbServiceDeps) {
    super();
  }

  private requireDeps(method: string): KbServiceDeps {
    if (!this.deps) {
      throw new Error(
        `KbService.${method} called without deps. Construct via createServices({ kb }).`,
      );
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
  refresh(input: Z.RefreshKnowledgeBaseInput): { started: true } | { inProgress: true } {
    const { kbManager } = this.requireDeps('refresh');
    if (kbManager.isRefreshing()) return { inProgress: true };
    const { project } = input;
    kbManager.refreshProject(project, (progress: KBRefreshProgress) => {
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

// ── Cost ─────────────────────────────────────────────────────────────────

interface CostEventMap {
  'cost.breach':    PayloadOf<'cost.breach'>;
  'cost.snapshot':  PayloadOf<'cost.snapshot'>;
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

export class CostService extends SyncEmitter<CostEventMap> {
  /**
   * Cost has a circular dep: `CostBreachHandler.onNotify` calls
   * `services.cost.emit('cost.breach', ...)`, but `respondBreach` needs
   * the handler. We resolve this by exposing `setDeps(...)` — the caller
   * constructs `services` first (without cost deps), wires the handler
   * with a closure over `services.cost.emit`, then back-fills the deps.
   */
  private deps?: CostServiceDeps;

  constructor(deps?: CostServiceDeps) {
    super();
    if (deps) this.deps = deps;
  }

  /** Late-bind the cost-breach handler — see class docstring. */
  setDeps(deps: CostServiceDeps): void {
    this.deps = deps;
  }

  private requireDeps(method: string): CostServiceDeps {
    if (!this.deps) {
      throw new Error(
        `CostService.${method} called without deps. Call services.cost.setDeps(...) after construction.`,
      );
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
  async respondBreach(input: Z.RespondCostBreachInput): Promise<{
    breach: Awaited<ReturnType<CostBreachHandler['respond']>>;
    project: string;
  }> {
    const { costBreachHandler, breachLogDir } = this.requireDeps('respondBreach');
    const { runId, decision, deltaUsd, extendSeconds } = input;
    const updated = await costBreachHandler.respond(runId, decision, deltaUsd, extendSeconds);
    this.emit('cost.breach', { breach: updated });
    // Telemetry: append decision row to NDJSON for tuning hints. Failures
    // are non-fatal — telemetry shouldn't block the operator's decision.
    try {
      const { existsSync, mkdirSync, appendFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      if (!existsSync(breachLogDir)) mkdirSync(breachLogDir, { recursive: true });
      const dec = {
        runId,
        project: updated.project,
        decision,
        deltaUsdApproved: decision === 'raise' ? (deltaUsd ?? 0) : 0,
        autoResolved: false,
        decisionLatencyMs: Math.max(
          0,
          Date.parse(updated.decisionAt ?? new Date().toISOString()) - Date.parse(updated.breachedAt),
        ),
        at: new Date().toISOString(),
      };
      appendFileSync(join(breachLogDir, 'decisions.ndjson'), JSON.stringify(dec) + '\n', 'utf-8');
    } catch { /* telemetry best-effort */ }
    return { breach: updated, project: updated.project };
  }
}

// ── Project graph ────────────────────────────────────────────────────────

interface ProjectGraphEventMap {
  'project-graph.started':   PayloadOf<'project-graph.started'>;
  'project-graph.progress':  PayloadOf<'project-graph.progress'>;
  'project-graph.complete':  PayloadOf<'project-graph.complete'>;
  'project-graph.error':     PayloadOf<'project-graph.error'>;
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

export class ProjectGraphService extends SyncEmitter<ProjectGraphEventMap> {
  constructor(private readonly deps?: ProjectGraphServiceDeps) {
    super();
  }

  private requireDeps(method: string): ProjectGraphServiceDeps {
    if (!this.deps) {
      throw new Error(
        `ProjectGraphService.${method} called without deps. Construct via createServices({ projectGraph }).`,
      );
    }
    return this.deps;
  }

  /**
   * build-project-graph — fire-and-forget kickoff. Emits 'started'
   * immediately, then 'progress' over the build, ending in either
   * 'complete' or 'error'. Errors during the run are caught and emitted
   * rather than thrown.
   */
  build(input: Z.BuildProjectGraphInput): void {
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
        ].find((p: string) => existsSync(p));
        if (!factoryPath) {
          throw new Error(`No factory.yaml found for project "${project}"`);
        }
        const graph = await buildProjectGraph(project, factoryPath, {
          provider: input.provider,
          model: input.model,
          onProgress: (message: string) => {
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
      } catch (err: unknown) {
        this.emit('project-graph.error', {
          project,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }
}

// ── State / misc ─────────────────────────────────────────────────────────
// `state` and `prs.updated` don't belong to any one domain — they're
// dashboard-wide rollups. Keep a thin SystemService for them.

interface SystemEventMap {
  'state':         PayloadOf<'state'>;
  'prs.updated':   PayloadOf<'prs.updated'>;
  'artifact':      PayloadOf<'artifact'>;
}

export class SystemService extends SyncEmitter<SystemEventMap> {}

// ── Aggregated service bundle ────────────────────────────────────────────

/**
 * The full set of dashboard services. Phase 3 will pass this struct as
 * `deps.services` into handler factories so handlers emit through the
 * right domain owner. The service-bridge (Phase 3) wires each service's
 * `onAny` to the EventReplay + (Phase 4) socket.io rooms.
 */
export interface DashboardServices {
  runs:          RunService;
  agents:        AgentService;
  pipeline:      PipelineService;
  reviews:       ReviewService;
  plans:         PlanService;
  tests:         TestService;
  bind:          BindService;
  incidents:     IncidentService;
  kb:            KbService;
  cost:          CostService;
  projectGraph:  ProjectGraphService;
  system:        SystemService;
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
export function createServices(methodDeps?: ServiceMethodDeps): DashboardServices {
  return {
    runs:          new RunService(),
    agents:        new AgentService(),
    pipeline:      new PipelineService(),
    reviews:       new ReviewService(methodDeps?.reviews),
    plans:         new PlanService(methodDeps?.plans),
    tests:         new TestService(),
    bind:          new BindService(methodDeps?.bind),
    incidents:     new IncidentService(methodDeps?.incidents),
    kb:            new KbService(methodDeps?.kb),
    cost:          new CostService(methodDeps?.cost),
    projectGraph:  new ProjectGraphService(methodDeps?.projectGraph),
    system:        new SystemService(),
  };
}
