/**
 * Phase H8 — `fix-loop.step` was promoted into core-pipeline with a
 * refactored signature requiring `AgentSession`. The legacy
 * `AgentManager`-based path is preserved here as a back-compat
 * adapter (constructs an `AgentManagerSession` internally).
 *
 * @deprecated Direct consumers should migrate to:
 *   import { createFixLoopStep, runFixLoop, type FixLoopStepOptions,
 *     type RunFixLoopOptions, type RunFixLoopResult,
 *     hasValidationFailures, extractRepoSection }
 *     from '@esankhan3/anvil-core-pipeline';
 */
import type { AgentSession, Step, StepContext, RunFixLoopResult } from '@esankhan3/anvil-core-pipeline';
import { hasValidationFailures, extractRepoSection } from '@esankhan3/anvil-core-pipeline';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
export { hasValidationFailures, extractRepoSection, };
export type { RunFixLoopResult };
/** Legacy options shape — accepts `agentSession` OR `agentManager`. */
export interface RunFixLoopOptions {
    agentSession?: AgentSession;
    agentManager?: AgentManager;
    project: string;
    model?: string;
    maxOutputTokens?: number;
    workspaceDir: string;
    repoNames: string[];
    repoPaths: Record<string, string>;
    validateArtifact: string;
    attempt: number;
    priorByRepo: Map<string, string>;
    priorSingleId: string | null;
    buildProjectPromptForBuildStage: () => string;
    buildRepoProjectPromptForBuildStage: (repoName: string) => string;
    isCancelled: () => boolean;
    onTruncation?: (agentName: string, outputTokens: number) => void;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    allowedTools?: string[];
}
export declare function runFixLoop(opts: RunFixLoopOptions): Promise<RunFixLoopResult>;
export interface FixLoopStepOptions extends Omit<RunFixLoopOptions, 'isCancelled' | 'validateArtifact' | 'attempt'> {
    id?: string;
    readInput?: (ctx: StepContext<unknown>) => {
        validateArtifact: string;
        attempt: number;
    };
    isCancelled?: (ctx: StepContext<unknown>) => boolean;
}
export declare function createFixLoopStep(opts: FixLoopStepOptions): Step<unknown, RunFixLoopResult>;
//# sourceMappingURL=fix-loop.step.d.ts.map