/**
 * Handler-route helper (Recipe 7 / Phase 1 of the dashboard decomposition).
 *
 * Today, every `case '<action>':` body in `dashboard-server.ts`
 * `handleClientMessage` repeats the same boilerplate:
 *
 *   const parsed = Z.<Action>.safeParse(msg);
 *   if (!parsed.success) { ws.send({type:'error',...}); break; }
 *   const result = doWork(parsed.data, ...);
 *   if ('error' in result) { ws.send({type:'error',...}); break; }
 *   ws.send({ type: '<wire>', payload: result });
 *
 * `route()` collapses that into a small typed configuration value. Each
 * registered route is `(msg, ws, deps) => Promise<void>` — same signature
 * as inlining the case body. The registry (`handlers/registry.ts`) maps
 * `msg.action` → one of these handlers.
 *
 * ### Reply shapes supported
 *
 * 1. **Echo back a single wire frame.** The most common case. Pass
 *    `wireType: 'plan-updated'` and have `handle` return the payload
 *    object. The helper sends `{ type: 'plan-updated', payload }`.
 *
 * 2. **Discriminated union on the result.** Many service methods return
 *    `{ result } | { error: 'X' }`. Pass `errorMessage(err, input)` to
 *    translate the typed error code into the human-facing message that
 *    today's case body builds. The helper detects `'error' in result`
 *    and routes to `errorWireType` (default: `'error'`).
 *
 * 3. **Fire-and-forget.** Service mutation already emitted through the
 *    bridge (e.g. `add-plan-comment` doesn't echo). Return `void` /
 *    `undefined` from `handle` and omit `wireType`.
 *
 * 4. **Hand-rolled wire writes.** Some handlers send multiple frames
 *    (e.g. `subscribe-cost` sends a snapshot AND joins a room) or shape
 *    the payload from input + result. Use `handle: async (input, deps) =>
 *    { deps.ws.send(...); }` and return `void` to keep total control.
 *
 * ### Error handling
 *
 * Exceptions thrown inside `handle` are caught and converted to
 * `{ type: errorWireType, payload: { message } }`. The default
 * `errorWireType` is `'error'` to match the legacy default; per-domain
 * routes (reviews, incidents, cost) override it to `'review-error'`,
 * `'incident-error'`, `'cost-error'` etc.
 *
 * ### Why we don't import `WsClient` from dashboard-server.ts
 *
 * `WsClient` is a structural type (`{ readyState; send(data) }`). We
 * declare it here to keep `handlers/*.ts` free of an import dependency
 * on the monolith — once Phase 1 lands, the registry is imported by
 * `dashboard-server.ts`, not the other way around.
 */

import type { ZodType } from 'zod';
import type { DashboardServices } from '../services/index.js';

/** Minimal structural shape a handler needs to send wire frames. */
export interface WsClient {
  readyState: number;
  send(data: string): void;
}

/**
 * Shared deps every handler needs. Domain-specific deps (e.g. `planStore`)
 * either live on `services` (when they've moved into a service) or get
 * threaded through here until Phase 2 extraction lets us trim the bag.
 *
 * Boot time (`startDashboardServer`) constructs this once and passes it
 * to `registry[action](msg, ws, deps)`.
 */
export interface HandlerDeps {
  services: DashboardServices;
  ws: WsClient;
  /** The raw message — needed by long-tail handlers that still cast. */
  raw: unknown;
  /** Per-action user context for `approve-plan` etc. */
  user?: string;
  /** Extra deps that haven't migrated into services yet. Tranche-by-tranche we drain this. */
  extras: HandlerExtras;
}

/**
 * Closure-resident dependencies. Each becomes a service dep once the
 * matching block is extracted in Phase 2 (e.g. `dispatchLifecycle` →
 * `services.plans` dep once lifecycle moves to `pipeline/lifecycle.ts`).
 *
 * Until then, the boot wires every field this struct exposes; handlers
 * just call `deps.extras.dispatchLifecycle(...)`. Adding a new field is
 * a one-line change here + one-line wire in `dashboard-server.ts`.
 */
