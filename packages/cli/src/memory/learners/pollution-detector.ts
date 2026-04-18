// Pollution detector — Section C.4

import type { MemoryStore } from '../memory-store.js';
import { getMemoryUsage } from '../usage-tracker.js';
import type { MemoryEntry } from '../types.js';

/**
 * Detect memories that appear in 3+ failed runs and reduce their confidence by 20.
 * Returns the IDs of polluted memories that were adjusted.
 */
export function detectPollution(
  store: MemoryStore,
  failedRunIds: string[],
): string[] {
  if (failedRunIds.length < 3) return [];

  const usageRecords = getMemoryUsage();
  const failedSet = new Set(failedRunIds);

  // Count how many failed runs each memory appeared in
  const failedCounts = new Map<string, number>();
  for (const record of usageRecords) {
    if (failedSet.has(record.runId)) {
      for (const memId of record.memoryIds) {
        failedCounts.set(memId, (failedCounts.get(memId) ?? 0) + 1);
      }
    }
  }

  // Find memories in 3+ failed runs
  const pollutedIds: string[] = [];
  const entries = store.list();
  const updated: MemoryEntry[] = [];

  for (const entry of entries) {
    const count = failedCounts.get(entry.id) ?? 0;
    if (count >= 3) {
      pollutedIds.push(entry.id);
      updated.push({
        ...entry,
        confidence: Math.max(0, entry.confidence - 20),
      });
    } else {
      updated.push(entry);
    }
  }

  if (pollutedIds.length > 0) {
    store.replaceAll(updated);
  }

  return pollutedIds;
}
