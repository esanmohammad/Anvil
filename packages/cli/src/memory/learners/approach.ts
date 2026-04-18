// Approach recorder — Section C.3

import { createMemoryEntry } from '../entry-factory.js';
import { createMemoryStore } from '../index.js';
import type { MemoryEntry } from '../types.js';

/**
 * Record an approach taken for a feature, especially when escalation happened.
 * Creates an approach memory with confidence 40.
 */
export function recordApproach(
  feature: string,
  project: string,
  approach: string,
  escalationReason: string,
): MemoryEntry {
  const content = `Feature: ${feature}\nApproach: ${approach}\nEscalation: ${escalationReason}`;
  const entry = createMemoryEntry('approach', content, {
    confidence: 40,
    source: 'auto-learn',
    tags: ['approach', 'escalation', project],
  });

  const store = createMemoryStore(project);
  store.add(entry);
  return entry;
}
