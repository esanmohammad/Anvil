/**
 * Broadcast helpers (Phase 2 / Recipe — lifecycle extraction).
 *
 * The 5 `broadcast*` closures used to live inline in
 * `dashboard-server.ts` (`broadcastActiveRuns`, `broadcastState`,
 * `broadcastRuns`, `broadcastPlanLifecycle`, `broadcastCostSnapshot`)
 * plus the cost-snapshot computation. Each was a thin shim around
 * `services.<X>.emit(...)` over some closure-resident state.
 *
 * `createBroadcaster(deps)` returns the bundle as a small object — that
 * lets `dashboard-server.ts` keep its existing call-site shape
 * (`broadcasts.broadcastActiveRuns()`) while the bodies live here.
 * It also lets handler files reach broadcasts via `HandlerExtras` as a
 * single bag instead of one slot per fn.
 *
 * Why this matters: the handler registry (Phase 1) blocked on
 * `get-active-runs`, `refresh-prs`, the cost-policy mutations, etc.
 * because each broadcast was an internal closure. Lifting them out
 * lets the registry call into the broadcaster from `handlers/*.ts`
 * with no further plumbing.
 *
 * Phase 3 will further split each broadcast into its owning service
 * method (e.g. `services.runs.broadcastActiveRuns(...)` on the
 * `RunService` itself); for now the factory shape keeps the migration
 * boundary small.
 */

import { existsSync, statSync, watch as fsWatch } from 'node:fs';
import type { DashboardServices } from './services/index.js';
import type { CostBreachHandler } from './cost-breach-handler.js';
import type { CostLedger } from './cost-ledger.js';
import type { ProjectLoader } from './project-loader.js';
import { loadPolicy } from './pipeline-policy.js';

// ── Shared run-tracker types ───────────────────────────────────────────
// These used to live inline in `startDashboardServer`. Hoisted here so
// `broadcasts.ts` and the future `run-registry.ts` (Phase 2.2) share
// one definition.

export interface ActivityEntry {
  timestamp: number;
  stage: string;
  type: 'stdout' | 'stderr';
  content: string;
  kind?: string;
  tool?: string;
  agentId?: string;
  repo?: string;
}

export interface ActiveRunStage {
  name: 'fix' | 'validate' | 'fix-loop';
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempt?: number;
  error?: string;
  cost?: number;
  startedAt?: string;
  completedAt?: string;
}

export interface ActiveRun {
  id: string;
  type: 'build' | 'fix' | 'spike' | 'plan';
  project: string;
  description: string;
  model: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  agentId?: string;
  activities: ActivityEntry[];
  prUrls: Set<string>;
  stages?: ActiveRunStage[];
  error?: string;
  completedAt?: number;
  totalCost?: number;
}

// ── Factory ────────────────────────────────────────────────────────────

export interface BroadcasterDeps {
  services: DashboardServices;
  activeRuns: Map<string, ActiveRun>;
  costLedger: CostLedger;
  costBreachHandler: CostBreachHandler;
  projectLoader: ProjectLoader;
  /** `<homedir>/.anvil` — for `loadPolicy(project, anvilHome)`. */
  anvilHome: string;
  /** Absolute path of the runs index file — `<anvilHome>/runs/index.jsonl`. */
  runsIndex: string;
  /** Absolute path of the runs dir — `<anvilHome>/runs`. */
  runsDir: string;
  /** Loader for the run index — passed in so broadcasts.ts doesn't own disk paths. */
  loadRunsSync: () => unknown[];
  /** Reader for `state.json`. Same rationale. */
  readStateFile: () => unknown;
}

/**
 * Public surface returned by `createBroadcaster`. Each callsite holds
 * one reference and reads the methods it needs — keeps the call shape
 * identical to today's inline closures.
 */
