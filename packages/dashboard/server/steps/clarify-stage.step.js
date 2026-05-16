/**
 * Phase H7 — `clarify-stage.step` was promoted into core-pipeline with
 * a refactored signature requiring `AgentSession` (the legacy direct
 * `AgentManager` fallback was dropped from the canonical path).
 *
 * This file remains in dashboard as a back-compat adapter — keeps the
 * legacy `agentManager`-based API by constructing an
 * `AgentManagerSession` internally. Direct consumers should migrate
 * to the canonical path:
 *
 *   import { createClarifyStageStep, runClarifyForProject,
 *     type ClarifyStageStepOptions, type RunClarifyForProjectOptions,
 *     type RunClarifyForProjectResult }
 *     from '@esankhan3/anvil-core-pipeline';
 *
 * @deprecated Construct an `AgentManagerSession` and call canonical
 *   `runClarifyForProject` / `createClarifyStageStep`.
 */
import { createClarifyStageStep as createClarifyStageStepCanonical, runClarifyForProject as runClarifyForProjectCanonical, } from '@esankhan3/anvil-core-pipeline';
import { AgentManagerSession } from '../runners/agent-manager-session.js';
export async function runClarifyForProject(opts) {
    const session = opts.agentSession ?? buildSession(opts);
    return runClarifyForProjectCanonical({
        agentSession: session,
        project: opts.project,
        workspaceDir: opts.workspaceDir,
        model: opts.model,
        maxOutputTokens: opts.maxOutputTokens,
        explorePrompt: opts.explorePrompt,
        projectPrompt: opts.projectPrompt,
        inputResolver: opts.inputResolver,
        isCancelled: opts.isCancelled,
        onAgentSpawned: opts.onAgentSpawned,
        onClarifyQuestion: opts.onClarifyQuestion,
        onWaitingForInput: opts.onWaitingForInput,
        onAnswerReceived: opts.onAnswerReceived,
        onClarifyAck: opts.onClarifyAck,
        onSynthesizeStart: opts.onSynthesizeStart,
        allowedTools: opts.allowedTools,
    });
}
function buildSession(opts) {
    if (!opts.agentManager) {
        throw new Error('runClarifyForProject requires either agentSession or agentManager');
    }
    return new AgentManagerSession({
        agentManager: opts.agentManager,
        project: opts.project,
        workspaceDir: opts.workspaceDir,
        isCancelled: opts.isCancelled,
        resolveModel: () => opts.model,
        onTruncation: opts.onTruncation,
    });
}
export function createClarifyStageStep(opts) {
    const session = new AgentManagerSession({
        agentManager: opts.agentManager,
        project: opts.project,
        workspaceDir: opts.workspaceDir,
        isCancelled: () => false,
        resolveModel: () => opts.model,
        onTruncation: opts.onTruncation,
    });
    return createClarifyStageStepCanonical({
        id: opts.id,
        agentSession: session,
        project: opts.project,
        workspaceDir: opts.workspaceDir,
        model: opts.model,
        maxOutputTokens: opts.maxOutputTokens,
        buildExplorePrompt: opts.buildExplorePrompt,
        buildProjectPrompt: opts.buildProjectPrompt,
        inputResolver: opts.inputResolver,
        onAgentSpawned: opts.onAgentSpawned,
        onClarifyQuestion: opts.onClarifyQuestion,
        onWaitingForInput: opts.onWaitingForInput,
        onAnswerReceived: opts.onAnswerReceived,
        onClarifyAck: opts.onClarifyAck,
        onSynthesizeStart: opts.onSynthesizeStart,
        isCancelled: opts.isCancelled,
    });
}
//# sourceMappingURL=clarify-stage.step.js.map