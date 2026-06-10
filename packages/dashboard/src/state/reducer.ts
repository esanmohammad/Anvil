/**
 * Dashboard UI state reducer.
 *
 * Single pure function over the typed `DashboardEvent` union. Replaces the
 * imperative `handleServerMessage(msg)` switch in `main.tsx` (~600 LOC of
 * setState calls scattered across event types) with one ~150 LOC reducer
 * that ts-pattern proves exhaustive at compile time.
 *
 * Wire mapping during Phase 5:
 *   - Server's typed services emit a `DashboardEvent` (kind, payload).
 *   - Bridge translates to today's legacy `{type,payload}` wire shape.
 *   - Frontend's `useDashboardSocket` hook receives the wire message AND
 *     calls `dispatch({ kind, payload })` translated back to the typed
 *     shape via `wireToEvent(wire)`. Phase 6 deletes the translation
 *     layer once both ends speak typed kinds directly.
 *
 * State shape mirrors what `main.tsx` tracks today: projects, runs,
 * activeRuns, features, prs, dashboardState, availableModels, agent
 * output buffer. The reducer is intentionally minimal — UI-level
 * concerns (selected project, panel state, scroll position) stay in
 * component-local useState; only cross-event-source state lives here.
 */

import type { DashboardEvent } from '../../shared/events.js';

// ── State shape ──────────────────────────────────────────────────────────

export interface DashboardUiState {
  initReceived: boolean;
  projects: unknown[];
  runs: unknown[];
  activeRuns: ActiveRunUi[];
  features: unknown[];
  prs: unknown[];
  dashboardState: unknown | null;
  availableModels: unknown | null;
  /** Recent agent output entries (cap to ~500 for memory). */
  agentOutput: AgentOutputEntryUi[];
}

interface ActiveRunUi {
  id: string;
  project: string;
  type: string;
  status: string;
  startedAt: number;
  description?: string;
  model?: string;
  activityCount?: number;
}

interface AgentOutputEntryUi {
  timestamp: number;
  stage: string;
  type: 'stdout' | 'stderr';
  content: string;
  kind: string;
  tool?: string;
  agentId?: string;
  repo?: string;
}

export const initialUiState: DashboardUiState = {
  initReceived: false,
  projects: [],
  runs: [],
  activeRuns: [],
  features: [],
  prs: [],
  dashboardState: null,
  availableModels: null,
  agentOutput: [],
};

// ── Reducer ──────────────────────────────────────────────────────────────

const MAX_AGENT_OUTPUT_BUFFER = 500;

/**
 * Pure reducer. No side effects, no async — easy to test in isolation.
 * Switch-by-kind is exhaustive on `DashboardEvent['kind']`; adding a new
 * kind without a case here is a compile error in `tsc --strict`.
 */
