// Success recorder — Section C.2

import { createMemoryStore } from '../index.js';
import {
  createMemoryEntry,
  type MemoryEntry,
} from '@anvil/memory-core/legacy/index.js';

/**
 * Record a successful feature implementation.
 * Creates a success memory with confidence 50.
 */
export function recordSuccess(
  feature: string,
  project: string,
  summary: string,
): MemoryEntry {
  const content = `Feature: ${feature}\nSummary: ${summary}`;
  const entry = createMemoryEntry('success', content, {
    confidence: 50,
    source: 'auto-learn',
    tags: ['success', 'feature', project],
  });

  const store = createMemoryStore(project);
  store.add(entry);
  return entry;
}
