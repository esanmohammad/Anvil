/**
 * Persona-prompt builder — Phase 5 of core-pipeline consolidation.
 *
 * Extracted verbatim from `orchestrator.ts:155-670`. Builds the
 * stage-specific persona prompt with memory + KB injection, layered
 * context, learnings, template variable expansion, and sanity caps.
 *
 * Pure function (modulo fs reads + memory-core lookups). Returns the
 * full project prompt string the agent runner consumes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PIPELINE_STAGES } from './types.js';
import type { PersonaName } from '../personas/types.js';
import { loadPersonaPrompt } from '../personas/loader.js';
import { MemoryStore } from './memory-store-cli.js';
import { info, warn } from '../logger.js';
import { loadKnowledgeGraph } from '../context/knowledge-graph.js';
import { injectMemories } from '../memory/injector.js';
import { readLearnings } from '../commands/team.js';
import { parseBytes } from '../project/parser.js';
import type { Project } from '../project/types.js';
import {
  getContextLayerForStage,
  getTokenBudgetForLayer,
  assembleLayeredContext,
} from '../knowledge/context-assembler.js';

export const STAGE_PERSONA_MAP: Record<number, PersonaName> = {
  0: 'clarifier',
  1: 'analyst',
  2: 'analyst',
  3: 'architect',
  4: 'lead',
  5: 'engineer',
  6: 'tester',
  7: 'engineer',
};

/** Substitute {{key}} placeholders in a template. */
export function injectTemplateVars(prompt: string, vars: Record<string, string>): string {
  let result = prompt;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

/**
 * Parse numbered questions from clarifier output. Matches:
 *   1. **[Topic]**: Question text?
 *   2. Question text?
 *   1) Question text?
 */
export function parseQuestions(output: string): string[] {
  const lines = output.split('\n');
  const questions: string[] = [];
  let current = '';

  for (const line of lines) {
    const isNewQ = /^\s*\d+[\.\)]\s+/.test(line);
    if (isNewQ) {
      if (current.trim()) questions.push(current.trim());
      current = line.replace(/^\s*\d+[\.\)]\s+/, '');
    } else if (current) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.toLowerCase().startsWith('please answer')) {
        current += '\n' + line;
      }
    }
  }
  if (current.trim()) questions.push(current.trim());

  return questions.filter((q) => q.length > 10);
}