export interface HandlerExtras {
  /** `<homedir>/.anvil` — needed for share-token signing, factory.yaml lookup. */
  anvilHome: string;
  /** Default TTL for `share-plan` tokens (ms). */
  shareTokenTtlMs: number;
  /** Read by `approve-plan` etc. to attribute the user. */
  defaultUser: string;
  /** Plan-lifecycle state machine dispatcher (closure over `planLifecycle` map). */
  dispatchLifecycle?: (
    project: string,
    planSlug: string,
    event: unknown,
  ) => Promise<unknown>;
  /** Project loader — needed by `validate-plan` for budget caps + repo mapping. */
  projectLoader?: ProjectLoaderShape;
  /** Plan store — needed by reads (`list-plan-comments`, `get-plans`) until they migrate. */
  planStore?: PlanStoreShape;
  /** Push fresh cost snapshot after a breach response — see `cost-breach-response`. */
  broadcastCostSnapshot?: (project: string, runId?: string | null) => void;
  /**
   * Snapshot the plan-lifecycle walker. Closes over `planLifecycle: Map`
   * inside `startDashboardServer`. Returns `null` if no context yet —
   * the UI mounts before any lifecycle tick fires.
   */
  getPlanLifecycleSnapshot?: (project: string, planSlug: string) => Promise<unknown | null>;
  /** Incident store read surface — populated for incidents read routes. */
  incidentStore?: IncidentStoreShape;
  /** Replay store read surface. */
  replayStore?: ReplayStoreShape;
  /** Bound-tests store read surface. */
  boundTestsStore?: BoundTestsStoreShape;
  /** Bound-tests audit log read surface. */
  boundAuditLog?: BoundAuditLogShape;
  /** Auto-replay queue — backing for `list-replay-queue`. */
  autoReplayQueue?: AutoReplayQueueShape;
  /** Review store reads — `get-review`, `list-reviews`. */
  reviewStore?: ReviewStoreShape;
  /** Reviewer calibration snapshot. */
  reviewCalibrationStore?: ReviewCalibrationStoreShape;
  /** Review dismissal records. */
  reviewDismissalStore?: ReviewDismissalStoreShape;
  /** Test spec store — `get-test-spec(s)`. */
  testSpecStore?: TestSpecStoreShape;
  /** Test case store — `get-test-cases`. */
  testCaseStore?: TestCaseStoreShape;
  /** Test run store — `get-test-runs`. */
  testRunStore?: TestRunStoreShape;
  /** Knowledge-base manager — `get-kb-*`, `query-kb`. */
  kbManager?: KbManagerShape;
  /** Path roots for `loadRules` (conventions). */
  conventionPaths?: { conventionsDir: string; rulesDir: string };
  /** Memory store backing `list-memories` / `ratify-proposal`. */
  memoryStore?: MemoryStoreShape;
  /** Cost ledger backing `get-cost-summary`. */
  costLedger?: CostLedgerShape;
  /** Cost-breach handler backing `get-cost-breach` + `list-pending-breaches`. */
  costBreachHandler?: CostBreachHandlerShape;
  /** Pipeline-pause store backing `list-pipeline-pauses` / `get-pipeline-pause`. */
  pauseStore?: PauseStoreShape;
  /** Learnings store backing `get-plan-approval-stats` / `list-plan-approval-records`. */
  learningsStore?: LearningsStoreShape;
  /** Checkpoint store backing `get-checkpoint-stats`. */
  checkpointStore?: CheckpointStoreShape;
  /** Discover available models — closure for `get-available-models`. */
  discoverAvailableModels?: () => Promise<unknown>;
  /** Test-learnings store — flakiness sample backing. */
  testLearningsStore?: TestLearningsStoreShape;
  /** CI-triage store backing `list-ci-triage`. */
  ciTriageStore?: CiTriageStoreShape;
  /**
   * Resolve the workspace dir for a project — used by `get-branches` and
   * `generate-conventions`. Closes over `~/.anvil/workspaces` config.
   */
  getWorkspaceFromConfig?: (project: string) => string | null;
  /**
   * Recompute the project overview — closes over featureStore/runs cache.
   * `memory-*` handlers fire-and-forget echo a refreshed overview after
   * the write. Returns null/unknown to keep the route ergonomics simple.
   */
  buildProjectOverview?: (project: string) => Promise<unknown>;
  /** Memory writer — `memory-add`/`replace`/`remove`. */
  memoryWriter?: MemoryWriterShape;
  /** Re-emit active-runs snapshot (`get-active-runs`). */
  broadcastActiveRuns?: () => void;
  /** Read the runs index (`get-runs`). */
  loadRunsSync?: () => unknown[];
  /** Feature store reads (`get-features`). */
  featureStore?: FeatureStoreShape;
  /** Async PR refresh (`refresh-prs`). */
  refreshTrackedPRs?: () => Promise<void>;
  /** PR cache snapshot. */
  trackedPRsForBroadcast?: () => unknown[];
  /** Active-runs map — `get-run` falls through this before disk fallback. */
  activeRuns?: Map<string, ActiveRunView>;
  /**
   * Send the full init payload to a single client (`get-state` /
   * `get-projects`). Closes over `discoverAvailableModels`,
   * `projectLoader.listProjects`, the feature store, the runs index, and
   * the active-runs map — too heavyweight to pass as separate slots.
   * Phase 3 will move `sendInit` into a dedicated `init.ts` module.
   */
  sendInit?: (ws: WsClient) => Promise<void>;
  /**
   * Kill a running agent by id — `kill-agent`. Backed by
   * `AgentManager.kill(agentId)`.
   */
  killAgent?: (agentId: string) => void;
  /**
   * Forward operator-typed text to whichever input sink is active —
   * `send-input`. Tries the live pipeline runner first, then the named
   * agent, then `activeChild.stdin` as a legacy fallback.
   */
  sendInput?: (text: string, agentId?: string) => void;
  /**
   * Cancel the running pipeline — `cancel-pipeline`. Routes through
   * the pipeline runner if one is active, else falls back to the
   * legacy child-process kill path.
   */
  cancelPipeline?: () => void;
  /**
   * Re-emit the persisted runs list (`runs.list`) — `broadcastRuns`
   * from the broadcaster. Used after `rollback-run` so the history
   * panel reflects the cancelled status.
   */
  broadcastRuns?: () => void;
  /**
   * Pipeline-pause audit log — used by `resume-pipeline` / `cancel-pipeline-pause`
   * to record the operator decision for the pause-flow audit trail.
   */
  auditLog?: AuditLogShape;

