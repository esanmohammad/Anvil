/**
 * Search tools — hybrid, semantic, and keyword search.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerContext } from '../server.js';
import { getRetriever, getKnowledgeBasePath, findChunksInFile } from '@esankhan3/anvil-knowledge-core';

export function registerSearchTools() {
  return [
    {
      name: 'search_code',
      description: 'Hybrid search across all repos using vector + BM25 + graph expansion + reranking. Best for general queries.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query (natural language or code identifier)' },
          maxResults: { type: 'number', description: 'Max results to return (default: 10)' },
          repos: { type: 'array', items: { type: 'string' }, description: 'Filter to specific repos (optional)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'search_semantic',
      description: 'Vector-only semantic search. Best for conceptual questions like "how does X work?"',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query' },
          maxResults: { type: 'number', description: 'Max results (default: 10)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'search_exact',
      description: 'BM25 keyword search. Best for exact function names, error codes, file paths.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Exact search query' },
          maxResults: { type: 'number', description: 'Max results (default: 10)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_code_snippet',
      description: 'Fetch the source code for one entity by qualified name. Pass either id="repo::path/to/file::entity" or the separate repo/file/entity fields. Returns just that symbol — far cheaper than reading the whole file.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Qualified id "repo::filePath::entity" (or "repo::filePath" for a whole file)' },
          repo: { type: 'string', description: 'Repository name (alternative to id)' },
          file: { type: 'string', description: 'File path relative to repo root (alternative to id)' },
          entity: { type: 'string', description: 'Entity name (optional; with repo/file)' },
        },
      },
    },
  ];
}

export async function handleSearchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  // get_code_snippet reads chunks.json directly — embedder-independent, so it
  // does its own existence check rather than gating on ctx.indexReady.
  if (name === 'get_code_snippet') return await handleGetCodeSnippet(args, ctx);

  if (!['search_code', 'search_semantic', 'search_exact'].includes(name)) return null;

  if (!ctx.indexReady) {
    return { content: [{ type: 'text', text: 'Index not ready. Run reindex tool or wait for auto-indexing to complete.' }] };
  }

  try {
    // getRetriever imported at top
    const retriever = await getRetriever(ctx.projectName);

    const query = args.query as string;
    const maxResults = (args.maxResults as number) || 10;
    const repos = args.repos as string[] | undefined;

    const modeMap: Record<string, string> = {
      search_code: 'vector+bm25+graph',
      search_semantic: 'vector',
      search_exact: 'bm25',
    };

    const result = await retriever.retrieve(query, {
      maxChunks: maxResults,
      repoFilter: repos,
      mode: modeMap[name] as any,
    });

    if (result.chunks.length === 0) {
      return { content: [{ type: 'text', text: `No results found for "${query}"` }] };
    }

    const text = result.chunks.map((sc, i) => {
      const c = sc.chunk;
      return `### ${i + 1}. ${c.repoName}/${c.filePath}:${c.startLine} (score: ${sc.score.toFixed(3)}, source: ${sc.source})\n\`\`\`${c.language}\n${c.content}\n\`\`\``;
    }).join('\n\n');

    return { content: [{ type: 'text', text: `Found ${result.chunks.length} results for "${query}" (${result.totalTokens} tokens):\n\n${text}` }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Search failed: ${msg}` }] };
  }
}

/** Fetch source for one entity from chunks.json (NDJSON or legacy array) by qualified name. */
async function handleGetCodeSnippet(
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  let repo = args.repo as string | undefined;
  let file = args.file as string | undefined;
  let entity = args.entity as string | undefined;

  if (typeof args.id === 'string') {
    const parts = (args.id as string).split('::');
    repo = parts[0];
    if (parts.length >= 3) { file = parts[1]; entity = parts.slice(2).join('::'); }
    else if (parts.length === 2) { file = parts[1]; }
  }
  if (!repo || !file) {
    return { content: [{ type: 'text', text: 'Provide id="repo::file::entity" or repo + file (entity optional).' }] };
  }

  const chunksPath = join(getKnowledgeBasePath(ctx.projectName), 'chunks.json');
  if (!existsSync(chunksPath)) {
    return { content: [{ type: 'text', text: 'No index found — chunks.json missing. Index the project first.' }] };
  }

  try {
    // Stream with early-exit. chunks.json is NDJSON at org scale;
    // findChunksInFile also reads the legacy single-array format.
    let matches = await findChunksInFile(
      chunksPath,
      (c) => c.repoName === repo && c.filePath === file && (!entity || c.entityName === entity),
      5,
    );
    // Fallback: entity may live in a differently-named file — match by entity within repo.
    if (matches.length === 0 && entity) {
      matches = await findChunksInFile(chunksPath, (c) => c.repoName === repo && c.entityName === entity, 5);
    }
    if (matches.length === 0) {
      return { content: [{ type: 'text', text: `No snippet found for ${repo}::${file}${entity ? `::${entity}` : ''}` }] };
    }

    matches.sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
    const text = matches.map((c) =>
      `### ${c.repoName}/${c.filePath}:${c.startLine}-${c.endLine}${c.entityName ? ` — ${c.entityName}` : ''}\n\`\`\`${c.language ?? ''}\n${c.content}\n\`\`\``,
    ).join('\n\n');
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Failed to read chunks: ${msg}` }] };
  }
}
