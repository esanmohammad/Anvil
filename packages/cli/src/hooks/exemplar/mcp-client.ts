// Section F — MCP Client for Exemplar Search

import type { Exemplar, ExemplarQuery } from './types.js';

export interface McpClientOptions {
  serverUrl?: string;
  timeout?: number;
}

export interface McpTransport {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/**
 * Search codebase for exemplar code via MCP server.
 */
export async function searchCodebase(
  query: ExemplarQuery,
  transport: McpTransport,
): Promise<Exemplar[]> {
  try {
    const result = await transport.call('searchCode', {
      language: query.language,
      pattern: query.pattern,
      context: query.context ?? '',
      maxResults: query.maxResults ?? 5,
    });

    if (!Array.isArray(result)) {
      return [];
    }

    return result.map((item: Record<string, unknown>) => ({
      filePath: String(item.filePath ?? ''),
      content: String(item.content ?? ''),
      language: String(item.language ?? query.language),
      relevanceScore: typeof item.relevanceScore === 'number' ? item.relevanceScore : 0,
      description: item.description ? String(item.description) : undefined,
    }));
  } catch {
    return [];
  }
}