  // ── Phase 2.6 — pipeline + agent spawn closures ────────────────────
  /**
   * Spawn closures owned by `dashboard-server.ts` (`startPipeline`,
   * `spawnPlanAgent`, etc.). These remain in the monolith for now; the
   * handler files just hold a reference. A future phase will move the
   * implementation into a dedicated `server/pipeline/*` module without
   * changing the handler call-shape.
   */
  pipelineActions?: PipelineActionsBundle;
  /**
   * Direct (rich-shape) access to stores that need write methods inside
   * pipeline/test-spec migrations. Typed `any` to avoid duplicating the
   * full store contracts here — handlers cast at the call site.
   */
  unsafeStores?: UnsafeStoresBundle;
  /** Direct manager handle used by `spawn-agent` / `stop-run`. */
  agentManagerHandle?: AgentManagerHandle;
  /** Bidirectional `agentId ↔ runId` map for the `stop-run` kill chain. */
  agentToRunId?: Map<string, string>;
  /** Runs index dir + file — used by `stop-run` for quick-action persist. */
  runsDir?: string;
  runsIndex?: string;
  /** Live pipeline-runner ref. `null` between runs. */
  getActivePipelineRunner?: () => { cancel(): void } | null;
  /** Plan validator (writes go through `unsafeStores.planStore`). Wide
   * shape — concrete `PlanIssue` has more optional fields than we model. */
  planValidator?: {
    validate(plan: unknown): {
      counts: { errors: number };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      issues: Array<{ autoFixable?: boolean; hint?: any; [k: string]: any }>;
    };
  };
  /**
   * Lifecycle helper for the bounded `auto-refine-plan` pass — closes
   * over the lifecycle walker inside `startDashboardServer`.
   */
  executeLifecycleRefine?: (project: string, planSlug: string) => Promise<void>;
  /** Rich KB manager (read-side helpers used by `spawn-agent`). */
  kbManagerRich?: {
    getIndexForPrompt(project: string): string | null;
    getQueryContextForPrompt(project: string, feature: string): string;
    getAllGraphReports(project: string): string;
  };
}

