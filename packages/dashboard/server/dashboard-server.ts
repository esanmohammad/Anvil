/**
 * Dashboard server — Hivemind/Swarm pattern.
 *
 * The dashboard IS the orchestrator. It uses:
 *   - ProjectLoader for project configuration (discovery, workspace setup)
 *   - FeatureStore for artifact persistence
 *   - PipelineRunner for multi-stage orchestration with per-repo parallelism
 *   - AgentManager for spawning Claude agents
 *
 * Architecture:
 *   HTTP server serves static files from dist/
 *   WebSocket server on same port via upgrade handler
 *   File watcher (fs.watch + polling) on state.json and runs/index.jsonl
 *   Full state broadcast on every change
 */

import { createServer } from 'node:http';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';

// @ts-ignore — ws is a runtime dependency
// Raw WebSocket server removed in Phase 8 — socket.io is the sole
// transport. The `ws` library is no longer a runtime dependency.

import type { AgentManager } from '@esankhan3/anvil-agent-core';
import type { PipelineRunner } from './pipeline-runner.js';
import type { PipelineRunState } from './pipeline-runner.js';
// Store classes are constructed in `./setup/stores.ts`. Only types
// + helper fns still imported here.
import type { KnowledgeBaseManager } from './knowledge-base-manager.js';
import type { Plan, PlanSection } from './plan-store.js';
import { SHARE_TOKEN_TTL_MS } from './plan-share.js';
import { PipelinePauseSweeper } from './pipeline-pause-sweeper.js';
import {
  resolveModelForStage as registryResolveStage,
  ModelResolutionError,
  UnknownStageError,
} from '@esankhan3/anvil-core-pipeline';
import { createServices, type DashboardServices } from './services/index.js';
import { createReplay, type EventReplay } from './events/replay.js';
import type { SocketServerHandle } from './ws/socket-server.js';
import { handlerRegistry } from './handlers/registry.js';
import type { HandlerExtras } from './handlers/route.js';
import { buildHandlerExtras } from './handlers/extras-builder.js';
import { createBroadcaster, type ActiveRun, type ActivityEntry } from './broadcasts.js';
import { attachAgentEventRouter, type PlanAgentContext as AERPlanAgentContext } from './agent-event-router.js';
import type { WebhookDeps as WebhookDepsExt } from './http/webhook-routes.js';
import { createPostRunPersister } from './pipeline/post-run.js';
import { createPrTracker, type TrackedPR } from './pipeline/pr-tracking.js';
import { createPlanLifecycle } from './pipeline/plan-lifecycle.js';
import { createProjectOverviewBuilder } from './pipeline/project-overview.js';
import { createQuickActionSpawner } from './pipeline/quick-action.js';
import { createPlanSpawn, type PlanAgentContextEntry } from './pipeline/plan-spawn.js';
import { createReviewSpawn } from './pipeline/review-spawn.js';
import { createStartPipeline, type StartPipelineFn } from './pipeline/start-pipeline.js';
import { createCostBreachRouter } from './pipeline/cost-breach-router.js';
import { startSleeptimeConsolidator } from './setup/sleeptime.js';
import { startAutoReplayPump } from './setup/auto-replay.js';
import { restoreIncompletePipelines } from './setup/restore-incomplete.js';
import { createInitSender } from './setup/init-payload.js';
import { registerGracefulShutdown } from './setup/graceful-shutdown.js';
import { listenAndReturnHandle } from './setup/server-listen.js';
import { WS_OPEN, type WsClient } from './setup/ws-client.js';
import { createStaticHandler } from './http/static.js';
import { loadRunsSync, readStateFile } from './runs/io.js';
import { discoverAvailableModels, type AvailableModelsResult } from './setup/model-discovery.js';
import {
  parseFixPatternContent,
  getWorkspaceFromConfig,
} from './shared/workspace.js';
import { createDashboardStores } from './setup/stores.js';
import {
  loadAnvilEnv,
  autoDetectTelemetry,
  ensureQuietOtelLogs,
} from './setup/load-env.js';
import { createCancelLegacyPipeline } from './pipeline/cancel-legacy.js';
import type {
  ProjectSummary,
  RunSummary,
  DashboardStageState,
  DashboardPipeline,
  DashboardState,
  ServerMessage,
  ClientMessage,
  DashboardServerOptions,
  DashboardServerHandle,
} from './shared/server-types.js';

// ── Paths ───────────────────────────────────────────────────────────────
const ANVIL_HOME = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
const CONVENTION_PATHS = {
  conventionsDir: join(ANVIL_HOME, 'conventions'),
  rulesDir: join(ANVIL_HOME, 'conventions', 'rules'),
};
const RUNS_DIR = join(ANVIL_HOME, 'runs');
const RUNS_INDEX = join(RUNS_DIR, 'index.jsonl');
const STATE_FILE = join(ANVIL_HOME, 'state.json');

