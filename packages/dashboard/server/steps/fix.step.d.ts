/**
 * `fix` step factory — runs an engineer agent against a bug
 * description. Composes with the `validate` and `fix-loop` steps to
 * form the multi-stage Fix flow that replaces the prior single-agent
 * `run-fix` quick action.
 *
 * Per-repo fan-out when `repoNames.length > 0`, else single-workspace.
 */
import type { AgentManager } from '@anvil/agent-core';
export interface RunFixOptions {
    agentManager: AgentManager;
    project: string;
    /** Bug description from the user — becomes the agent's prompt. */
    description: string;
    /** Resolved model id for the fix stage. */
    model: string;
    workspaceDir: string;
    repoNames: string[];
    repoPaths: Record<string, string>;
    /** Builds the project (system) prompt. */
    buildProjectPrompt: () => string;
    /** Builds the per-repo project (system) prompt. */
    buildRepoProjectPrompt: (repoName: string) => string;
    isCancelled: () => boolean;
    onTruncation?: (agentName: string, outputTokens: number) => void;
    maxOutputTokens?: number;
    /** Per-stage allow list. Fix needs read+write+exec. */
    allowedTools?: string[];
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Spawn-id sink so callers can track the agent for resume. */
    onSpawn?: (repoName: string | null, agentId: string) => void;
}
export interface RunFixResult {
    /** Combined fix output across all repos (single-workspace: that one agent's output). */
    artifact: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Per-repo agent ids — used by fix-loop to resume sessions on retry. */
    agentIds: Map<string, string>;
    /** Single-workspace agent id (null on per-repo path). */
    singleAgentId: string | null;
}
export declare function runFix(opts: RunFixOptions): Promise<RunFixResult>;
//# sourceMappingURL=fix.step.d.ts.map