/** Prompt the user via stdin readline. */
export function askUser(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Build the persona project prompt for a given pipeline stage.
 * Lifted from `orchestrator.ts:456`.
 */
export async function buildPersonaProjectPrompt(
  stageIndex: number,
  project: string,
  feature: string,
  featureSlug: string,
  projectYamlPath: string | undefined,
  workspaceDir: string,
  repoNames: string[],
  memoryStore: MemoryStore,
): Promise<string> {
  const persona = STAGE_PERSONA_MAP[stageIndex];
  if (!persona) return '';

  let personaPrompt: string;
  try {
    personaPrompt = await loadPersonaPrompt(persona);
  } catch {
    return `You are the ${persona} agent in an Anvil pipeline for the "${project}" project.`;
  }
  if (!personaPrompt) {
    return `You are the ${persona} agent in an Anvil pipeline for the "${project}" project.`;
  }

  let projectYaml = '(not available)';
  let parsedProject: Project | null = null;
  if (projectYamlPath && existsSync(projectYamlPath)) {
    try {
      const rawYaml = readFileSync(projectYamlPath, 'utf-8');
      projectYaml = rawYaml.slice(0, 8000);
      parsedProject = parseBytes(rawYaml);
      info(`[project-context] Loaded project.yaml for "${project}" (${projectYaml.length} chars) → injecting into ${persona} prompt`);
    } catch { /* ignore */ }
  }

  const projectMemory = memoryStore.formatForPrompt(project, 'memory');
  const userProfile = memoryStore.formatForPrompt(project, 'user');
  let memoryBlock = [projectMemory, userProfile].filter(Boolean).join('\n\n') || '(no prior memories)';

  try {
    const stageName = PIPELINE_STAGES[stageIndex]?.name ?? `stage-${stageIndex}`;
    const { text: injectedMemoryText } = injectMemories(stageName, project, {
      tags: [stageName, persona],
      searchContent: feature,
      k: 5,
    });
    if (injectedMemoryText) {
      memoryBlock = memoryBlock === '(no prior memories)'
        ? injectedMemoryText
        : memoryBlock + '\n\n' + injectedMemoryText;
      info(`[memory] Injected memories for stage "${stageName}"`);
    }
  } catch {
    /* memory injection optional */
  }

  let conventionText = '(use existing project conventions found in the codebase)';
  try {
    const learnings = readLearnings().filter((l) => !l.project || l.project === project);
    const conventions = learnings
      .filter((l) => l.type === 'convention')
      .slice(0, 10)
      .map((l) => `- ${l.text}`);
    if (conventions.length > 0) {
      conventionText = conventions.join('\n');
      info(`[team] Loaded ${conventions.length} team conventions`);
    }
  } catch {
    /* learnings optional */
  }

  const layer = getContextLayerForStage(stageIndex);
  const tokenBudget = getTokenBudgetForLayer(layer);

  let knowledgeGraph: string | null = null;
  try {
    const { getRetriever } = await import('@anvil/knowledge-core');
    const retriever = await getRetriever(project);
    const result = await retriever.retrieve(feature, {
      maxTokens: tokenBudget,
      repoFilter: layer === 'full' ? undefined : repoNames.slice(0, 3),
    });
    if (result.chunks.length > 0) {
      const repoLanguages = parsedProject?.repos
        ?.map((r) => r.language).filter(Boolean) as string[] | undefined;
      const systemInvariants = parsedProject?.invariants
        ?.map((inv) => inv.statement) ?? [];
      const teamConventions = conventionText !== '(use existing project conventions found in the codebase)'
        ? conventionText.split('\n').map((l) => l.replace(/^- /, ''))
        : [];

      knowledgeGraph = assembleLayeredContext(
        {
          project,
          feature,
          layer,
          repoNames,
          languages: [...new Set(repoLanguages ?? [])],
          domain: parsedProject?.description,
          invariants: systemInvariants,
          conventions: teamConventions,
        },
        result,
      );
      info(`[knowledge-base] Layered retrieval (${layer}): ${result.chunks.length} chunks, ${result.totalTokens} tokens`);
    }
  } catch {
    /* semantic index unavailable */
  }

  if (!knowledgeGraph) {
    const legacyKb = await loadKnowledgeGraph(project, feature);
    if (legacyKb) {
      const maxChars = tokenBudget * 4;
      if (legacyKb.length > maxChars) {
        knowledgeGraph = legacyKb.slice(0, maxChars) + '\n\n[... truncated to fit context layer budget]\n';
        info(`[knowledge-base] Legacy KB truncated from ${legacyKb.length} to ${maxChars} chars for layer "${layer}"`);
      } else {
        knowledgeGraph = legacyKb;
      }
      info(`[knowledge-base] Loaded KB for "${project}" (${knowledgeGraph.length} chars) → injecting into ${persona} prompt`);
    } else {
      warn(`[knowledge-base] No KB available for "${project}" — agent will explore codebase manually`);
    }
  }

  const repoList = repoNames.length > 0 ? repoNames.join(', ') : '(single-repo or monorepo)';

  const MAX_KNOWLEDGE_GRAPH_CHARS = 60_000;
  const MAX_MEMORIES_CHARS = 4_000;

  let trimmedKnowledgeGraph = knowledgeGraph || '(no knowledge base available — run "ff kb refresh" or use the dashboard to build it)';
  if (trimmedKnowledgeGraph.length > MAX_KNOWLEDGE_GRAPH_CHARS) {
    warn(`[prompt-budget] Knowledge graph is ${trimmedKnowledgeGraph.length} chars — trimming to ${MAX_KNOWLEDGE_GRAPH_CHARS}`);
    trimmedKnowledgeGraph = trimmedKnowledgeGraph.slice(0, MAX_KNOWLEDGE_GRAPH_CHARS) + '\n\n[... knowledge graph truncated to fit context window ...]';
  }

  let trimmedMemories = memoryBlock;
  if (trimmedMemories.length > MAX_MEMORIES_CHARS) {
    warn(`[prompt-budget] Memories section is ${trimmedMemories.length} chars — trimming to ${MAX_MEMORIES_CHARS}`);
    trimmedMemories = trimmedMemories.slice(0, MAX_MEMORIES_CHARS) + '\n\n[... memories truncated ...]';
  }

  const injected = injectTemplateVars(personaPrompt, {
    project_yaml: projectYaml,
    task: `Feature: "${feature}"\nProject: ${project}\nRepositories: ${repoList}`,
    conventions: conventionText,
    memories: trimmedMemories,
    knowledge_graph: trimmedKnowledgeGraph,
    repo_context: `Project: ${project}\nRepositories: ${repoList}\nWorkspace: ${workspaceDir}`,
    existing_code: knowledgeGraph
      ? '(see Knowledge Graph section for codebase structure — explore specific files as needed)'
      : '(explore the codebase to discover relevant code)',
  });

  const overrides: string[] = [];
  if (knowledgeGraph) {
    overrides.push(`CRITICAL — KNOWLEDGE BASE USAGE:
A pre-computed Knowledge Base has been injected into the "Codebase Knowledge Graph" section above. It contains:
1. **Project-level synthesis** (if available): Cross-repo dependencies, shared concepts, and architecture overview for the entire "${project}" project.
2. **Per-repo analysis**: AST-extracted modules, functions, imports, call graphs, and community clusters for each repository.

**You MUST follow this traversal strategy:**
- START by reading the Project Knowledge Base section (if present) to understand how repos relate to each other.
- THEN read the per-repo sections relevant to your task for detailed module/function information.
- ONLY read specific source files when you need exact implementation details (API signatures, data model fields) not covered by the KB.
- When you use KB information, explicitly state it: e.g., "From the Knowledge Base, I can see that module X in repo Y handles Z..."
- Do NOT broadly explore files when the KB already provides the architectural map.`);
    if (persona === 'analyst') {
      overrides.push('IMPORTANT — ANALYST DIRECTIVE: The Knowledge Base provides sufficient architectural context for writing requirements. Do NOT spawn sub-agents to explore the codebase. Do NOT run find/ls/tree commands. Focus on producing requirements from the clarification document, project YAML, and the Knowledge Base. Reference specific KB findings in your requirements (e.g., "Based on KB analysis of module X..."). Only read a specific file if you need to verify a concrete implementation detail.');
    }
  }
  if (persona !== 'engineer') {
    overrides.push('CRITICAL — NO FILE WRITES: Do NOT use the Write tool, do NOT create files, do NOT run mkdir. Output your documents as plain text in your response. The pipeline will persist your output automatically. The workspace repos must contain ONLY source code changes, never markdown artifacts.');
  }
  if (persona === 'clarifier') {
    overrides.push('IMPORTANT: Format each clarifying question as a separate numbered item (1. 2. 3. etc). Each question will be shown to the user one at a time in an interactive Q&A flow. Keep each question self-contained. Do NOT combine multiple questions into one item.');
  }
  if (persona === 'engineer') {
    overrides.push('IMPORTANT: Do NOT make git commits. Commits happen in the ship stage on a feature branch.');
    overrides.push('IMPORTANT: Do NOT run linters (golangci-lint, eslint, ruff). Linting is handled once by post-build guards. You may run `go build`/`go vet`/`tsc --noEmit` to verify compilation, but skip lint commands to avoid redundant slow passes.');
  }
  if (persona === 'tester') {
    overrides.push('IMPORTANT: Do NOT make git commits. Commits happen in the ship stage on a feature branch.');
    overrides.push('CRITICAL: You MUST fix ALL build errors, lint errors, and test failures before completing. Iterate until the codebase is clean. End your output with "VERDICT: PASS" or "VERDICT: FAIL" so the pipeline knows whether to proceed to shipping.');
  }

  let prompt = injected + (overrides.length > 0 ? '\n\n' + overrides.join('\n') : '');

  const MAX_PROMPT_CHARS = parseInt(process.env.ANVIL_MAX_PROMPT_CHARS ?? '', 10) || 600_000;
  if (prompt.length > MAX_PROMPT_CHARS) {
    warn(`[prompt-budget] Project prompt is ${prompt.length} chars (${Math.ceil(prompt.length / 4)} tokens) — trimming to pre-model sanity cap (${MAX_PROMPT_CHARS} chars)`);
    prompt = prompt.slice(0, MAX_PROMPT_CHARS) + '\n\n[... prompt truncated to pre-model sanity cap ...]';
  }

  // featureSlug intentionally accepted as a parameter for symmetry with the
  // legacy signature; not used in the prompt body. Drop with a no-op ref.
  void featureSlug;

  info(`[prompt-budget] Project prompt: ${Math.ceil(prompt.length / 4)} tokens`);
  return prompt;
}