/**
 * Closure bundle holding every "spawn this pipeline / agent" entrypoint.
 * Each callable is a thin proxy over the matching closure inside
 * `startDashboardServer`. None of them return a result — they fire,
 * the bridge handles the wire events.
 */
export interface PipelineActionsBundle {
  startPipeline: (project: string, feature: string, options?: unknown) => void;
  spawnQuickAction: (
    action: 'run-fix' | 'run-review' | 'run-spike',
    project: string,
    feature: string,
    model?: string,
  ) => void;
  spawnPlanAgent: (project: string, feature: string, model?: string) => void;
  spawnPlanVariants: (
    project: string,
    feature: string,
    variants: unknown[],
    model?: string,
  ) => void;
  spawnPlanSectionRegen: (plan: unknown, section: unknown, model?: string) => void;
  startReviewRun: (
    project: string,
    prUrl: string,
    trigger: string,
    personas: string[],
    model?: string,
    prior?: unknown,
  ) => Promise<void>;
  applyReviewFix: (project: string, reviewId: string, findingId: string) => Promise<string>;
}

/**
 * Stores that the 28 pipeline-tail handlers write through. Typed `any`
 * intentionally — these contracts are wide and live in `dashboard-server.ts`.
 * The handler files cast to the concrete store type at the call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UnsafeStoresBundle = Record<string, any>;

/**
 * `AgentManager`'s public surface — handlers cast at call sites that pass
 * the manager into helper modules (`runMultiPersonaReview`, `runTestAuthor`,
 * `runReplayPipeline`, `analyzeFlakiness`) that expect the concrete type.
 * Typed `unknown` here so the registry's route file stays free of an
 * @esankhan3/anvil-agent-core import cycle.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentManagerHandle = any;

interface AuditLogShape {
  record(entry: {
    runId: string;
    project: string;
    event: 'approved' | 'rejected' | 'modified';
    actor: string;
    details?: Record<string, unknown>;
  }): void;
}

/**
 * Shape of the live-run record exposed to read-only handlers. Mirrors
 * `ActiveRun` from `broadcasts.ts` but narrowed to the fields callers
 * actually read.
 */
interface ActiveRunView {
  id: string;
  type: string;
  project: string;
  description: string;
  model: string;
  status: string;
  startedAt: number;
  activities: unknown[];
}

interface MemoryWriterShape {
  add(project: string, target: string, content: string): unknown;
  replace(project: string, target: string, oldText: string, content: string): unknown;
  remove(project: string, target: string, oldText: string): unknown;
}

/** Project overview reads (Phase 2.1b — post-broadcasts extraction). */
export interface ProjectsExtras {
  /** Re-emit the active-runs snapshot via the typed RunService. */
  broadcastActiveRuns?: () => void;
  /** Reads the persisted runs index (`<anvilHome>/runs/index.jsonl`). */
  loadRunsSync?: () => unknown[];
  /** Feature-store list — `get-features`. */
  featureStore?: FeatureStoreShape;
  /** Async PR refresh; closure over `gh pr list` cache. */
  refreshTrackedPRs?: () => Promise<void>;
  /** Snapshot getter for the PR cache (used after refresh). */
  trackedPRsForBroadcast?: () => unknown[];
}

interface FeatureStoreShape {
  listFeatures(project?: string): unknown[];
  updateFeature?(project: string, slug: string, patch: Record<string, unknown>): unknown;
}

