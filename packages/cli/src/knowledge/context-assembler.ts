/**
 * Budget-constrained context assembly for agent prompts.
 *
 * Supports layered context loading (MemPalace L0→L3 pattern):
 *   L0 — Project Identity (~50 tokens, always loaded)
 *   L1 — Critical Invariants (~120 tokens, always loaded)
 *   L2 — Stage-Relevant Context (loaded per stage)
 *   L3 — Deep Search (on-demand, future)
 */

import type { CodeChunk, RetrievalResult, ScoredChunk } from './types.js';
import { loadProjectGraph, formatProjectGraphForPrompt } from './project-graph-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function langTag(language: string): string {
  switch (language) {
    case 'typescript':
      return 'ts';
    case 'javascript':
      return 'js';
    case 'python':
      return 'py';
    default:
      return language;
  }
}

// ---------------------------------------------------------------------------
// Context layer types
// ---------------------------------------------------------------------------

export type ContextLayer = 'minimal' | 'moderate' | 'full';

export interface LayeredContextConfig {
  project: string;
  feature: string;
  layer: ContextLayer;
  repoNames?: string[];
  languages?: string[];
  domain?: string;
  invariants?: string[];
  conventions?: string[];
}

// ---------------------------------------------------------------------------
// Public: format a single chunk
// ---------------------------------------------------------------------------

/**
 * Format a single code chunk for inclusion in a prompt, with a metadata
 * comment and fenced code block.
 */
export function formatChunkForPrompt(chunk: CodeChunk, score: number): string {
  const pct = Math.round(score * 100);
  const entityLabel = chunk.entityName
    ? `${chunk.entityType}: ${chunk.entityName}`
    : chunk.entityType;
  const header = `// ${entityLabel} (relevance: ${pct}%)`;
  const lang = langTag(chunk.language);
  return `${header}\n\`\`\`${lang}\n${chunk.content}\n\`\`\``;
}

// ---------------------------------------------------------------------------
// Public: stage → layer mapping
// ---------------------------------------------------------------------------

/**
 * Map pipeline stage index to the appropriate context layer.
 *
 *   clarify (0)        → minimal  (agent asks questions, not code)
 *   requirements (1)   → moderate (architecture summary)
 *   sys-reqs (2)       → moderate
 *   specs (3)          → moderate (+ architecture + relevant chunks)
 *   tasks (4)          → moderate
 *   build (5)          → full     (deep code chunks, full budget)
 *   validate (6)       → minimal  (needs test/git context, not code KB)
 *   ship (7)           → minimal
 */
export function getContextLayerForStage(stageIndex: number): ContextLayer {
  switch (stageIndex) {
    case 0: return 'minimal';     // clarify
    case 1: return 'moderate';    // requirements
    case 2: return 'moderate';    // project-requirements
    case 3: return 'moderate';    // specs
    case 4: return 'moderate';    // tasks
    case 5: return 'full';        // build
    case 6: return 'minimal';     // validate
    case 7: return 'minimal';     // ship
    default: return 'moderate';
  }
}

/**
 * Get the token budget for a given context layer.
 */
export function getTokenBudgetForLayer(layer: ContextLayer): number {
  switch (layer) {
    case 'minimal': return 500;
    case 'moderate': return 4000;
    case 'full': return 12000;
  }
}

// ---------------------------------------------------------------------------
// Public: layered context assembly
// ---------------------------------------------------------------------------

/**
 * Assemble L0 (Project Identity) + L1 (Critical Invariants) — always included.
 */
export function assembleProjectIdentity(config: LayeredContextConfig): string {
  const repoList = config.repoNames?.join(', ') || '(unknown)';
  const repoCount = config.repoNames?.length ?? 0;

  const lines = [
    `Project: ${config.project} (${repoCount} repos: ${repoList})`,
  ];
  if (config.languages?.length) {
    lines.push(`Stack: ${config.languages.join(', ')}`);
  }
  if (config.domain) {
    lines.push(`Domain: ${config.domain}`);
  }

  // L1 — Critical Invariants
  if (config.invariants?.length || config.conventions?.length) {
    lines.push('', 'Invariants:');
    if (config.invariants) {
      for (const inv of config.invariants) {
        lines.push(`- ${inv}`);
      }
    }
    if (config.conventions) {
      for (const conv of config.conventions.slice(0, 10)) {
        lines.push(`- ${conv}`);
      }
    }
  }

  // Load project graph if available (LLM-powered semantic understanding)
  try {
    const projectGraph = loadProjectGraph(config.project);
    if (projectGraph) {
      const graphContext = formatProjectGraphForPrompt(projectGraph);
      lines.push('', graphContext);
    }
  } catch {
    // Project graph not available — continue without it
  }

  return lines.join('\n');
}

