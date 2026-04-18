/**
 * Search tools — hybrid, semantic, and keyword search.
 */

import type { ServerContext } from '../server.js';
import { getRetriever } from '../core/indexer.js';

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
  ];
}

export async function handleSearchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
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