export function dashboardReducer(
  state: DashboardUiState,
  ev: DashboardEvent,
): DashboardUiState {
  switch (ev.kind) {
    // ── Run lifecycle ──────────────────────────────────────────────────
    case 'run.active-snapshot': {
      // The legacy bridge unwraps `run.active-snapshot` to a wire
      // payload that is the array directly (see
      // `server/events/wire-translate.ts:33`). `wireToEvent` passes
      // wire.payload through unchanged, so depending on which
      // transport hop the event came from, `ev.payload` may be the
      // raw array OR the typed `{runs:[]}` envelope. Accept both.
      const payload = ev.payload as unknown;
      const list = (
        Array.isArray(payload)
          ? payload
          : (payload as { runs?: unknown[] } | null)?.runs ?? []
      ) as Array<{
        id: string; project: string; type: string; status: string;
        startedAt: number; description?: string; model?: string;
        activityCount?: number;
      }>;
      const runs = list.map((r) => ({
        id: r.id,
        project: r.project,
        type: r.type,
        status: r.status,
        startedAt: r.startedAt,
        description: r.description,
        model: r.model,
        activityCount: r.activityCount,
      }));
      return { ...state, activeRuns: runs };
    }
    case 'run.started':
    case 'run.state-changed':
    case 'run.completed':
    case 'run.stopped':
    case 'run.rejected':
      // active-snapshot is the source of truth for the active list — these
      // events fire alongside but don't independently mutate `activeRuns`.
      return state;
    case 'runs.list': {
      // Bridge unwraps to wire `payload: array`; pass-through reaches
      // here as the raw array. Accept both shapes (see active-snapshot
      // case above for the wire-translate divergence).
      const payload = ev.payload as unknown;
      const list = Array.isArray(payload)
        ? payload
        : (payload as { runs?: unknown[] } | null)?.runs ?? [];
      return { ...state, runs: list };
    }

    // ── Agent stream ───────────────────────────────────────────────────
    case 'agent.output': {
      const next = [...state.agentOutput, ...ev.payload.entries];
      if (next.length > MAX_AGENT_OUTPUT_BUFFER) {
        next.splice(0, next.length - MAX_AGENT_OUTPUT_BUFFER);
      }
      return { ...state, agentOutput: next };
    }
    case 'agent.spawned':
    case 'agent.done':
    case 'agent.error':
      // Surface in agent output panel via the activity stream; nothing to
      // pin on the global UI state for spawn/done/error directly.
      return state;

    // ── Pipeline lifecycle ─────────────────────────────────────────────
    case 'pipeline.paused':
    case 'pipeline.resumed':
    case 'pipeline.cancelled':
    case 'pipeline.waiting-for-input':
    case 'pipeline.step-cost':
      // Pipeline events flow into the run's stage panel — kept in run-scoped
      // state, not the global UI state. Components subscribe to `run:<id>`
      // and maintain their own state from these events. (`pipeline.step-cost`
      // is consumed by the legacy `handleServerMessage` path in main.tsx,
      // which owns the load-bearing per-run cost state — same pattern as
      // `cost.snapshot`.)
      return state;

    // ── State / runs / system ──────────────────────────────────────────
    case 'state': {
      // Bridge unwraps to wire `payload: state`; the typed payload is
      // `{state}`. Accept either.
      const payload = ev.payload as unknown;
      const next = (payload as { state?: unknown } | null)?.state ?? payload;
      return { ...state, dashboardState: next };
    }
    case 'prs.updated': {
      // Bridge unwraps to wire `payload: prs[]`; typed payload is
      // `{prs}`. Accept either.
      const payload = ev.payload as unknown;
      const list = Array.isArray(payload)
        ? payload
        : (payload as { prs?: unknown[] } | null)?.prs ?? [];
      return { ...state, prs: list };
    }

    // ── Plans / reviews / tests / incidents / kb / cost / artifact ─────
    case 'plan.created':
    case 'plan.updated':
    case 'plan.validation':
    case 'plan.lifecycle':
    case 'plan.comment-added':
    case 'plan.comment-resolved':
    case 'plan.comment-deleted':
    case 'plan.approved':
    case 'review.created':
    case 'review.error':
    case 'test.run-log':
    case 'test.specs':
    case 'test.spec-created':
    case 'test.review-persona-start':
    case 'test.review-persona-done':
    case 'test.review-persona-error':
    case 'test.mutation-log':
    case 'test.polish-case-start':
    case 'test.polish-case-done':
    case 'test.polish-case-error':
    case 'test.regen-complete':
    case 'test.contract-complete':
    case 'test.scenarios-complete':
    case 'test.flakiness-case-start':
    case 'test.flakiness-case-done':
    case 'test.flakiness-case-error':
    case 'test.flakiness-complete':
    case 'incident.ingested':
    case 'replay.step':
    case 'replay.complete':
    case 'kb.progress':
    case 'kb.status':
    case 'cost.breach':
    case 'cost.snapshot':
    case 'project-graph.started':
    case 'project-graph.progress':
    case 'bind.overridden':
    case 'bind.override-applied':
    case 'artifact':
      // Per-domain components subscribe to entity-scoped rooms
      // (plan:<slug>, review:<id>, test-spec:<slug>, run:<id>, …) and
      // maintain their own local state from these events. The global
      // reducer doesn't need a flat copy.
      return state;

    default: {
      // Exhaustiveness check — TS compile error if a kind is unhandled.
      const _exhaustive: never = ev;
      void _exhaustive;
      return state;
    }
  }
}

