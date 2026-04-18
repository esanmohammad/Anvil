// Memory injector — Section B.4

import { createMemoryStore } from './index.js';
import { queryByTags } from './query-by-tags.js';
import { queryByContent } from './query-by-content.js';
import { selectTopK } from './top-k.js';
import type { MemoryEntry } from './types.js';

export interface InjectionContext {
  tags?: string[];
  searchContent?: string;
  k?: number;
}

/**
 * Query memories by tags and content, select top-K, format as a prompt section.
 * Returns a markdown-formatted string ready for injection, or empty string if no memories.
 */
export function injectMemories(
  stage: string,
  project: string,
  context: InjectionContext,
): { text: string; memoryIds: string[] } {
  const store = createMemoryStore(project);

  const results: MemoryEntry[] = [];

  if (context.tags && context.tags.length > 0) {
    results.push(...queryByTags(store, context.tags));
  }

  if (context.searchContent) {
    results.push(...queryByContent(store, context.searchContent));
  }

  const topK = selectTopK(results, context.k ?? 5);

  if (topK.length === 0) {
    return { text: '', memoryIds: [] };
  }

  const lines = [
    `## Relevant Memories (${stage})`,
    '',
    ...topK.map(
      (entry) =>
        `- **[${entry.kind}]** (confidence: ${entry.confidence}) ${entry.content}`,
    ),
    '',
  ];

  return {
    text: lines.join('\n'),
    memoryIds: topK.map((e) => e.id),
  };
}
