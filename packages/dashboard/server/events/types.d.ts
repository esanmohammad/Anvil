/**
 * Typed event union for the dashboard WS surface.
 *
 * Today's wire format is `{ type: string; payload: unknown }` — fully
 * untyped. This module is the v2 contract: every emission has a stable
 * `kind`, a typed `payload`, an id-ordered envelope, and a topic set.
 *
 * Phase 2 introduces the types but doesn't switch the wire over —
 * `broadcast()` keeps emitting the legacy shape. Phase 3 tranches replace
 * call sites with `services.<X>.emit(kind, payload)` which the
 * service-bridge translates into both wire shapes (legacy + new). Phase 4
 * deletes the legacy adapter once socket.io owns the wire.
 *
 * Topics are socket.io rooms — see `topics.ts` for the
 * `roomsForEvent(ev)` mapping.
 */
/**
 * Socket.io room identifier. Clients subscribe to a topic to receive
 * events tagged with it. Strings rather than enums so dynamic
 * per-entity rooms (`run:<id>`, `plan:<slug>`) are first-class.
 */
export type Topic = 'global' | 'cost' | 'kb' | 'incident' | 'system' | `run:${string}` | `project:${string}` | `review:${string}` | `plan:${string}` | `test-spec:${string}`;
/**
 * Wire schema version. Bumped only on breaking format changes
 * (renames, field removals). Additive changes — new kinds, new optional
 * fields — stay at version 1.
 */
export type SchemaVersion = 1;
export interface EventEnvelope<K extends string, P> {
    /** Monotonically increasing id, format `<ts>-<seq>`. Used by replay. */
    id: string;
    /** Discriminator for the union — exhaustively matched by ts-pattern. */
    kind: K;
    /** Typed payload — different per kind. */
    payload: P;
    /** Wall-clock time at emission (ms since epoch). */
    ts: number;
    /** Rooms this event publishes to. Computed via `roomsForEvent(ev)`. */
    topics: Topic[];
    /** Wire schema version. */
    schemaVersion: SchemaVersion;
}
interface ActiveRunSnapshot {
    id: string;
    type: string;
    project: string;
    description: string;
    model: string;
    status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
    startedAt: number;
    completedAt?: number;
    activityCount: number;
    stages?: unknown;
    error?: string | null;
    totalCost?: number;
}
export type RunStartedEvent = EventEnvelope<'run.started', {
    runId: string;
    project: string;
    type: 'build' | 'fix' | 'spike' | 'review' | 'plan' | 'research';
    description: string;
    model: string;
}>;
export type RunStateChangedEvent = EventEnvelope<'run.state-changed', {
    runId: string;
    status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
    stage?: {
        index: number;
        name: string;
        label: string;
    };
}>;
export type RunCompletedEvent = EventEnvelope<'run.completed', {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled';
    durationMs: number;
}>;
export type RunStoppedEvent = EventEnvelope<'run.stopped', {
    runId: string;
}>;
export type RunRejectedEvent = EventEnvelope<'run.rejected', {
    runId: string;
    reason: 'cost-breach' | 'policy';
}>;
export type ActiveRunsSnapshotEvent = EventEnvelope<'run.active-snapshot', {
    runs: ActiveRunSnapshot[];
}>;
export type RunsListEvent = EventEnvelope<'runs.list', {
    runs: unknown[];
}>;
/**
 * `agent.spawned` payload mirrors today's wire shape: it can be EITHER
 * the minimal `{id, runId, stage}` triplet emitted by quick actions OR
 * the full agent state spread with `{runId, persona, reviewId, variant}`
 * metadata. Keep it open via index signature — concrete narrowing
 * lives in the consumer (frontend reducer) which checks for fields it
 * cares about.
 *
 * `id` (not `agentId`) — the dashboard frontend reads `.id` because the
 * legacy broadcast payloads were direct AgentState spreads.
 */
