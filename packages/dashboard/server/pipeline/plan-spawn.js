/**
 * Plan-agent spawn cluster (Phase 3 round-3 extraction from
 * `dashboard-server.ts`).
 *
 * `createPlanSpawn(deps)` returns the bundle:
 *   - `spawnPlanAgent`           — fresh full-plan generation
 *   - `spawnOnePlanVariant`      — one variant of an A/B batch
 *   - `spawnPlanVariants`        — fan out N variants with stagger
 *   - `spawnPlanSectionRegen`    — re-generate a single section
 *   - `retryPlanAgentWithNextModel` — chain-walk to the next model
 *   - `finalizePlanAgent`        — parse + persist + lifecycle
 *   - `planAgentContext`         — Map exposed for the agent-event router
 *
 * Encapsulated state:
 *   - `planAgentContext: Map<agentId, …>` (owned here; the agent-event
 *     router reads/deletes via the exposed reference).
 *
 * All closure deps (agentManager, activeRuns, agentToRunId, services,
 * broadcasts, lifecycle handle, stores, model resolver, workspace
 * getter, KB manager, memory store, outputBuffer reset) come in via
 * the `deps` bag.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { disallowedToolsForPersona } from '@esankhan3/anvil-core-pipeline';
import { extractJsonBlock, isValidParsedShape, buildJsonCorrectionInput, } from './json-extract.js';
// Tunables — same defaults the legacy closure carried.
const PLAN_AGENT_MAX_ATTEMPTS = 6; // cheap (2) → premium (3) → local (1)
const PLAN_AGENT_SAME_AGENT_RETRIES = 2;
// Stagger between variant spawns to dodge Anthropic burst limits.
const VARIANT_SPAWN_STAGGER_MS = 6000;
export function createPlanSpawn(deps) {
    const planAgentContext = new Map();
    // ── Pure helpers (closure-only; no deps) ─────────────────────────
    async function pickNextPlanModel(currentModel, burned) {
        try {
            const { loadModelRegistry } = await import('@esankhan3/anvil-agent-core');
            const registry = loadModelRegistry({});
            const current = registry.models.find((m) => m.id === currentModel);
            if (!current)
                return null;
            const isChatCandidate = (m) => m.id !== currentModel
                && !burned.has(m.id)
                && !m.consumed_by
                && (m.capabilities?.includes('code') || m.capabilities?.includes('reasoning'));
            const tierOrder = current.tier === 'cheap'
                ? ['cheap', 'premium', 'local']
                : current.tier === 'premium'
                    ? ['premium', 'cheap', 'local']
                    : [current.tier, 'cheap', 'premium', 'local'];
            for (const tier of tierOrder) {
                const inTier = registry.models.filter((m) => m.tier === tier && isChatCandidate(m));
                if (inTier[0])
                    return inTier[0].id;
            }
            return null;
        }
        catch {
            return null;
        }
    }
    function buildPlanPrompt(project, feature, repoNames, kbReport, mode, existingPlan) {
        const schema = `{
  "title": "string — short title (<80 chars)",
  "problem": "string — plain English problem statement",
  "scope": { "inScope": ["string"], "outOfScope": ["string"] },
  "repos": [
    {
      "name": "string — must match a project repo",
      "changes": "string — concise description of changes in this repo",
      "files": ["string — path relative to repo root; use new ones freely"],
      "symbols": ["string — function/class/type names modified or added"]
    }
  ],
  "contracts": [
    {
      "kind": "http | grpc | kafka | db | other",
      "name": "string",
      "producer": "string — repo name",
      "consumers": ["string — repo names"],
      "description": "string"
    }
  ],
  "architecture": { "mermaid": "string — optional mermaid diagram body", "notes": "string" },
  "risks": [ { "title": "string", "mitigation": "string", "severity": "low | med | high" } ],
  "rollout": {
    "strategy": "string",
    "flags": ["string"],
    "order": ["string — repos in deploy order"],
    "rollback": "string"
  },
  "tests": { "unit": ["string"], "integration": ["string"], "manual": ["string"] },
  "estimate": { "usd": 0.0, "minutes": 0, "prs": 0 }
}`;
        const rules = [
            `You are a senior staff engineer producing an implementation plan for the "${project}" project.`,
            `Project repos (you MUST only reference these): ${repoNames.join(', ') || '(none configured)'}.`,
            kbReport ? 'The Knowledge Base in your project prompt lists every existing module, function and import. Ground file paths and symbol names in the KB. Only invent names for NEW symbols you will create.' : 'No Knowledge Base is available; use plain engineering judgement.',
            'Be specific. Prefer concrete file paths and function names over vague descriptions.',
            'Keep estimates realistic: count repos touched × typical stage cost. Default model: $5/run, $10 for multi-repo changes.',
            'Do NOT modify any files. This is planning only.',
        ].filter(Boolean).join('\n');
        const outputContract = `## OUTPUT CONTRACT (read first, obey strictly)

Your ENTIRE response MUST be a single fenced \`\`\`json ... \`\`\` block. No prose
before it. No prose after it. No commentary inside. No additional fences.
If you cannot fully satisfy the schema, emit your best-effort JSON anyway —
the server validates and asks for fixes; prose is rejected.`;
        if (mode === 'full') {
            return `${outputContract}

${rules}

## Feature to plan

${feature}

## Schema

The JSON object must match this schema:

\`\`\`json
${schema}
\`\`\`

## Reminder

Reply with ONLY a fenced \`\`\`json ... \`\`\` block. No prose. No markdown. All
string fields must be non-empty where the schema has no "optional" qualifier.`;
        }
        // Section regen
        const planJson = existingPlan ? JSON.stringify(existingPlan, null, 2) : '{}';
        return `${outputContract}

${rules}

## Existing plan (regenerate one section only)

\`\`\`json
${planJson}
\`\`\`

## Task

Regenerate the **"${mode}"** section of the plan based on the existing context and any new information you gather.

## Reminder

Reply with ONLY a fenced \`\`\`json ... \`\`\` block containing the updated section value (matching that section's schema — an object for scope/architecture/rollout/tests/estimate, an array for repos/contracts/risks, or a string for problem). No prose.`;
    }
    // ── Spawners ─────────────────────────────────────────────────────
    function resolveCwd(project) {
        const configWorkspace = deps.getWorkspaceFromConfig(project);
        if (configWorkspace && existsSync(configWorkspace))
            return configWorkspace;
        return join(process.env.ANVIL_WORKSPACE_ROOT
            || process.env.FF_WORKSPACE_ROOT
            || join(homedir(), 'workspace'), project);
    }
    function loadKbReport(project, query) {
        const indexPrompt = deps.kbManager.getIndexForPrompt(project);
        if (indexPrompt) {
            const queryContext = deps.kbManager.getQueryContextForPrompt(project, query);
            return `${indexPrompt}\n\n---\n\n${queryContext}`;
        }
        return deps.kbManager.getAllGraphReports(project);
    }
    function spawnPlanAgent(project, feature, modelId, retryState) {
        if (!retryState)
            deps.resetOutputBuffer();
        const cwd = resolveCwd(project);
        const runId = `plan-${Date.now().toString(36)}`;
        const model = deps.resolvePlanStageModel(modelId);
        const kbReport = loadKbReport(project, feature);
        const repoInfo = deps.projectLoader.getRepoLocalPaths(project);
        const repoNames = Object.keys(repoInfo);
        const repoPaths = Object.entries(repoInfo).map(([n, p]) => `- ${n}: ${p}`).join('\n');
        const projectPromptParts = [
            `You are a senior engineer planning work in the "${project}" project.`,
            `\n## Project Repos\nThis project has ${repoNames.length} repositories. You may reference these and only these:\n${repoPaths}`,
        ];
        if (kbReport) {
            projectPromptParts.push(`\n## Codebase Knowledge Base\n${kbReport}\n\n`
                + `**Rules when KB is present:** do NOT spawn sub-agents. Do NOT run find/ls/tree. Cite the KB by name when choosing files and symbols.`);
        }
        const projectMemory = deps.memoryStore.formatForPrompt(project, 'memory');
        const userProfile = deps.memoryStore.formatForPrompt(project, 'user');
        if (projectMemory || userProfile) {
            projectPromptParts.push(`\n## Memories\n${[projectMemory, userProfile].filter(Boolean).join('\n\n')}`);
        }
        const projectPrompt = projectPromptParts.join('\n');
        const prompt = buildPlanPrompt(project, feature, repoNames, kbReport, 'full');
        const agent = deps.agentManager.spawn({
            name: `plan-${project}`,
            persona: 'architect',
            project,
            stage: 'plan',
            prompt,
            projectPrompt,
            model,
            cwd,
            permissionMode: 'bypassPermissions',
            disallowedTools: disallowedToolsForPersona('architect'),
        });
        planAgentContext.set(agent.id, {
            project,
            feature,
            model,
            burned: retryState?.burned ?? new Set(),
            attemptsRemaining: retryState?.attemptsRemaining ?? PLAN_AGENT_MAX_ATTEMPTS,
            sameAgentRetriesRemaining: PLAN_AGENT_SAME_AGENT_RETRIES,
        });
        deps.activeRuns.set(runId, {
            id: runId,
            type: 'plan',
            project,
            description: feature,
            model,
            status: 'running',
            startedAt: Date.now(),
            agentId: agent.id,
            activities: [],
            prUrls: new Set(),
        });
        deps.agentToRunId.set(agent.id, runId);
        deps.broadcastActiveRuns();
        deps.services.agents.emit('agent.spawned', { ...agent, runId });
    }
    function spawnOnePlanVariant(project, feature, variant, batchId, index, model, retryState) {
        const cwd = resolveCwd(project);
        const kbReport = loadKbReport(project, feature);
        const repoInfo = deps.projectLoader.getRepoLocalPaths(project);
        const repoNames = Object.keys(repoInfo);
        const repoPaths = Object.entries(repoInfo).map(([n, p]) => `- ${n}: ${p}`).join('\n');
        const variantHint = variant.prompt
            ? `This variant is approach "${variant.label}". ${variant.prompt}`
            : `This variant is approach "${variant.label}". Bias your plan toward that approach (${variant.label.toLowerCase()} — e.g. smallest change, cleanest refactor, or a greenfield rewrite).`;
        const projectPromptParts = [
            `You are a senior engineer planning work in the "${project}" project.`,
            `\n## Variant\n${variantHint}`,
            `\n## Project Repos\n${repoNames.length} repositories:\n${repoPaths}`,
        ];
        if (kbReport) {
            projectPromptParts.push(`\n## Codebase Knowledge Base\n${kbReport}`);
        }
        const projectMemory = deps.memoryStore.formatForPrompt(project, 'memory');
        const userProfile = deps.memoryStore.formatForPrompt(project, 'user');
        if (projectMemory || userProfile) {
            projectPromptParts.push(`\n## Memories\n${[projectMemory, userProfile].filter(Boolean).join('\n\n')}`);
        }
        const projectPrompt = projectPromptParts.join('\n');
        const prompt = buildPlanPrompt(project, feature, repoNames, kbReport, 'full');
        const agent = deps.agentManager.spawn({
            name: `plan-variant-${variant.label}-${project}`,
            persona: 'architect',
            project,
            stage: `plan-variant:${variant.label}`,
            prompt,
            projectPrompt,
            model,
            cwd,
            permissionMode: 'bypassPermissions',
            disallowedTools: disallowedToolsForPersona('architect'),
        });
        planAgentContext.set(agent.id, {
            project,
            feature,
            model,
            variant: { batchId, index, label: variant.label },
            variantPrompt: variant.prompt,
            burned: retryState?.burned ?? new Set(),
            attemptsRemaining: retryState?.attemptsRemaining ?? PLAN_AGENT_MAX_ATTEMPTS,
            sameAgentRetriesRemaining: PLAN_AGENT_SAME_AGENT_RETRIES,
        });
        const runId = `plan-var-${batchId}-${index}`;
        deps.activeRuns.set(runId, {
            id: runId,
            type: 'plan',
            project,
            description: `[variant:${variant.label}] ${feature}`,
            model,
            status: 'running',
            startedAt: Date.now(),
            agentId: agent.id,
            activities: [],
            prUrls: new Set(),
        });
        deps.agentToRunId.set(agent.id, runId);
        deps.services.agents.emit('agent.spawned', {
            ...agent,
            runId,
            variant: { batchId, index, label: variant.label },
        });
    }
    function spawnPlanVariants(project, feature, variants, modelId) {
        const model = deps.resolvePlanStageModel(modelId);
        const batchId = `variants-${Date.now().toString(36)}`;
        deps.services.plans.emit('plan.variants-started', {
            project,
            feature,
            batchId,
            variants: variants.map((v, i) => ({ index: i, label: v.label })),
        });
        variants.forEach((variant, index) => {
            const fire = () => spawnOnePlanVariant(project, feature, variant, batchId, index, model);
            if (index === 0) {
                fire();
            }
            else {
                setTimeout(fire, index * VARIANT_SPAWN_STAGGER_MS);
            }
        });
        deps.broadcastActiveRuns();
    }
    function spawnPlanSectionRegen(existingPlan, section, modelId, retryState, fixPrompt) {
        const cwd = resolveCwd(existingPlan.project);
        const runId = `plan-${section}-${Date.now().toString(36)}`;
        const model = deps.resolvePlanStageModel(modelId ?? existingPlan.model);
        let kbReport = '';
        const indexPrompt = deps.kbManager.getIndexForPrompt(existingPlan.project);
        if (indexPrompt) {
            const queryContext = deps.kbManager.getQueryContextForPrompt(existingPlan.project, existingPlan.feature);
            kbReport = `${indexPrompt}\n\n---\n\n${queryContext}`;
        }
        const repoInfo = deps.projectLoader.getRepoLocalPaths(existingPlan.project);
        const repoNames = Object.keys(repoInfo);
        const projectPrompt = `You are a senior engineer iterating on an existing plan for "${existingPlan.project}".\n\n## Repos\n${repoNames.map((n) => `- ${n}`).join('\n')}\n\n${kbReport ? `## Knowledge Base\n${kbReport}\n` : ''}`;
        const basePrompt = buildPlanPrompt(existingPlan.project, existingPlan.feature, repoNames, kbReport, section, existingPlan);
        const prompt = fixPrompt
            ? `${basePrompt}\n\n## Auto-refine corrections\n${fixPrompt}\n\nApply the above corrections; keep every other field of the "${section}" section unchanged.`
            : basePrompt;
        const agent = deps.agentManager.spawn({
            name: `plan-${section}-${existingPlan.project}`,
            persona: 'architect',
            project: existingPlan.project,
            stage: `plan-${section}`,
            prompt,
            projectPrompt,
            model,
            cwd,
            permissionMode: 'bypassPermissions',
            disallowedTools: disallowedToolsForPersona('architect'),
        });
        planAgentContext.set(agent.id, {
            project: existingPlan.project,
            feature: existingPlan.feature,
            model,
            existingSlug: existingPlan.slug,
            section,
            burned: retryState?.burned ?? new Set(),
            attemptsRemaining: retryState?.attemptsRemaining ?? PLAN_AGENT_MAX_ATTEMPTS,
            sameAgentRetriesRemaining: PLAN_AGENT_SAME_AGENT_RETRIES,
        });
        deps.activeRuns.set(runId, {
            id: runId,
            type: 'plan',
            project: existingPlan.project,
            description: `Regenerate ${section} — ${existingPlan.title}`,
            model,
            status: 'running',
            startedAt: Date.now(),
            agentId: agent.id,
            activities: [],
            prUrls: new Set(),
        });
        deps.agentToRunId.set(agent.id, runId);
        deps.broadcastActiveRuns();
        deps.services.agents.emit('agent.spawned', { ...agent, runId });
    }
    async function retryPlanAgentWithNextModel(ctx, reason) {
        if (ctx.attemptsRemaining <= 0)
            return false;
        const nextModel = await pickNextPlanModel(ctx.model, ctx.burned);
        if (!nextModel)
            return false;
        const retryState = {
            burned: new Set([...ctx.burned, ctx.model]),
            attemptsRemaining: ctx.attemptsRemaining - 1,
        };
        const burnedList = [...retryState.burned].join(', ');
        deps.services.agents.emit('agent.output', { entries: [{
                    timestamp: Date.now(),
                    stage: 'plan',
                    type: 'stderr',
                    kind: 'stderr',
                    content: `[plan] ${reason} — burning ${ctx.model}, retrying with ${nextModel} (burned: ${burnedList}; ${retryState.attemptsRemaining} attempt(s) left)`,
                }] });
        if (ctx.existingSlug && ctx.section) {
            const current = deps.planStore.readCurrent(ctx.project, ctx.existingSlug);
            if (!current)
                return false;
            spawnPlanSectionRegen(current, ctx.section, nextModel, retryState);
            return true;
        }
        if (ctx.variant) {
            spawnOnePlanVariant(ctx.project, ctx.feature, { label: ctx.variant.label, prompt: ctx.variantPrompt }, ctx.variant.batchId, ctx.variant.index, nextModel, retryState);
            return true;
        }
        spawnPlanAgent(ctx.project, ctx.feature, nextModel, retryState);
        return true;
    }
    function finalizePlanAgent(agentId, agentOutput) {
        const ctx = planAgentContext.get(agentId);
        if (!ctx)
            return;
        const parsed = extractJsonBlock(agentOutput);
        if (parsed === null || !isValidParsedShape(parsed, ctx.section)) {
            if (ctx.sameAgentRetriesRemaining > 0) {
                ctx.sameAgentRetriesRemaining -= 1;
                deps.services.agents.emit('agent.output', { entries: [{
                            timestamp: Date.now(),
                            stage: 'plan',
                            type: 'stderr',
                            kind: 'stderr',
                            content: `[plan] output not parseable as JSON — asking ${ctx.model} to correct (${ctx.sameAgentRetriesRemaining} same-agent retry/retries left before chain-walk)`,
                        }] });
                try {
                    deps.agentManager.sendInput(agentId, buildJsonCorrectionInput(agentOutput, ctx.section));
                    // Context stays in the map; next agent-done re-enters this fn.
                    return;
                }
                catch (err) {
                    deps.services.agents.emit('agent.output', { entries: [{
                                timestamp: Date.now(),
                                stage: 'plan',
                                type: 'stderr',
                                kind: 'stderr',
                                content: `[plan] sendInput failed (${err instanceof Error ? err.message : String(err)}) — falling through to chain-walk`,
                            }] });
                    // fall through to chain-walk
                }
            }
            planAgentContext.delete(agentId);
            void retryPlanAgentWithNextModel(ctx, 'output did not contain valid JSON').then((retried) => {
                if (retried)
                    return;
                deps.services.plans.emit('plan.error', {
                    project: ctx.project,
                    message: `Plan failed after exhausting ${[...ctx.burned, ctx.model].length} model(s) and same-agent corrections — none produced valid JSON.`,
                    raw: agentOutput.slice(0, 2000),
                });
            });
            return;
        }
        planAgentContext.delete(agentId);
        try {
            if (ctx.existingSlug && ctx.section) {
                // Section regen: merge one key into the existing plan
                const current = deps.planStore.readCurrent(ctx.project, ctx.existingSlug);
                if (!current)
                    throw new Error(`Plan ${ctx.existingSlug} disappeared`);
                const update = { [ctx.section]: parsed };
                const next = deps.planStore.bumpVersion(ctx.project, ctx.existingSlug, update);
                const validation = deps.planValidator.validate(next);
                deps.planStore.writeValidation(ctx.project, ctx.existingSlug, validation);
                deps.services.plans.emit('plan.updated', { plan: next, validation, section: ctx.section });
                // Lifecycle dispatch:
                //   - When part of an active refine pass: decrement the
                //     outstanding-regens counter. When count hits 0, the helper
                //     fires `refine-complete` which transitions to verifying.
                //     CRITICAL: do NOT dispatch `edit` here — that would reset
                //     the refine budget and put us into a verify→refine loop.
                //   - Otherwise (user clicked Regen on a single section): the
                //     regen is a real edit and the lifecycle re-verifies under
                //     a fresh budget.
                if (deps.lifecycle.isPartOfActiveRefine(ctx.project, ctx.existingSlug)) {
                    deps.lifecycle.noteRefineRegenCompleted(ctx.project, ctx.existingSlug);
                }
                else {
                    void deps.lifecycle.dispatchLifecycle(ctx.project, ctx.existingSlug, {
                        kind: 'edit',
                        reason: `regen of ${ctx.section}`,
                    });
                    void deps.lifecycle.dispatchLifecycle(ctx.project, ctx.existingSlug, {
                        kind: 'verify-complete',
                        errors: validation.counts.errors,
                        autoFixableCount: validation.issues.filter((i) => i.autoFixable).length,
                        canTargetedRegen: validation.issues.some((i) => i.hint),
                    });
                }
            }
            else if (ctx.variant) {
                const seed = parsed;
                if (seed.title)
                    seed.title = `[${ctx.variant.label}] ${seed.title}`;
                const plan = deps.planStore.createPlan(ctx.project, ctx.feature, ctx.model, seed);
                const validation = deps.planValidator.validate(plan);
                deps.planStore.writeValidation(ctx.project, plan.slug, validation);
                deps.services.plans.emit('plan.variant-created', { plan, validation, variant: ctx.variant });
                void deps.lifecycle.dispatchLifecycle(ctx.project, plan.slug, { kind: 'plan-draft-complete' });
                void deps.lifecycle.dispatchLifecycle(ctx.project, plan.slug, {
                    kind: 'verify-complete',
                    errors: validation.counts.errors,
                    autoFixableCount: validation.issues.filter((i) => i.autoFixable).length,
                    canTargetedRegen: validation.issues.some((i) => i.hint),
                });
            }
            else {
                const seed = parsed;
                const plan = deps.planStore.createPlan(ctx.project, ctx.feature, ctx.model, seed);
                const validation = deps.planValidator.validate(plan);
                deps.planStore.writeValidation(ctx.project, plan.slug, validation);
                deps.services.plans.emit('plan.created', { plan, validation });
                void deps.lifecycle.dispatchLifecycle(ctx.project, plan.slug, { kind: 'plan-draft-complete' });
                void deps.lifecycle.dispatchLifecycle(ctx.project, plan.slug, {
                    kind: 'verify-complete',
                    errors: validation.counts.errors,
                    autoFixableCount: validation.issues.filter((i) => i.autoFixable).length,
                    canTargetedRegen: validation.issues.some((i) => i.hint),
                });
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            deps.services.plans.emit('plan.error', {
                project: ctx.project,
                message: `Failed to persist plan: ${message}`,
            });
            if (ctx.existingSlug) {
                void deps.lifecycle.dispatchLifecycle(ctx.project, ctx.existingSlug, {
                    kind: 'plan-draft-failed',
                    reason: message,
                });
            }
        }
    }
    return {
        spawnPlanAgent,
        spawnOnePlanVariant,
        spawnPlanVariants,
        spawnPlanSectionRegen,
        retryPlanAgentWithNextModel,
        finalizePlanAgent,
        planAgentContext,
    };
}
//# sourceMappingURL=plan-spawn.js.map