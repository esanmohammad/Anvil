/**
 * Plan-domain WS routes (Recipe 7 / Phase 1).
 *
 * One `route(...)` per `case '<plan-action>':` body that has a matching
 * `services.plans.<method>(...)` in `services/index.ts`. The case bodies
 * in `dashboard-server.ts` are deleted in the same change that switches
 * `handleClientMessage` over to the registry; this file becomes the new
 * home for each handler.
 *
 * Migrated:
 *   - add-plan-comment       (fire-and-forget — emit-only via service)
 *   - resolve-plan-comment   (fire-and-forget — emit-only via service)
 *   - delete-plan-comment    (fire-and-forget — emit-only via service)
 *   - approve-plan           (service write + handler-side lifecycle tick)
 *   - adopt-plan-variant     (echo `plan-variant-adopted`)
 *   - validate-plan          (echo `plan-validation`; handler reads
 *                             projectLoader for budget caps + repo map)
 *   - estimate-plan          (echo `plan-estimate`)
 *   - save-plan              (echo `plan-updated` + two lifecycle ticks)
 *   - share-plan             (echo `plan-shared`)
 *
 * NOT migrated (closure-dependent — Phase 2):
 *   - regen-plan-section, auto-refine, execute-plan, run-plan-variants —
 *     these spawn agent processes through `spawnPlanAgent` /
 *     `spawnPlanSectionRegen` / `spawnPlanVariants`, which live inside
 *     `startDashboardServer`. Each lands as a service method once that
 *     closure is extracted to its own module.
 *
 * Read-only plan actions (`list-plan-comments`, `list-plan-approvals`,
 * `get-plans`, `get-plan`, etc.) also stay in the monolith for now —
 * they read `planStore` directly and don't need a service method. Phase 1
 * migrates them once a read-only `route()` shape is comfortable to write.
 */

import { route, type Handler } from './route.js';
import * as Z from './schemas.js';

/**
 * Build the plan-domain route map. Returns a `Record<action, Handler>`
 * that the registry spreads into the top-level handlerRegistry.
 *
 * Today the function is a no-op factory — it takes no args because every
 * dep these handlers need is on `deps` at call time. Keeping the factory
 * form anyway so Phase 2's lifecycle-extraction can pass closures in
 * (e.g. `attachX({ dispatchLifecycle, projectLoader })`) without a wire
 * refactor.
 */