export type AgentSpawnedEvent = EventEnvelope<'agent.spawned', {
    id: string;
    runId?: string;
    stage?: string;
    persona?: string;
    reviewId?: string;
    variant?: {
        batchId: string;
        index: number;
        label: string;
    };
    [key: string]: unknown;
}>;
export type AgentOutputEntry = {
    timestamp: number;
    stage: string;
    type: 'stdout' | 'stderr';
    content: string;
    kind: string;
    tool?: string;
    agentId?: string;
    repo?: string;
};
export type AgentOutputEvent = EventEnvelope<'agent.output', {
    entries: AgentOutputEntry[];
    runId?: string;
}>;
export type AgentDoneEvent = EventEnvelope<'agent.done', {
    agentId: string;
    agent: unknown;
}>;
export type AgentErrorEvent = EventEnvelope<'agent.error', {
    agentId: string;
    error: string;
}>;
export type PipelinePausedEvent = EventEnvelope<'pipeline.paused', {
    pause: unknown;
}>;
export type PipelineResumedEvent = EventEnvelope<'pipeline.resumed', {
    pause: unknown;
}>;
export type PipelineCancelledEvent = EventEnvelope<'pipeline.cancelled', {
    pause: unknown;
}>;
export type WaitingForInputEvent = EventEnvelope<'pipeline.waiting-for-input', {
    stageIndex: number;
    agentId: string;
}>;
export type CostBreachEvent = EventEnvelope<'cost.breach', {
    breach: unknown;
    topSpenders?: unknown;
}>;
export type CostSnapshotEvent = EventEnvelope<'cost.snapshot', {
    project: string;
    runId?: string;
    snapshot: unknown;
}>;
export type ReviewCreatedEvent = EventEnvelope<'review.created', {
    review: unknown;
}>;
export type ReviewErrorEvent = EventEnvelope<'review.error', {
    reviewId?: string;
    message: string;
}>;
export type PlanCreatedEvent = EventEnvelope<'plan.created', {
    plan: unknown;
    validation: unknown;
}>;
export type PlanUpdatedEvent = EventEnvelope<'plan.updated', {
    plan: unknown;
    validation?: unknown;
    section?: string;
}>;
export type PlanValidationEvent = EventEnvelope<'plan.validation', {
    planSlug: string;
    validation: unknown;
}>;
export type PlanLifecycleEvent = EventEnvelope<'plan.lifecycle', {
    snapshot: unknown;
}>;
export type PlanCommentAddedEvent = EventEnvelope<'plan.comment-added', {
    planSlug: string;
    comment: unknown;
}>;
export type PlanCommentResolvedEvent = EventEnvelope<'plan.comment-resolved', {
    planSlug: string;
    commentId: string;
    ok: boolean;
}>;
export type PlanCommentDeletedEvent = EventEnvelope<'plan.comment-deleted', {
    planSlug: string;
    commentId: string;
    ok: boolean;
}>;
export type PlanApprovedEvent = EventEnvelope<'plan.approved', {
    planSlug: string;
    approval: unknown;
}>;
export type TestRunLogEvent = EventEnvelope<'test.run-log', {
    runId: string;
    stream: 'stdout' | 'stderr';
    line: string;
}>;
export type TestSpecsEvent = EventEnvelope<'test.specs', {
    specs: unknown[];
}>;
export type TestSpecCreatedEvent = EventEnvelope<'test.spec-created', {
    spec: unknown;
    cases: unknown[];
}>;
export type TestReviewPersonaStartEvent = EventEnvelope<'test.review-persona-start', {
    runId: string;
    persona: unknown;
    agentId: string;
}>;
export type TestReviewPersonaDoneEvent = EventEnvelope<'test.review-persona-done', {
    runId: string;
    persona: unknown;
    findingCount: number;
    cost: unknown;
}>;
export type TestReviewPersonaErrorEvent = EventEnvelope<'test.review-persona-error', {
    runId: string;
    persona: unknown;
    message: string;
}>;
export type TestMutationLogEvent = EventEnvelope<'test.mutation-log', {
    runId: string;
    stream: 'stdout' | 'stderr';
    line: string;
}>;
export type TestPolishCaseStartEvent = EventEnvelope<'test.polish-case-start', {
    slug: string;
    caseId: string;
    agentId: string;
}>;
export type TestPolishCaseDoneEvent = EventEnvelope<'test.polish-case-done', {
    slug: string;
    caseId: string;
    cost: unknown;
    case: unknown;
}>;
export type TestPolishCaseErrorEvent = EventEnvelope<'test.polish-case-error', {
    slug: string;
    caseId: string;
    message: string;
}>;
export type TestRegenCompleteEvent = EventEnvelope<'test.regen-complete', {
    spec: unknown;
    cases: unknown[];
    summary: unknown;
    added: number;
}>;
export type TestContractCompleteEvent = EventEnvelope<'test.contract-complete', {
    spec: unknown;
    added: number;
    bySource: unknown;
}>;
export type TestScenariosCompleteEvent = EventEnvelope<'test.scenarios-complete', {
    spec: unknown;
    added: number;
    derivedFrom: unknown;
}>;
export type TestFlakinessCaseStartEvent = EventEnvelope<'test.flakiness-case-start', {
    runId: string;
    caseId: string;
    agentId: string;
}>;
export type TestFlakinessCaseDoneEvent = EventEnvelope<'test.flakiness-case-done', {
    runId: string;
    caseId: string;
    finding: unknown;
}>;
export type TestFlakinessCaseErrorEvent = EventEnvelope<'test.flakiness-case-error', {
    runId: string;
    caseId: string;
    message: string;
}>;
export type TestFlakinessCompleteEvent = EventEnvelope<'test.flakiness-complete', {
    runId: string;
    run: unknown;
    findings: number;
    signals: unknown;
}>;
export type BindOverriddenEvent = EventEnvelope<'bind.overridden', {
    replayId: string;
    filePath: string;
    incidentId: string;
}>;
export type BoundOverrideAppliedEvent = EventEnvelope<'bind.override-applied', {
    entry: unknown;
}>;
export type ArtifactEvent = EventEnvelope<'artifact', {
    runId?: string;
    stage?: string;
    kind: string;
    value: unknown;
}>;
export type PlanErrorEvent = EventEnvelope<'plan.error', {
    project: string;
    message: string;
    raw?: string;
}>;
export type PlanVariantsStartedEvent = EventEnvelope<'plan.variants-started', {
    project: string;
    feature: string;
    count?: number;
    [k: string]: unknown;
}>;
export type PlanVariantCreatedEvent = EventEnvelope<'plan.variant-created', {
    plan: unknown;
    validation: unknown;
    variant: unknown;
}>;
export type AutoRefineProgressEvent = EventEnvelope<'plan.auto-refine-progress', {
    summary: string;
}>;
export type ReviewStartedEvent = EventEnvelope<'review.started', {
    reviewId: string;
    prId: string;
    personas: unknown;
    project: string;
}>;
export type ReviewKbSummaryEvent = EventEnvelope<'review.kb-summary', {
    reviewId: string;
    summary: unknown;
    changedSymbols: number;
    orphans: number;
}>;
export type ReviewPersonaDoneEvent = EventEnvelope<'review.persona-done', {
    reviewId: string;
    persona: unknown;
    findingCount: number;
}>;
export type ReviewPublishedEvent = EventEnvelope<'review.published', {
    reviewId: string;
    [k: string]: unknown;
}>;
export type ReviewFindingResolvedEvent = EventEnvelope<'review.finding-resolved', {
    reviewId: string;
    findingId: string;
    resolution: unknown;
    review: unknown;
}>;
export type TestReviewCompleteEvent = EventEnvelope<'test.review-complete', {
    runId: string;
    run: unknown;
    totalFindings: number;
    perPersona: Record<string, number>;
}>;
export type TestFindingResolvedEvent = EventEnvelope<'test.finding-resolved', {
    runId: string;
    findingId: string;
    resolution: unknown;
    run: unknown;
}>;
export type ProjectGraphCompleteEvent = EventEnvelope<'project-graph.complete', {
    project: string;
    generatedAt: unknown;
    [k: string]: unknown;
}>;
export type ProjectGraphErrorEvent = EventEnvelope<'project-graph.error', {
    project: string;
    error: string;
}>;
export type AuthRequiredEvent = EventEnvelope<'pipeline.auth-required', {
    runId: string;
    stageName: string;
    message: string;
}>;
export type InterruptedPipelinesEvent = EventEnvelope<'pipeline.interrupted-snapshot', {
    pipelines: unknown[];
}>;
export type IncidentIngestedEvent = EventEnvelope<'incident.ingested', {
    incident: unknown;
}>;
export type ReplayQueuedEvent = EventEnvelope<'replay.queued', {
    incidentId: string;
    project: string;
    queueDepth: number;
}>;
export type ReplayStepEvent = EventEnvelope<'replay.step', {
    incidentId: string;
    step: unknown;
    state: unknown;
}>;
export type ReplayCompleteEvent = EventEnvelope<'replay.complete', {
    result: unknown;
    incidentId: string;
    attempt: unknown;
    boundFilePath?: string;
}>;
export type KbProgressEvent = EventEnvelope<'kb.progress', {
    progress: unknown;
}>;
export type KbStatusEvent = EventEnvelope<'kb.status', {
    status: unknown;
}>;
export type StateEvent = EventEnvelope<'state', {
    state: unknown;
}>;
export type PrsUpdatedEvent = EventEnvelope<'prs.updated', {
    prs: unknown[];
}>;
export type ProjectGraphStartedEvent = EventEnvelope<'project-graph.started', {
    project: string;
}>;
export type ProjectGraphProgressEvent = EventEnvelope<'project-graph.progress', {
    project: string;
    message: string;
}>;
export type DashboardEvent = RunStartedEvent | RunStateChangedEvent | RunCompletedEvent | RunStoppedEvent | RunRejectedEvent | ActiveRunsSnapshotEvent | RunsListEvent | AgentSpawnedEvent | AgentOutputEvent | AgentDoneEvent | AgentErrorEvent | PipelinePausedEvent | PipelineResumedEvent | PipelineCancelledEvent | WaitingForInputEvent | CostBreachEvent | CostSnapshotEvent | ReviewCreatedEvent | ReviewErrorEvent | PlanCreatedEvent | PlanUpdatedEvent | PlanValidationEvent | PlanLifecycleEvent | PlanCommentAddedEvent | PlanCommentResolvedEvent | PlanCommentDeletedEvent | PlanApprovedEvent | TestRunLogEvent | TestSpecsEvent | TestSpecCreatedEvent | TestReviewPersonaStartEvent | TestReviewPersonaDoneEvent | TestReviewPersonaErrorEvent | TestMutationLogEvent | TestPolishCaseStartEvent | TestPolishCaseDoneEvent | TestPolishCaseErrorEvent | TestRegenCompleteEvent | TestContractCompleteEvent | TestScenariosCompleteEvent | TestFlakinessCaseStartEvent | TestFlakinessCaseDoneEvent | TestFlakinessCaseErrorEvent | TestFlakinessCompleteEvent | BindOverriddenEvent | BoundOverrideAppliedEvent | ArtifactEvent | PlanErrorEvent | PlanVariantsStartedEvent | PlanVariantCreatedEvent | AutoRefineProgressEvent | ReviewStartedEvent | ReviewKbSummaryEvent | ReviewPersonaDoneEvent | ReviewPublishedEvent | ReviewFindingResolvedEvent | TestReviewCompleteEvent | TestFindingResolvedEvent | ProjectGraphCompleteEvent | ProjectGraphErrorEvent | AuthRequiredEvent | InterruptedPipelinesEvent | IncidentIngestedEvent | ReplayQueuedEvent | ReplayStepEvent | ReplayCompleteEvent | KbProgressEvent | KbStatusEvent | StateEvent | PrsUpdatedEvent | ProjectGraphStartedEvent | ProjectGraphProgressEvent;
export type EventKind = DashboardEvent['kind'];
export type EventOf<K extends EventKind> = Extract<DashboardEvent, {
    kind: K;
}>;
export type PayloadOf<K extends EventKind> = EventOf<K>['payload'];
/**
 * Generate a monotonically increasing event id `<ts>-<seq>`. The id is
 * ordered by emission time; replay queries use it as a cursor.
 *
 * Test seam: pass a fixed `now` for deterministic snapshots.
 */
export declare function nextEventId(now?: () => number): string;
/**
 * Build an event envelope. Callers (services) emit by kind+payload;
 * the bridge wraps the payload into an envelope before queuing for
 * the wire layer.
 */
export declare function envelope<K extends EventKind>(kind: K, payload: PayloadOf<K>, topics: Topic[], now?: () => number): EventOf<K>;
export {};
//# sourceMappingURL=types.d.ts.map