// Memory types — Section A.1

export type MemoryKind =
  | 'fix-pattern'
  | 'flaky-test'
  | 'approach'
  | 'performance'
  | 'manual'
  | 'success';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  createdAt: string;
  expiresAt: string;
  confidence: number; // 0-100
  source: string;
  tags: string[];
}

export interface MemoryQueryOpts {
  kind?: MemoryKind;
  tags?: string[];
  search?: string;
  minConfidence?: number;
  limit?: number;
}

export interface MemoryStoreConfig {
  path: string;
  maxSizeBytes: number;
  defaultTTLDays: number;
}

/** Default TTL: 30 days */
export const DEFAULT_TTL_DAYS = 30;

/** Max store size: 1 MB */
export const MAX_SIZE_BYTES = 1_048_576;
