/**
 * LLM-powered semantic edge detection.
 *
 * Finds structural relationships invisible to AST analysis:
 * - Dependency injection bindings
 * - Event emitter/listener wiring
 * - Config-driven routing (decorators → handlers)
 * - Dynamic dispatch (factory/registry patterns)
 *
 * Runs AFTER the AST graph is built, targeting files with orphan entities
 * or known DI/event patterns. Results merge as INFERRED edges.
 */

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { GraphifyNode, GraphifyEdge, GraphifyOutput } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SemanticEdgeResult {
  edges: GraphifyEdge[];
  filesAnalyzed: number;
  tokensUsed: number;
}

type LLMCallFn = (prompt: string) => Promise<{ content: string; inputTokens: number; outputTokens: number }>;

// ---------------------------------------------------------------------------
// Pattern detection for candidate files
// ---------------------------------------------------------------------------

const DI_EVENT_PATTERNS = [
  // DI patterns
  /\@Injectable|\@Inject|\@Autowired/,
  /container\.(?:register|bind|singleton|resolve)/,
  /\$this->app->(?:bind|singleton|make)/,
  /providers:\s*\[/,
  // Event patterns
  /\.on\s*\(|\.emit\s*\(|\.addEventListener/,
  /EventEmitter|@Subscribe|@Listener|@EventHandler/,
  /event\s*\(\s*['"`]/,
  // Routing patterns
  /\@Controller|\@Get|\@Post|\@Put|\@Delete|\@RequestMapping/,
  /app\.(?:get|post|put|delete|use)\s*\(/,
  /router\.(?:get|post|put|delete)\s*\(/,
  // Factory/Registry patterns
  /\.register\s*\(|\.factory\s*\(/,
  /switch\s*\([^)]*type[^)]*\)/i,
];

function fileMatchesDIPatterns(content: string): boolean {
  return DI_EVENT_PATTERNS.some(p => p.test(content));
}

// ---------------------------------------------------------------------------
// Find candidate files for semantic analysis
// ---------------------------------------------------------------------------

function findOrphanEntityFiles(graph: GraphifyOutput): Set<string> {
  // Build outgoing edge map (excluding 'contains')
  const outgoing = new Map<string, number>();
  for (const edge of graph.links) {
    if (edge.type === 'contains') continue;
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
  }

  // Find files that have entities with 0 outgoing non-contains edges
  const orphanFiles = new Set<string>();
  for (const node of graph.nodes) {
    if (node.type === 'module' || node.type === 'package') continue;
    if ((outgoing.get(node.id) ?? 0) === 0 && node.file) {
      orphanFiles.add(node.file);
    }
  }
  return orphanFiles;
}

// ---------------------------------------------------------------------------
// Prompt template
// ---------------------------------------------------------------------------

const SEMANTIC_EDGE_PROMPT = `You are analyzing source code to find structural relationships that static AST analysis missed.

Given code files and the list of known entities, identify relationships of these types ONLY:
1. **di-inject**: A class receives another class via constructor injection, decorator, or container registration
2. **event-wire**: An entity emits/publishes an event that another entity subscribes to/handles
3. **config-route**: A config file or decorator maps a path/key to a handler function
4. **dynamic-dispatch**: A factory/registry pattern where a string key maps to a class/function

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "edges": [
    {
      "source": "file/path.ext::EntityName",
      "target": "file/path.ext::EntityName",
      "type": "di-inject",
      "evidence": "brief explanation",
      "confidence": 0.8
    }
  ]
}

Rules:
- ONLY report edges between entities in the Known Entities list below
- ONLY report edges with confidence >= 0.7
- Do NOT report edges detectable by import analysis or direct function calls
- If no relationships found, return {"edges": []}

## Known Entities
{ENTITY_LIST}

## Code Files
{FILE_CONTENTS}`;

// ---------------------------------------------------------------------------
// Main detection function
// ---------------------------------------------------------------------------

export async function detectSemanticEdges(
  repoPath: string,
  graph: GraphifyOutput,
  callLLM: LLMCallFn,
  opts?: { maxFiles?: number },
): Promise<SemanticEdgeResult> {
  const maxFiles = opts?.maxFiles ?? 30;
  const allEdges: GraphifyEdge[] = [];
  let totalTokens = 0;

  // 1. Find candidate files
  const orphanFiles = findOrphanEntityFiles(graph);
  const patternFiles = new Set<string>();

  for (const node of graph.nodes) {
    if (node.type !== 'module' || !node.file) continue;
    try {
      const content = readFileSync(join(repoPath, node.file), 'utf-8');
      if (fileMatchesDIPatterns(content)) {
        patternFiles.add(node.file);
      }
    } catch { /* skip unreadable */ }
  }

  const candidateFiles = [...new Set([...orphanFiles, ...patternFiles])].slice(0, maxFiles);
  if (candidateFiles.length === 0) return { edges: [], filesAnalyzed: 0, tokensUsed: 0 };

  // 2. Build entity list (compact)
  const nodeSet = new Set(graph.nodes.map(n => n.id));
  const entityList = graph.nodes
    .filter(n => n.type !== 'module' && n.type !== 'package')
    .map(n => `${n.id} (${n.type})`)
    .join('\n');

  // 3. Batch files (~4000 chars per batch)
  const batches: Array<Array<{ relPath: string; content: string }>> = [];
  let currentBatch: Array<{ relPath: string; content: string }> = [];
  let currentSize = 0;

  for (const relPath of candidateFiles) {
    try {
      const content = readFileSync(join(repoPath, relPath), 'utf-8');
      const trimmed = content.slice(0, 3000); // limit per file
      if (currentSize + trimmed.length > 12000) {
        if (currentBatch.length > 0) batches.push(currentBatch);
        currentBatch = [];
        currentSize = 0;
      }
      currentBatch.push({ relPath, content: trimmed });
      currentSize += trimmed.length;
    } catch { /* skip */ }
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  // 4. Run LLM on each batch
  for (const batch of batches) {
    const fileContents = batch
      .map(f => `### ${f.relPath}\n\`\`\`\n${f.content}\n\`\`\``)
      .join('\n\n');

    const prompt = SEMANTIC_EDGE_PROMPT
      .replace('{ENTITY_LIST}', entityList.slice(0, 5000))
      .replace('{FILE_CONTENTS}', fileContents);

    try {
      const result = await callLLM(prompt);
      totalTokens += result.inputTokens + result.outputTokens;

      // Parse response — handle markdown-wrapped JSON
      let jsonStr = result.content.trim();
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonStr = jsonMatch[1].trim();

      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed?.edges)) continue;

      for (const edge of parsed.edges) {
        // Validate: both source and target must exist in the graph
        if (nodeSet.has(edge.source) && nodeSet.has(edge.target) && edge.source !== edge.target) {
          const confidence = typeof edge.confidence === 'number' ? Math.min(edge.confidence, 0.95) : 0.75;
          if (confidence >= 0.7) {
            allEdges.push({
              source: edge.source,
              target: edge.target,
              type: edge.type || 'semantic',
              confidence,
            });
          }
        }
      }
    } catch {
      // LLM call or parse failure — skip batch, don't crash pipeline
    }
  }

  return {
    edges: allEdges,
    filesAnalyzed: candidateFiles.length,
    tokensUsed: totalTokens,
  };
}
