/**
 * Phase H3 — `fix.step` was promoted into
 * `core-pipeline/src/steps/fix.step.ts` with a new signature accepting
 * an `AgentRunner`.
 *
 * This file is a back-compat adapter — keeps the legacy
 * `{agentManager, isCancelled, onSpawn, onTruncation, ...}` opts
 * shape so fix-flow.ts compiles unchanged. Internally wraps into an
 * `AgentManagerRunner` and dispatches to the canonical `runFix`.
 *
 * @deprecated Direct consumers should import from
 *   `@esankhan3/anvil-core-pipeline` and pass an `AgentRunner`.
 */
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import { type RunFixResult } from '@esankhan3/anvil-core-pipeline';
export type { RunFixResult };
export interface RunFixOptions {
    agentManager: AgentManager;
    project: string;
    description: string;
    model: string;
    workspaceDir: string;
    repoNames: string[];
    repoPaths: Record<string, string>;
    buildProjectPrompt: () => string;
    buildRepoProjectPrompt: (repoName: string) => string;
    isCancelled: () => boolean;
    onTruncation?: (agentName: string, outputTokens: number) => void;
    maxOutputTokens?: number;
    allowedTools?: string[];
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onSpawn?: (repoName: string | null, agentId: string) => void;
}
export declare function runFix(opts: RunFixOptions): Promise<RunFixResult>;
//# sourceMappingURL=fix.step.d.ts.map