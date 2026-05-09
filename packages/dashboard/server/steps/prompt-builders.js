/**
 * `prompt-builders` — Phase 4f.7 of the dashboard consolidation.
 *
 * Lifts the 6 system / user prompt builders + 2 helpers that
 * `pipeline-runner.ts` carried for the agent stages:
 *
 *   - `buildProjectPrompt(ctx, stage)`               — system prompt for non-repo stages
 *   - `buildRepoProjectPrompt(ctx, stage, repoName)` — system prompt scoped to one repo
 *   - `buildClarifyExplorePrompt(ctx)`               — Phase A clarify user prompt
 *   - `buildStagePrompt(ctx, stage, prevArtifact)`   — non-repo user prompt
 *   - `buildRepoStagePrompt(ctx, stage, repoName, prevArtifact)` — per-repo user prompt
 *   - `buildPerTaskPrompt(ctx, repoName, repoPath, task, specsMd)` — single-task user prompt
 *   - `buildManifestPrefix(ctx)`                     — feature-manifest prefix block
 *   - `warnIfSystemPromptOversized(ctx, label, prompt)` — > 60KB warn-and-emit
 *
 * Plus the two file-loader helpers that the prompt path needs:
 *   - `loadPersonaPromptSync(personaName)`
 *   - `injectTemplateVars(prompt, vars)`
 *
 * Each builder takes a `PromptBuilderContext` that bundles every
 * dependency the legacy code reached through `this.*`. The context is
 * intentionally a snapshot of getters + closures so:
 *   - Tests can supply a fully-stubbed context without spinning up
 *     `MemoryStore` / `KnowledgeBaseManager` / `FeatureStore`.
 *   - The cache-stability invariant (P1 — byte-identical bytes across
 *     stages of one run) is preserved by the caller's memoised getters.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { buildShipUserPrompt } from '@esankhan3/anvil-core-pipeline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetPromptContext } from '../context-budget.js';
import { sliceSpecForRefs } from '@esankhan3/anvil-core-pipeline';
import { bundleFiles, parseTasks } from '../engineer-task-bundler.js';
import { enforceBudget } from '../prompt-budget.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');
// ── Persona-prompt loader ───────────────────────────────────────────────
const personaPromptCache = new Map();
/**
 * Load a persona's prompt markdown file. Resolution order:
 *   1. User override at `$ANVIL_HOME/personas/<persona>.md`
 *   2. CLI bundle / monorepo source-tree paths
 *
 * Lifted verbatim from `pipeline-runner.ts`. Callers MUST handle the
 * empty-string return (persona file missing → callers fall back to
 * a minimal hardcoded prompt).
 */
export function loadPersonaPromptSync(personaName) {
    if (personaPromptCache.has(personaName))
        return personaPromptCache.get(personaName);
    const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
    const userPath = join(anvilHome, 'personas', `${personaName}.md`);
    if (existsSync(userPath)) {
        const content = readFileSync(userPath, 'utf-8');
        personaPromptCache.set(personaName, content);
        return content;
    }
    const bundledPaths = [
        // anvil-loc bundle: server/steps/<file> → cli/dist/personas/prompts/<name>.md
        join(__dirname, '..', '..', '..', 'personas', 'prompts', `${personaName}.md`),
        join(__dirname, '..', '..', 'personas', 'prompts', `${personaName}.md`),
        join(__dirname, '..', '..', 'cli', 'src', 'personas', 'prompts', `${personaName}.md`),
        join(__dirname, '..', '..', '..', 'packages', 'cli', 'src', 'personas', 'prompts', `${personaName}.md`),
        join(__dirname, '..', '..', '..', '..', 'packages', 'cli', 'src', 'personas', 'prompts', `${personaName}.md`),
        join(__dirname, '..', '..', '..', 'src', 'personas', 'prompts', `${personaName}.md`),
    ];
    for (const p of bundledPaths) {
        if (existsSync(p)) {
            const content = readFileSync(p, 'utf-8');
            personaPromptCache.set(personaName, content);
            return content;
        }
    }
    console.warn(`[pipeline] Persona prompt not found for "${personaName}", using fallback. Checked: ${bundledPaths.join(', ')}`);
    return '';
}
/**
 * Inject `{{key}}` template variables into a persona prompt.
 * Lifted verbatim from `pipeline-runner.ts`.
 */