/**
 * Assemble layered context: L0+L1 identity, optionally L2 retrieval results.
 */
export function assembleLayeredContext(
  config: LayeredContextConfig,
  result: RetrievalResult | null,
): string {
  const sections: string[] = [];
  const maxTokens = getTokenBudgetForLayer(config.layer);

  // Always include L0+L1
  const identity = assembleProjectIdentity(config);
  sections.push(identity);

  // For minimal layer, we're done
  if (config.layer === 'minimal' || !result) {
    return sections.join('\n\n');
  }

  // L2 — Stage-relevant context
  const remaining = assembleKnowledgeContext(result, config.feature, maxTokens - estimateTokens(identity));
  if (remaining) {
    sections.push(remaining);
  }

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Public: assemble full context (original API, still used)
// ---------------------------------------------------------------------------

/**
 * Assemble a retrieval result into a markdown context block that fits within
 * `maxTokens`.
 *
 * Layout:
 *  1. Project architecture section (from graphContext) if available
 *  2. Code chunks grouped by repo → file for readability
 *  3. Truncation notice if budget is exceeded
 */
export function assembleKnowledgeContext(
  result: RetrievalResult,
  feature: string,
  maxTokens: number = 12000,
): string {
  const sections: string[] = [];
  let usedTokens = 0;

  // -- Header ---------------------------------------------------------------
  const header = `## Knowledge Context — ${feature}\n`;
  usedTokens += estimateTokens(header);
  sections.push(header);

  // -- Graph context (project architecture) ----------------------------------
  if (result.graphContext && result.graphContext.trim().length > 0) {
    const archSection = `### Project Architecture\n\n${result.graphContext}\n`;
    const archTokens = estimateTokens(archSection);
    if (usedTokens + archTokens <= maxTokens) {
      sections.push(archSection);
      usedTokens += archTokens;
    }
  }

  // -- Group chunks by repo → file ------------------------------------------
  const grouped = new Map<string, Map<string, ScoredChunk[]>>();
  for (const sc of result.chunks) {
    const repo = sc.chunk.repoName;
    const file = sc.chunk.filePath;
    if (!grouped.has(repo)) grouped.set(repo, new Map());
    const repoMap = grouped.get(repo)!;
    if (!repoMap.has(file)) repoMap.set(file, []);
    repoMap.get(file)!.push(sc);
  }

  // -- Render chunks --------------------------------------------------------
  let truncated = false;

  const repos = Array.from(grouped.entries());
  for (const [repo, fileMap] of repos) {
    if (truncated) break;

    const repoHeader = `### ${repo}\n`;
    const repoHeaderTokens = estimateTokens(repoHeader);
    if (usedTokens + repoHeaderTokens > maxTokens) {
      truncated = true;
      break;
    }
    sections.push(repoHeader);
    usedTokens += repoHeaderTokens;

    const files = Array.from(fileMap.entries());
    for (const [file, scoredChunks] of files) {
      if (truncated) break;

      const fileHeader = `#### \`${file}\`\n`;
      const fileHeaderTokens = estimateTokens(fileHeader);
      if (usedTokens + fileHeaderTokens > maxTokens) {
        truncated = true;
        break;
      }
      sections.push(fileHeader);
      usedTokens += fileHeaderTokens;

      // Sort chunks within a file by score descending
      scoredChunks.sort((a, b) => b.score - a.score);

      for (const sc of scoredChunks) {
        const formatted = formatChunkForPrompt(sc.chunk, sc.score);
        const chunkTokens = estimateTokens(formatted);

        if (usedTokens + chunkTokens > maxTokens) {
          truncated = true;
          break;
        }

        sections.push(formatted + '\n');
        usedTokens += chunkTokens;
      }
    }
  }

  if (truncated) {
    sections.push('\n[... truncated to fit token budget]\n');
  }

  return sections.join('\n');
}
