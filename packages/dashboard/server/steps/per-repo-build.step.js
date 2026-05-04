/**
 * `per-repo-build` — Phase 4f.3 of the dashboard consolidation.
 *
 * Lifts the build-stage-specific per-repo + per-task fanout that
 * `pipeline-runner.ts:runBuildForRepo()` implements:
 *
 *   - Parse `TASKS.md` via `parseTasks()` and group via
 *     `groupTasksForExecution()` (P5 — task batches with stable system
 *     prompt for prompt-cache hits across spawns).
 *   - Run each group serially; within a group, fan tasks out in parallel.
 *   - Per-task spawns disable Read/Grep/Glob/Agent — every file the engineer
 *     needs is pre-bundled into the per-task user prompt.
 *   - Fallback path when TASKS.md isn't parseable: single repo-wide spawn
 *     with the same Read/Grep/Glob/Agent lockdown.
 *   - Combine task artifacts in original task order with the legacy
 *     `\n\n---\n\n` separator.
 *
 * As with Phase 4f.2, `pipeline-runner.runBuildForRepo` keeps owning the
 * dashboard state mutations and project-event emission today; this module
 * only owns the spawn-orchestration shape so 4f.7 can register the Step
 * once `Pipeline.run()` becomes the orchestrator.
 */
import { spawnAndWait } from './agent-spawner.js';
import { parseTasks, groupTasksForExecution } from '../engineer-task-bundler.js';
/**
 * Per-task disallowedTools rule. Differs from the general
 * `disallowedToolsForPersona('engineer')` (which only disables `Agent`):
 * during build, every file the engineer needs is pre-bundled into the
 * user prompt, so Read/Grep/Glob are also disabled to force the model to
 * use what's been provided. Mirrors `pipeline-runner.ts:1847,1890`.
 */
export const BUILD_DISALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Agent'];
/**
 * Combine per-task artifacts in the original task order. Mirrors
 * `pipeline-runner.ts:1925-1928` verbatim.
 */
export function combineTaskArtifacts(tasks, taskOutputs) {
    const idOrder = new Map(tasks.map((t, i) => [t.id, i]));
    const sorted = [...taskOutputs].sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));
    return sorted.map((t) => t.artifact.trim()).join('\n\n---\n\n');
}
/**
 * Format a per-task failure as a placeholder artifact so the combined
 * output documents what didn't land. Mirrors `pipeline-runner.ts:1909-1913`.
 */
function unresolvedArtifact(task, message) {
    return `## Implementation: ${task.id} — ${task.title}\n\nUNRESOLVED: ${message}\n`;
}
/**
 * Run the build stage for one repo. Falls back to a single repo-wide
 * spawn when TASKS.md isn't parseable.
 *
 * Per-task failures are swallowed into the artifact as `UNRESOLVED:`
 * placeholders (same as legacy) so a single bad task doesn't kill the
 * whole repo's build. The fallback path is NOT failure-tolerant —
 * agent rejections propagate so the caller can mark the repo failed.
 */
