/**
 * Shared dashboard server types (Phase 3 round-9 extraction from
 * `dashboard-server.ts`).
 *
 * These interfaces describe the wire-shape of the dashboard's HTTP +
 * WebSocket API. They're consumed by `setup/init-payload.ts`,
 * `runs/io.ts`, `pipeline/start-pipeline.ts`, the handler-registry
 * adapters, the broadcaster, AND the Vite frontend (`src/`) — so
 * they live in `shared/` instead of being trapped inside
 * `startDashboardServer`'s scope.
 *
 * `dashboard-server.ts` re-exports every interface here so existing
 * consumers' `import { ... } from './dashboard-server.js'` paths keep
 * working unchanged.
 */
export interface ProjectSummary {
    name: string;
    title: string;
    owner: string;
    lifecycle: string;
    repoCount: number;
    repos?: Array<{
        name: string;
        language: string;
        github: string;
    }>;
}
export interface RunSummary {
    id: string;
    project: string;
    feature: string;
    featureSlug?: string;
    status: string;
    model?: string;
    startedAt: number;
    completedAt?: number;
    durationMs?: number;
    totalCost?: number;
    stages: number;
    completedStages: number;
    repos: string[];
    prUrls?: string[];
    runType?: string;
    output?: string;
    stageDetails?: Array<{
        name: string;
        label: string;
        status: string;
        cost: number;
        startedAt: string | null;
        completedAt: string | null;
        error: string | null;
    }>;
}
export interface DashboardStageState {
    name: string;
    label?: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting';
    startedAt?: string;
    completedAt?: string;
    error?: string;
    cost?: number;
    perRepo?: boolean;
    repos?: Array<{
        repoName: string;
        agentId: string | null;
        status: string;
        cost: number;
        error: string | null;
    }>;
    /** Phase 8 — model id resolved by the registry-driven resolver. */
    resolvedModel?: string;
    /** Phase 8 — tool-permission classes for this stage. */
    permissionClasses?: ('read' | 'write' | 'exec')[];
    /**
     * Stage Q&A — populated when the agent's first response is a
     * `<questions>...</questions>` block. Frontend's PipelineContainer
     * mounts StageQuestionsPanel when this is non-empty. Each entry's
     * `answer` is filled in by `provideStageAnswer` as the user replies.
     */
    questions?: Array<{
        index: number;
        text: string;
        answer?: string;
    }>;
}
export interface DashboardPipeline {
    runId: string;
    project: string;
    feature: string;
    featureSlug?: string;
    status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting';
    currentStage: number;
    stages: DashboardStageState[];
    startedAt: string;
    cost: {
        inputTokens: number;
        outputTokens: number;
        estimatedCost: number;
    };
    model?: string;
    repoNames?: string[];
    waitingForInput?: boolean;
}
export interface DashboardState {
    activePipeline: DashboardPipeline | null;
    lastUpdated: string;
}
export interface ServerMessage {
    type: string;
    payload: unknown;
}
export interface ClientMessage {
    action: string;
    project?: string;
    feature?: string;
    runId?: string;
    text?: string;
    agentId?: string;
    stage?: number;
    reason?: string;
    fromStage?: string;
    slug?: string;
    query?: string;
    maxChunks?: number;
    referenceAnswer?: string;
    benchModel?: string;
    provider?: string;
    model?: string;
    path?: string;
    force?: boolean;
    maxPerRun?: number;
    maxPerDay?: number;
    alertAt?: number;
    key?: string;
    planSlug?: string;
    section?: string;
    plan?: unknown;
    options?: {
        skipClarify?: boolean;
        skipShip?: boolean;
        model?: string;
        models?: Record<string, string>;
        approvalRequired?: boolean;
        baseBranch?: string;
        modelTier?: 'fast' | 'balanced' | 'thorough';
        repo?: string;
        level?: string;
    };
}
export interface DashboardServerOptions {
    port?: number;
    staticDir: string;
    open?: boolean;
}
/**
 * Returned by `startDashboardServer` once the HTTP+WS server is listening.
 * Tests use `stop()` to release the port and clear interval handles so the
 * Node process can exit cleanly. Production callers can simply ignore the
 * handle — the HTTP server keeps the event loop alive on its own.
 */
export interface DashboardServerHandle {
    port: number;
    stop: () => Promise<void>;
}
//# sourceMappingURL=server-types.d.ts.map