export function injectTemplateVars(prompt, vars) {
    let result = prompt;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }
    // Sweep any remaining `{{...}}` placeholders. Persona prompts evolve
    // independently of the injection map; leftover braces are bad for every
    // provider — Claude / OpenRouter / OpenCode / Ollama silently feed the
    // literal text to the LLM (poor output), Gemini-via-ADK parses it as a
    // context variable and 500s. Empty-string substitution is safer than
    // either failure mode and produces consistent prompts across providers.
    result = result.replace(/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/g, '');
    return result;
}
// ── warnIfSystemPromptOversized ────────────────────────────────────────
export function warnIfSystemPromptOversized(ctx, label, projectPrompt) {
    const bytes = Buffer.byteLength(projectPrompt, 'utf8');
    if (bytes > 60_000) {
        ctx.emit('project-event', {
            source: 'context-budget',
            message: `[${label}] system prompt is ${(bytes / 1024).toFixed(1)}KB (>60KB) — review KB tier and memory blocks`,
            level: 'warn',
        });
    }
}
// ── buildManifestPrefix ────────────────────────────────────────────────
export function buildManifestPrefix(ctx) {
    const block = ctx.getStableManifestBlock();
    if (!block)
        return '';
    const discipline = [
        'Manifest discipline:',
        '- The feature manifest below is authoritative. If a field you would otherwise derive is already marked [final], use that value verbatim.',
        '- Do not re-justify, re-validate, or paraphrase final fields. Move on to the unset/partial fields.',
        "- If you find the manifest contradicts your reasoning, note the contradiction in `openQuestions` (don't silently override).",
    ].join('\n');
    const prefix = `## Feature manifest\n${block}\n\n${discipline}\n\n`;
    if (process.env.ANVIL_LOG_MANIFEST_BYTES === '1') {
        console.log(`[pipeline] manifest prefix: ${Buffer.byteLength(prefix, 'utf8')} bytes`);
    }
    return prefix;
}
// ── buildProjectPrompt ────────────────────────────────────────────────
export function buildProjectPrompt(ctx, stage) {
    const personaPrompt = loadPersonaPromptSync(stage.persona);
    if (personaPrompt) {
        const repoList = ctx.repoNames.length > 0
            ? ctx.repoNames.join(', ')
            : '(single-repo or monorepo)';
        const memoryBlock = ctx.getStableMemoryBlock();
        const tier = ctx.getLockedKbTier(stage);
        const kb = tier === 'none'
            ? { content: '', sourceLabel: 'none' }
            : ctx.getStableKbBlock(tier);
        const knowledgeGraph = kb.content;
        console.log(`[pipeline] buildProjectPrompt("${stage.name}"): KB tier=${tier}, source=${kb.sourceLabel}, ${knowledgeGraph.length} chars`);
        if (knowledgeGraph) {
            ctx.emit('project-event', {
                source: 'knowledge-base',
                message: `Knowledge Base loaded for "${ctx.project}" (${knowledgeGraph.length} chars, source=${kb.sourceLabel}) → injecting into ${stage.persona} agent`,
                stage: stage.name,
            });
        }
        else if (tier === 'none') {
            // Stage policy intentionally skips KB injection — e.g. shipping
            // (git operations: commit / branch / PR — no codebase reasoning
            // needed). Don't claim "no KB available"; the KB exists, this
            // stage just doesn't need it.
            ctx.emit('project-event', {
                source: 'knowledge-base',
                message: `Knowledge Base intentionally skipped for "${stage.name}" stage (policy: tier=none). KB is available but not needed for this stage.`,
                stage: stage.name,
            });
        }
        else {
            ctx.emit('project-event', {
                source: 'knowledge-base',
                message: `No Knowledge Base available for "${ctx.project}" — ${stage.persona} agent will explore codebase manually`,
                level: 'warn',
                stage: stage.name,
            });
        }
        const projectYamlSlice = ctx.getStableProjectYamlSlice(8000);
        if (ctx.projectYaml && ctx.projectYaml.length > 10) {
            ctx.emit('project-event', {
                source: 'project-context',
                message: `Project config loaded for "${ctx.project}" (${projectYamlSlice.length} chars) → injecting into ${stage.persona} agent`,
                stage: stage.name,
            });
        }
        const budgeted = budgetPromptContext({
            featureDescription: `Feature: "${ctx.feature}"\nProject: ${ctx.project}\nRepositories: ${repoList}`,
            stagePrompt: personaPrompt,
            knowledgeBase: knowledgeGraph,
            priorArtifacts: '',
            memory: memoryBlock,
            projectYaml: projectYamlSlice,
            overrides: '',
            modelId: ctx.model,
        });
        if (budgeted.warning) {
            console.warn(`[pipeline] Context budget: ${budgeted.warning}`);
            ctx.emit('project-event', {
                source: 'context-budget',
                message: budgeted.warning,
                level: 'warn',
            });
        }
        const tokenInfo = `[Context: ~${Math.round(budgeted.totalTokens / 1000)}K / ${Math.round(budgeted.limit / 1000)}K tokens]`;
        console.log(`[pipeline] ${stage.name} prompt ${tokenInfo}`);
        const injected = injectTemplateVars(personaPrompt, {
            project_yaml: budgeted.projectYaml,
            // Persona prompts (analyst.md, architect.md, clarifier.md, ...) use
            // `{{system_yaml}}`. Alias to project_yaml so the placeholder is
            // substituted for every provider — the leftover-brace sweep below
            // catches anything else, but explicit aliasing keeps the content
            // (project YAML) flowing where the persona expects it.
            system_yaml: budgeted.projectYaml,
            feature_request: `Feature: "${ctx.feature}"\nProject: ${ctx.project}\nRepositories: ${repoList}`,
            existing_clarifications: '',
            task: `Feature: "${ctx.feature}"\nProject: ${ctx.project}\nRepositories: ${repoList}`,
            conventions: ctx.getStableConventionsBlock(),
            memories: budgeted.memory,
            knowledge_graph: budgeted.knowledgeBase,
            repo_context: `Project: ${ctx.project}\nRepositories: ${repoList}\nWorkspace: ${ctx.workspaceDir}`,
            existing_code: budgeted.knowledgeBase ? '(see Knowledge Graph section above)' : '',
        });
        const overrides = [];
        if (stage.persona !== 'engineer') {
            overrides.push('CRITICAL — NO FILE WRITES: Do NOT use the Write tool, do NOT create files, do NOT run mkdir. Output your documents as plain text in your response. The pipeline will persist your output automatically. The workspace repos must contain ONLY source code changes, never markdown artifacts.');
        }
        if (knowledgeGraph) {
            overrides.push(`CRITICAL — KNOWLEDGE BASE USAGE:
A pre-computed Knowledge Base has been injected into the "Codebase Knowledge Graph" section above. It contains:
1. **Project-level synthesis** (if available): Cross-repo dependencies, shared concepts, and architecture overview for the entire "${ctx.project}" project.
2. **Per-repo analysis**: AST-extracted modules, functions, imports, call graphs, and community clusters for each repository.

**You MUST follow this traversal strategy:**
- START by reading the Project Knowledge Base section (if present) to understand how repos relate to each other.
- THEN read the per-repo sections relevant to your task for detailed module/function information.
- ONLY read specific source files when you need exact implementation details (API signatures, data model fields) not covered by the KB.
- When you use KB information, explicitly state it: e.g., "From the Knowledge Base, I can see that module X in repo Y handles Z..."
- Do NOT broadly explore files when the KB already provides the architectural map.`);
            if (stage.persona === 'analyst' || stage.persona === 'architect' || stage.persona === 'lead') {
                const role = stage.persona === 'analyst' ? 'requirements'
                    : stage.persona === 'architect' ? 'specs'
                        : 'task breakdowns';
                overrides.push(`IMPORTANT — KB-FIRST DIRECTIVE: The Knowledge Base provides sufficient architectural context for writing ${role}. Do NOT spawn sub-agents to explore the codebase. Do NOT run find/ls/tree commands. Do NOT read more than 2-3 files. Reference specific KB findings explicitly (e.g., "Based on KB analysis of module X..."). Only read a specific file if you need to verify a concrete implementation detail not covered by the KB.`);
            }
        }
        if (stage.persona === 'clarifier') {
            overrides.push('IMPORTANT: Format each clarifying question as a separate numbered item (1. 2. 3. etc). Each question will be shown to the user one at a time in an interactive Q&A flow. Keep each question self-contained. Do NOT combine multiple questions into one item.');
        }
        if (stage.persona === 'engineer') {
            overrides.push('IMPORTANT: Do NOT make git commits. Commits happen in the ship stage on a feature branch.');
        }
        if (stage.persona === 'tester') {
            overrides.push('IMPORTANT: Do NOT make git commits. Commits happen in the ship stage on a feature branch.');
            overrides.push('CRITICAL: You MUST fix ALL build errors, lint errors, and test failures before completing. Iterate until the codebase is clean. End your output with "VERDICT: PASS" or "VERDICT: FAIL" so the pipeline knows whether to proceed to shipping.');
        }
        const manifestPrefix = buildManifestPrefix(ctx);
        const finalPrompt = manifestPrefix
            + injected
            + (overrides.length > 0 ? '\n\n' + overrides.join('\n') : '');
        warnIfSystemPromptOversized(ctx, `${stage.persona}/${stage.name}`, finalPrompt);
        return finalPrompt;
    }
    return `You are the ${stage.persona} agent in an Anvil pipeline for the "${ctx.project}" project.\n\nProject YAML:\n${ctx.projectYaml.slice(0, 4000)}`;
}
// ── buildRepoProjectPrompt ─────────────────────────────────────────────
export function buildRepoProjectPrompt(ctx, stage, repoName) {
    const personaPrompt = loadPersonaPromptSync(stage.persona);
    const repoInfo = ctx.projectInfo?.repos.find((r) => r.name === repoName);
    const repoContext = repoInfo
        ? `Repository: ${repoName}\n- GitHub: ${repoInfo.github}\n- Language: ${repoInfo.language}\n- Kind: ${repoInfo.repoKind}\n- Description: ${repoInfo.description}`
        : `Repository: ${repoName}`;
    if (personaPrompt) {
        const memoryBlock = ctx.getStableMemoryBlock();
        const tier = ctx.getLockedKbTier(stage);
        const kb = tier === 'none'
            ? { content: '', sourceLabel: 'none' }
            : ctx.getStableKbBlock(tier, repoName);
        const knowledgeGraph = kb.content;
        const kbSourceLabel = kb.sourceLabel;
        if (knowledgeGraph) {
            ctx.emit('project-event', {
                source: 'knowledge-base',
                message: `Knowledge Base loaded for repo "${repoName}" (${knowledgeGraph.length} chars, tier=${kbSourceLabel}) → injecting into ${stage.persona} agent`,
                stage: `${stage.name}:${repoName}`,
            });
        }
        else if (tier !== 'none') {
            ctx.emit('project-event', {
                source: 'knowledge-base',
                message: `No Knowledge Base available for repo "${repoName}" — ${stage.persona} agent will explore codebase manually`,
                level: 'warn',
                stage: `${stage.name}:${repoName}`,
            });
        }
        if (ctx.projectYaml && ctx.projectYaml.length > 10) {
            ctx.emit('project-event', {
                source: 'project-context',
                message: `Project config loaded for "${ctx.project}" → injecting into ${stage.persona}/${repoName} agent`,
                stage: `${stage.name}:${repoName}`,
            });
        }
        const injected = injectTemplateVars(personaPrompt, {
            project_yaml: ctx.getStableProjectYamlSlice(4000),
            // Mirror the per-project builder — provider-agnostic alias.
            system_yaml: ctx.getStableProjectYamlSlice(4000),
            feature_request: `Feature: "${ctx.feature}"\nProject: ${ctx.project}\nTarget repository: ${repoName}`,
            existing_clarifications: '',
            task: `Feature: "${ctx.feature}"\nProject: ${ctx.project}\nTarget repository: ${repoName}`,
            conventions: ctx.getStableConventionsBlock(),
            memories: memoryBlock,
            knowledge_graph: knowledgeGraph,
            repo_context: repoContext,
            existing_code: knowledgeGraph
                ? '(see Knowledge Graph section above)'
                : '',
        });
        const overrides = [
            `You are working specifically on the "${repoName}" repository within the "${ctx.project}" project.`,
        ];
        if (stage.persona !== 'engineer') {
            overrides.push('CRITICAL — NO FILE WRITES: Do NOT use the Write tool, do NOT create files, do NOT run mkdir. Output your documents as plain text in your response. The pipeline will persist your output automatically. The workspace repos must contain ONLY source code changes, never markdown artifacts.');
        }
        if (knowledgeGraph) {
            overrides.push(`CRITICAL — KNOWLEDGE BASE USAGE:
The Knowledge Base above contains your target repo "${repoName}" (labeled "YOUR TARGET REPO") as the primary section, plus the Project Knowledge Base and other repos for cross-repo context.

**You MUST follow this traversal strategy:**
- START with the Project Knowledge Base section (if present) to understand how "${repoName}" relates to other repos in "${ctx.project}".
- THEN read the "${repoName}" section in depth — it has AST-extracted modules, functions, imports, call graphs, and community clusters.
- USE the other repo sections to understand integration points, shared interfaces, and API contracts.
- ONLY read specific source files when you need exact implementation details not covered by the KB.
- When you use KB information, explicitly state it: e.g., "From the Knowledge Base, I can see that module X handles Z..."
- Do NOT broadly explore files when the KB already provides the architectural map.`);
            if (stage.persona === 'analyst' || stage.persona === 'architect' || stage.persona === 'lead') {
                const role = stage.persona === 'analyst' ? 'requirements'
                    : stage.persona === 'architect' ? 'specs'
                        : 'task breakdowns';
                overrides.push(`IMPORTANT — KB-FIRST DIRECTIVE: The Knowledge Base for "${repoName}" provides sufficient architectural context for writing ${role}. Do NOT spawn sub-agents to explore the codebase. Do NOT run find/ls/tree commands. Do NOT read more than 2-3 files. Reference specific KB findings explicitly. Refer to other repos' KB sections for API contracts and integration points. Only read a specific file if you need to verify a concrete implementation detail not covered by the KB.`);
            }
        }
        if (stage.persona === 'engineer' || stage.persona === 'tester') {
            overrides.push('IMPORTANT: Do NOT make git commits. Commits happen in the ship stage on a feature branch.');
        }
        const manifestPrefix = buildManifestPrefix(ctx);
        const finalPrompt = manifestPrefix + injected + '\n\n' + overrides.join('\n');
        warnIfSystemPromptOversized(ctx, `${stage.persona}/${stage.name}:${repoName}`, finalPrompt);
        return finalPrompt;
    }
    return `You are the ${stage.persona} agent working on "${repoName}" in the "${ctx.project}" project.\n\n${repoContext}\n\nProject YAML:\n${ctx.projectYaml.slice(0, 2000)}`;
}
// ── buildClarifyExplorePrompt ──────────────────────────────────────────
export function buildClarifyExplorePrompt(ctx) {
    const repoList = ctx.repoNames.length > 0 ? ctx.repoNames.join(', ') : '';
    let kbReport = '';
    const indexPrompt = ctx.kbManager?.getIndexForPrompt(ctx.project) || '';
    if (indexPrompt) {
        const queryCtx = ctx.kbManager?.getQueryContextForPrompt(ctx.project, ctx.feature) || '';
        kbReport = `${indexPrompt}\n\n---\n\n${queryCtx}`;
    }
    else {
        kbReport = ctx.kbManager?.getAllGraphReports(ctx.project) || '';
    }
    const hasKB = kbReport.length > 100;
    console.log(`[pipeline] Clarify KB for "${ctx.project}": ${hasKB ? `${kbReport.length} chars` : 'none'} (${indexPrompt ? 'index-based' : 'full blob'})`);
    const questionFormat = `IMPORTANT: The user will answer each question one at a time in an interactive conversation. Format each question as a separate numbered item so they can be presented individually.

Format your response EXACTLY like this — each question must start on its own line with a number:
1. **[Question topic]**: Your specific question here?
2. **[Question topic]**: Your specific question here?
3. **[Question topic]**: Your specific question here?

Keep each question self-contained and clear. Do not combine multiple questions into one numbered item. End with: "Please answer these questions so I can proceed with detailed requirements."

CRITICAL OUTPUT RULES (especially for thinking-mode models):
- Your FINAL message MUST be plain text containing the numbered question list above. NOT a tool call. NOT just internal reasoning.
- Do not stop after only reading files — file reads are exploration, not output. After exploration you MUST emit the numbered list as text.
- If you find yourself reasoning without writing, stop reasoning and write the numbered list now.
- The numbered list IS your answer. There is no "next step" — just emit the questions.`;
    if (hasKB) {
        return `Feature: "${ctx.feature}"
Project: ${ctx.project}
Repositories: ${repoList}

## Codebase Knowledge Graph
The following is a pre-computed architectural analysis of the codebase(s). It contains:
- Module/file structure and key components
- Function signatures, class definitions, and their relationships
- Import dependencies and call graphs
- Topological communities (clusters of related code)
- Hub components (highly connected critical nodes)

USE THIS AS YOUR PRIMARY SOURCE OF UNDERSTANDING. Do NOT re-explore the entire codebase.
Only read specific files if you need to verify a detail or understand implementation specifics
that the knowledge graph doesn't cover.

### How to read the Knowledge Graph
- **Graph Statistics**: Node count, edge count, density — gives scale of the codebase
- **Communities**: Topologically clustered modules — each is a logical domain boundary
- **Hub Components (God Nodes)**: Most-connected components — critical integration points
- **Surprising Connections**: Unexpected dependencies that may indicate coupling risks

${kbReport}

---

Based on this architectural understanding, generate 3-5 specific, thoughtful clarifying questions about the feature request that will help produce better requirements.

${questionFormat}`;
    }
    return `Feature: "${ctx.feature}"${repoList ? `\n\nThis project contains these repositories: ${repoList}. Explore them to understand the architecture.` : ''}

Explore the codebase thoroughly. Understand the architecture, key files, APIs, data flows, and patterns. Then generate 3-5 specific, thoughtful clarifying questions that will help produce better requirements.

${questionFormat}`;
}
// ── buildStagePrompt ───────────────────────────────────────────────────
export function buildStagePrompt(ctx, stage, prevArtifact) {
    const feature = `Feature: "${ctx.feature}"`;
    const prev = prevArtifact ? `\n\n## Previous stage output:\n${prevArtifact.slice(0, 12000)}` : '';
    const resumeCtx = ctx.failureContext
        ? `\n\nIMPORTANT — This is a RETRY. The previous run failed:\n${ctx.failureContext}\nFix the issues and proceed. All prior stage artifacts are included above.`
        : '';
    const reviewBlock = ctx.reviewNote
        ? `\n\n## User note from review (read this FIRST and apply throughout this stage)\n${ctx.reviewNote}`
        : '';
    const repoList = ctx.repoNames.length > 0
        ? `\nRepositories: ${ctx.repoNames.join(', ')}`
        : '';
    switch (stage.name) {
        case 'requirements':
            return `${feature}${repoList}${reviewBlock}\n\nProduce high-level requirements for this feature across the entire project. Identify which repositories need changes and why. Include success criteria.${prev}${resumeCtx}`;
        case 'ship': {
            const shipPrompt = buildShipUserPrompt({
                feature: ctx.feature,
                featureSlug: ctx.featureSlug,
                repoNames: ctx.repoNames,
                workspaceDir: ctx.workspaceDir,
                actionType: ctx.actionType,
                baseBranch: ctx.baseBranch,
            });
            return `${shipPrompt}${reviewBlock}${prev}${resumeCtx}`;
        }
        default:
            return `${feature}${repoList}${reviewBlock}${prev}${resumeCtx}`;
    }
}
// ── buildRepoStagePrompt ──────────────────────────────────────────────
export function buildRepoStagePrompt(ctx, stage, repoName, prevArtifact) {
    const feature = `Feature: "${ctx.feature}"`;
    const repoPath = ctx.repoPaths[repoName] || join(ctx.workspaceDir, repoName);
    const resumeCtx = ctx.failureContext
        ? `\n\nIMPORTANT — This is a RETRY. The previous run failed:\n${ctx.failureContext}\nFix the issues and proceed.`
        : '';
    const reviewBlock = ctx.reviewNote
        ? `\n\n## User note from review (read this FIRST and apply throughout this stage)\n${ctx.reviewNote}`
        : '';
    const prev = prevArtifact ? `\n\n## Prior stage output:\n${prevArtifact.slice(0, 12000)}` : '';
    const hlReqs = ctx.loadHighLevelRequirements();
    const hlReqsBlock = hlReqs ? `\n\n## High-Level Requirements\n${hlReqs.slice(0, 4000)}` : '';
    const repoArtifacts = ctx.loadRepoArtifacts(repoName);
    switch (stage.name) {
        case 'repo-requirements':
            return `${feature}${reviewBlock}\n\nProduce requirements specific to the "${repoName}" repository. What changes does THIS repo need for this feature? Include success criteria.${hlReqsBlock}${prev}`;
        case 'specs': {
            const repoReqsBlock = repoArtifacts.requirements
                ? `\n\n## Requirements for ${repoName}\n${repoArtifacts.requirements}`
                : prev;
            return `${feature}${reviewBlock}\n\nProduce a detailed technical specification for changes in "${repoName}". Include file paths, function signatures, API changes, data model changes, and how components interact.${hlReqsBlock}${repoReqsBlock}`;
        }
        case 'tasks': {
            const specsBlock = repoArtifacts.specs
                ? `\n\n## Technical Specification for ${repoName}\n${repoArtifacts.specs}`
                : '';
            const repoReqsFallback = !specsBlock && repoArtifacts.requirements
                ? `\n\n## Requirements for ${repoName}\n${repoArtifacts.requirements}`
                : '';
            const context = specsBlock || repoReqsFallback || prev;
            return `${feature}${reviewBlock}\n\nBreak down the spec into ordered implementation tasks for "${repoName}". Each task should include: file path, description, acceptance criteria. Order tasks so dependencies come first.${hlReqsBlock}${context}`;
        }
        case 'build': {
            const sections = [feature];
            sections.push(`\n## Context`);
            sections.push(`- Repository: "${repoName}" at ${repoPath}`);
            sections.push(`- Feature branch: anvil/${ctx.featureSlug}`);
            const parsedTasks = repoArtifacts.tasks ? parseTasks(repoArtifacts.tasks) : [];
            const taskFiles = [];
            const seen = new Set();
            for (const t of parsedTasks) {
                for (const f of t.files) {
                    if (!seen.has(f)) {
                        seen.add(f);
                        taskFiles.push(f);
                    }
                }
            }
            const specRefs = parsedTasks.map((t) => t.specRef).filter((r) => !!r);
            if (repoArtifacts.tasks) {
                sections.push(`\n## Implementation Tasks for ${repoName}\n${repoArtifacts.tasks}`);
            }
            if (repoArtifacts.specs && specRefs.length > 0) {
                const slice = sliceSpecForRefs(repoArtifacts.specs, specRefs, { maxBytes: 20000 });
                if (slice.text)
                    sections.push(`\n${slice.text}`);
            }
            else if (repoArtifacts.specs && !repoArtifacts.tasks) {
                sections.push(`\n## Technical Specification for ${repoName}\n${repoArtifacts.specs}`);
            }
            if (taskFiles.length > 0) {
                const bundle = bundleFiles({ repoPath, files: taskFiles, maxBytes: 200_000 });
                if (bundle.included.length > 0) {
                    sections.push(`\n## Files referenced by tasks (pre-bundled — do NOT re-read)\n${bundle.block}`);
                }
                if (bundle.skipped.length > 0) {
                    const lines = bundle.skipped
                        .map((s) => `- ${s.path} (${s.reason})`)
                        .join('\n');
                    sections.push(`\n## Task files NOT in bundle\nIf you need any of these, output \`NEED_FILE: path\` and stop. Do not guess contents.\n${lines}`);
                }
            }
            if (!repoArtifacts.tasks && !repoArtifacts.specs && prevArtifact) {
                sections.push(`\n## Prior stage output\n${prevArtifact.slice(0, 12000)}`);
            }
            sections.push(`\n## Instructions`);
            sections.push(`Implement each task in order. Read/Grep/Glob/Agent are disabled — every file you may need is in the <files> block above.`);
            sections.push(`- Use Edit/Write to modify files; use Bash only to run tests/build.`);
            sections.push(`- Bash discipline: prefer focused test commands (single file or test name). Pipe verbose output through \`tail -50\`. Do NOT run a whole monorepo suite at once.`);
            sections.push(`- If a file you need is missing from the bundle, output \`NEED_FILE: <path>\` on its own line and stop.`);
            sections.push(`- Write production-quality code; no pseudocode or placeholders.`);
            sections.push(`- Run the build/test step to verify your changes work.`);
            sections.push(`- Do NOT make git commits — that happens in the ship stage.`);
            sections.push(`- Do NOT ask for clarification. Decide from the context above and proceed.`);
            if (reviewBlock)
                sections.push(reviewBlock);
            if (resumeCtx)
                sections.push(resumeCtx);
            return sections.join('\n');
        }
        case 'validate': {
            const sections = [feature];
            sections.push(`\n## Context`);
            sections.push(`- You are validating the "${repoName}" repository at: ${repoPath}`);
            sections.push(`- Feature branch: anvil/${ctx.featureSlug}`);
            if (repoArtifacts.tasks) {
                sections.push(`\n## Expected Changes (Tasks)\n${repoArtifacts.tasks}`);
            }
            if (repoArtifacts.specs) {
                sections.push(`\n## Technical Specification\n${repoArtifacts.specs.slice(0, 4000)}`);
            }
            if (!repoArtifacts.tasks && !repoArtifacts.specs && prevArtifact) {
                sections.push(`\n## Prior stage output\n${prevArtifact.slice(0, 8000)}`);
            }
            sections.push(`\n## Validation Steps`);
            sections.push(`You MUST ensure the code is fully clean before this stage completes:`);
            sections.push(`1. Run the build (compile/type-check). Fix ALL errors.`);
            sections.push(`2. Run the linter. Fix ALL lint warnings and errors.`);
            sections.push(`3. Run the test suite. Fix ALL failing tests.`);
            sections.push(`4. Repeat steps 1-3 until everything passes with zero errors.`);
            sections.push(`5. Do NOT move on until build, lint, AND tests all pass.`);
            sections.push(`\nIf you cannot fix an issue after 5 attempts, document it clearly as UNRESOLVED.`);
            sections.push(`\nAt the end, output a clear verdict:`);
            sections.push(`- VERDICT: PASS — if build, lint, and tests all pass`);
            sections.push(`- VERDICT: FAIL — if any issues remain unresolved`);
            sections.push(`\nDo NOT make git commits.`);
            sections.push(`Do NOT ask for missing information. Use the codebase and context above to validate.`);
            if (reviewBlock)
                sections.push(reviewBlock);
            if (resumeCtx)
                sections.push(resumeCtx);
            return sections.join('\n');
        }
        default:
            return `${feature}${reviewBlock}\n\nWork on "${repoName}".${prev}${resumeCtx}`;
    }
}
// ── buildPerTaskPrompt ─────────────────────────────────────────────────
export function buildPerTaskPrompt(ctx, repoName, repoPath, task, specsMd) {
    const headerLines = [
        `Feature: "${ctx.feature}"`,
        ``,
        `## Context`,
        `- Repository: "${repoName}" at ${repoPath}`,
        `- Feature branch: anvil/${ctx.featureSlug}`,
        `- You are implementing exactly one task: ${task.id}.`,
    ];
    if (task.prerequisites.length > 0) {
        headerLines.push(`- Prerequisite tasks already complete: ${task.prerequisites.join(', ')}.`);
    }
    const sections = [];
    sections.push({ id: 'header', text: headerLines.join('\n'), priority: 100 });
    sections.push({ id: 'task', text: `## Your task\n${task.block}`, priority: 90 });
    if (task.specRef && specsMd) {
        const slice = sliceSpecForRefs(specsMd, [task.specRef], { maxBytes: 8000, includeOverview: false });
        if (slice.text) {
            sections.push({ id: 'spec-slice', text: slice.text, priority: 60, truncatable: true });
        }
    }
    if (task.files.length > 0) {
        const bundle = bundleFiles({ repoPath, files: task.files, maxBytes: 80_000 });
        if (bundle.included.length > 0) {
            sections.push({
                id: 'files',
                text: `## Files for this task (pre-bundled — do NOT re-read)\n${bundle.block}`,
                priority: 80,
                truncatable: true,
            });
        }
        if (bundle.skipped.length > 0) {
            const lines = bundle.skipped.map((s) => `- ${s.path} (${s.reason})`).join('\n');
            sections.push({
                id: 'files-skipped',
                text: `## Files NOT in bundle\nIf you need any of these, output \`NEED_FILE: path\` and stop. Do not guess contents.\n${lines}`,
                priority: 75,
            });
        }
    }
    if (ctx.failureContext) {
        sections.push({
            id: 'retry-context',
            text: `IMPORTANT — This is a RETRY. Previous failure:\n${ctx.failureContext}`,
            priority: 70,
            truncatable: true,
        });
    }
    const instructionLines = [
        `## Instructions`,
        `Implement only ${task.id}. Read/Grep/Glob/Agent are disabled — every file you may need is in the <files> block above.`,
        `- Use Edit/Write to modify files; use Bash only to run tests/build.`,
        `- Bash discipline: run only the focused test for this task (e.g. \`npx vitest run path/to/file.test.ts\`, \`go test ./pkg/foo -run TestX\`). Do NOT run the full suite. Pipe verbose output through \`tail -50\` so the result fits in context.`,
        `- If a file you need is missing from the bundle, output \`NEED_FILE: <path>\` on its own line and stop.`,
        `- Output the tight summary format from your persona spec — do NOT dump file contents.`,
        `- Do NOT make git commits — that happens in the ship stage.`,
        `- Do NOT modify scope outside the files listed for this task. If you discover the task needs out-of-scope changes, flag them in the Notes section and stop.`,
    ];
    sections.push({ id: 'instructions', text: instructionLines.join('\n'), priority: 100 });
    const result = enforceBudget(sections, { maxBytes: 120_000 });
    if (result.trimmed) {
        const dropped = result.decisions.filter((d) => d.action !== 'kept').map((d) => `${d.id}=${d.action}`).join(', ');
        ctx.emit('project-event', {
            source: 'context-budget',
            message: `[build] ${repoName} ${task.id}: prompt over 120KB — ${dropped}`,
            level: 'warn',
        });
    }
    return result.text;
}
//# sourceMappingURL=prompt-builders.js.map