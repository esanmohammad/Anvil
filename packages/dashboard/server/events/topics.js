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
export function roomsForEvent(ev) {
    return match(ev)
        // ── Run lifecycle ────────────────────────────────────────────────
        .with({ kind: 'run.started' }, ({ payload }) => [
        'global',
        `run:${payload.runId}`,
        `project:${payload.project}`,
    ])
        .with({ kind: 'run.state-changed' }, ({ payload }) => [
        'global',
        `run:${payload.runId}`,
    ])
        .with({ kind: 'run.completed' }, ({ payload }) => [
        'global',
        `run:${payload.runId}`,
    ])
        .with({ kind: 'run.stopped' }, ({ payload }) => [
        'global',
        `run:${payload.runId}`,
    ])
        .with({ kind: 'run.rejected' }, ({ payload }) => [
        'global',
        `run:${payload.runId}`,
    ])
        .with({ kind: 'run.active-snapshot' }, () => ['global'])
        .with({ kind: 'runs.list' }, () => ['global'])
        // ── Agent stream ─────────────────────────────────────────────────
        // During the raw-WS → socket.io transition agent events publish to
        // both `global` AND `run:<id>` so clients that haven't opted into
        // per-run subscriptions still see the firehose (matches raw-WS
        // semantics). The frontend will move to per-run subscriptions in a
        // follow-up; at that point drop `global` from these mappings.
        .with({ kind: 'agent.spawned' }, ({ payload }) => payload.runId
        ? ['global', `run:${payload.runId}`]
        : ['global'])
        .with({ kind: 'agent.output' }, ({ payload }) => payload.runId
        ? ['global', `run:${payload.runId}`]
        : ['global'])
        .with({ kind: 'agent.done' }, () => ['global'])
        .with({ kind: 'agent.error' }, () => ['global'])
        // ── Pipeline lifecycle ───────────────────────────────────────────
        .with({ kind: P.union('pipeline.paused', 'pipeline.resumed', 'pipeline.cancelled') }, ({ payload }) => {
        const runId = payload.pause?.runId;
        return runId
            ? ['global', `run:${runId}`]
            : ['global'];
    })
        .with({ kind: 'pipeline.waiting-for-input' }, () => ['global'])
        // ── Cost ─────────────────────────────────────────────────────────
        .with({ kind: 'cost.breach' }, () => ['global', 'cost'])
        .with({ kind: 'cost.snapshot' }, ({ payload }) => {
        const rooms = ['global', 'cost', `project:${payload.project}`];
        if (payload.runId)
            rooms.push(`run:${payload.runId}`);
        return rooms;
    })
        // ── Reviews ──────────────────────────────────────────────────────
        .with({ kind: 'review.created' }, ({ payload }) => {
        const reviewId = payload.review?.id;
        return reviewId
            ? ['global', `review:${reviewId}`]
            : ['global'];
    })
        .with({ kind: 'review.error' }, ({ payload }) => payload.reviewId
        ? ['global', `review:${payload.reviewId}`]
        : ['global'])
        // ── Plans ────────────────────────────────────────────────────────
        .with({
        kind: P.union('plan.created', 'plan.updated', 'plan.validation', 'plan.lifecycle', 'plan.comment-added', 'plan.comment-resolved', 'plan.comment-deleted', 'plan.approved'),
    }, ({ payload, kind }) => {
        const slug = payload.planSlug ??
            payload.plan?.slug;
        return slug
            ? ['global', `plan:${slug}`]
            : ['global'];
    })
        // ── Tests ────────────────────────────────────────────────────────
        // During migration: per-run/per-spec test events also broadcast to
        // `global` so default-subscribed clients keep firehose parity with
        // raw-WS. Tighten back to entity-only rooms once the frontend opts
        // into explicit subscriptions per route.
        .with({ kind: 'test.run-log' }, ({ payload }) => [
        'global',
        `run:${payload.runId}`,
    ])
        .with({ kind: 'test.specs' }, () => ['global'])
        .with({ kind: 'test.spec-created' }, ({ payload }) => {
        const slug = payload.spec?.slug;
        return slug
            ? ['global', `test-spec:${slug}`]
            : ['global'];
    })
        .with({
        kind: P.union('test.review-persona-start', 'test.review-persona-done', 'test.review-persona-error', 'test.mutation-log', 'test.flakiness-case-start', 'test.flakiness-case-done', 'test.flakiness-case-error', 'test.flakiness-complete'),
    }, ({ payload }) => ['global', `run:${payload.runId}`])
        .with({ kind: P.union('test.polish-case-start', 'test.polish-case-done', 'test.polish-case-error') }, ({ payload }) => ['global', `test-spec:${payload.slug}`])
        .with({ kind: P.union('test.regen-complete', 'test.contract-complete', 'test.scenarios-complete') }, ({ payload }) => {
        const slug = payload.spec?.slug;
        return slug
            ? ['global', `test-spec:${slug}`]
            : ['global'];
    })
        // ── Bind / artifact ──────────────────────────────────────────────
        .with({ kind: 'bind.overridden' }, ({ payload }) => [
        'global',
        'incident',
        ...(payload.incidentId ? [`run:${payload.incidentId}`] : []),
    ])
        .with({ kind: 'bind.override-applied' }, () => ['global', 'incident'])
        .with({ kind: 'artifact' }, ({ payload }) => payload.runId
        ? ['global', `run:${payload.runId}`]
        : ['global'])
        // ── Incidents ────────────────────────────────────────────────────
        .with({ kind: 'incident.ingested' }, () => ['global', 'incident'])
        .with({ kind: 'replay.queued' }, () => ['global', 'incident'])
        .with({ kind: 'replay.step' }, () => ['global', 'incident'])
        .with({ kind: 'replay.complete' }, () => ['global', 'incident'])
        // ── KB ───────────────────────────────────────────────────────────
        .with({ kind: 'kb.progress' }, () => ['global', 'kb'])
        .with({ kind: 'kb.status' }, () => ['global', 'kb'])
        // ── State / runs / misc ──────────────────────────────────────────
        .with({ kind: 'state' }, () => ['global'])
        .with({ kind: 'prs.updated' }, () => ['global'])
        .with({ kind: 'project-graph.started' }, ({ payload }) => [
        'global',
        `project:${payload.project}`,
    ])
        .with({ kind: 'project-graph.progress' }, ({ payload }) => [
        'global',
        `project:${payload.project}`,
    ])
        .with({ kind: 'project-graph.complete' }, ({ payload }) => [
        'global',
        `project:${payload.project}`,
    ])
        .with({ kind: 'project-graph.error' }, ({ payload }) => [
        'global',
        `project:${payload.project}`,
    ])
        // ── Plan side-channel ────────────────────────────────────────────
        .with({ kind: 'plan.error' }, ({ payload }) => [
        `project:${payload.project}`,
        'global',
    ])
        .with({ kind: 'plan.variants-started' }, ({ payload }) => [
        'global',
        `project:${payload.project}`,
    ])
        .with({ kind: 'plan.variant-created' }, ({ payload }) => {
        const slug = payload.plan?.slug;
        return slug
            ? ['global', `plan:${slug}`]
            : ['global'];
    })
        .with({ kind: 'plan.auto-refine-progress' }, () => ['global'])
        // ── Review side-channel ──────────────────────────────────────────
        .with({ kind: 'review.started' }, ({ payload }) => [
        `review:${payload.reviewId}`,
        'global',
    ])
        .with({ kind: 'review.kb-summary' }, ({ payload }) => [
        'global',
        `review:${payload.reviewId}`,
    ])
        .with({ kind: 'review.persona-done' }, ({ payload }) => [
        'global',
        `review:${payload.reviewId}`,
    ])
        .with({ kind: 'review.published' }, ({ payload }) => [
        'global',
        `review:${payload.reviewId}`,
    ])
        .with({ kind: 'review.finding-resolved' }, ({ payload }) => [
        'global',
        `review:${payload.reviewId}`,
    ])
        // ── Test side-channel ────────────────────────────────────────────
        .with({ kind: 'test.review-complete' }, ({ payload }) => [
        'global',
        `run:${payload.runId}`,
    ])
        .with({ kind: 'test.finding-resolved' }, ({ payload }) => [
        'global',
        `run:${payload.runId}`,
    ])
        // ── Pipeline auth + interrupted snapshot ─────────────────────────
        .with({ kind: 'pipeline.auth-required' }, ({ payload }) => [
        `run:${payload.runId}`,
        'global',
    ])
        .with({ kind: 'pipeline.interrupted-snapshot' }, () => ['global'])
        .exhaustive();
}
//# sourceMappingURL=topics.js.map