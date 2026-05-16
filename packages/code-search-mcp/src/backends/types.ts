/**
 * SearchBackend — interface that both the in-process and daemon-backed
 * implementations satisfy. Tool handlers depend on this interface, never on
 * the underlying retriever class, so the MCP server can pick its substrate
 * at boot without touching tool code.
 */

import type { KnowledgeConfig } from '@esankhan3/anvil-knowledge-core';

export type SearchMode = 'hybrid' | 'vector' | 'bm25';

export interface SearchHit {
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  repoName: string;
  score: number;
  source: string;
  content: string;
}

export interface SearchResultPayload {
  query: string;
  totalTokens: number;
  chunks: SearchHit[];
}

export interface IndexStatusPayload {
  totalChunks: number;
  repos: Array<{ name: string; chunkCount: number; language: string }>;
  embeddingProvider: string;
  lastIndexedAt: string | null;
  watching: boolean;
  queueDepth: number;
  uptimeSec: number;
}

export interface SearchOpts {
  mode: SearchMode;
  maxResults?: number;
  repos?: string[];
}

export interface SearchBackend {
  /** Identify the backend ("in-process" or "daemon"). */
  readonly kind: 'in-process' | 'daemon';

  /** Project name (used as the storage namespace). */
  readonly project: string;

  /** Run a search and return the typed payload. */
  search(query: string, opts: SearchOpts): Promise<SearchResultPayload>;

  /** Get current index status. */
  status(): Promise<IndexStatusPayload>;

  /** Trigger a full reindex. */
  forceIndex(opts?: { force?: boolean }): Promise<IndexStatusPayload>;

  /** Drop chunks for the given paths from the index (test seam). */
  invalidate(paths: string[]): Promise<void>;

  /** Release any underlying resources. */
  close(): Promise<void>;
}

export interface BackendConfig {
  project: string;
  workspaceDir: string | null;
  knowledge: KnowledgeConfig;
  socketPath?: string;
  /** If true and daemon socket is present, prefer the daemon backend. */
  preferDaemon: boolean;
}