export function planRoutes(): Record<string, Handler> {
  return {
    // ── Reads ───────────────────────────────────────────────────────────
    // Pure planStore reads — no service method needed. Each closes over
    // `deps.extras.planStore` (injected at boot from `dashboard-server.ts`).

    'get-plans': route({
      input: Z.GetPlans,
      handle: (input, deps) => {
        const store = deps.extras.planStore;
        if (!store) return;
        try {
          return { plans: store.listPlans(input.project ?? undefined) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `Failed to list plans: ${message}` };
        }
      },
      wireType: 'plans',
      errorMessage: (code) => code,
    }),

    'get-plan': route({
      input: Z.GetPlan,
      handle: (input, deps) => {
        const store = deps.extras.planStore;
        if (!store) return;
        const plan = store.readCurrent(input.project, input.planSlug);
        const validation = plan ? store.readValidation(input.project, input.planSlug) : null;
        const versions = plan ? store.listVersions(input.project, input.planSlug) : [];
        return { plan, validation, versions };
      },
      wireType: 'plan',
    }),

    'list-plan-comments': route({
      input: Z.ListPlanComments,
      onParseFail: 'silent',
      handle: (input, deps) => {
        const store = deps.extras.planStore;
        if (!store) return;
        return { planSlug: input.planSlug, comments: store.listComments(input.project, input.planSlug) };
      },
      wireType: 'plan-comments',
    }),

    'list-plan-approvals': route({
      input: Z.ListPlanApprovals,
      onParseFail: 'silent',
      handle: (input, deps) => {
        const store = deps.extras.planStore;
        if (!store) return;
        const approvals = store.listApprovals(input.project, input.planSlug);
        const pointer = store.readPointer(input.project, input.planSlug);
        return {
          planSlug: input.planSlug,
          approvals,
          currentVersion: pointer?.currentVersion ?? null,
        };
      },
      wireType: 'plan-approvals',
    }),

    'get-plan-lifecycle': route({
      input: Z.GetPlanLifecycle,
      handle: async (input, deps) => {
        const snap = await deps.extras.getPlanLifecycleSnapshot?.(input.project, input.planSlug);
        // The UI treats `payload: null` as "no lifecycle yet" — important
        // to preserve so the mount path doesn't show a stale snapshot.
        deps.ws.send(JSON.stringify({ type: 'plan-lifecycle', payload: snap ?? null }));
      },
    }),

    'get-plan-lineage': route({
      input: Z.GetPlanLineage,
      handle: (input, deps) => {
        const store = deps.extras.planStore;
        if (!store) return;
        const versions = store.listVersions(input.project, input.planSlug);
        const lineage = versions.map((n) => {
          const p = store.readVersion(input.project, input.planSlug, n) as
            | { version: number; updatedAt: string; createdBy?: string; parentVersion?: number; contentHash?: string }
            | null;
          if (!p) return { version: n, updatedAt: '', createdBy: undefined };
          return {
            version: p.version,
            updatedAt: p.updatedAt,
            createdBy: p.createdBy,
            parentVersion: p.parentVersion,
            contentHash: p.contentHash,
          };
        });
        return { planSlug: input.planSlug, versions: lineage };
      },
      wireType: 'plan-lineage',
    }),

    // ── Comments — fire-and-forget; bridge fans the service emit out ────
    'add-plan-comment': route({
      input: Z.AddPlanComment,
      handle: (input, deps) => { deps.services.plans.addComment(input); },
    }),

    'resolve-plan-comment': route({
      input: Z.ResolvePlanComment,
      handle: (input, deps) => { deps.services.plans.resolveComment(input); },
    }),

    'delete-plan-comment': route({
      input: Z.DeletePlanComment,
      handle: (input, deps) => { deps.services.plans.deleteComment(input); },
    }),

    // ── Approvals — service write + handler-side lifecycle tick ─────────
    // `dispatchLifecycle` is a closure inside `startDashboardServer`;
    // Phase 2 extracts it to `pipeline/lifecycle.ts` and threads it in
    // as a service dep. Until then, the handler invokes it via
    // `deps.extras.dispatchLifecycle`.
    'approve-plan': route({
      input: Z.ApprovePlan,
      handle: async (input, deps) => {
        const user = input.user ?? deps.user ?? deps.extras.defaultUser;
        deps.services.plans.approve(input, user);
        await deps.extras.dispatchLifecycle?.(input.project, input.planSlug, { kind: 'approve' });
      },
    }),

    // ── Adopt variant ────────────────────────────────────────────────────
    'adopt-plan-variant': route({
      input: Z.AdoptPlanVariant,
      handle: (input, deps) => {
        const outcome = deps.services.plans.adoptVariant(input);
        if ('error' in outcome) return { error: 'variant-not-found' };
        // Echo full outcome (plan + validation + adoptedFrom).
        return outcome;
      },
      wireType: 'plan-variant-adopted',
      errorMessage: (_code, input) => `Variant ${input.planSlug} not found`,
    }),

    // ── Validate ─────────────────────────────────────────────────────────
    // Budget caps + gh-repo mapping live on `projectLoader`. The handler
    // does the cross-service lookups + plumbs them into `services.plans.validate`.
    'validate-plan': route({
      input: Z.ValidatePlan,
      handle: (input, deps) => {
        const loader = deps.extras.projectLoader;
        const budget = safeBudget(loader, input.project);
        const githubByRepoName = safeRepoMap(loader, input.project);
        const outcome = deps.services.plans.validate(input, {
          maxPerRun: budget.max_per_run,
          maxPerDay: budget.max_per_day,
          githubByRepoName,
        });
        if ('error' in outcome) return { error: 'plan-not-found' };
        return { validation: outcome.validation, planSlug: input.planSlug };
      },
      wireType: 'plan-validation',
      errorMessage: (_code, input) => `Plan ${input.project}/${input.planSlug} not found`,
    }),

    // ── Estimate ─────────────────────────────────────────────────────────
    'estimate-plan': route({
      input: Z.EstimatePlan,
      handle: (input, deps) => {
        const outcome = deps.services.plans.estimate(input);
        if ('error' in outcome) return { error: 'plan-not-found' };
        return { planSlug: input.planSlug, ...outcome };
      },
      wireType: 'plan-estimate',
      errorMessage: (_code, input) => `Plan ${input.planSlug} not found`,
    }),

    // ── Save ─────────────────────────────────────────────────────────────
    // Writes the new version + fires two lifecycle ticks (`edit` then
    // `verify-complete`) so the UI badge settles into the post-verify
    // state. Errors are wrapped with `Failed to save plan: …` to match
    // the legacy wire message.
    'save-plan': route({
      input: Z.SavePlan,
      handle: async (input, deps) => {
        try {
          const { plan: next, validation } = deps.services.plans.save(input);
          deps.ws.send(JSON.stringify({ type: 'plan-updated', payload: { plan: next, validation } }));
          const editedSections = Object.keys(input.plan as Record<string, unknown>).join(', ') || 'unknown';
          await deps.extras.dispatchLifecycle?.(input.project, input.planSlug, {
            kind: 'edit',
            reason: `user edit (${editedSections})`,
          });
          await deps.extras.dispatchLifecycle?.(input.project, input.planSlug, {
            kind: 'verify-complete',
            errors: validation.counts.errors,
            autoFixableCount: validation.issues.filter((i) => i.autoFixable).length,
            canTargetedRegen: validation.issues.some((i) => i.hint),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.ws.send(JSON.stringify({ type: 'error', payload: { message: `Failed to save plan: ${message}` } }));
        }
      },
    }),

    // ── Share ────────────────────────────────────────────────────────────
    'share-plan': route({
      input: Z.SharePlan,
      handle: (input, deps) => {
        const outcome = deps.services.plans.share(input, {
          anvilHome: deps.extras.anvilHome,
          defaultTtlMs: deps.extras.shareTokenTtlMs,
        });
        if ('error' in outcome) return { error: 'plan-not-found' };
        return {
          planSlug: input.planSlug,
          token: outcome.token,
          url: outcome.url,
          expiresAt: outcome.expiresAt,
        };
      },
      wireType: 'plan-shared',
      errorMessage: (_code, input) => `Plan ${input.planSlug} not found`,
    }),
  };
}

// ── helpers ─────────────────────────────────────────────────────────────

function safeBudget(
  loader: { getBudgetConfig(project: string): { max_per_run?: number; max_per_day?: number } } | undefined,
  project: string,
): { max_per_run?: number; max_per_day?: number } {
  if (!loader) return {};
  try { return loader.getBudgetConfig(project); } catch { return {}; }
}

function safeRepoMap(
  loader: { getRepoLocalPaths(project: string): Record<string, string> } | undefined,
  project: string,
): Record<string, string> {
  if (!loader) return {};
  try {
    const names = Object.keys(loader.getRepoLocalPaths(project));
    const out: Record<string, string> = {};
    for (const n of names) out[n] = n;
    return out;
  } catch {
    return {};
  }
}
