// Memory usage tracker — Section B.5

import { join } from 'node:path';
import { appendJSONL, readJSONL } from '@anvil/memory-core/legacy/index.js';
import { getFFDirs } from '../home.js';

export interface MemoryUsageRecord {
  runId: string;
  stageIndex: number;
  memoryIds: string[];
  timestamp: string;
}

/**
 * Record which memories were used in a pipeline run stage.
 */
export function trackMemoryUsage(
  runId: string,
  stageIndex: number,
  memoryIds: string[],
): void {
  const dirs = getFFDirs();
  const filePath = join(dirs.memory, 'usage.jsonl');

  const record: MemoryUsageRecord = {
    runId,
    stageIndex,
    memoryIds,
    timestamp: new Date().toISOString(),
  };

  appendJSONL(filePath, record);
}

/**
 * Get all usage records (for analysis).
 */
export function getMemoryUsage(): MemoryUsageRecord[] {
  const dirs = getFFDirs();
  const filePath = join(dirs.memory, 'usage.jsonl');
  return readJSONL<MemoryUsageRecord>(filePath);
}