// `.env` loader + telemetry auto-detect moved to `./setup/load-env.ts`.
// `loadAnvilEnv` runs synchronously so subsequent imports / boot code
// see the populated `process.env`. `autoDetectTelemetry()` is
// fire-and-forget; the actual OTel SDK initialises lazily on the
// first agent call.
loadAnvilEnv(ANVIL_HOME);
ensureQuietOtelLogs();
void autoDetectTelemetry();

// ── MIME map ────────────────────────────────────────────────────────────
// `MIME` map + static-file handler moved to `./http/static.ts`.

// ── Types ───────────────────────────────────────────────────────────────
// Shared wire-shape interfaces moved to `./shared/server-types.ts`.
// Re-exported here so consumers keep their existing import paths.
export type {
  ProjectSummary,
  RunSummary,
  DashboardStageState,
  DashboardPipeline,
  DashboardState,
  ServerMessage,
  ClientMessage,
} from './shared/server-types.js';

// ── Helpers ──────────────────────────────────────────────────────────────
// `parseFixPatternContent` + `getWorkspaceFromConfig` moved to
// `./shared/workspace.ts`. Imported above.

// Model discovery moved to `./setup/model-discovery.ts`.
// `AvailableModelsResult` is re-exported from there.
export type { AvailableModelsResult };

// `loadRunsSync(RUNS_INDEX)` + `readStateFile(STATE_FILE)` moved to
// `./runs/io.ts`. Call sites pass the path explicitly so tests can
// target a temp ANVIL_HOME.

// Static file handler moved to `./http/static.ts`. `WebhookDeps`
// continues to live in `./http/webhook-routes.ts`; local alias kept
// for the `webhookDepsRef` typing further down.
type WebhookDeps = WebhookDepsExt;

// ── Dashboard server ────────────────────────────────────────────────────
// `DashboardServerOptions` + `DashboardServerHandle` live in
// `./shared/server-types.ts`; re-exported up top.
export type { DashboardServerOptions, DashboardServerHandle };

/**
 * Dependency-injection seam for `startDashboardServer`. Tests pass fakes
 * here to avoid real LLM spawns and real provider APIs. Every field is
 * optional with a default matching today's inline construction.
 *
 * Stays here (not in `shared/server-types.ts`) because it references
 * `AgentManager` + `DashboardServices` + `EventReplay`, which would
 * make `shared/` import the agent-core/services packages.
 */
export interface DashboardServerDeps {
  agentManager?: AgentManager;
  services?: DashboardServices;
  replay?: EventReplay;
}

