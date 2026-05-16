/**
 * Plan-lifecycle walker (Phase 3 extraction from `dashboard-server.ts`).
 *
 * Owns:
 *   - `planLifecycle: Map<key, LifecycleContext>` — per-(project,slug)
 *     state machine context held across dispatches.
 *   - `outstandingRefineRegens: Map<key, …>` — tracks async regen
 *     fan-outs scheduled by `runAutoRefinePass` so a single user click
 *     can never stack passes.
 *
 * Exposes:
 *   - `dispatchLifecycle(project, slug, event)` — wraps
 *     `transitionLifecycle(...)` and emits `plan-lifecycle` after.
 *   - `executeLifecycleVerify(project, slug)` — sync verify pass.
 *   - `executeLifecycleRefine(project, slug)` — single bounded refine
 *     pass; async regens fire-and-forget; `noteRefineRegenCompleted`
 *     drains the outstanding count and resolves the lifecycle.
 *   - `runAutoRefinePass(project, slug)` — deterministic patches +
 *     targeted regen dispatch.
 *   - `isPartOfActiveRefine(project, slug)` — gate against re-entry.
 *   - `noteRefineRegenCompleted(project, slug)` — call from
 *     `finalizePlanAgent` when a section-regen agent finishes.
 *   - `getSnapshot(project, slug)` — async lifecycle snapshot for the
 *     `getPlanLifecycleSnapshot` extras slot.
 *
 * The factory takes a forward-ref `getSpawnPlanSectionRegen()` getter
 * so the lifecycle module can call back into the (still-monolithic)
 * plan-spawn closures without a circular import.
 */

import type { Plan, PlanSection } from '../plan-store.js';
import type { PlanStore } from '../plan-store.js';
import type { PlanValidator } from '../plan-validator.js';
import type { ProjectLoader } from '../project-loader.js';
import type { DashboardServices } from '../services/index.js';
import type {
  LifecycleEvent,
  LifecycleSnapshot,
  LifecycleContext,
} from '@esankhan3/anvil-core-pipeline';

export interface PlanLifecycleDeps {
  planStore: PlanStore;
  planValidator: PlanValidator;
  projectLoader: ProjectLoader;
  services: DashboardServices;
  broadcastPlanLifecycle: (snap: LifecycleSnapshot) => void;
  /**
   * Forward-ref to the section-regen spawner. Still owned by
   * `dashboard-server.ts`; the lifecycle module never imports it
   * directly to avoid a cycle.
   */
  getSpawnPlanSectionRegen: () => (
    existingPlan: Plan,
    section: PlanSection,
    modelId?: string,
    retryState?: { burned: Set<string>; attemptsRemaining: number },
    fixPrompt?: string,
  ) => void;
}

export interface PlanLifecycleHandle {
  dispatchLifecycle: (
    project: string,
    slug: string,
    event: LifecycleEvent,
  ) => Promise<LifecycleSnapshot>;
  executeLifecycleVerify: (project: string, slug: string) => Promise<void>;
  executeLifecycleRefine: (project: string, slug: string) => Promise<void>;
  runAutoRefinePass: (project: string, slug: string) => Promise<number | null>;
  isPartOfActiveRefine: (project: string, slug: string) => boolean;
  noteRefineRegenCompleted: (project: string, slug: string) => void;
  /** Snapshot for the `get-plan-lifecycle` registry handler. */
  getSnapshot: (project: string, slug: string) => Promise<LifecycleSnapshot | null>;
}

const REFINE_PASS_TIMEOUT_MS = 120_000;
const PER_REGEN_USD_ESTIMATE = 0.10;

