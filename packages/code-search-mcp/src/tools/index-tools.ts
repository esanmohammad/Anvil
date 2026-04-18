/**
 * Index management tools — status, reindex, and dynamic index_path.
 */

import type { ServerContext } from '../server.js';
import { KnowledgeIndexer } from '../core/indexer.js';

const TOOL_NAMES = ['index_status'];

export function registerIndexTools() {
  return [
    {
      name: 'index_status',
      description: 'Get current index stats — chunk count, embedding provider, repos indexed, last indexed time.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ];
}

export async function handleIndexTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  if (!TOOL_NAMES.includes(name)) return null;

  try {
    if (name === 'index_status') {
      const indexer = new KnowledgeIndexer();
      const stats = await indexer.getStats(ctx.projectName);

      const lines = [
        `# Index Status: ${ctx.projectName}`,
        '',
        `- **Chunks:** ${stats.totalChunks.toLocaleString()}`,
        `- **Embedding provider:** ${stats.embeddingProvider}`,
        `- **Last indexed:** ${stats.lastIndexed || 'never'}`,
        `- **Repos:** ${stats.repos.length}`,
        '',
        '## Repos',
        ...stats.repos.map(r => `- ${r.name}: ${r.chunkCount} chunks`),
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Index tool error: ${msg}` }] };
  }
}
