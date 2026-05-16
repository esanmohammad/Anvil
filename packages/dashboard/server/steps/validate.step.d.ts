/**
 * Phase H2 — `validate.step` was promoted into
 * `core-pipeline/src/steps/validate.step.ts` with a new signature
 * accepting an `AgentRunner` (canonical agent invocation surface).
 *
 * This file remains in dashboard as a back-compat adapter so existing
 * callers (`fix-flow.ts`) keep using the legacy `agentManager + isCancelled
 * + onSpawn + onTruncation + pollIntervalMs + sleep + ...` opts shape.
 * Internally we wrap those into an `AgentManagerRunner` and call the
 * canonical `runValidate(opts)`.
 *
 * Direct consumers should migrate to the canonical path:
 *   import { runValidate, hasValidationFailures, extractRepoSection,
 *     type RunValidateOptions, type RunValidateResult }
 *     from '@esankhan3/anvil-core-pipeline';
 *
 * Construct an `AgentRunner` (e.g. dashboard's `AgentManagerRunner`)
 * and pass it as `runner`.
 */
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import { hasValidationFailures, extractRepoSection, type RunValidateResult } from '@esankhan3/anvil-core-pipeline';
export { hasValidationFailures, extractRepoSection, };
export type { RunValidateResult };
/** Legacy options shape kept here for back-compat with fix-flow.ts. */
export interface RunValidateOptions {
    agentManager: AgentManager;
    project: string;
    model: string;
    workspaceDir: string;
    repoNames: string[];
    repoPaths: Record<string, string>;
    buildRepoProjectPrompt: (repoName: string) => string;
    buildProjectPrompt: () => string;
    isCancelled: () => boolean;
    onTruncation?: (agentName: string, outputTokens: number) => void;
    maxOutputTokens?: number;
    allowedTools?: string[];
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onSpawn?: (repoName: string | null, agentId: string) => void;
}
/**
 * Back-compat wrapper. Constructs an `AgentManagerRunner` from the
 * legacy opts and dispatches to the canonical `runValidate`.
 */
export declare function runValidate(opts: RunValidateOptions): Promise<RunValidateResult>;
//# sourceMappingURL=validate.step.d.ts.map