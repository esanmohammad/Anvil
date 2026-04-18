// Section F — Exemplar Fetcher Facade (cache-first then MCP)
import type { Exemplar, ExemplarQuery, ExemplarCache } from './types.js';
import type { McpTransport } from './mcp-client.js';
import { searchCodebase } from './mcp-client.js';

export interface FetcherDeps {
  cache: ExemplarCache;
  transport: McpTransport;
  searchCodebase: typeof searchCodebase;
}

function queryKey(query: ExemplarQuery): string {
  return `${query.language}:${query.pattern}:${query.context ?? ''}`;
}

/**
 * Fetch exemplars: check cache first, fall back to MCP search.
 */
export async function fetchExemplar(
  query: ExemplarQuery,
  deps: FetcherDeps,
): Promise<Exemplar[]> {
  const key = queryKey(query);

  // Try cache first
  const cached = deps.cache.get(key);
  if (cached && cached.length > 0) {
    return cached;
  }

  // Fall back to MCP
  const results = await deps.searchCodebase(query, deps.transport);

  // Populate cache
  if (results.length > 0) {
    deps.cache.set(key, results);
  }

  return results;
}
