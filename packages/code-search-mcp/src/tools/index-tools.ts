/**
 * Index management tools — status and reindex.
 */

import type { ServerContext } from '../server.js';
import { KnowledgeIndexer, indexFromPath } from '../core/indexer.js';

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
    {
      name: 'reindex',
      description: 'Trigger a re-index. Uses git diff for incremental updates — only re-processes changed files.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          force: { type: 'boolean', description: 'Force full re-index (ignore cache)' },
        },
      },
    },
  ];
}

export async function handleIndexTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  if (!['index_status', 'reindex'].includes(name)) return null;

  try {
    if (name === 'index_status') {
      const { KnowledgeIndexer } = await import('../../core/indexer');
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

    if (name === 'reindex') {
      if (!ctx.directoryPath) {
        return { content: [{ type: 'text', text: 'No directory path configured. Cannot reindex.' }] };
      }

      const force = (args.force as boolean) ?? false;
      const { indexFromPath } = await import('../../core/indexer');

      const progressLines: string[] = [];
      const stats = await indexFromPath(ctx.projectName, ctx.directoryPath, {
        force,
        onProgress: (m) => { progressLines.push(m); console.error(`[reindex] ${m}`); },
      });

      ctx.indexReady = true;

      return {
        content: [{
          type: 'text',
          text: [
            `# Reindex Complete`,
            '',
            `- **Chunks:** ${stats.totalChunks.toLocaleString()}`,
            `- **Repos:** ${stats.repos.length}`,
            `- **Duration:** ${Math.round(stats.indexDurationMs / 1000)}s`,
            `- **Cross-repo edges:** ${stats.crossRepoEdges}`,
            '',
            '## Log',
            ...progressLines.map(l => `- ${l}`),
          ].join('\n'),
        }],
      };
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Index tool error: ${msg}` }] };
  }
}
