/**
 * Quick-action spawner (Phase 3 round-3 extraction from
 * `dashboard-server.ts`).
 *
 * `createQuickActionSpawner(deps)` returns the `spawnQuickAction`
 * closure used by `run-fix` / `run-review` / `run-spike`. The body is
 * verbatim from the legacy closure; closure-resident state
 * (`activeRuns`, `agentToRunId`, `outputBuffer`) is passed through
 * `deps` so the dashboard-server keeps owning the canonical refs.
 *
 * `outputBuffer` is interesting: spawnQuickAction does
 * `outputBuffer = []` (reassignment, not mutation). Reassigning the
 * outer `let` variable invalidates references held by
 * `attachAgentEventRouter`. The legacy behavior is preserved — call
 * `deps.resetOutputBuffer()` from inside the factory to keep
 * dashboard-server's local binding in control.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { disallowedToolsForPersona, } from '@esankhan3/anvil-core-pipeline';
import { allowedToolsForStage, resolveModelForStage as registryResolveStage, ModelResolutionError, UnknownStageError, } from '@esankhan3/anvil-core-pipeline';
import { runFixFlow } from '../fix-flow.js';
export function createQuickActionSpawner(deps) {
    return function spawnQuickAction(actionType, project, description, model) {
        deps.resetOutputBuffer();
        // Resolve workspace: prefer factory.yaml config, then env var, then default
        let cwd;
        const configWorkspace = deps.getWorkspaceFromConfig(project);
        if (configWorkspace && existsSync(configWorkspace)) {
            cwd = configWorkspace;
        }
        else {
            const wsRoot = process.env.ANVIL_WORKSPACE_ROOT
                || process.env.FF_WORKSPACE_ROOT
                || join(homedir(), 'workspace');
            cwd = join(wsRoot, project);
        }
        const actionLabel = actionType.replace('run-', '');
        const runId = `${actionLabel}-${Date.now().toString(36)}`;
        // Load knowledge graph — prefer index + query-matched context.
        let kbReport = '';
        const indexPrompt = deps.kbManager.getIndexForPrompt(project);
        if (indexPrompt) {
            const queryContext = deps.kbManager.getQueryContextForPrompt(project, description);
            kbReport = `${indexPrompt}\n\n---\n\n${queryContext}`;
        }
        else {
            kbReport = deps.kbManager.getAllGraphReports(project);
        }
        if (kbReport) {
            const kbEntry = {
                timestamp: Date.now(),
                stage: actionLabel,
                type: 'stdout',
                content: `📚 [knowledge-base] Knowledge Base loaded for "${project}" (${kbReport.length} chars, ${indexPrompt ? 'index + query-matched' : 'full blob'}) → injecting into ${actionLabel} agent`,
                kind: 'project',
            };
            deps.pushOutputEntry(kbEntry);
            deps.services.agents.emit('agent.output', { entries: [kbEntry], runId });
        }
        else {
            const kbEntry = {
                timestamp: Date.now(),
                stage: actionLabel,
                type: 'stderr',
                content: `📚 [knowledge-base] No Knowledge Base available for "${project}" — ${actionLabel} agent will explore codebase manually`,
                kind: 'project',
            };
            deps.pushOutputEntry(kbEntry);
            deps.services.agents.emit('agent.output', { entries: [kbEntry], runId });
        }
        const wsEntry = {
            timestamp: Date.now(),
            stage: actionLabel,
            type: 'stdout',
            content: `🔌 [project-context] Using workspace at ${cwd} for ${actionLabel} agent`,
            kind: 'project',
        };
        deps.pushOutputEntry(wsEntry);
        deps.services.agents.emit('agent.output', { entries: [wsEntry], runId });
        const repoInfo = deps.projectLoader.getRepoLocalPaths(project);
        const repoNames = Object.keys(repoInfo);
        const repoPaths = Object.entries(repoInfo).map(([name, path]) => `- ${name}: ${path}`).join('\n');
        const projectPromptParts = [
            `You are a senior engineer working on the "${project}" project.`,
            `\n## Project Repos\nThis project has ${repoNames.length} repositories. ONLY work within these:\n${repoPaths}\n\nDo NOT explore or read files outside these directories. Ignore all other directories in the workspace.`,
        ];
        if (kbReport) {
            projectPromptParts.push(`\n## Codebase Knowledge Base\n`
                + `CRITICAL — KNOWLEDGE BASE AVAILABLE (${kbReport.length} chars):\n`
                + `The following is a pre-computed Knowledge Base for the "${project}" project. It contains:\n`
                + `1. **Project-level synthesis** (if available): Cross-repo dependencies, shared concepts, and architecture overview.\n`
                + `2. **Per-repo analysis**: AST-extracted modules, functions, imports, call graphs, and community clusters.\n\n`
                + `**MANDATORY rules when Knowledge Base is present:**\n`
                + `- Do NOT spawn sub-agents to explore the codebase. You already have the full architectural map.\n`
                + `- Do NOT run find, ls, tree commands to discover file structure. The KB already maps it.\n`
                + `- START your analysis by citing KB findings: "From the Knowledge Base, module X in repo Y handles Z..."\n`
                + `- ONLY read specific source files when you need exact implementation details (function bodies, config values) not in the KB.\n`
                + `- When you do read a file, explain why: "The KB shows module X exists but I need the exact retry logic..."\n\n`
                + `${kbReport}`);
        }
        const projectMemory = deps.memoryStore.formatForPrompt(project, 'memory');
        const userProfile = deps.memoryStore.formatForPrompt(project, 'user');
        if (projectMemory || userProfile) {
            projectPromptParts.push(`\n## Memories\n${[projectMemory, userProfile].filter(Boolean).join('\n\n')}`);
        }
        const projectPrompt = projectPromptParts.join('\n');
        const kbInstructions = kbReport ? `
CRITICAL — KNOWLEDGE BASE AVAILABLE:
Your project prompt contains a comprehensive Knowledge Base (${kbReport.length} chars) with the full architectural map of the "${project}" project — modules, functions, imports, call graphs, cross-repo dependencies, and community clusters.

**You MUST follow these rules:**
1. Do NOT spawn sub-agents to explore the codebase. You already have the architectural map.
2. Do NOT run find, ls, tree, or grep commands to discover files. The KB already tells you what exists and where.
3. START your analysis by citing what the KB reveals about the relevant modules. For example: "From the Knowledge Base, the module X in repo Y handles Z via function W..."
4. ONLY read a specific source file when you need exact implementation details (specific function body, config values, error handling logic) that the KB summary doesn't cover.
5. When you do read a file, explain WHY the KB wasn't sufficient: "The KB shows module X exists but I need to check the exact retry logic in line N..."

` : '';
        const promptMap = {
            'run-fix': `Fix the following issue:\n\n${description}\n${kbInstructions}\nFollow these steps in order:\n1. ${kbReport ? 'Review the Knowledge Base in your project prompt to identify affected modules and dependencies\n2. ' : ''}Find the root cause of the issue\n${kbReport ? '3' : '2'}. Implement the fix\n${kbReport ? '4' : '3'}. Run tests to verify the fix works and nothing is broken\n${kbReport ? '5' : '4'}. Create a feature branch: git checkout -b anvil/fix-${Date.now().toString(36)}\n${kbReport ? '6' : '5'}. Stage and commit all changes with a clear message: git add -A && git commit -m "[anvil-fix] ${description.slice(0, 80).replace(/"/g, '\\"')}"\n${kbReport ? '7' : '6'}. Push the branch: git push -u origin HEAD\n${kbReport ? '8' : '7'}. Create a Pull Request: gh pr create --title "[anvil-fix] ${description.slice(0, 60).replace(/"/g, '\\"')}" --body "## Fix\\n${description.replace(/"/g, '\\"').replace(/\n/g, '\\n')}\\n\\n---\\n_Auto-generated by Anvil_"\n\nIMPORTANT: Do NOT merge the PR. Only create it. If tests fail, fix them before creating the PR.`,
            'run-spike': `Research the following:\n\n${description}\n${kbInstructions}\n${kbReport ? `IMPORTANT — Your project prompt contains a Knowledge Base with the full map of this project. Follow this exact workflow:

1. FIRST: Analyze the Knowledge Base to identify which repos, modules, and functions are relevant to "${description}". Write a section called "Analysis from Knowledge Base" citing specific findings.
2. SECOND: Based on KB findings, read ONLY the specific files you need for implementation details. Typically 3-8 files max. Do NOT scan entire directories or run find/grep across the workspace.
3. THIRD: Synthesize your findings with code examples from the files you read.

You have ${repoNames.length} repos: ${repoNames.join(', ')}. Stay within these directories only.\n\n` : ''}This is read-only research — do NOT modify any files.`,
        };
        const spikePersona = actionType === 'run-spike' ? 'analyst' : 'engineer';
        const stageMap = {
            'run-fix': 'fix',
            'run-review': 'review',
            'run-spike': 'research',
        };
        const stageId = stageMap[actionType];
        // Resolution precedence (matches pipeline-runner):
        //   1. Caller-supplied model (UI dropdown override).
        //   2. Registry-driven resolver from @esankhan3/anvil-core-pipeline.
        //   3. Hardcoded fallback (sonnet) — last resort.
        const resolvedModel = (() => {
            if (model)
                return model;
            try {
                return registryResolveStage(stageId).primary;
            }
            catch (err) {
                if (err instanceof UnknownStageError || err instanceof ModelResolutionError) {
                    console.warn(`[quick-action] resolver: ${err.message}; falling back to sonnet`);
                }
                else {
                    console.warn(`[quick-action] resolver crashed:`, err);
                }
                return 'sonnet';
            }
        })();
        if (actionType === 'run-fix') {
            // Multi-stage Fix flow: fix → validate → fix-loop (with attempt cap).
            const initialStages = [
                { name: 'fix', status: 'pending' },
                { name: 'validate', status: 'pending' },
                { name: 'fix-loop', status: 'pending' },
            ];
            deps.activeRuns.set(runId, {
                id: runId,
                type: 'fix',
                project,
                description,
                model: resolvedModel,
                status: 'running',
                startedAt: Date.now(),
                activities: [],
                prUrls: new Set(),
                stages: initialStages,
                totalCost: 0,
            });
            deps.broadcastActiveRuns();
            const stageStarted = {};
            const onStage = (event) => {
                const run = deps.activeRuns.get(runId);
                if (!run || !run.stages)
                    return;
                const stage = run.stages.find((s) => s.name === event.name);
                if (!stage)
                    return;
                if (event.status === 'running') {
                    stage.status = 'running';
                    stage.startedAt = event.startedAt ?? new Date().toISOString();
                    stage.attempt = event.attempt;
                    stageStarted[event.name] = stage.startedAt;
                }
                else {
                    stage.status = event.status;
                    stage.completedAt = event.completedAt ?? new Date().toISOString();
                    stage.error = event.error;
                    if (event.cost) {
                        stage.cost = (stage.cost ?? 0) + event.cost;
                        run.totalCost = (run.totalCost ?? 0) + event.cost;
                    }
                }
                deps.broadcastActiveRuns();
            };
            runFixFlow({
                agentManager: deps.agentManager,
                project,
                description,
                model: resolvedModel,
                workspaceDir: cwd,
                repoNames,
                repoPaths: repoInfo,
                buildProjectPrompt: () => projectPrompt,
                buildRepoProjectPrompt: () => projectPrompt,
                isCancelled: () => deps.activeRuns.get(runId)?.status !== 'running',
                allowedToolsForStage: (s) => allowedToolsForStage(s),
                onStage,
                onSpawn: (stage, _repo, agentId) => {
                    deps.agentToRunId.set(agentId, runId);
                    deps.services.agents.emit('agent.spawned', { id: agentId, runId, stage });
                },
            })
                .then((result) => {
                const run = deps.activeRuns.get(runId);
                if (!run)
                    return;
                run.status = result.resolved ? 'completed' : 'failed';
                run.completedAt = Date.now();
                if (!result.resolved) {
                    run.error = `validation still failing after ${result.attempts} attempts`;
                }
                deps.broadcastActiveRuns();
            })
                .catch((err) => {
                const run = deps.activeRuns.get(runId);
                if (!run)
                    return;
                run.status = 'failed';
                run.completedAt = Date.now();
                run.error = err instanceof Error ? err.message : String(err);
                deps.broadcastActiveRuns();
                console.warn(`[run-fix] flow failed for ${runId}:`, err);
            });
            return;
        }
        // Legacy single-agent path for spike / review.
        const agent = deps.agentManager.spawn({
            name: `${actionType.replace('run-', '')}-${project}`,
            persona: spikePersona,
            project,
            stage: stageId,
            prompt: promptMap[actionType] ?? description,
            projectPrompt,
            model: resolvedModel,
            cwd,
            permissionMode: 'bypassPermissions',
            disallowedTools: disallowedToolsForPersona(spikePersona),
            allowedTools: allowedToolsForStage(stageId),
        });
        const runType = actionLabel;
        deps.activeRuns.set(runId, {
            id: runId,
            type: runType,
            project,
            description,
            model: resolvedModel,
            status: 'running',
            startedAt: Date.now(),
            agentId: agent.id,
            activities: [],
            prUrls: new Set(),
        });
        deps.agentToRunId.set(agent.id, runId);
        deps.broadcastActiveRuns();
        deps.services.agents.emit('agent.spawned', { ...agent, runId });
    };
}
//# sourceMappingURL=quick-action.js.map