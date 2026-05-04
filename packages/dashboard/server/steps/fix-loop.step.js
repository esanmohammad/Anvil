/**
 * `fix-loop` — Phase 4f.5 of the dashboard consolidation.
 *
 * Lifts the validation-failure → engineer-fix loop that
 * `pipeline-runner.ts:runFixLoop()` implements, plus the two pure
 * helpers it depends on (`hasValidationFailures`, `extractRepoSection`).
 *
 * Behavior parity with the legacy:
 *   - Single-repo path when `repoNames.length === 0` (uses workspaceDir
 *     as cwd) — spawns one fixer agent.
 *   - Per-repo path otherwise — extracts each repo's section out of the
 *     combined VALIDATE.md artifact, skips repos whose section has no
 *     failure markers, fans the remaining repos out via Promise.all.
 *   - Cross-attempt session resume (P9): on `attempt > 1`, if a prior
 *     agent id exists for the repo (or single path), call
 *     `agentManager.sendInput(priorId, followUp)` instead of spawning a
 *     fresh agent. The map is mutated in place so the next attempt
 *     finds the latest id.
 *   - Disallowed tools = `['Agent']` (engineer + tester rule).
 */
import { spawnAndWait, waitForAgent } from './agent-spawner.js';
import { disallowedToolsForPersona } from './per-repo-stage.step.js';
/**
 * Pure helper: detect validation failures in an artifact. Lifted
 * verbatim from `pipeline-runner.ts:hasValidationFailures()` so the
 * regex set is unchanged.
 */
export function hasValidationFailures(artifact) {
    if (!artifact)
        return false;
    // Explicit markers always win.
    if (/VERDICT:\s*FAIL/i.test(artifact))
        return true;
    if (/\bUNRESOLVED\b/i.test(artifact))
        return true;
    for (const rawLine of artifact.split('\n')) {
        const line = rawLine.trim();
        if (!line)
            continue;
        if (/\bPASS\b/.test(line) && !/\bFAIL\b/.test(line))
            continue;
        if (/\b(?:build|lint|linting|typecheck|type[- ]?check|tests?)\s+(?:failed|failing|errored|broken|has\s+errors?|exits?\s+non-?zero)\b/i.test(line))
            return true;
        if (/(?:^|\s)(?:✗|✖|❌|FAILED:|FAIL:)/.test(line))
            return true;
        if (/\b[1-9]\d*\s+(?:failed|failing)\b/i.test(line))
            return true;
    }
    return false;
}
/**
 * Pure helper: extract the section of a combined VALIDATE.md artifact
 * that belongs to a specific repo. Lifted verbatim from
 * `pipeline-runner.ts:extractRepoSection()`.
 */
export function extractRepoSection(artifact, repoName) {
    const regex = new RegExp(`## ${repoName}[\\s\\S]*?(?=## \\w|$)`, 'i');
    const match = artifact.match(regex);
    if (match)
        return match[0];
    if (artifact.includes(repoName))
        return artifact;
    return '';
}
/**
 * Run one fix-loop attempt. Mutates `priorByRepo` in place; returns the
 * single-mode agent id alongside the artifact + cost so the caller can
 * persist it for the next attempt.
 *
 * Per-repo failures are NOT swallowed here (unlike the per-task build
 * fanout) — a single repo's fix throwing rejects the whole attempt,
 * matching legacy behavior.
 */
