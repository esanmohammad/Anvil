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
import { runWithChainFallback } from '@esankhan3/anvil-core-pipeline';
import { spawnAndWait } from '../steps/agent-spawner.js';
import { disallowedToolsForPersona } from '@esankhan3/anvil-core-pipeline';
export class AgentManagerRunner {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    async run(req) {
        return runWithChainFallback({
            stageName: req.stage,
            maxAttempts: this.opts.maxAttempts,
            resolveModel: (excluded) => this.opts.resolveModel(req.stage, excluded),
            onBurn: (info) => {
                this.opts.burnedModels.add(info.model);
                this.opts.onBurn?.(info);
            },
        }, async (model) => this.spawnOnce(req, model));
    }
    async spawnOnce(req, model) {
        const cwd = req.workingDir || this.opts.workspaceDir;
        const result = await spawnAndWait({
            agentManager: this.opts.agentManager,
            spec: {
                name: `${req.persona}-${this.opts.project}-${req.repoName ?? 'root'}`,
                persona: req.persona,
                project: this.opts.project,
                stage: req.repoName ? `${req.stage}:${req.repoName}` : req.stage,
                prompt: req.userPrompt,
                model,
                cwd,
                projectPrompt: req.projectPrompt,
                permissionMode: 'bypassPermissions',
                disallowedTools: req.disallowedTools
                    ? [...req.disallowedTools]
                    : [...disallowedToolsForPersona(req.persona)],
                allowedTools: req.allowedTools ? [...req.allowedTools] : undefined,
                maxOutputTokens: req.maxOutputTokens,
            },
            isCancelled: this.opts.isCancelled,
            onSpawn: (agentId) => this.opts.onSpawn?.(agentId, req),
            onTruncation: this.opts.onTruncation,
        });
        return {
            output: result.artifact,
            tokenEstimate: (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cacheReadTokens: result.cacheReadTokens,
            cacheWriteTokens: result.cacheWriteTokens,
            costUsd: result.cost,
            model,
        };
    }
}
//# sourceMappingURL=agent-manager-runner.js.map