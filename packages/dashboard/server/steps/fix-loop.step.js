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
import { runFixLoop as runFixLoopCanonical, hasValidationFailures, extractRepoSection, } from '@esankhan3/anvil-core-pipeline';
import { AgentManagerSession } from '../runners/agent-manager-session.js';
export { hasValidationFailures, extractRepoSection, };
export async function runFixLoop(opts) {
    const session = opts.agentSession ?? buildSession(opts);
    return runFixLoopCanonical({
        agentSession: session,
        project: opts.project,
        model: opts.model,
        maxOutputTokens: opts.maxOutputTokens,
        workspaceDir: opts.workspaceDir,
        repoNames: opts.repoNames,
        repoPaths: opts.repoPaths,
        validateArtifact: opts.validateArtifact,
        attempt: opts.attempt,
        priorByRepo: opts.priorByRepo,
        priorSingleId: opts.priorSingleId,
        buildProjectPromptForBuildStage: opts.buildProjectPromptForBuildStage,
        buildRepoProjectPromptForBuildStage: opts.buildRepoProjectPromptForBuildStage,
        isCancelled: opts.isCancelled,
        allowedTools: opts.allowedTools,
    });
}
function buildSession(opts) {
    if (!opts.agentManager) {
        throw new Error('runFixLoop requires either agentSession or agentManager');
    }
    return new AgentManagerSession({
        agentManager: opts.agentManager,
        project: opts.project,
        workspaceDir: opts.workspaceDir,
        isCancelled: opts.isCancelled,
        resolveModel: () => opts.model ?? '',
        onTruncation: opts.onTruncation,
    });
}
export function createFixLoopStep(opts) {
    const id = opts.id ?? 'fix-loop';
    return {
        id,
        name: 'Fix loop attempt',
        parallelism: 'serial',
        async run(ctx) {
            const { validateArtifact, attempt } = opts.readInput
                ? opts.readInput(ctx)
                : ctx.input;
            const isCancelled = opts.isCancelled
                ? () => opts.isCancelled(ctx)
                : () => ctx.signal.aborted;
            return runFixLoop({
                ...opts,
                validateArtifact,
                attempt,
                isCancelled,
            });
        },
    };
}
//# sourceMappingURL=fix-loop.step.js.map