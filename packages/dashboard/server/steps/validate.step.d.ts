/**
 * `validate` step factory — standalone validate stage callable from the
 * Fix flow (and any future flow that wants a validate pass without the
 * full build pipeline).
 *
 * Behavior parity with `pipeline-runner.ts`'s validate stage:
 *   - Per-repo fan-out when `repoNames.length > 0`, else single-workspace.
 *   - Combines per-repo outputs into one VALIDATE.md artifact.
 *   - Detects failure via `hasValidationFailures` (lifted from fix-loop).
 *   - Persona = 'tester'; allowedTools sourced by the caller.
 */
import type { AgentManager } from '@anvil/agent-core';
export interface RunValidateOptions {
    agentManager: AgentManager;
    project: string;
    /** Resolved model id for the validate stage. */
    model: string;
    workspaceDir: string;
    repoNames: string[];
    repoPaths: Record<string, string>;
    /** Builds the per-repo project (system) prompt. Mirrors fix-loop's hook. */
    buildRepoProjectPrompt: (repoName: string) => string;
    /** Builds the project-wide system prompt for single-workspace path. */
    buildProjectPrompt: () => string;
    isCancelled: () => boolean;
    onTruncation?: (agentName: string, outputTokens: number) => void;
    /** Optional output-token ceiling. */
    maxOutputTokens?: number;
    /** Per-stage allow list. Validate is read+exec only (lint/typecheck/tests). */
    allowedTools?: string[];
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Optional spawn-id sink so the caller can persist for future resume. */
    onSpawn?: (repoName: string | null, agentId: string) => void;
}
export interface RunValidateResult {
    /** Combined VALIDATE.md across all repos. */
    artifact: string;
    /** True when at least one repo failed (or single-workspace mode failed). */
    failed: boolean;
    /** Per-repo outcome — empty for single-workspace mode. */
    perRepo: Record<string, {
        failed: boolean;
        section: string;
    }>;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}
export declare function runValidate(opts: RunValidateOptions): Promise<RunValidateResult>;
//# sourceMappingURL=validate.step.d.ts.map