export async function startDashboardServer(
  opts: DashboardServerOptions,
  deps: DashboardServerDeps = {},
): Promise<DashboardServerHandle> {
  const port = opts.port ?? 5173;
  const kbManagerRef: { current: KnowledgeBaseManager | null } = { current: null };
  const webhookDepsRef: { current: WebhookDeps | null } = { current: null };
  const handler = createStaticHandler({
    staticDir: opts.staticDir,
    anvilHome: ANVIL_HOME,
    kbManagerRef,
    webhookDepsRef,
  });
  const server = createServer(handler);
  // Phase 8: raw WebSocket transport removed. socket.io handles every WS
  // upgrade on `/socket.io/*` through its own internal upgrade listener
  // registered by `mountSocketServer`. `WsClient` / `WS_OPEN` shapes
  // live in `./setup/ws-client.ts` so the init-payload sender +
  // server-listen factory share one definition.
  void WS_OPEN;

  // ── Shared stores (Phase 3 round-11 — `./setup/stores.ts`) ────────
  const stores = createDashboardStores({
    anvilHome: ANVIL_HOME,
    agentManager: deps.agentManager,
  });
  const {
    projectLoader, featureStore, agentManager, memoryStore, kbManager,
    planStore, planValidator,
    reviewStore, testSpecStore, testCaseStore, testRunStore,
    testLearningsStore, incidentStore, replayStore, boundTestsStore,
    pauseStore, auditLog, learningsStore, costLedger,
    blobStore, checkpointStore, approvalSecret,
    boundAuditLog, ciTriageStore,
    reviewDismissalStore, reviewCalibrationStore,
  } = stores;
  void stores.reviewersStore; void stores.relevanceCache; // unused in boot

  // Plan lifecycle is now owned by `./pipeline/plan-lifecycle.ts`.
  // The `planLifecycleHandle` binding happens after `services` +
  // `broadcastPlanLifecycle` exist (see below). Until then, declare
  // forward stubs the closure-site signatures can reference.
  let dispatchLifecycle!: (
    project: string,
    slug: string,
    event: import('@esankhan3/anvil-core-pipeline').LifecycleEvent,
  ) => Promise<import('@esankhan3/anvil-core-pipeline').LifecycleSnapshot>;
  let executeLifecycleVerify!: (project: string, slug: string) => Promise<void>;
  let executeLifecycleRefine!: (project: string, slug: string) => Promise<void>;
  let isPartOfActiveRefine!: (project: string, slug: string) => boolean;
  let noteRefineRegenCompleted!: (project: string, slug: string) => void;
  let getLifecycleSnapshot!: (
    project: string, slug: string,
  ) => Promise<import('@esankhan3/anvil-core-pipeline').LifecycleSnapshot | null>;
  // Auto-replay queue — crash-safe FIFO for incident → bug-replay-pipeline jobs.
  const { AutoReplayQueue } = await import('./auto-replay-queue.js');
  const autoReplayQueue = new AutoReplayQueue(ANVIL_HOME, { maxConcurrent: 2, maxAttempts: 3 });
  kbManagerRef.current = kbManager;

  // ── Clean up stale "running" state from previous crashes ────────────
  {
    const staleState = readStateFile(STATE_FILE);
    if (staleState.activePipeline) {
      staleState.activePipeline = null;
      staleState.lastUpdated = new Date().toISOString();
      try {
        const tmp = STATE_FILE + '.tmp';
        writeFileSync(tmp, JSON.stringify(staleState, null, 2), 'utf-8');
        renameSync(tmp, STATE_FILE);
        console.log('[dashboard] Cleared stale pipeline state');
      } catch { /* ignore */ }
    }
  }

  // ── PR tracking (Phase 3 — extracted to ./pipeline/pr-tracking.ts) ──
  // `createPrTracker(deps)` owns the `trackedPRs` map + the 30s polling
  // interval. `services` is constructed below; PR tracker is built
  // after services exist (see the `prTracker = createPrTracker(...)` line).
  // For now declare placeholder types so the closure-site signatures
  // resolve. The actual binding happens later in the boot sequence.
  let extractPRUrls!: (text: string) => string[];
  let fetchPRDetails!: (prUrl: string) => Promise<TrackedPR | null>;
  let trackedPRsForBroadcast!: () => Array<TrackedPR & { review: unknown }>;
  let refreshTrackedPRs!: () => Promise<void>;
  let trackPR!: (prUrl: string) => Promise<void>;
  let loadPRsFromFeatureStore!: () => Promise<void>;
  let stopPrPolling: (() => void) | null = null;

  // ── Pipeline tracking ───────────────────────────────────────────────
  let activeChild: ChildProcess | null = null;
  // ActivityEntry / ActiveRunStage / ActiveRun moved to `./broadcasts.ts`
  // so they can be shared with the broadcaster + handler registry.
  let outputBuffer: ActivityEntry[] = [];
  let activePipelineRunner: PipelineRunner | null = null;
  // `startPipeline` is bound to the `createStartPipeline(...)` factory
  // result further down (after `persistRunRecord`). Declared up-front so
  // the `handlerExtras.pipelineActions.startPipeline` thunk closes over
  // the same binding the factory will assign.
  let startPipeline: StartPipelineFn = () => {
    throw new Error('startPipeline invoked before factory init');
  };

  const activeRuns = new Map<string, ActiveRun>();

  /** Map agentId → runId for quick action agents */
  const agentToRunId = new Map<string, string>();

  // Cost subscriptions used to be tracked per-WS with a WeakMap; with
  // socket.io rooms + the typed `services.cost.emit('cost.snapshot', …)`
  // path, the bridge fans every snapshot to the `cost`/`project:<X>`
  // rooms (plus `global`) and clients filter locally. The
  // `subscribe-cost`/`unsubscribe-cost` handlers are no-ops now and the
  // initial-snapshot reply is delivered via the same typed emission.

  // Broadcaster initialised after `services` + `costBreachHandler` are
  // constructed below (Phase 2 — see `./broadcasts.ts`).

  // ── Agent Manager events ────────────────────────────────────────────
  // The 4 `agentManager.on('agent-{activity,output,done,error}')` listeners
  // + resolveAgentRepo/resolveAgentStage live in `./agent-event-router.ts`
  // (Phase 2.3). `attachAgentEventRouter(...)` is wired late — after every
  // closure dep is declared — see the bottom of `startDashboardServer`.

  // `lastStateJson` (dedup for broadcastState) lives inside `createBroadcaster`.

  // ── Typed services + replay ─────────────────────────────────────────
  // Services own typed event emissions per domain. The socket.io bridge
  // (`bridgeServicesToRooms` inside `mountSocketServer`) subscribes to
  // every service and fans events to the matching socket.io rooms after
  // appending the typed envelope to the replay ring buffer for
  // subscribe-since backfill on reconnect.
  const services: DashboardServices = deps.services ?? createServices({
    plans: { planStore, planValidator },
    bind: { boundTestsStore, boundAuditLog },
    reviews: {
      reviewStore, reviewCalibrationStore, reviewDismissalStore,
      projectLoader, anvilHome: ANVIL_HOME,
    },
    incidents: { incidentStore },
    kb: { kbManager },
    projectGraph: { anvilHome: ANVIL_HOME },
    // cost deps are late-bound below (circular dep: CostBreachHandler.onNotify
    // closes over services.cost.emit).
  });
  const replay: EventReplay = deps.replay ?? createReplay();

  // ── PR tracking bound now that `services` exists (Phase 3) ──────────
  {
    const prTracker = createPrTracker({ reviewStore, featureStore, services });
    extractPRUrls = prTracker.extractPRUrls;
    fetchPRDetails = prTracker.fetchPRDetails;
    trackedPRsForBroadcast = prTracker.trackedPRsForBroadcast;
    refreshTrackedPRs = prTracker.refreshTrackedPRs;
    trackPR = prTracker.trackPR;
    loadPRsFromFeatureStore = prTracker.loadPRsFromFeatureStore;
    stopPrPolling = prTracker.startPolling();
  }

  // ── Phase 4: socket.io transport modules built but NOT auto-mounted ─
  // Wiring `new socketIo.Server(httpServer)` here disrupts the raw WS
  // pipeline — socket.io's attach() replaces the http server's request
  // listener and the raw `WebSocketServer({ server, path: '/ws' })`
  // stops receiving upgrades reliably. The frontend currently relies
  // on raw WS, so we defer the actual socket.io mount to Phase 5,
  // which lands the mount + the frontend swap together. The bridge
  // module + socket-server module are unit-tested in isolation; the
  // services bundle + replay buffer feed both paths once Phase 5 wires
  // socket.io in as the primary transport.
  // eslint-disable-next-line prefer-const -- listenAndReturnHandle assigns on mount
  let socketHandle: SocketServerHandle | null = null as SocketServerHandle | null;

  // Auto-replay queue pump (15s interval) moved to
  // `./setup/auto-replay.ts`. Returns a stop fn that gets registered
  // with the stop-handler chain further down.
  const autoReplayPump = startAutoReplayPump({
    autoReplayQueue,
    incidentStore,
    replayStore,
    testSpecStore,
    testCaseStore,
    testLearningsStore,
    boundTestsStore,
    agentManager,
    projectLoader,
    services,
  });

  // Populate the webhook-deps ref for the static handler (see /api/incidents/webhook/*).
  webhookDepsRef.current = {
    incidentStore, replayStore,
    testSpecStore, testCaseStore, testLearningsStore,
    boundTestsStore, agentManager, projectLoader,
    services,
    enqueueReplay: (incidentId: string, project: string) => {
      autoReplayQueue.enqueue(incidentId, project);
      return { queueDepth: autoReplayQueue.snapshot().length };
    },
    pauseStore, approvalSecret,
    kbManager, ciTriageStore,
  };

  // ── Sweepers: pause timeouts + cost breach grace ─────────────────────
  const pauseSweeper = new PipelinePauseSweeper(pauseStore, {
    intervalMs: 60_000,
    onTimeout: (state) => {
      services.pipeline.emit('pipeline.paused', { pause: state });
      try {
        auditLog.record({
          runId: state.runId, project: state.project,
          event: 'timed-out', actor: 'system',
        });
      } catch { /* non-fatal */ }
    },
  });
  pauseSweeper.start();

  // Cost-breach handler + sweeper + onNotify/onRejectStop wiring live in
  // `./pipeline/cost-breach-router.ts`. The factory takes a `{ current }`
  // ref for `broadcastCostSnapshot` because the broadcaster requires
  // `costBreachHandler` as a dep — the snapshot fn is wired after the
  // broadcaster is built (see further down).
  const broadcastCostSnapshotRef: { current: (project: string, runId: string) => void } = {
    current: () => { /* late-bound below */ },
  };
  const costBreachRouter = createCostBreachRouter({
    anvilHome: ANVIL_HOME,
    costLedger,
    agentManager,
    services,
    activeRuns,
    agentToRunId,
    getActivePipelineRunner: () => activePipelineRunner,
    broadcastCostSnapshotRef,
  });
  const costBreachHandler = costBreachRouter.handler;
  const costBreachSweeper = costBreachRouter.sweeper;

  // Late-bind cost deps now that costBreachHandler exists. See the
  // CostService docstring for why this is two-phase.
  services.cost.setDeps({
    costBreachHandler,
    breachLogDir: costBreachRouter.breachLogDir,
  });

  // Shutdown hook — stop sweepers on process exit.
  const shutdownSweepers = () => {
    try { pauseSweeper.stop(); } catch { /* ignore */ }
    try { costBreachSweeper.stop(); } catch { /* ignore */ }
  };
  process.once('SIGINT', shutdownSweepers);
  process.once('SIGTERM', shutdownSweepers);

  // ── Broadcasts (Phase 2 — extracted to `./broadcasts.ts`) ───────────
  // `broadcastActiveRuns`, `broadcastState`, `broadcastRuns`,
  // `broadcastPlanLifecycle`, `broadcastCostSnapshot`,
  // `computeCostSnapshot`, `startStateWatcher`, `startRunsWatcher` live
  // in `createBroadcaster(...)`. Destructure so existing call sites
  // (`broadcastActiveRuns()`, etc.) keep working unchanged.
  const broadcaster = createBroadcaster({
    services,
    activeRuns,
    costLedger,
    costBreachHandler,
    projectLoader,
    anvilHome: ANVIL_HOME,
    runsIndex: RUNS_INDEX,
    runsDir: RUNS_DIR,
    loadRunsSync: () => loadRunsSync(RUNS_INDEX),
    readStateFile: () => readStateFile(STATE_FILE),
  });
  const {
    broadcastActiveRuns,
    broadcastState,
    broadcastRuns,
    broadcastPlanLifecycle,
    broadcastCostSnapshot,
    computeCostSnapshot,
    startStateWatcher,
    startRunsWatcher,
  } = broadcaster;
  // Late-bind: the cost-breach onNotify closure now has a real
  // snapshot dispatcher (was a noop until the broadcaster existed).
  broadcastCostSnapshotRef.current = broadcastCostSnapshot;

  // ── Plan lifecycle binding (Phase 3 — ./pipeline/plan-lifecycle.ts) ──
  // Forward-ref to spawnPlanSectionRegen (still in the monolith) lets
  // the lifecycle module call back into the plan-spawn flow without a
  // circular import. The getter resolves at call time, after
  // spawnPlanSectionRegen is declared further down.
  const planLifecycleHandle = createPlanLifecycle({
    planStore,
    planValidator,
    projectLoader,
    services,
    broadcastPlanLifecycle,
    getSpawnPlanSectionRegen: () => planSpawn.spawnPlanSectionRegen,
  });
  dispatchLifecycle = planLifecycleHandle.dispatchLifecycle;
  executeLifecycleVerify = planLifecycleHandle.executeLifecycleVerify;
  executeLifecycleRefine = planLifecycleHandle.executeLifecycleRefine;
  isPartOfActiveRefine = planLifecycleHandle.isPartOfActiveRefine;
  noteRefineRegenCompleted = planLifecycleHandle.noteRefineRegenCompleted;
  getLifecycleSnapshot = planLifecycleHandle.getSnapshot;

  // Plan-spawn cluster (Phase 3 round-3 — ./pipeline/plan-spawn.ts).
  // Owns `planAgentContext` Map; the agent-event router consumes the
  // map + finalize/retry refs via the bag built later in this fn.
  const planSpawn = createPlanSpawn({
    agentManager,
    planStore,
    planValidator,
    kbManager,
    memoryStore,
    projectLoader,
    services,
    activeRuns,
    agentToRunId,
    broadcastActiveRuns,
    getWorkspaceFromConfig,
    resetOutputBuffer: () => { outputBuffer = []; },
    resolvePlanStageModel,
    lifecycle: planLifecycleHandle,
  });
  const {
    spawnPlanAgent, spawnOnePlanVariant, spawnPlanVariants,
    spawnPlanSectionRegen, retryPlanAgentWithNextModel,
    finalizePlanAgent, planAgentContext,
  } = planSpawn;
  void spawnOnePlanVariant;

  // Review-spawn cluster (Phase 3 round-3 — ./pipeline/review-spawn.ts).
  // Owns `reviewAgentContext` Map; the agent-event router consumes
  // `finalizeReviewAgent` + the Map via the bag built later in this fn.
  const reviewSpawn = createReviewSpawn({
    anvilHome: ANVIL_HOME,
    conventionPaths: CONVENTION_PATHS,
    agentManager,
    planStore,
    projectLoader,
    services,
    reviewStore,
    reviewCalibrationStore,
    reviewDismissalStore,
    boundTestsStore,
    getWorkspaceFromConfig,
  });
  const {
    startReviewRun, finalizeReviewAgent, applyReviewFix, reviewAgentContext,
  } = reviewSpawn;

  // ── Send full init payload to a single client ───────────────────────
  // Closure now lives in `./setup/init-payload.ts`. The factory takes
  // a `getOutputBuffer()` getter so the rebound `let outputBuffer = []`
  // semantics survive (pipeline + quick-action both reassign it).
  const sendInit = createInitSender({
    projectLoader,
    featureStore,
    broadcaster,
    activeRuns,
    discoverAvailableModels,
    loadRunsSync: () => loadRunsSync(RUNS_INDEX),
    readStateFile: () => readStateFile(STATE_FILE),
    trackedPRsForBroadcast,
    getOutputBuffer: () => outputBuffer,
  });

  // File watchers + broadcastRuns moved to ./broadcasts.ts (Phase 2)

  // Raw-WS connection handler removed in Phase 8 — every client now
  // connects via socket.io. `handleClientMessage` below is invoked from
  // `mountSocketServer({ onAction })` with the fauxWs adapter.

  // Build the project-overview function up-front so `handlerExtras`
  // can reference it without forward-declaration issues.
  const buildProjectOverview = createProjectOverviewBuilder({
    memoryStore,
    projectLoader,
    featureStore,
    kbManager,
    conventionPaths: CONVENTION_PATHS,
  });

  // ── Handler-registry deps (Recipe 7 / Phase 1). Each closure-resident
  // dep that case bodies used to capture from this scope is threaded
  // through `HandlerExtras`; Phase 2 will drain this struct as those
  // closures are extracted into their own modules.
  const handlerExtras: HandlerExtras = buildHandlerExtras({
    anvilHome: ANVIL_HOME,
    shareTokenTtlMs: SHARE_TOKEN_TTL_MS,
    conventionPaths: CONVENTION_PATHS,
    runsDir: RUNS_DIR,
    runsIndex: RUNS_INDEX,
    projectLoader,
    planStore,
    planValidator,
    incidentStore,
    replayStore,
    boundTestsStore,
    boundAuditLog,
    autoReplayQueue,
    reviewStore,
    reviewCalibrationStore,
    reviewDismissalStore,
    testSpecStore,
    testCaseStore,
    testRunStore,
    testLearningsStore,
    ciTriageStore,
    featureStore,
    kbManager,
    memoryStore,
    costLedger,
    costBreachHandler,
    pauseStore,
    learningsStore,
    checkpointStore,
    auditLog,
    activeRuns,
    agentToRunId,
    agentManager,
    dispatchLifecycle,
    getLifecycleSnapshot,
    broadcastCostSnapshot,
    discoverAvailableModels,
    getWorkspaceFromConfig,
    buildProjectOverview,
    broadcastActiveRuns,
    broadcastRuns,
    loadRunsSync: () => loadRunsSync(RUNS_INDEX),
    refreshTrackedPRs,
    trackedPRsForBroadcast,
    sendInit,
    executeLifecycleRefine,
    defaultUser: process.env.ANVIL_USER_NAME ?? 'anonymous',
    // Spawn closures are declared further down in the boot sequence
    // (`spawnQuickAction`, `applyReviewFix`, etc.). Wrap in thunks so
    // the extras builder sees a stable closure that resolves the
    // late-bound `const` references on each call.
    startPipeline: (project, feature, options) =>
      startPipeline(project, feature, options as Parameters<typeof startPipeline>[2]),
    spawnQuickAction: (action, project, feature, model) =>
      spawnQuickAction(action, project, feature, model),
    spawnPlanAgent: (project, feature, model) =>
      spawnPlanAgent(project, feature, model),
    spawnPlanVariants: (project, feature, variants, model) =>
      spawnPlanVariants(project, feature, variants as Parameters<typeof spawnPlanVariants>[2], model),
    spawnPlanSectionRegen: (plan, section, model) =>
      spawnPlanSectionRegen(plan, section, model),
    startReviewRun: (project, prUrl, trigger, personas, model, prior) =>
      startReviewRun(
        project,
        prUrl,
        trigger as Parameters<typeof startReviewRun>[2],
        personas,
        model,
        prior as Parameters<typeof startReviewRun>[5],
      ),
    applyReviewFix: (project, reviewId, findingId) =>
      applyReviewFix(project, reviewId, findingId),
    getActivePipelineRunner: () => activePipelineRunner,
    setActivePipelineRunner: (r) => { activePipelineRunner = r; },
    getActiveChild: () => activeChild,
    cancelLegacyPipeline: () => cancelLegacyPipeline(),
  });

  // ── Client message handler ──────────────────────────────────────────
  async function handleClientMessage(ws: WsClient, msg: ClientMessage): Promise<void> {
    // Recipe 7 + Phase 2.6: every WS action is now in the registry.
    // Unknown actions silently drop (legacy parity — the switch's
    // `default: break;` was the same no-op).
    const registered = handlerRegistry[msg.action];
    if (!registered) return;
    await registered(msg, { services, ws, raw: msg, extras: handlerExtras });
  }

  // ── Run persistence ─────────────────────────────────────────────────

  /**
   * Persist a complete run record to both:
   *  1. RUNS_INDEX (global, for history list)
   *  2. FeatureStore (per-feature, for detailed analysis)
   *
   * Stores: stages, per-stage costs/timing, total cost, model, repos, PRs, duration
   */
  // `persistRunRecord` lives in `./pipeline/post-run.ts` since Phase 3.
  // The factory closes over `activeRuns` (write access for PR aggregation)
  // and the surrounding feature/memory/agent managers.
  const persistRunRecord = createPostRunPersister({
    anvilHome: ANVIL_HOME,
    runsDir: RUNS_DIR,
    runsIndex: RUNS_INDEX,
    featureStore,
    memoryStore,
    agentManager,
    activeRuns: activeRuns as unknown as Map<string, { prUrls: Set<string> }>,
    getWorkspaceFromConfig,
  });

  // buildProjectOverview moved to ./pipeline/project-overview.ts; the
  // factory is constructed earlier (before handlerExtras) so the extras
  // bag can reference it without a forward declaration.

  // ── Start pipeline (Phase 3 round-4 — ./pipeline/start-pipeline.ts) ──
  // The closure (~670 LOC) now lives in `createStartPipeline(deps)`.
  // Mutable state (`activePipelineRunner`, `activeChild`,
  // `outputBuffer`) stays here and is threaded via get/set callbacks so
  // the legacy register-before-spawn + restore-spawn-on-complete
  // invariants are preserved.
  startPipeline = createStartPipeline({
    agentManager,
    projectLoader,
    featureStore,
    memoryStore,
    kbManager,
    testSpecStore,
    testCaseStore,
    pauseStore,
    auditLog,
    costLedger,
    costBreachHandler,
    blobStore,
    checkpointStore,
    services,
    activeRuns,
    agentToRunId,
    getActivePipelineRunner: () => activePipelineRunner,
    setActivePipelineRunner: (r) => { activePipelineRunner = r; },
    getActiveChild: () => activeChild,
    setActiveChild: (c) => { activeChild = c; },
    resetOutputBuffer: () => { outputBuffer = []; },
    pushOutputEntry: (entry) => { outputBuffer.push(entry); },
    broadcastActiveRuns,
    broadcastRuns,
    broadcastCostSnapshot: (project, runId) => broadcastCostSnapshot(project, runId ?? undefined),
    persistRunRecord,
    extractPRUrls,
    trackPR,
    dispatchLifecycle,
    startReviewRun: (project, prUrl, sourceStage, personas, model) =>
      startReviewRun(project, prUrl, sourceStage, personas, model),
    anvilHome: ANVIL_HOME,
    runsDir: RUNS_DIR,
    stateFile: STATE_FILE,
    approvalSecret,
  });

  // ── Quick action spawn (via AgentManager directly) ──────────────────
  // Moved to ./pipeline/quick-action.ts. The factory closes over the
  // same `outputBuffer` let-binding via the reset/push callbacks so the
  // legacy "outputBuffer = []" reassignment behavior is preserved.
  const spawnQuickAction = createQuickActionSpawner({
    agentManager,
    kbManager,
    memoryStore,
    projectLoader,
    services,
    activeRuns,
    agentToRunId,
    broadcastActiveRuns,
    getWorkspaceFromConfig,
    resetOutputBuffer: () => { outputBuffer = []; },
    pushOutputEntry: (entry) => { outputBuffer.push(entry); },
  });

  // ── Plan agent: structured Plan generation ─────────────────────────
  // Spawn cluster (spawnPlanAgent, spawnOnePlanVariant, spawnPlanVariants,
  // spawnPlanSectionRegen, retryPlanAgentWithNextModel, finalizePlanAgent,
  // buildPlanPrompt, pickNextPlanModel) + `planAgentContext` Map moved to
  // `./pipeline/plan-spawn.ts`. The factory is constructed alongside the
  // plan lifecycle handle further up. Tunables (PLAN_AGENT_MAX_ATTEMPTS,
  // PLAN_AGENT_SAME_AGENT_RETRIES, VARIANT_SPAWN_STAGGER_MS) live inside
  // the factory.

  /**
   * Resolve the model for a stage from `~/.anvil/models.yaml` +
   * stage-policy.yaml. Honors an explicit user pick (anything that's
   * not the legacy `'sonnet'` sentinel) and otherwise lets the
   * resolver pick the first model in the chain. UI's
   * `availableModels.defaultModel` is hardcoded to `'sonnet'` (see
   * provider-registry.ts) which pre-dates stage-policy — this guard
   * keeps stage-policy in charge.
   */
  function resolveStageModel(stage: string, userPick?: string): string {
    if (userPick && userPick !== 'sonnet' && userPick !== 'auto') {
      return userPick;
    }
    try {
      const chain = registryResolveStage(stage);
      return chain.primary;
    } catch (err) {
      if (err instanceof ModelResolutionError || err instanceof UnknownStageError) {
        return userPick || 'sonnet';
      }
      throw err;
    }
  }

  function resolvePlanStageModel(userPick?: string): string {
    return resolveStageModel('plan', userPick);
  }

  // Plan-lifecycle walker (dispatchLifecycle, executeLifecycleVerify,
  // executeLifecycleRefine, runAutoRefinePass, isPartOfActiveRefine,
  // noteRefineRegenCompleted, getSnapshot) now lives in
  // `./pipeline/plan-lifecycle.ts`. The handle is bound up-front
  // (right after `services` + `broadcastPlanLifecycle` exist) via
  // `createPlanLifecycle({...})`. The lifecycle map +
  // outstanding-regens map + REFINE_PASS_TIMEOUT_MS constant are
  // encapsulated inside the factory; only the typed handle is exposed.

  // pickNextPlanModel + buildPlanPrompt + extractJsonBlock helpers all
  // moved into ./pipeline/{plan-spawn,json-extract}.ts.

  // buildPlanPrompt moved to ./pipeline/plan-spawn.ts.

  // spawnPlanAgent + spawnOnePlanVariant + spawnPlanVariants +
  // spawnPlanSectionRegen + retryPlanAgentWithNextModel +
  // finalizePlanAgent all moved to ./pipeline/plan-spawn.ts.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // (full plan-spawn cluster moved to ./pipeline/plan-spawn.ts)

  // ── PR Review: agent spawner + persona orchestration ──────────────
  // startReviewRun / finalizeReviewAgent / applyReviewFix +
  // `reviewAgentContext` Map moved to ./pipeline/review-spawn.ts. The
  // factory is bound alongside the plan-spawn factory further up.

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // (full review-spawn cluster moved to ./pipeline/review-spawn.ts)

  // Legacy-pipeline canceller moved to `./pipeline/cancel-legacy.ts`.
  const cancelLegacyPipeline = createCancelLegacyPipeline({
    stateFile: STATE_FILE,
    getActiveChild: () => activeChild,
    setActiveChild: (c) => { activeChild = c; },
    broadcastState,
  });

  // ── Start watchers and server ───────────────────────────────────────
  const stopHandlers: Array<() => void | Promise<void>> = [];
  stopHandlers.push(startStateWatcher());
  stopHandlers.push(startRunsWatcher());
  stopHandlers.push(() => autoReplayPump.stop());
  stopHandlers.push(() => shutdownSweepers());
  stopHandlers.push(() => { try { stopPrPolling?.(); } catch { /* ok */ } });
  // Legacy bridge detach removed in Phase 8 — socket.io bridge is the
  // only fan-out path and tears down with `socketHandle.stop()`.
  stopHandlers.push(async () => { if (socketHandle) await socketHandle.stop(); });

  // Scan feature store for existing PR URLs on startup (async, non-blocking)
  loadPRsFromFeatureStore();

  // Restore incomplete pipelines from previous sessions into active
  // runs. Moved to `./setup/restore-incomplete.ts`. Fire-and-forget —
  // the 2s setTimeout inside the helper gives clients time to connect
  // before the snapshot emit.
  void restoreIncompletePipelines({
    anvilHome: ANVIL_HOME,
    activeRuns,
    services,
    broadcastActiveRuns,
  });

  // Graceful shutdown — kill all child processes on exit. Moved to
  // `./setup/graceful-shutdown.ts`; registers SIGINT + SIGTERM hooks.
  registerGracefulShutdown({
    server,
    agentManager,
    getActiveChild: () => activeChild,
    setActiveChild: (c) => { activeChild = c; },
  });

  // Sleeptime memory consolidation moved to `./setup/sleeptime.ts`.
  // The factory honors `ANVIL_SLEEPTIME_INTERVAL_MS=0` (disabled) and
  // returns `{ stop: null }` in that case so we skip the
  // stop-handler registration.
  const sleeptime = startSleeptimeConsolidator({
    memoryStore,
    projectLoader,
    conventionPaths: CONVENTION_PATHS,
    parseFixPatternContent,
  });
  if (sleeptime.stop) {
    const stopFn = sleeptime.stop;
    stopHandlers.push(() => stopFn());
  }

  // ── Agent-event router (Phase 2.3) ──────────────────────────────────
  // Wired LATE so every closure dep (`finalizePlanAgent`,
  // `finalizeReviewAgent`, `retryPlanAgentWithNextModel`,
  // `planAgentContext`, the broadcaster, …) is already declared. The
  // listeners only fire during agent activity, which can't happen
  // before the server starts accepting connections in the `Promise`
  // block below.
  const detachAgentRouter = attachAgentEventRouter({
    agentManager,
    outputBuffer,
    activeRuns,
    agentToRunId,
    services,
    runsDir: RUNS_DIR,
    runsIndex: RUNS_INDEX,
    getActivePipelineRunner: () => activePipelineRunner,
    extractPRUrls,
    trackPR,
    finalizePlanAgent,
    finalizeReviewAgent,
    retryPlanAgentWithNextModel: retryPlanAgentWithNextModel as unknown as (
      ctx: AERPlanAgentContext, reason: string,
    ) => Promise<boolean>,
    planAgentContext: planAgentContext as unknown as Map<string, AERPlanAgentContext>,
    broadcastRuns,
    broadcastActiveRuns,
  });
  stopHandlers.push(detachAgentRouter);

  // Terminal block — start listening, mount socket.io, return the
  // dashboard handle. Body moved to `./setup/server-listen.ts`.
  return listenAndReturnHandle({
    server,
    port,
    services,
    replay,
    open: opts.open ?? false,
    sendInit,
    handleClientMessage,
    setSocketHandle: (h) => { socketHandle = h; },
    stopHandlers,
  });
}
