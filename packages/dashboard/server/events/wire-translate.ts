/**
 * Typed-event → legacy `{type, payload}` wire translation.
 *
 * Both the React frontend (via `wireToEvent` in `src/state/reducer.ts`)
 * and the socket.io bridge (`services-bridge.ts`) speak the legacy
 * `<verb>-<noun>` slug vocabulary. The pure translation lives here so
 * the bridge stays focused on lifecycle (subscribe / append / fan out).
 *
 * Exhaustive on `DashboardEvent['kind']` via `ts-pattern.match(...).exhaustive()`
 * — adding a new event kind without a case here is a compile error.
 */

import { match, P } from 'ts-pattern';
import type { DashboardEvent } from './types.js';

/** Legacy wire shape — what the frontend's reducer + `wireToEvent` consume. */
export interface LegacyMessage {
  type: string;
  payload: unknown;
}

/**
 * Translate a typed event envelope into the legacy `{type,payload}` wire
 * shape. Returns `null` for kinds that are purely internal (e.g.
 * `run.started`/`run.state-changed`/`run.completed` are folded into
 * `run.active-snapshot` for the wire — they don't get their own slug).
 */
export function toLegacyWire(ev: DashboardEvent): LegacyMessage | null {
  return match(ev)
    // ── Run lifecycle ────────────────────────────────────────────────
    .with({ kind: 'run.active-snapshot' }, (e) => ({
      type: 'active-runs',
      payload: e.payload.runs,
    } as LegacyMessage))
    .with({ kind: 'runs.list' }, (e) => ({
      type: 'runs',
      payload: e.payload.runs,
    } as LegacyMessage))
    .with({ kind: 'run.stopped' }, (e) => ({
      type: 'run-stopped',
      payload: { runId: e.payload.runId },
    } as LegacyMessage))
    .with({ kind: 'run.rejected' }, (e) => ({
      type: 'run-rejected',
      payload: { runId: e.payload.runId },
    } as LegacyMessage))
    .with(
      { kind: P.union('run.started', 'run.state-changed', 'run.completed') },
      () => null,
    )

    // ── Agent stream ─────────────────────────────────────────────────
    .with({ kind: 'agent.spawned' }, (e) => ({
      type: 'agent-spawned',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'agent.output' }, (e) => ({
      type: 'agent-output',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'agent.done' }, (e) => ({
      type: 'agent-done',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'agent.error' }, (e) => ({
      type: 'agent-error',
      payload: e.payload,
    } as LegacyMessage))

    // ── Pipeline lifecycle ───────────────────────────────────────────
    .with({ kind: 'pipeline.paused' }, (e) => ({
      type: 'pipeline-paused',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'pipeline.resumed' }, (e) => ({
      type: 'pipeline-resumed',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'pipeline.cancelled' }, (e) => ({
      type: 'pipeline-cancelled',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'pipeline.waiting-for-input' }, (e) => ({
      type: 'waiting-for-input',
      payload: e.payload,
    } as LegacyMessage))

    // ── Cost ─────────────────────────────────────────────────────────
    .with({ kind: 'cost.breach' }, (e) => ({
      type: 'cost-breach',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'cost.snapshot' }, (e) => ({
      type: 'cost-snapshot',
      payload: e.payload.snapshot,
    } as LegacyMessage))

    // ── Reviews ──────────────────────────────────────────────────────
    .with({ kind: 'review.created' }, (e) => ({
      type: 'review-created',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'review.error' }, (e) => ({
      type: 'review-error',
      payload: e.payload,
    } as LegacyMessage))

    // ── Plans ────────────────────────────────────────────────────────
    .with({ kind: 'plan.created' }, (e) => ({
      type: 'plan-created',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'plan.updated' }, (e) => ({
      type: 'plan-updated',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'plan.validation' }, (e) => ({
      type: 'plan-validation',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'plan.lifecycle' }, (e) => ({
      type: 'plan-lifecycle',
      payload: e.payload.snapshot,
    } as LegacyMessage))
    .with({ kind: 'plan.comment-added' }, (e) => ({
      type: 'plan-comment-added',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'plan.comment-resolved' }, (e) => ({
      type: 'plan-comment-resolved',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'plan.comment-deleted' }, (e) => ({
      type: 'plan-comment-deleted',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'plan.approved' }, (e) => ({
      type: 'plan-approved',
      payload: e.payload,
    } as LegacyMessage))

    // ── Tests ────────────────────────────────────────────────────────
    .with({ kind: 'test.run-log' }, (e) => ({
      type: 'test-run-log',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.specs' }, (e) => ({
      type: 'test-specs',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.spec-created' }, (e) => ({
      type: 'test-spec-created',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.review-persona-start' }, (e) => ({
      type: 'test-review-persona-start',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.review-persona-done' }, (e) => ({
      type: 'test-review-persona-done',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.review-persona-error' }, (e) => ({
      type: 'test-review-persona-error',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.mutation-log' }, (e) => ({
      type: 'test-mutation-log',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.polish-case-start' }, (e) => ({
      type: 'test-polish-case-start',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.polish-case-done' }, (e) => ({
      type: 'test-polish-case-done',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.polish-case-error' }, (e) => ({
      type: 'test-polish-case-error',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.regen-complete' }, (e) => ({
      type: 'test-regen-complete',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.contract-complete' }, (e) => ({
      type: 'test-contract-complete',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.scenarios-complete' }, (e) => ({
      type: 'test-scenarios-complete',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.flakiness-case-start' }, (e) => ({
      type: 'test-flakiness-case-start',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.flakiness-case-done' }, (e) => ({
      type: 'test-flakiness-case-done',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.flakiness-case-error' }, (e) => ({
      type: 'test-flakiness-case-error',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.flakiness-complete' }, (e) => ({
      type: 'test-flakiness-complete',
      payload: e.payload,
    } as LegacyMessage))

    // ── Bind / artifact ──────────────────────────────────────────────
    .with({ kind: 'bind.overridden' }, (e) => ({
      type: 'bind-overridden',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'bind.override-applied' }, (e) => ({
      type: 'bound-override-applied',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'artifact' }, (e) => ({
      type: 'artifact',
      payload: e.payload,
    } as LegacyMessage))

    // ── Plan side-channel ────────────────────────────────────────────
    .with({ kind: 'plan.error' }, (e) => ({
      type: 'plan-error',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'plan.variants-started' }, (e) => ({
      type: 'plan-variants-started',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'plan.variant-created' }, (e) => ({
      type: 'plan-variant-created',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'plan.auto-refine-progress' }, (e) => ({
      type: 'auto-refine-progress',
      payload: e.payload,
    } as LegacyMessage))

    // ── Review side-channel ──────────────────────────────────────────
    .with({ kind: 'review.started' }, (e) => ({
      type: 'review-started',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'review.kb-summary' }, (e) => ({
      type: 'review-kb-summary',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'review.persona-done' }, (e) => ({
      type: 'review-persona-done',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'review.published' }, (e) => ({
      type: 'review-published',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'review.finding-resolved' }, (e) => ({
      type: 'review-finding-resolved',
      payload: e.payload,
    } as LegacyMessage))

    // ── Test side-channel ────────────────────────────────────────────
    .with({ kind: 'test.review-complete' }, (e) => ({
      type: 'test-review-complete',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'test.finding-resolved' }, (e) => ({
      type: 'test-finding-resolved',
      payload: e.payload,
    } as LegacyMessage))

    // ── Project-graph completion / error ─────────────────────────────
    .with({ kind: 'project-graph.complete' }, (e) => ({
      type: 'project-graph-complete',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'project-graph.error' }, (e) => ({
      type: 'project-graph-error',
      payload: e.payload,
    } as LegacyMessage))

    // ── Pipeline auth + interrupted snapshot ─────────────────────────
    .with({ kind: 'pipeline.auth-required' }, (e) => ({
      type: 'auth-required',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'pipeline.interrupted-snapshot' }, (e) => ({
      type: 'interrupted-pipelines',
      payload: e.payload,
    } as LegacyMessage))

    // ── Incidents ────────────────────────────────────────────────────
    .with({ kind: 'incident.ingested' }, (e) => ({
      type: 'incident-ingested',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'replay.queued' }, (e) => ({
      type: 'replay-queued',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'replay.step' }, (e) => ({
      type: 'replay-step',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'replay.complete' }, (e) => ({
      type: 'replay-complete',
      payload: e.payload,
    } as LegacyMessage))

    // ── KB ───────────────────────────────────────────────────────────
    .with({ kind: 'kb.progress' }, (e) => ({
      type: 'kb-progress',
      payload: e.payload.progress,
    } as LegacyMessage))
    .with({ kind: 'kb.status' }, (e) => ({
      type: 'kb-status',
      payload: e.payload.status,
    } as LegacyMessage))

    // ── State / runs / misc ──────────────────────────────────────────
    .with({ kind: 'state' }, (e) => ({
      type: 'state',
      payload: e.payload.state,
    } as LegacyMessage))
    .with({ kind: 'prs.updated' }, (e) => ({
      type: 'prs',
      payload: e.payload.prs,
    } as LegacyMessage))
    .with({ kind: 'project-graph.started' }, (e) => ({
      type: 'project-graph-started',
      payload: e.payload,
    } as LegacyMessage))
    .with({ kind: 'project-graph.progress' }, (e) => ({
      type: 'project-graph-progress',
      payload: e.payload,
    } as LegacyMessage))
    .exhaustive();
}
