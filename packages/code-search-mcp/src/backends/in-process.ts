/**
 * In-process search backend — runs the retriever + indexer locally.
 * Drop-in replacement for the historical "just call getRetriever()" code
 * path. Threaded with an explicit KnowledgeConfig so issue #6 stays fixed
 * regardless of how the backend was instantiated.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  getRetriever,
  indexFromPath,
  getKnowledgeBasePath,
  KnowledgeIndexer,
  VectorStore,
  type KnowledgeConfig,
} from '@esankhan3/anvil-knowledge-core';
import { metrics } from '../observability/metrics.js';
import type {
  BackendConfig,
  IndexStatusPayload,
  SearchBackend,
  SearchOpts,
  SearchResultPayload,
} from './types.js';

export class InProcessBackend implements SearchBackend {
  readonly kind = 'in-process' as const;
  readonly project: string;
  private readonly workspaceDir: string | null;
  private readonly knowledge: KnowledgeConfig;
  private readonly startedAt = Date.now();

  constructor(cfg: BackendConfig) {
    this.project = cfg.project;
    this.workspaceDir = cfg.workspaceDir;
    this.knowledge = cfg.knowledge;
  }

  async search(query: string, opts: SearchOpts): Promise<SearchResultPayload> {
    const started = Date.now();
    let outcome: 'ok' | 'error' = 'ok';
    let retriever: Awaited<ReturnType<typeof getRetriever>> | undefined;
    try {
      retriever = await getRetriever(this.project, this.knowledge);
      const modeMap = {
        hybrid: 'vector+bm25+graph',
        vector: 'vector',
        bm25: 'bm25',
      } as const;
      const result = await retriever.retrieve(query, {
        maxChunks: opts.maxResults ?? this.knowledge.retrieval.maxChunks,
        repoFilter: opts.repos,
        mode: modeMap[opts.mode] as 'vector' | 'bm25' | 'vector+bm25+graph',
      });
      return {
        query: result.query,
        totalTokens: result.totalTokens,
        chunks: result.chunks.map((sc) => ({
          filePath: sc.chunk.filePath,
          startLine: sc.chunk.startLine,
          endLine: sc.chunk.endLine,
          language: sc.chunk.language,
          repoName: sc.chunk.repoName,
          score: sc.score,
          source: sc.source,
          content: sc.chunk.content,
        })),
      };
    } catch (err) {
      outcome = 'error';
      metrics.errors.inc({ kind: 'search' });
      throw err;
    } finally {
      // Release the GraphStore's SQLite connection — the retriever is created
      // per request, so without this each search would leak an fd until GC.
      retriever?.close?.();
      const elapsed = (Date.now() - started) / 1000;
      metrics.queriesTotal.inc({ mode: opts.mode, outcome });
      metrics.queryDuration.observe(elapsed, { mode: opts.mode });
    }
  }

  async status(): Promise<IndexStatusPayload> {
    const indexer = new KnowledgeIndexer();
    const stats = await indexer.getStats(this.project);
    return {
      totalChunks: stats.totalChunks,
      repos: stats.repos,
      embeddingProvider: stats.embeddingProvider,
      lastIndexedAt: stats.lastIndexed || null,
      watching: false,
      queueDepth: 0,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  async forceIndex(opts?: { force?: boolean }): Promise<IndexStatusPayload> {
    if (!this.workspaceDir) {
      throw new Error('InProcessBackend.forceIndex requires a workspaceDir');
    }
    await indexFromPath(this.project, this.workspaceDir, {
      force: opts?.force,
      config: this.knowledge,
    });
    return this.status();
  }

  async invalidate(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const basePath = getKnowledgeBasePath(this.project);
    const dbPath = join(basePath, 'lancedb');
    if (!existsSync(dbPath)) return;
    const store = new VectorStore(dbPath);
    await store.init();
    // Group by repoName when possible — for now, infer per call site.
    // Repo grouping is the caller's responsibility; for arbitrary paths we
    // invalidate by passing the project-scoped path list across all repos.
    const stats = await store.getStats();
    if (!stats || stats.rowCount === 0) return;
    // Best-effort: delete by file path within each known repo.
    const indexer = new KnowledgeIndexer();
    const summary = await indexer.getStats(this.project);
    for (const r of summary.repos) {
      await store.deleteFileChunks(this.project, r.name, paths);
    }
  }

  async close(): Promise<void> {
    // Nothing to release — retriever and store are short-lived per call.
  }
}
