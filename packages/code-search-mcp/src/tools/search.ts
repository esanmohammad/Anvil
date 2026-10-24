/**
 * Search tools — hybrid, semantic, and keyword search.
 */

import type { ServerContext } from '../server.js';
import { getRetriever, getBlobStore, findChunksInProject } from '@esankhan3/anvil-knowledge-core';
import { resolvedKnowledgeConfig } from '../core/env-config.js';
import { metrics } from '../observability/metrics.js';
import { toolError, toolText, validateArgs, type InputSchema, type ToolResult } from './validate.js';

const queryProps = {
  query: { type: 'string', minLength: 1, description: 'Search query (natural language or code identifier)' },
  maxResults: { type: 'integer', minimum: 1, description: 'Max results to return (default: 10)' },
  repos: { type: 'array', items: { type: 'string' }, description: 'Only search these repos (optional)' },
};

export function registerSearchTools() {
  return [
    {
      name: 'search_code',
      description: 'Hybrid search across all repos using vector + BM25 + graph expansion + reranking. Best for general queries. Needs the embedder.',
      inputSchema: { type: 'object' as const, properties: queryProps, required: ['query'] },
    },
    {
      name: 'search_semantic',
      description: 'Vector-only semantic search. Best for conceptual questions like "how does X work?". Needs the embedder.',
      inputSchema: { type: 'object' as const, properties: queryProps, required: ['query'] },
    },
    {
      name: 'search_exact',
      description: 'BM25 keyword search, led by exact symbol-name and exact-phrase hits. Best for exact function names, error codes, file paths. Works without the embedder.',
      inputSchema: { type: 'object' as const, properties: queryProps, required: ['query'] },
    },
    {
      name: 'get_code_snippet',
      description: 'Fetch the source code for one entity by qualified name. Pass either id="repo::path/to/file::entity" or the separate repo/file/entity fields. Returns just that symbol — far cheaper than reading the whole file.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', minLength: 1, description: 'Qualified id "repo::filePath::entity" (or "repo::filePath" for a whole file)' },
          repo: { type: 'string', minLength: 1, description: 'Repository name (alternative to id)' },
          file: { type: 'string', minLength: 1, description: 'File path relative to repo root (alternative to id)' },
          entity: { type: 'string', minLength: 1, description: 'Entity name (optional; with repo/file)' },
        },
      },
    },
  ];
}

const SCHEMAS = new Map(registerSearchTools().map((t) => [t.name, t.inputSchema as InputSchema]));
/** Metric `mode` label per tool — the same values InProcessBackend records. */
const METRIC_MODE: Record<string, string> = { search_code: 'hybrid', search_semantic: 'vector', search_exact: 'bm25' };

export async function handleSearchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<ToolResult | null> {
  const schema = SCHEMAS.get(name);
  if (!schema) return null;
  const invalid = validateArgs(schema, args);
  if (invalid) return toolError(`${name}: ${invalid}`);

  // get_code_snippet reads chunks.json directly — embedder-independent, so it
  // does its own existence check rather than gating on ctx.indexReady.
  if (name === 'get_code_snippet') return await handleGetCodeSnippet(args, ctx);

  // BM25 needs no embeddings, so search_exact serves whatever the index already
  // holds; the vector modes wait for the index to finish.
  if (!ctx.indexReady && name !== 'search_exact') {
    return toolText('Index not ready — indexing is still running or has not completed. Check index_status for progress.');
  }

  const query = args.query as string;
  const maxResults = (args.maxResults as number | undefined) ?? 10;
  const repos = args.repos as string[] | undefined;
  const modeMap: Record<string, string> = {
    search_code: 'vector+bm25+graph',
    search_semantic: 'vector',
    search_exact: 'bm25',
  };

  const started = Date.now();
  let outcome: 'ok' | 'error' = 'ok';
  try {
    const retriever = await getRetriever(ctx.projectName, resolvedKnowledgeConfig());
    const result = await retriever.retrieve(query, {
      maxChunks: maxResults,
      // A search tool returns a fixed COUNT of results; the config token budget
      // is for LLM-context packing and would truncate below maxResults (the
      // benchmark saw ~6.6 of 10 returned). Give maxChunks room to bind while
      // still bounding a pathological all-huge-chunks payload.
      maxTokens: maxResults * 4000,
      repoFilter: repos,
      mode: modeMap[name] as any,
    });

    if (result.chunks.length === 0) {
      return toolText(`No results found for "${query}"${ctx.indexReady ? '' : ' (indexing has not completed — check index_status)'}`);
    }

    const text = result.chunks.map((sc, i) => {
      const c = sc.chunk;
      return `### ${i + 1}. ${c.repoName}/${c.filePath}:${c.startLine} (score: ${sc.score.toFixed(3)}, source: ${sc.source})\n\`\`\`${c.language}\n${c.content}\n\`\`\``;
    }).join('\n\n');

    return toolText(`Found ${result.chunks.length} results for "${query}" (${result.totalTokens} tokens):\n\n${text}`);
  } catch (err) {
    outcome = 'error';
    metrics.errors.inc({ kind: 'search' });
    const msg = err instanceof Error ? err.message : String(err);
    return toolError(`Search failed: ${msg}`);
  } finally {
    const mode = METRIC_MODE[name];
    metrics.queriesTotal.inc({ mode, outcome });
    metrics.queryDuration.observe((Date.now() - started) / 1000, { mode });
  }
}

/** Fetch source for one entity from chunks.json (NDJSON or legacy array) by qualified name. */
async function handleGetCodeSnippet(
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<ToolResult> {
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
    return toolError('get_code_snippet: provide id="repo::file::entity" or repo + file (entity optional).');
  }

  try {
    // Primary: indexed lookup in the vector store (scalar indexes on
    // repoName/filePath/entityName) — one bounded query instead of streaming
    // the whole chunks.json per call (a full GridFS download at org scale on
    // remote backends). The retriever is cached + generation-invalidated.
    const esc = (v: string) => v.replace(/'/g, "''");
    let matches: Array<{ repoName: string; filePath: string; entityName?: string; startLine?: number; endLine?: number; language?: string; content: string }> = [];
    try {
      const store = (await getRetriever(ctx.projectName, resolvedKnowledgeConfig())).vectorStore;
      let scored = await store.getChunksByEntity([
        { repoName: repo, filePath: file, ...(entity ? { entityName: entity } : {}) },
      ]);
      // Entity may live in a differently-named file — match by entity within repo.
      if (scored.length === 0 && entity) {
        scored = await store.searchByEntityName([entity], 5, `repoName = '${esc(repo)}'`);
      }
      matches = scored.slice(0, 5).map((sc) => sc.chunk);
    } catch { /* vector store unavailable — fall through to chunks.json */ }

    // Fallback for indexes that are built but not yet embedded (empty Lance
    // table): stream chunks.json with early-exit through the blob port.
    if (matches.length === 0 && (await getBlobStore(ctx.projectName, resolvedKnowledgeConfig()).exists('chunks.json'))) {
      matches = await findChunksInProject(
        ctx.projectName,
        (c) => c.repoName === repo && c.filePath === file && (!entity || c.entityName === entity),
        5,
        resolvedKnowledgeConfig(),
      );
      if (matches.length === 0 && entity) {
        matches = await findChunksInProject(ctx.projectName, (c) => c.repoName === repo && c.entityName === entity, 5, resolvedKnowledgeConfig());
      }
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
    return toolError(`Failed to read chunks: ${msg}`);
  }
}