export function createPlanLifecycle(deps: PlanLifecycleDeps): PlanLifecycleHandle {
  const planLifecycle = new Map<string, LifecycleContext>();
  const outstandingRefineRegens = new Map<string, {
    count: number;
    spentUsd: number;
    timeoutHandle: NodeJS.Timeout;
  }>();

  const lifecycleKey = (project: string, slug: string) => `${project}:${slug}`;

  function isPartOfActiveRefine(project: string, slug: string): boolean {
    return outstandingRefineRegens.has(lifecycleKey(project, slug));
  }

  function noteRefineRegenCompleted(project: string, slug: string): void {
    const key = lifecycleKey(project, slug);
    const entry = outstandingRefineRegens.get(key);
    if (!entry) return;
    entry.count--;
    entry.spentUsd += PER_REGEN_USD_ESTIMATE;
    if (entry.count <= 0) {
      clearTimeout(entry.timeoutHandle);
      outstandingRefineRegens.delete(key);
      void (async () => {
        await dispatchLifecycle(project, slug, {
          kind: 'refine-complete',
          spentUsd: entry.spentUsd,
        });
        const plan = deps.planStore.readCurrent(project, slug);
        if (!plan) return;
        const validation = deps.planValidator.validate(plan);
        deps.planStore.writeValidation(project, slug, validation);
        deps.services.plans.emit('plan.validation', { validation, planSlug: slug } as never);
        await dispatchLifecycle(project, slug, {
          kind: 'verify-complete',
          errors: validation.counts.errors,
          autoFixableCount: validation.issues.filter((i) => i.autoFixable).length,
          canTargetedRegen: validation.issues.some((i) => i.hint),
        });
      })();
    }
  }

  async function dispatchLifecycle(
    project: string,
    slug: string,
    event: LifecycleEvent,
  ): Promise<LifecycleSnapshot> {
    const { initLifecycle, transitionLifecycle, snapshotLifecycle } =
      await import('@esankhan3/anvil-core-pipeline');
    const key = lifecycleKey(project, slug);
    let ctx = planLifecycle.get(key);
    if (!ctx) {
      ctx = initLifecycle({ project, slug });
      planLifecycle.set(key, ctx);
    }
    const { next } = transitionLifecycle(ctx, event);
    planLifecycle.set(key, next);
    const snap = snapshotLifecycle(next);
    deps.broadcastPlanLifecycle(snap);
    return snap;
  }

  async function executeLifecycleVerify(project: string, slug: string): Promise<void> {
    try {
      const plan = deps.planStore.readCurrent(project, slug);
      if (!plan) return;
      const validation = deps.planValidator.validate(plan);
      deps.planStore.writeValidation(project, slug, validation);
      const autoFixableCount = validation.issues.filter((i) => i.autoFixable).length;
      const canTargetedRegen = validation.issues.some((i) => i.hint);
      deps.services.plans.emit('plan.validation', { validation, planSlug: slug } as never);
      await dispatchLifecycle(project, slug, {
        kind: 'verify-complete',
        errors: validation.counts.errors,
        autoFixableCount,
        canTargetedRegen,
      });
    } catch (err) {
      console.warn('[lifecycle] verify failed:', err);
    }
  }

  async function executeLifecycleRefine(project: string, slug: string): Promise<void> {
    try {
      // Refuse to enter a fresh refine pass if one's already in flight.
      // Prevents the runaway where verify-complete keeps firing refine
      // against a plan still being mutated by async regens.
      if (isPartOfActiveRefine(project, slug)) return;
      const result = await runAutoRefinePass(project, slug);
      // null = async regens scheduled; refine-complete fires from
      // noteRefineRegenCompleted when the last regen lands.
      if (result === null) return;
      await dispatchLifecycle(project, slug, { kind: 'refine-complete', spentUsd: result });
      const plan = deps.planStore.readCurrent(project, slug);
      if (!plan) return;
      const validation = deps.planValidator.validate(plan);
      deps.planStore.writeValidation(project, slug, validation);
      deps.services.plans.emit('plan.validation', { validation, planSlug: slug } as never);
      await dispatchLifecycle(project, slug, {
        kind: 'verify-complete',
        errors: validation.counts.errors,
        autoFixableCount: validation.issues.filter((i) => i.autoFixable).length,
        canTargetedRegen: validation.issues.some((i) => i.hint),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await dispatchLifecycle(project, slug, { kind: 'refine-failed', reason });
    }
  }

  async function runAutoRefinePass(project: string, slug: string): Promise<number | null> {
    const plan = deps.planStore.readCurrent(project, slug);
    if (!plan) return 0;
    const { autoRefinePlan, runPlanRules } = await import('@esankhan3/anvil-core-pipeline');
    const ruleCtx = {
      project: plan.project,
      projectRepos: (() => {
        try { return Object.keys(deps.projectLoader.getRepoLocalPaths(plan.project)); }
        catch { return []; }
      })(),
      kbFiles: {} as Record<string, Set<string>>,
      kbSymbols: {} as Record<string, Set<string>>,
    };
    const ruleReport = runPlanRules(plan, ruleCtx);
    const outcome = autoRefinePlan(plan, ruleReport);
    let nextPlan = outcome.plan;
    if (outcome.changes > 0) {
      nextPlan = deps.planStore.bumpVersion(plan.project, plan.slug, {
        ...outcome.plan,
        approval: undefined,
      });
      const reval = deps.planValidator.validate(nextPlan);
      deps.planStore.writeValidation(plan.project, plan.slug, reval);
      deps.services.plans.emit('plan.updated', { plan: nextPlan, validation: reval } as never);
      deps.services.plans.emit('plan.auto-refine-progress', {
        summary: `${outcome.changes} deterministic patch${outcome.changes === 1 ? '' : 'es'} applied. ${outcome.remaining.length} issue${outcome.remaining.length === 1 ? '' : 's'} remain.`,
      } as never);
    }
    const PLAN_SECTIONS_BY_PREFIX: Record<string, PlanSection> = {
      problem: 'problem', scope: 'scope', repos: 'repos', contracts: 'contracts',
      data: 'data', observability: 'observability', architecture: 'architecture',
      risks: 'risks', rollout: 'rollout', tests: 'tests', estimate: 'estimate',
    };
    const sectionsToRegen = new Map<PlanSection, string[]>();
    for (const issue of outcome.remaining) {
      if (!issue.fixHint) continue;
      const prefix = issue.path.split(/[[.]/)[0];
      const section = PLAN_SECTIONS_BY_PREFIX[prefix];
      if (!section) continue;
      const hints = sectionsToRegen.get(section) ?? [];
      hints.push(`${issue.ruleId}: ${issue.fixHint}`);
      sectionsToRegen.set(section, hints);
    }
    // Hard cap on regens per pass — even if the rule engine surfaces 20
    // sections needing fixes, only spawn 4. Bounds a single click.
    const MAX_REGENS_PER_PASS = 4;
    const cappedSections = [...sectionsToRegen.entries()].slice(0, MAX_REGENS_PER_PASS);
    if (cappedSections.length === 0) {
      // No regens — synchronous refine; refine-complete fires now.
      return 0;
    }
    // Register an outstanding-refine entry so the lifecycle stays in
    // `refining` until every regen returns. Timeout is a safety valve:
    // if a regen hangs forever, the lifecycle won't deadlock.
    const key = lifecycleKey(project, slug);
    const existing = outstandingRefineRegens.get(key);
    if (existing) clearTimeout(existing.timeoutHandle);
    const timeoutHandle = setTimeout(() => {
      const entry = outstandingRefineRegens.get(key);
      if (entry && entry.count > 0) {
        outstandingRefineRegens.delete(key);
        void dispatchLifecycle(project, slug, {
          kind: 'refine-failed',
          reason: `regen timeout (${cappedSections.length} pending)`,
        });
      }
    }, REFINE_PASS_TIMEOUT_MS);
    outstandingRefineRegens.set(key, {
      count: cappedSections.length,
      spentUsd: 0,
      timeoutHandle,
    });
    const spawnFn = deps.getSpawnPlanSectionRegen();
    let idx = 0;
    for (const [section, hints] of cappedSections) {
      const correction = hints.slice(0, 5).join('\n- ');
      const fixPrompt = `Apply these corrections to the "${section}" section:\n- ${correction}`;
      setTimeout(() => {
        try {
          spawnFn(
            deps.planStore.readCurrent(plan.project, plan.slug) ?? nextPlan,
            section,
            undefined,
            undefined,
            fixPrompt,
          );
        } catch (err) {
          console.warn(`[auto-refine] regen for ${section} failed:`, err);
          // Decrement the outstanding count so a failed-to-spawn regen
          // doesn't keep the lifecycle hung.
          noteRefineRegenCompleted(project, slug);
        }
      }, idx * 3000);
      idx++;
    }
    return null;
  }

  async function getSnapshot(project: string, slug: string): Promise<LifecycleSnapshot | null> {
    const ctx = planLifecycle.get(lifecycleKey(project, slug));
    if (!ctx) return null;
    const { snapshotLifecycle } = await import('@esankhan3/anvil-core-pipeline');
    return snapshotLifecycle(ctx);
  }

  return {
    dispatchLifecycle,
    executeLifecycleVerify,
    executeLifecycleRefine,
    runAutoRefinePass,
    isPartOfActiveRefine,
    noteRefineRegenCompleted,
    getSnapshot,
  };
}