export async function runFixLoop(opts) {
    const repos = opts.repoNames;
    if (repos.length === 0) {
        return runFixLoopSingle(opts);
    }
    const promises = repos.map(async (repoName) => {
        const repoPath = opts.repoPaths[repoName] ?? '';
        const repoSection = extractRepoSection(opts.validateArtifact, repoName);
        if (!repoSection || !hasValidationFailures(repoSection)) {
            return {
                artifact: '',
                cost: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
            };
        }
        const issuesBlock = repoSection.slice(0, 4000);
        const priorId = opts.priorByRepo.get(repoName);
        if (priorId && opts.attempt > 1 && opts.agentManager.getAgent(priorId)) {
            const followUp = `Validation still failing in "${repoName}" after your last fix (attempt ${opts.attempt}). Issues:\n\n${issuesBlock}\n\nFix the remaining errors and re-run tests.`;
            opts.agentManager.sendInput(priorId, followUp);
            return waitForAgent({
                agentId: priorId,
                agentManager: opts.agentManager,
                isCancelled: opts.isCancelled,
                onTruncation: opts.onTruncation,
                pollIntervalMs: opts.pollIntervalMs,
                sleep: opts.sleep,
            });
        }
        const prompt = `The validation stage found issues in "${repoName}" that need to be fixed (attempt ${opts.attempt}):\n\n${issuesBlock}\n\nFix ALL build errors, lint errors, and test failures in this repo. Run the build and tests again to verify. Do NOT make git commits.`;
        const result = await spawnAndWait({
            agentManager: opts.agentManager,
            spec: {
                name: `fixer-${repoName}-${opts.attempt}`,
                persona: 'engineer',
                project: opts.project,
                stage: `fix-${opts.attempt}:${repoName}`,
                prompt,
                model: opts.model,
                cwd: repoPath,
                projectPrompt: opts.buildRepoProjectPromptForBuildStage(repoName),
                permissionMode: 'bypassPermissions',
                disallowedTools: disallowedToolsForPersona('engineer'),
                allowedTools: opts.allowedTools,
                maxOutputTokens: opts.maxOutputTokens,
            },
            isCancelled: opts.isCancelled,
            onSpawn: (agentId) => opts.priorByRepo.set(repoName, agentId),
            onTruncation: opts.onTruncation,
            pollIntervalMs: opts.pollIntervalMs,
            sleep: opts.sleep,
        });
        return {
            artifact: result.artifact,
            cost: result.cost,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cacheReadTokens: result.cacheReadTokens,
            cacheWriteTokens: result.cacheWriteTokens,
        };
    });
    const results = await Promise.all(promises);
    const combinedArtifact = results.map((r) => r.artifact).filter(Boolean).join('\n\n');
    const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
    return {
        artifact: combinedArtifact,
        cost: totalCost,
        newSingleId: opts.priorSingleId,
        inputTokens: results.reduce((s, r) => s + r.inputTokens, 0),
        outputTokens: results.reduce((s, r) => s + r.outputTokens, 0),
        cacheReadTokens: results.reduce((s, r) => s + r.cacheReadTokens, 0),
        cacheWriteTokens: results.reduce((s, r) => s + r.cacheWriteTokens, 0),
    };
}
async function runFixLoopSingle(opts) {
    const issuesBlock = opts.validateArtifact.slice(0, 6000);
    if (opts.priorSingleId
        && opts.attempt > 1
        && opts.agentManager.getAgent(opts.priorSingleId)) {
        const followUp = `Validation still failing after your last fix (attempt ${opts.attempt}). Issues:\n\n${issuesBlock}\n\nFix the remaining errors and re-run tests.`;
        opts.agentManager.sendInput(opts.priorSingleId, followUp);
        const result = await waitForAgent({
            agentId: opts.priorSingleId,
            agentManager: opts.agentManager,
            isCancelled: opts.isCancelled,
            onTruncation: opts.onTruncation,
            pollIntervalMs: opts.pollIntervalMs,
            sleep: opts.sleep,
        });
        return {
            artifact: result.artifact,
            cost: result.cost,
            newSingleId: opts.priorSingleId,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cacheReadTokens: result.cacheReadTokens,
            cacheWriteTokens: result.cacheWriteTokens,
        };
    }
    const prompt = `The validation stage found issues that need to be fixed (attempt ${opts.attempt}):\n\n${issuesBlock}\n\nFix ALL build errors, lint errors, and test failures. Run the build and tests again to verify. Do NOT make git commits.`;
    let newSingleId = null;
    const result = await spawnAndWait({
        agentManager: opts.agentManager,
        spec: {
            name: `fixer-${opts.project}-${opts.attempt}`,
            persona: 'engineer',
            project: opts.project,
            stage: `fix-${opts.attempt}`,
            prompt,
            model: opts.model,
            cwd: opts.workspaceDir,
            projectPrompt: opts.buildProjectPromptForBuildStage(),
            permissionMode: 'bypassPermissions',
            disallowedTools: disallowedToolsForPersona('engineer'),
            maxOutputTokens: opts.maxOutputTokens,
        },
        isCancelled: opts.isCancelled,
        onSpawn: (agentId) => { newSingleId = agentId; },
        onTruncation: opts.onTruncation,
        pollIntervalMs: opts.pollIntervalMs,
        sleep: opts.sleep,
    });
    return {
        artifact: result.artifact,
        cost: result.cost,
        newSingleId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
    };
}
/**
 * Step factory for one fix-loop attempt. Phase 4f.7 wires registration
 * once `Pipeline.run()` becomes the orchestrator.
 *
 * Note: the legacy `runFixLoop` is invoked imperatively from within the
 * validate-loop iteration in pipeline-runner. The Step factory shape is
 * exposed for parity testing + future composition; today the production
 * caller goes through `runFixLoop()` directly.
 */
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