export interface Broadcaster {
  broadcastActiveRuns(): void;
  broadcastState(): void;
  broadcastRuns(): void;
  broadcastPlanLifecycle(snap: import('@esankhan3/anvil-core-pipeline').LifecycleSnapshot): void;
  broadcastCostSnapshot(project: string, runId?: string | null): void;
  /**
   * Returns the project/run-scoped snapshot the cost meters render.
   * Pulled out so the handler-registry breach helpers can compute and
   * forward without a separate emit.
   */
  computeCostSnapshot(project: string, runId?: string | null): unknown;
  /** Start the state.json watcher. Returns a detach fn. */
  startStateWatcher(): () => void;
  /** Start the runs index.jsonl watcher. Returns a detach fn. */
  startRunsWatcher(): () => void;
  /**
   * Pre-load the state dedup string without emitting. Used by `sendInit`:
   * the init frame already carries `state`, so the next watcher tick
   * shouldn't fire a duplicate `state` emission. Call this right after
   * embedding `state` in init.
   */
  primeStateDedup(): void;
}

export function createBroadcaster(deps: BroadcasterDeps): Broadcaster {
  // `broadcastState` deduplicates by `JSON.stringify(state)` to avoid
  // chatty emissions on the 1-second poll interval. The closure state
  // lives here, not on the caller.
  let lastStateJson = '';

  function computeCostSnapshot(project: string, runId?: string | null): unknown {
    const policy = (() => { try { return loadPolicy(project, deps.anvilHome); } catch { return null; } })();
    const budget = (() => {
      try { return deps.projectLoader.getBudgetConfig(project); }
      catch { return {} as Record<string, unknown>; }
    })();
    const policyLimits = policy?.cost?.limits ?? {};
    const perRunLimit = policyLimits.perRun ?? (typeof budget.max_per_run === 'number' ? budget.max_per_run : undefined);
    const dailyLimit = policyLimits.perProjectDaily ?? (typeof budget.max_per_day === 'number' ? budget.max_per_day : undefined);
    const alertAtUsd = typeof budget.alert_at === 'number' ? budget.alert_at : undefined;
    const alertAtFraction = (alertAtUsd && dailyLimit && dailyLimit > 0) ? alertAtUsd / dailyLimit : 0.6;

    const todayUsd = (() => { try { return deps.costLedger.projectDailyTotal(project); } catch { return 0; } })();

    const runBlock = runId ? (() => {
      try {
        const sum = deps.costLedger.summarize(runId, project);
        return { usd: sum.totalUsd, limitUsd: perRunLimit, perStageUsd: sum.byStage };
      } catch { return undefined; }
    })() : undefined;

    const breach = (() => {
      try {
        let b: ReturnType<typeof deps.costBreachHandler.getBreach> | null | undefined;
        if (runId) {
          b = deps.costBreachHandler.getBreach(runId);
        } else {
          const pendings = deps.costBreachHandler.listPending?.() ?? [];
          b = pendings.find((p) => p.project === project) ?? null;
        }
        if (!b || b.status !== 'pending') return undefined;
        const topSpenders = (() => {
          try {
            const sum = deps.costLedger.summarize(b!.runId, project);
            return Object.entries(sum.byStage)
              .map(([stage, usd]) => ({ stage, usd: usd as number }))
              .sort((a, c) => c.usd - a.usd)
              .slice(0, 3);
          } catch { return []; }
        })();
        return {
          runId: b.runId,
          project: b.project,
          currentUsd: b.currentUsdAtBreach,
          limitUsd: b.limitUsdAtBreach,
          projectedUsd: b.currentUsdAtBreach * 1.2,
          graceEndsAt: b.graceEndsAt,
          topSpenders,
          extensionsUsed: b.extensionsUsed,
        };
      } catch { return undefined; }
    })();

    return {
      project,
      runId: runId ?? undefined,
      run: runBlock,
      today: { usd: todayUsd, limitUsd: dailyLimit, alertAt: alertAtFraction },
      pendingBreach: breach,
      recentBreaches: { count30d: 0, decisions: { raise: 0, reject: 0, extend: 0, autoResolved: 0 } },
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * Always emits the run-scoped snapshot when a runId is provided, plus
   * the project-wide snapshot once for any subscribers watching the
   * project alone. The bridge fans the event out to the `cost`,
   * `project:<X>`, and `run:<id>` rooms.
   */
  function broadcastCostSnapshot(project: string, runId?: string | null): void {
    if (runId) {
      const runSnap = computeCostSnapshot(project, runId);
      deps.services.cost.emit('cost.snapshot', { project, runId, snapshot: runSnap });
    }
    const projectSnap = computeCostSnapshot(project);
    deps.services.cost.emit('cost.snapshot', { project, snapshot: projectSnap });
  }

  function broadcastActiveRuns(): void {
    const list = Array.from(deps.activeRuns.values()).map((r) => ({
      id: r.id,
      type: r.type,
      project: r.project,
      description: r.description,
      model: r.model,
      status: r.status,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      activityCount: r.activities.length,
      stages: r.stages,
      error: r.error,
      totalCost: r.totalCost,
    }));
    deps.services.runs.emit('run.active-snapshot', { runs: list });
  }

  function broadcastState(): void {
    const state = deps.readStateFile();
    const json = JSON.stringify(state);
    if (json === lastStateJson) return;
    lastStateJson = json;
    // Cast widens to the typed payload shape; the runtime value is the
    // same `DashboardState` object the legacy code emitted.
    deps.services.system.emit('state', { state } as never);
  }

  function broadcastRuns(): void {
    try {
      const runs = deps.loadRunsSync();
      deps.services.runs.emit('runs.list', { runs } as never);
    } catch { /* ignore */ }
  }

  function broadcastPlanLifecycle(
    snap: import('@esankhan3/anvil-core-pipeline').LifecycleSnapshot,
  ): void {
    deps.services.plans.emit('plan.lifecycle', { snapshot: snap });
  }

  function startStateWatcher(): () => void {
    let watcher: ReturnType<typeof fsWatch> | null = null;
    try {
      if (existsSync(deps.anvilHome)) {
        watcher = fsWatch(deps.anvilHome, (_eventType, filename) => {
          if (filename === 'state.json') broadcastState();
        });
      }
    } catch {
      console.warn('[dashboard] Could not fs.watch ANVIL_HOME');
    }
    const interval = setInterval(() => broadcastState(), 1000);
    return () => { try { watcher?.close(); } catch { /* ok */ } clearInterval(interval); };
  }

  function startRunsWatcher(): () => void {
    let lastRunsSize = 0;
    try {
      if (existsSync(deps.runsIndex)) lastRunsSize = statSync(deps.runsIndex).size;
    } catch { /* ignore */ }

    let watcher: ReturnType<typeof fsWatch> | null = null;
    try {
      if (existsSync(deps.runsDir)) {
        watcher = fsWatch(deps.runsDir, (_, filename) => {
          if (filename === 'index.jsonl') broadcastRuns();
        });
      }
    } catch { /* ignore */ }

    const interval = setInterval(() => {
      try {
        if (!existsSync(deps.runsIndex)) return;
        const size = statSync(deps.runsIndex).size;
        if (size !== lastRunsSize) {
          lastRunsSize = size;
          broadcastRuns();
        }
      } catch { /* ignore */ }
    }, 2000);
    return () => { try { watcher?.close(); } catch { /* ok */ } clearInterval(interval); };
  }

  function primeStateDedup(): void {
    lastStateJson = JSON.stringify(deps.readStateFile());
  }

  return {
    broadcastActiveRuns,
    broadcastState,
    broadcastRuns,
    broadcastPlanLifecycle,
    broadcastCostSnapshot,
    computeCostSnapshot,
    startStateWatcher,
    startRunsWatcher,
    primeStateDedup,
  };
}