interface TestLearningsStoreShape {
  read(project: string): { flakyTests?: Array<{ caseId: string; lastSeen: string; failureRate: number }> } | null;
}

interface CiTriageStoreShape {
  list(project: string, opts?: { limit?: number }): unknown[];
  record(project: string, report: unknown, ciRunId?: string): unknown;
}

interface MemoryStoreShape {
  unwrap(): unknown;
}

interface CostLedgerShape {
  summarize(runId: string): unknown;
}

interface CostBreachHandlerShape {
  getBreach(runId: string): unknown;
  listPending?: () => unknown[];
}

interface PauseStoreShape {
  get(runId: string): PauseStateShape | null | undefined;
}

interface PauseStateShape {
  runId: string;
  project: string;
  pausedAt: string;
  resumedAt?: string;
  resumedBy?: string;
  // `action` is a wider enum (see `pipeline-pause-types.ResumeAction`).
  // Keep loose here — the dashboard owns the canonical type and we only
  // forward the value through.
  resumeDecision?: { action: string; note?: string; [k: string]: unknown };
  [k: string]: unknown;
}

interface LearningsStoreShape {
  computeStats(project: string): unknown;
  // The concrete `PipelineLearningsStore.list` accepts a narrower
  // `outcome: PlanOutcome` enum. We type `outcome` as `string` here
  // since the Zod schema already validates the literal; callers cast
  // when needed.
  list(
    project: string,
    opts?: { limit?: number; since?: string; outcome?: string },
  ): unknown[];
  /** `resume-pipeline` records the operator decision for tuning. */
  record(project: string, entry: Record<string, unknown>): void;
}

interface CheckpointStoreShape {
  stats(project: string, runFamily?: string): unknown;
}

interface KbManagerShape {
  getProjectReport(project: string): unknown;
  getGraphReport(project: string, repo: string): unknown;
  getAllGraphReports(project: string): unknown;
  getGraphHtmlPath(project: string, repo: string): string | null | undefined;
  getStatus(project: string): Promise<unknown>;
  getProjectIndex(project: string): unknown;
  queryKnowledgeBase(project: string, query: string, maxChars?: number): unknown;
}

interface IncidentStoreShape {
  list(project: string): { id: string }[];
  read(project: string, incidentId: string): unknown;
}

interface ReplayStoreShape {
  list(project: string, incidentId?: string): unknown[];
}

interface BoundTestsStoreShape {
  listBound(project: string): unknown[];
}

interface BoundAuditLogShape {
  tail(project: string, n: number): unknown[];
}

interface AutoReplayQueueShape {
  snapshot(): { project: string }[];
}

interface ReviewStoreShape {
  readCurrent(project: string, reviewId: string): unknown;
  listReviews(project: string | undefined, limit: number): unknown[];
}

interface ReviewCalibrationStoreShape {
  computeSnapshot(project: string): unknown;
}

interface ReviewDismissalStoreShape {
  list(project: string): unknown[];
}

interface TestSpecStoreShape {
  listSpecs(project: string): unknown[];
  readCurrent(project: string, slug: string): unknown;
}

interface TestCaseStoreShape {
  readCases(project: string, slug: string, version?: number): unknown[];
}

interface TestRunStoreShape {
  listRuns(project: string, slug: string): unknown[];
  readRun(project: string, slug: string, runId: string): unknown;
}

interface ProjectLoaderShape {
  getBudgetConfig(project: string): { max_per_run?: number; max_per_day?: number; alert_at?: number };
  saveBudgetConfig?(
    project: string,
    cfg: { max_per_run?: number; max_per_day?: number; alert_at?: number },
  ): void;
  getRepoLocalPaths(project: string): Record<string, string>;
  getModelForStage?(project: string, stage: string): unknown;
  getConfig?(project: string): { repos?: Array<{ name?: string; path?: string }> } | null | undefined;
}

