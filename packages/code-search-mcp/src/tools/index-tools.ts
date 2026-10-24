/**
 * Index tools — index_status.
 */

import type { ServerContext } from '../server.js';
import { resolvedKnowledgeConfig } from '../core/env-config.js';
import { KnowledgeIndexer } from '@esankhan3/anvil-knowledge-core';
import type { VectorIndexHealth } from '@esankhan3/anvil-knowledge-core';
import { toolError, type ToolResult } from './validate.js';

const TOOL_NAMES = ['index_status'];

/** One-line summary of the writer's vector-index record. */
function describeVectorIndex(v: VectorIndexHealth | undefined): string {
  if (!v) return 'none (flat scan — table below the index threshold or not yet indexed)';
  const parts = [`${v.indexType ?? 'unknown'}, ${v.numPartitions ?? '?'} partitions`];
  parts.push(
    v.trainedRows
      ? `trained on ${v.trainedRows.toLocaleString()} rows at ${v.trainedAt}, +${v.rowsAddedSinceTrain.toLocaleString()} since (${Math.round((v.rowsAddedSinceTrain / v.trainedRows) * 100)}%)`
      : 'training untracked (retrains on the next writer run)',
  );
  parts.push(`${(v.numUnindexedRows ?? 0).toLocaleString()} unindexed rows`);
  if (v.nprobes) {
    parts.push(`${v.nprobes} probes per query (recall@10 ${v.calibratedRecall?.toFixed(3)} on ${v.calibrationQueries} query-like probes)`);
  }
  if (v.retrainStartedAt) parts.push(`retrain started ${v.retrainStartedAt} has not completed`);
  if (v.lastError) parts.push(`last error: ${v.lastError}`);
  return parts.join('; ');
}

export function registerIndexTools() {
  return [
    {
      name: 'index_status',
      description: 'Get current index stats — chunk count, embedding provider, last indexed time, vector-index health, and chunks per repo.',
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
): Promise<ToolResult | null> {
  if (!TOOL_NAMES.includes(name)) return null;

  try {
    if (name === 'index_status') {
      const indexer = new KnowledgeIndexer();
      const stats = await indexer.getStats(ctx.projectName, resolvedKnowledgeConfig());

      const lines = [
        `# Index Status: ${ctx.projectName}`,
        '',
        `- **Chunks:** ${stats.totalChunks.toLocaleString()}`,
        `- **Embedding provider:** ${stats.embeddingProvider}`,
        `- **Last indexed:** ${stats.lastIndexed || 'never'}`,
        `- **Repos:** ${stats.repos.length}`,
        `- **Vector index:** ${describeVectorIndex(stats.vectorIndex)}`,
        '',
        '## Repos',
        ...stats.repos.map(r => `- ${r.name}: ${r.chunkCount} chunks`),
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolError(`Index tool error: ${msg}`);
  }
}
