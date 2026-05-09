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
import { runValidate as runValidateCanonical, hasValidationFailures, extractRepoSection, } from '@esankhan3/anvil-core-pipeline';
import { AgentManagerRunner } from '../runners/agent-manager-runner.js';
export { hasValidationFailures, extractRepoSection, };
/**
 * Back-compat wrapper. Constructs an `AgentManagerRunner` from the
 * legacy opts and dispatches to the canonical `runValidate`.
 */
export async function runValidate(opts) {
    const burnedModels = new Set();
    const runner = new AgentManagerRunner({
        agentManager: opts.agentManager,
        project: opts.project,
        workspaceDir: opts.workspaceDir,
        isCancelled: opts.isCancelled,
        resolveModel: () => opts.model,
        burnedModels,
        maxAttempts: 1,
        onSpawn: (agentId, req) => opts.onSpawn?.(req.repoName ?? null, agentId),
        onTruncation: opts.onTruncation,
    });
    return runValidateCanonical({
        runner,
        project: opts.project,
        model: opts.model,
        workspaceDir: opts.workspaceDir,
        repoNames: opts.repoNames,
        repoPaths: opts.repoPaths,
        buildRepoProjectPrompt: opts.buildRepoProjectPrompt,
        buildProjectPrompt: opts.buildProjectPrompt,
        maxOutputTokens: opts.maxOutputTokens,
        allowedTools: opts.allowedTools,
    });
}
//# sourceMappingURL=validate.step.js.map