// ── Wire → typed event translation ──────────────────────────────────────
// The bridge emits the legacy `{type,payload}` wire shape (for backward
// compat during Phase 5–6). This adapter rebuilds a `DashboardEvent` from
// the wire — enough for the reducer to switch on `kind`. Once both ends
// speak typed kinds directly (Phase 6), this can be deleted.

const WIRE_TO_KIND: Record<string, DashboardEvent['kind']> = {
  // Run lifecycle
  'active-runs': 'run.active-snapshot',
  'runs': 'runs.list',
  'run-stopped': 'run.stopped',
  'run-rejected': 'run.rejected',
  // Agent stream
  'agent-spawned': 'agent.spawned',
  'agent-output': 'agent.output',
  'agent-done': 'agent.done',
  'agent-error': 'agent.error',
  // Pipeline
  'pipeline-paused': 'pipeline.paused',
  'pipeline-resumed': 'pipeline.resumed',
  'pipeline-cancelled': 'pipeline.cancelled',
  'waiting-for-input': 'pipeline.waiting-for-input',
  'pipeline-step-cost': 'pipeline.step-cost',
  // State
  'state': 'state',
  'prs': 'prs.updated',
  // Plans
  'plan-created': 'plan.created',
  'plan-updated': 'plan.updated',
  'plan-validation': 'plan.validation',
  'plan-lifecycle': 'plan.lifecycle',
  'plan-comment-added': 'plan.comment-added',
  'plan-comment-resolved': 'plan.comment-resolved',
  'plan-comment-deleted': 'plan.comment-deleted',
  'plan-approved': 'plan.approved',
  // Reviews
  'review-created': 'review.created',
  'review-error': 'review.error',
  // Tests
  'test-run-log': 'test.run-log',
  'test-specs': 'test.specs',
  'test-spec-created': 'test.spec-created',
  'test-review-persona-start': 'test.review-persona-start',
  'test-review-persona-done': 'test.review-persona-done',
  'test-review-persona-error': 'test.review-persona-error',
  'test-mutation-log': 'test.mutation-log',
  'test-polish-case-start': 'test.polish-case-start',
  'test-polish-case-done': 'test.polish-case-done',
  'test-polish-case-error': 'test.polish-case-error',
  'test-regen-complete': 'test.regen-complete',
  'test-contract-complete': 'test.contract-complete',
  'test-scenarios-complete': 'test.scenarios-complete',
  'test-flakiness-case-start': 'test.flakiness-case-start',
  'test-flakiness-case-done': 'test.flakiness-case-done',
  'test-flakiness-case-error': 'test.flakiness-case-error',
  'test-flakiness-complete': 'test.flakiness-complete',
  // Incidents
  'incident-ingested': 'incident.ingested',
  'replay-step': 'replay.step',
  'replay-complete': 'replay.complete',
  // KB / cost / project-graph / bind / artifact
  'kb-progress': 'kb.progress',
  'kb-status': 'kb.status',
  'cost-breach': 'cost.breach',
  'cost-snapshot': 'cost.snapshot',
  'project-graph-started': 'project-graph.started',
  'project-graph-progress': 'project-graph.progress',
  'bind-overridden': 'bind.overridden',
  'bound-override-applied': 'bind.override-applied',
  'artifact': 'artifact',
};

/**
 * Convert a legacy wire message into a typed `DashboardEvent` envelope.
 * Returns `null` for unknown types (caller can fall back to the legacy
 * imperative handler for `init` and any other untyped messages).
 */
export function wireToEvent(
  wire: { type: string; payload: unknown },
): DashboardEvent | null {
  const kind = WIRE_TO_KIND[wire.type];
  if (!kind) return null;
  // Reconstruct a minimal envelope. Topics aren't recomputed on the client
  // (the server already routed it to us via the room subscription); leave
  // them empty.
  return {
    id: '',
    kind,
    payload: wire.payload as never,
    ts: Date.now(),
    topics: [],
    schemaVersion: 1,
  } as DashboardEvent;
}