interface PlanStoreShape {
  listComments(project: string, planSlug: string): unknown[];
  listApprovals(project: string, planSlug: string): unknown[];
  readPointer(project: string, planSlug: string): { currentVersion: number | null } | null;
  listPlans(project?: string): unknown[];
  readCurrent(project: string, planSlug: string): unknown;
  readValidation(project: string, planSlug: string): unknown;
  listVersions(project: string, planSlug: string): number[];
  readVersion(project: string, planSlug: string, version: number): unknown;
}

/** Function signature every registered route must satisfy. */
export type Handler = (msg: unknown, deps: HandlerDeps) => Promise<void>;

/**
 * Result shape a `handle` callback may return. Three forms:
 *   - `void` — fire-and-forget, no echo.
 *   - `{ payload }` — the helper wraps it in `{ type: wireType, payload }`.
 *   - `{ error: code }` — the helper echoes the error wire-type with a
 *     human message derived from `errorMessage(code, input)`.
 *
 * To keep the type ergonomic for the common case where service methods
 * return `{ result } | { error }` discriminated unions, we accept any
 * object and detect `'error' in result` at runtime.
 */
type HandleReturn<O> =
  | void
  | undefined
  | O
  | { error: string };

/**
 * Define one route. The returned `Handler` is what the registry stores.
 *
 * @param opts.input         Zod schema for the inbound message.
 * @param opts.handle        Async body — receives parsed input + deps.
 * @param opts.wireType      If set + `handle` returns a non-error result,
 *                           the result is sent as `{ type: wireType, payload }`.
 * @param opts.errorWireType Wire-type for errors (default `'error'`).
 *                           Override for review/cost/incident domains.
 * @param opts.errorMessage  Maps a typed error code (e.g. `'plan-not-found'`)
 *                           to the human message that goes onto the wire.
 *                           Defaults to using the code verbatim.
 */
export function route<I, O>(opts: {
  input: ZodType<I>;
  handle: (input: I, deps: HandlerDeps) => Promise<HandleReturn<O>> | HandleReturn<O>;
  wireType?: string;
  errorWireType?: string;
  errorMessage?: (code: string, input: I) => string;
  /**
   * If a payload from `handle` is an object with one of these keys (e.g.
   * `findingId`), pass that key/value into the error envelope payload
   * alongside `message`. Used by `apply-review-patch` to keep the
   * legacy `review-patch-error` shape `{ findingId, message }`.
   */
  errorEcho?: (input: I) => Record<string, unknown>;
  /**
   * Match the legacy `if (!parsed.success) break;` silent path — some
   * handlers swallow parse failures instead of writing an error frame.
   * Default `'send'` (the new, stricter behavior).
   */
  onParseFail?: 'send' | 'silent';
}): Handler {
  return async function handler(msg: unknown, deps: HandlerDeps): Promise<void> {
    const parsed = opts.input.safeParse(msg);
    if (!parsed.success) {
      if (opts.onParseFail === 'silent') return;
      const extra = opts.errorEcho ? opts.errorEcho(msg as I) : undefined;
      sendError(deps.ws, opts.errorWireType ?? 'error', parsed.error.message, extra);
      return;
    }
    try {
      const result = await opts.handle(parsed.data, deps);
      if (result === undefined || result === null) return;
      if (typeof result === 'object' && 'error' in result && typeof (result as { error: unknown }).error === 'string') {
        const code = (result as { error: string }).error;
        const message = opts.errorMessage ? opts.errorMessage(code, parsed.data) : code;
        const extra = opts.errorEcho ? opts.errorEcho(parsed.data) : undefined;
        sendError(deps.ws, opts.errorWireType ?? 'error', message, extra);
        return;
      }
      if (opts.wireType) {
        deps.ws.send(JSON.stringify({ type: opts.wireType, payload: result }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const extra = opts.errorEcho ? opts.errorEcho(parsed.data) : undefined;
      sendError(deps.ws, opts.errorWireType ?? 'error', message, extra);
    }
  };
}

function sendError(
  ws: WsClient,
  wireType: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  ws.send(JSON.stringify({ type: wireType, payload: { ...(extra ?? {}), message } }));
}