export async function runBuildForOneRepo(opts) {
    const tasks = opts.tasksMarkdown ? parseTasks(opts.tasksMarkdown) : [];
    if (tasks.length === 0) {
        return runBuildFallback(opts);
    }
    const groups = groupTasksForExecution(tasks);
    opts.onProjectEvent?.('info', `[build] ${opts.repoName}: ${tasks.length} task${tasks.length === 1 ? '' : 's'} in ${groups.length} group${groups.length === 1 ? '' : 's'} (per-task spawning)`);
    const taskOutputs = [];
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    for (const group of groups) {
        if (opts.isCancelled()) {
            throw new Error('Pipeline cancelled');
        }
        const groupPromises = group.tasks.map(async (task) => {
            try {
                const prompt = opts.buildPerTaskPrompt(task);
                const result = await spawnAndWait({
                    agentManager: opts.agentManager,
                    spec: {
                        name: `engineer-${opts.repoName}-${task.id}`,
                        persona: opts.persona,
                        project: opts.project,
                        stage: `${opts.stageName}:${opts.repoName}:${task.id}`,
                        prompt,
                        model: opts.model,
                        cwd: opts.repoPath,
                        projectPrompt: opts.projectPrompt,
                        permissionMode: 'bypassPermissions',
                        disallowedTools: [...BUILD_DISALLOWED_TOOLS],
                        allowedTools: opts.allowedTools,
                        maxOutputTokens: opts.maxOutputTokens,
                    },
                    isCancelled: opts.isCancelled,
                    onSpawn: opts.onAgentSpawned,
                    onTruncation: opts.onTruncation,
                    pollIntervalMs: opts.pollIntervalMs,
                    sleep: opts.sleep,
                });
                totalCost += result.cost;
                totalInputTokens += result.inputTokens;
                totalOutputTokens += result.outputTokens;
                totalCacheReadTokens += result.cacheReadTokens;
                totalCacheWriteTokens += result.cacheWriteTokens;
                taskOutputs.push({ id: task.id, title: task.title, artifact: result.artifact });
                opts.onProjectEvent?.('info', `[build] ${opts.repoName} ${task.id} done (${(result.cost * 100).toFixed(2)}¢)`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                taskOutputs.push({
                    id: task.id,
                    title: task.title,
                    artifact: unresolvedArtifact(task, msg),
                });
                opts.onProjectEvent?.('warn', `[build] ${opts.repoName} ${task.id} failed: ${msg}`);
            }
        });
        await Promise.all(groupPromises);
    }
    const combined = combineTaskArtifacts(tasks, taskOutputs);
    return {
        artifact: combined,
        cost: totalCost,
        taskCount: tasks.length,
        fallback: false,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadTokens: totalCacheReadTokens,
        cacheWriteTokens: totalCacheWriteTokens,
    };
}
async function runBuildFallback(opts) {
    const result = await spawnAndWait({
        agentManager: opts.agentManager,
        spec: {
            name: `${opts.persona}-${opts.repoName}`,
            persona: opts.persona,
            project: opts.project,
            stage: `${opts.stageName}:${opts.repoName}`,
            prompt: opts.buildFallbackPrompt(),
            model: opts.model,
            cwd: opts.repoPath,
            projectPrompt: opts.projectPrompt,
            permissionMode: 'bypassPermissions',
            disallowedTools: [...BUILD_DISALLOWED_TOOLS],
            allowedTools: opts.allowedTools,
            maxOutputTokens: opts.maxOutputTokens,
        },
        isCancelled: opts.isCancelled,
        onSpawn: opts.onAgentSpawned,
        onTruncation: opts.onTruncation,
        pollIntervalMs: opts.pollIntervalMs,
        sleep: opts.sleep,
    });
    return {
        artifact: result.artifact,
        cost: result.cost,
        taskCount: 0,
        fallback: true,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
    };
}
/**
 * Step factory for the per-repo build. Declares `parallelism: 'per-repo'`
 * so the Pipeline walker (Phase 4a) fans `run()` across `ctx.repoPaths`
 * keys. Each invocation handles one repo and returns its combined
 * artifact + total cost; the walker aggregates into a
 * `Record<string, RunBuildForRepoResult>`.
 *
 * NOT auto-registered in `buildDashboardStepRegistry` — Phase 4f.7 wires
 * registration once `Pipeline.run()` becomes the orchestrator.
 */
export function createPerRepoBuildStep(opts) {
    const id = opts.id ?? `per-repo-build:${opts.stageName}`;
    return {
        id,
        name: `Per-repo build (${opts.stageName})`,
        parallelism: 'per-repo',
        async run(ctx) {
            const repoName = ctx.repoName;
            if (!repoName) {
                throw new Error(`[${id}] requires ctx.repoName — did the walker forget to fan out?`);
            }
            const repoPath = ctx.repoPaths?.[repoName];
            if (!repoPath) {
                throw new Error(`[${id}] no repoPath registered for "${repoName}"`);
            }
            const isCancelled = opts.isCancelled
                ? () => opts.isCancelled(ctx)
                : () => ctx.signal.aborted;
            const result = await runBuildForOneRepo({
                agentManager: opts.agentManager,
                project: opts.project,
                stageName: opts.stageName,
                persona: opts.persona,
                model: opts.model,
                maxOutputTokens: opts.maxOutputTokens,
                repoName,
                repoPath,
                projectPrompt: opts.buildProjectPrompt(repoName),
                tasksMarkdown: opts.loadTasksMarkdown(repoName),
                buildPerTaskPrompt: (task) => opts.buildPerTaskPrompt(repoName, repoPath, task),
                buildFallbackPrompt: () => opts.buildFallbackPrompt(repoName, repoPath),
                isCancelled,
                onAgentSpawned: opts.onAgentSpawned
                    ? (agentId) => opts.onAgentSpawned(repoName, agentId)
                    : undefined,
                onTruncation: opts.onTruncation,
                onProjectEvent: opts.onProjectEvent
                    ? (level, message) => opts.onProjectEvent(repoName, level, message)
                    : undefined,
                pollIntervalMs: opts.pollIntervalMs,
                sleep: opts.sleep,
            });
            opts.writeRepoArtifact?.(repoName, result.artifact);
            return result;
        },
    };
}
//# sourceMappingURL=per-repo-build.step.js.map