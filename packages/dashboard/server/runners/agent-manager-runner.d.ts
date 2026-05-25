/**
 * `AgentManagerRunner` — adapter that satisfies the canonical
 * `AgentRunner` interface (from `@esankhan3/anvil-core-pipeline`)
 * by wrapping the dashboard's heavyweight `AgentManager` + the
 * `spawnAndWait` helper + the chain-fallback walker.
 *
 * Once `pipeline-runner.ts` migrates to driving `Pipeline.run()` over
 * an `InMemoryStepRegistry` (R7), every Step factory will accept this
 * runner as the agent invocation surface. cli builds its own
 * lightweight runner that fulfills the same shape, so the same Step
 * factories drive both consumers without modification.
 */
import type { AgentRunner, AgentRunRequest, AgentRunResult } from '@esankhan3/anvil-core-pipeline';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
export interface AgentManagerRunnerOptions {
    agentManager: AgentManager;
    /** Project name forwarded to the spawn config. */
    project: string;
    /** Workspace root used as default cwd when the request omits one. */
    workspaceDir: string;
    /** Cancellation predicate read on every poll tick. */
    isCancelled: () => boolean;
    /**
     * Resolves the next model to try given the in-flight burn-set. Lets
     * the dashboard plug in its liveness-aware
     * `pickAliveModelFromChainSync` while the runner stays generic.
     */
    resolveModel: (stageName: string, exclude: ReadonlySet<string>) => string;
    /** Mutable burn-set shared across all stages of a single run. */
    burnedModels: Set<string>;
    /** Max chain-fallback attempts. Forwarded to `runWithChainFallback`. */
    maxAttempts: number;
    /** Optional callback fired the moment an agent is spawned. */
    onSpawn?: (agentId: string, req: AgentRunRequest) => void;
    /** Optional callback fired when the adapter reports max-tokens truncation. */
    onTruncation?: (agentName: string, outputTokens: number) => void;
    /** Optional callback fired when a model gets burned mid-run. */
    onBurn?: (info: {
        stageName: string;
        model: string;
        status: number | string;
        message: string;
    }) => void;
    /**
     * Wave 5 — optional callback that powers the agent's `recall_memory`
     * tool. When set AND the stage's permissions include `recall`, the
     * BuiltinToolExecutor advertises the tool to the model. The callback
     * is bounded by a 3-call budget per spawn enforced inside the executor.
     */
    recallMemory?: (query: string, opts: {
        kind?: string;
        subtype?: string;
        limit?: number;
    }) => Promise<string>;
}
export declare class AgentManagerRunner implements AgentRunner {
    private readonly opts;
    constructor(opts: AgentManagerRunnerOptions);
    run(req: AgentRunRequest): Promise<AgentRunResult>;
    private spawnOnce;
}
//# sourceMappingURL=agent-manager-runner.d.ts.map