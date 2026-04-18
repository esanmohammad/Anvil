// Expiration pruning — Section A.6

import type { MemoryStore } from './memory-store.js';

/**
 * Remove expired entries from the store.
 * Returns the number of entries removed.
 */
export function pruneExpired(store: MemoryStore): number {
  const entries = store.list();
  const now = Date.now();
  const alive = entries.filter((e) => new Date(e.expiresAt).getTime() > now);
  const removed = entries.length - alive.length;
  if (removed > 0) {
    store.replaceAll(alive);
  }
  return removed;
}
