// Memory injector — Section B.4
// Phase 4: namespace-aware. Accepts either a project name (backwards
// compatible) or a `MemoryNamespace` tuple in the second position.

import { createMemoryStore } from './index.js';
import {
  queryByTags,
  queryByContent,
  selectTopK,
  type MemoryEntry,
} from '@anvil/memory-core/legacy/index.js';
import type { MemoryNamespace } from '@anvil/memory-core';

export interface InjectionContext {
  tags?: string[];
  searchContent?: string;
  k?: number;
}

/**
 * Query memories by tags and content, select top-K, format as a prompt section.
 * Returns a markdown-formatted string ready for injection, or empty string if no memories.
 *
 * The second positional argument may be a project name (legacy form) or
 * a `MemoryNamespace` tuple (v2 form). A bare project name is normalized
 * to `{scope: 'project', projectId: project}` internally so the v2
 * namespace path resolver still picks up legacy `~/.anvil/memory/<project>/`
 * directories.
 */
export function injectMemories(
  stage: string,
  target: string | MemoryNamespace,
  context: InjectionContext,
): { text: string; memoryIds: string[] } {
  const store = createMemoryStore(target);

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
