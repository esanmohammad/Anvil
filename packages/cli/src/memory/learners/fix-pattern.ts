// Fix-pattern recorder — Section C.1

import { createMemoryEntry } from '../entry-factory.js';
import { createMemoryStore } from '../index.js';
import type { MemoryEntry } from '../types.js';

/**
 * Record a fix pattern: how an error was resolved.
 * Creates a fix-pattern memory with confidence 60.
 */
export function recordFixPattern(
  error: string,
  fix: string,
  project: string,
): MemoryEntry {
  const content = `Error: ${error}\nFix: ${fix}`;
  const entry = createMemoryEntry('fix-pattern', content, {
    confidence: 60,
    source: 'auto-learn',
    tags: ['fix', 'error', project],
  });

  const store = createMemoryStore(project);
  store.add(entry);
  return entry;
}
