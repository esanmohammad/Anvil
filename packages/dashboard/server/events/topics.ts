/**
 * Topic-routing for typed dashboard events.
 *
 * Every `DashboardEvent` declares its rooms via `roomsForEvent(ev)`.
 * The service-bridge calls this once per emission to look up which
 * socket.io rooms should receive the message.
 *
 * Default subscription rules (Phase 4):
 *   - Every client auto-subscribes to `global` on connect (lossless
 *     transition from today's firehose).
 *   - Route mounts (RunDetail, PlanEditor, ReviewPage) add per-entity
 *     subscriptions via `socket.emit('subscribe', { rooms: [...] })`.
 *   - High-volume per-run events (agent.output, agent.spawned, etc.)
 *     publish ONLY to `run:<id>` — clients without that subscription
 *     don't receive them. Cuts firehose noise.
 *
 * Exhaustiveness: `match(...).exhaustive()` makes a missing case a
 * TypeScript compile error. Adding a new event kind without a topic
 * mapping breaks the build, not runtime.
 */

import { match, P } from 'ts-pattern';
import type { DashboardEvent, Topic } from './types.js';

export function roomsForEvent(ev: DashboardEvent): Topic[] {
  return match(ev)
    // ── Run lifecycle ────────────────────────────────────────────────
    .with({ kind: 'run.started' }, ({ payload }) => [
      'global' as Topic,
      `run:${payload.runId}` as Topic,
      `project:${payload.project}` as Topic,
    ])
    .with({ kind: 'run.state-changed' }, ({ payload }) => [
      'global' as Topic,
      `run:${payload.runId}` as Topic,
    ])
    .with({ kind: 'run.completed' }, ({ payload }) => [
      'global' as Topic,
      `run:${payload.runId}` as Topic,
    ])
    .with({ kind: 'run.stopped' }, ({ payload }) => [
      'global' as Topic,
      `run:${payload.runId}` as Topic,
    ])
    .with({ kind: 'run.rejected' }, ({ payload }) => [
      'global' as Topic,
      `run:${payload.runId}` as Topic,
    ])
    .with({ kind: 'run.active-snapshot' }, () => ['global' as Topic])
    .with({ kind: 'runs.list' }, () => ['global' as Topic])

    // ── Agent stream ─────────────────────────────────────────────────
    // During the raw-WS → socket.io transition agent events publish to
    // both `global` AND `run:<id>` so clients that haven't opted into
    // per-run subscriptions still see the firehose (matches raw-WS
    // semantics). The frontend will move to per-run subscriptions in a
    // follow-up; at that point drop `global` from these mappings.
    .with({ kind: 'agent.spawned' }, ({ payload }) =>
      payload.runId
        ? (['global', `run:${payload.runId}` as Topic] as Topic[])
        : (['global'] as Topic[]),
    )
    .with({ kind: 'agent.output' }, ({ payload }) =>
      payload.runId
        ? (['global', `run:${payload.runId}` as Topic] as Topic[])
        : (['global'] as Topic[]),
    )
    .with({ kind: 'agent.done' }, () => ['global' as Topic])
    .with({ kind: 'agent.error' }, () => ['global' as Topic])

    // ── Pipeline lifecycle ───────────────────────────────────────────
    .with(
      { kind: P.union('pipeline.paused', 'pipeline.resumed', 'pipeline.cancelled') },
      ({ payload }) => {
        const runId = (payload.pause as { runId?: string })?.runId;
        return runId
          ? (['global', `run:${runId}` as Topic] as Topic[])
          : (['global'] as Topic[]);
      },
    )
    .with({ kind: 'pipeline.waiting-for-input' }, () => ['global' as Topic])
    .with({ kind: 'pipeline.step-cost' }, ({ payload }) => [
      'global' as Topic,
      'cost' as Topic,
      `run:${payload.runId}` as Topic,
    ])

    // ── Cost ─────────────────────────────────────────────────────────
    .with({ kind: 'cost.breach' }, () => ['global' as Topic, 'cost' as Topic])
    .with({ kind: 'cost.snapshot' }, ({ payload }) => {
      const rooms: Topic[] = ['global', 'cost', `project:${payload.project}` as Topic];
      if (payload.runId) rooms.push(`run:${payload.runId}` as Topic);
      return rooms;
    })

    // ── Reviews ──────────────────────────────────────────────────────
    .with({ kind: 'review.created' }, ({ payload }) => {
      const reviewId = (payload.review as { id?: string })?.id;
      return reviewId
        ? (['global', `review:${reviewId}` as Topic] as Topic[])
        : (['global'] as Topic[]);
    })
    .with({ kind: 'review.error' }, ({ payload }) =>
      payload.reviewId
        ? (['global', `review:${payload.reviewId}` as Topic] as Topic[])
        : (['global'] as Topic[]),
    )

    // ── Plans ────────────────────────────────────────────────────────
    .with(
      {
        kind: P.union(
          'plan.created',
          'plan.updated',
          'plan.validation',
          'plan.lifecycle',
          'plan.comment-added',
          'plan.comment-resolved',
          'plan.comment-deleted',
          'plan.approved',
        ),
      },
      ({ payload, kind }) => {
        const slug =
          (payload as { planSlug?: string }).planSlug ??
          (payload as { plan?: { slug?: string } }).plan?.slug;
        return slug
          ? (['global', `plan:${slug}` as Topic] as Topic[])
          : (['global'] as Topic[]);
      },
    )

    // ── Tests ────────────────────────────────────────────────────────
    // During migration: per-run/per-spec test events also broadcast to
    // `global` so default-subscribed clients keep firehose parity with
    // raw-WS. Tighten back to entity-only rooms once the frontend opts
    // into explicit subscriptions per route.
    .with({ kind: 'test.run-log' }, ({ payload }) => [
      'global' as Topic,
      `run:${payload.runId}` as Topic,
    ])
    .with({ kind: 'test.specs' }, () => ['global' as Topic])
    .with({ kind: 'test.spec-created' }, ({ payload }) => {
      const slug = (payload.spec as { slug?: string })?.slug;
      return slug
        ? (['global', `test-spec:${slug}` as Topic] as Topic[])
        : (['global'] as Topic[]);
    })
    .with(
      {
        kind: P.union(
          'test.review-persona-start',
          'test.review-persona-done',
          'test.review-persona-error',
          'test.mutation-log',
          'test.flakiness-case-start',
          'test.flakiness-case-done',
          'test.flakiness-case-error',
          'test.flakiness-complete',
        ),
      },
      ({ payload }) => ['global' as Topic, `run:${payload.runId}` as Topic],
    )
    .with(
      { kind: P.union('test.polish-case-start', 'test.polish-case-done', 'test.polish-case-error') },
      ({ payload }) => ['global' as Topic, `test-spec:${payload.slug}` as Topic],
    )
    .with(
      { kind: P.union('test.regen-complete', 'test.contract-complete', 'test.scenarios-complete') },
      ({ payload }) => {
        const slug = (payload.spec as { slug?: string })?.slug;
        return slug
          ? (['global', `test-spec:${slug}` as Topic] as Topic[])
          : (['global'] as Topic[]);
      },
    )

    // ── Bind / artifact ──────────────────────────────────────────────
    .with({ kind: 'bind.overridden' }, ({ payload }) => [
      'global' as Topic,
      'incident' as Topic,
      ...(payload.incidentId ? [`run:${payload.incidentId}` as Topic] : []),
    ])
    .with({ kind: 'bind.override-applied' }, () => ['global' as Topic, 'incident' as Topic])
    .with({ kind: 'artifact' }, ({ payload }) =>
      payload.runId
        ? (['global', `run:${payload.runId}` as Topic] as Topic[])
        : (['global'] as Topic[]),
    )

    // ── Incidents ────────────────────────────────────────────────────
    .with({ kind: 'incident.ingested' }, () => ['global' as Topic, 'incident' as Topic])
    .with({ kind: 'replay.queued' }, () => ['global' as Topic, 'incident' as Topic])
    .with({ kind: 'replay.step' }, () => ['global' as Topic, 'incident' as Topic])
    .with({ kind: 'replay.complete' }, () => ['global' as Topic, 'incident' as Topic])

    // ── KB ───────────────────────────────────────────────────────────
    .with({ kind: 'kb.progress' }, () => ['global' as Topic, 'kb' as Topic])
    .with({ kind: 'kb.status' }, () => ['global' as Topic, 'kb' as Topic])

    // ── State / runs / misc ──────────────────────────────────────────
    .with({ kind: 'state' }, () => ['global' as Topic])
    .with({ kind: 'prs.updated' }, () => ['global' as Topic])
    .with({ kind: 'project-graph.started' }, ({ payload }) => [
      'global' as Topic,
      `project:${payload.project}` as Topic,
    ])
    .with({ kind: 'project-graph.progress' }, ({ payload }) => [
      'global' as Topic,
      `project:${payload.project}` as Topic,
    ])
    .with({ kind: 'project-graph.complete' }, ({ payload }) => [
      'global' as Topic,
      `project:${payload.project}` as Topic,
    ])
    .with({ kind: 'project-graph.error' }, ({ payload }) => [
      'global' as Topic,
      `project:${payload.project}` as Topic,
    ])

    // ── Plan side-channel ────────────────────────────────────────────
    .with({ kind: 'plan.error' }, ({ payload }) => [
      `project:${payload.project}` as Topic,
      'global' as Topic,
    ])
    .with({ kind: 'plan.variants-started' }, ({ payload }) => [
      'global' as Topic,
      `project:${payload.project}` as Topic,
    ])
    .with({ kind: 'plan.variant-created' }, ({ payload }) => {
      const slug = (payload.plan as { slug?: string })?.slug;
      return slug
        ? (['global', `plan:${slug}` as Topic] as Topic[])
        : (['global'] as Topic[]);
    })
    .with({ kind: 'plan.auto-refine-progress' }, () => ['global' as Topic])

    // ── Review side-channel ──────────────────────────────────────────
    .with({ kind: 'review.started' }, ({ payload }) => [
      `review:${payload.reviewId}` as Topic,
      'global' as Topic,
    ])
    .with({ kind: 'review.kb-summary' }, ({ payload }) => [
      'global' as Topic,
      `review:${payload.reviewId}` as Topic,
    ])
    .with({ kind: 'review.persona-done' }, ({ payload }) => [
      'global' as Topic,
      `review:${payload.reviewId}` as Topic,
    ])
    .with({ kind: 'review.published' }, ({ payload }) => [
      'global' as Topic,
      `review:${payload.reviewId}` as Topic,
    ])
    .with({ kind: 'review.finding-resolved' }, ({ payload }) => [
      'global' as Topic,
      `review:${payload.reviewId}` as Topic,
    ])

    // ── Test side-channel ────────────────────────────────────────────
    .with({ kind: 'test.review-complete' }, ({ payload }) => [
      'global' as Topic,
      `run:${payload.runId}` as Topic,
    ])
    .with({ kind: 'test.finding-resolved' }, ({ payload }) => [
      'global' as Topic,
      `run:${payload.runId}` as Topic,
    ])

    // ── Pipeline auth + interrupted snapshot ─────────────────────────
    .with({ kind: 'pipeline.auth-required' }, ({ payload }) => [
      `run:${payload.runId}` as Topic,
      'global' as Topic,
    ])
    .with({ kind: 'pipeline.interrupted-snapshot' }, () => ['global' as Topic])

    .exhaustive();
}
