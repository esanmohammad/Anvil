/**
 * Per-repo indexing pipeline: chunk + AST graph + workspace detection for ONE
 * repo. Extracted so it can run either in the main thread or in a worker_thread
 * (index-worker.ts). Imports only the light, CPU-side modules (chunker, AST
 * builder, workspace, git-diff, tree-sitter) — deliberately NOT the vector
 * store / agent-core, so a worker stays lean and doesn't load native LanceDB.
 *
 * Chunks are streamed to a per-repo shard on disk; only the small per-repo
 * graph + metadata cross the worker boundary (never the chunks themselves).
 */

import { mkdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { chunkRepo, chunkChangedFiles } from './chunker.js';
import { buildAstGraph, incrementalGraphUpdate, generateGraphReport } from './ast-graph-builder.js';
import { detectWorkspace } from './workspace-detector.js';
import { getAllChanges, getChangedFilesList, getDeletedFilesList } from './git-diff.js';
import { createChunkWriter } from './chunks-io.js';
import { FsBlobStore } from './storage/fs-blob-store.js';
import { resolveStorage } from './storage/resolve.js';
import type { BlobStorePort } from './storage/ports.js';
import { initTreeSitter } from './tree-sitter-parser.js';
// Type-only (erased at runtime — keeps the worker lean): from the package barrel.
import type { FileIndexEntry, WorkspaceMap, WorkspacePackage, GraphifyOutput } from '@esankhan3/anvil-knowledge-core';
import { extractCrossRepoSignals } from './cross-repo-detector.js';
import type { KnowledgeConfig, KnowledgeStorageConfig } from './config.js';

export interface RepoIndexMeta {
  lastIndexedSha: string;
  lastIndexedAt: string;
  chunkCount: number;
  embeddingProvider: string;
  files?: Record<string, FileIndexEntry>;
  /** Serializable workspace packages (WorkspaceMap holds Maps, which don't
   *  survive JSON) — rehydrated for cross-repo correlation on skipped repos. */
  workspacePackages?: WorkspacePackage[];
}

export function getRepoSha(repoPath: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoPath, stdio: 'pipe', encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

/** HEAD sha of a REMOTE repo without cloning (`git ls-remote`) — lets the
 *  writer skip unchanged repos before paying for a clone (the k8s CronJob
 *  writer has no persistent clones; most repos are unchanged most cycles). */
export function getRemoteSha(cloneUrl: string): string | null {
  try {
    const out = execSync(`git ls-remote ${JSON.stringify(cloneUrl)} HEAD`, {
      stdio: 'pipe', encoding: 'utf-8', timeout: 30_000,
    });
    const sha = out.split(/\s/)[0]?.trim();
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export async function readRepoIndexMeta(
  basePath: string,
  repoName: string,
  blobs?: BlobStorePort,
): Promise<RepoIndexMeta | null> {
  try {
    const store = blobs ?? new FsBlobStore(basePath);
    return await store.getJson<RepoIndexMeta>(`${repoName}/index_meta.json`);
  } catch {
    return null;
  }
}

export interface RepoJob {
  repoName: string;
  repoPath: string;
  language: string;
  basePath: string;
  project: string;
  chunking: { maxTokens: number; contextEnrichment: 'structural' | 'llm' | 'none' };
  doChunk: boolean;
  force: boolean;
  /** Serializable storage config — a live BlobStorePort cannot cross the
   *  worker_thread boundary, so the worker reconstructs its own port from
   *  this block. Unset ⇒ FsBlobStore(basePath), today's behavior. */
  storage?: KnowledgeStorageConfig;
  /** Bounded-scratch writer mode: shallow-clone this URL to repoPath before
   *  processing and DELETE the clone afterwards. Peak disk = concurrency ×
   *  largest repo, never the whole org (~95GB). Unset ⇒ repoPath is a
   *  pre-existing local checkout, today's behavior. */
  cloneUrl?: string;
}

export interface RepoResult {
  repoName: string;
  language: string;
  sha: string | null;
  graph: GraphifyOutput | null;
  workspaceMap: WorkspaceMap | null;
  chunked: boolean;
  /** True when the shard holds ONLY changed files' chunks (git-diff incremental
   *  re-chunk) — the indexer must carry this repo's untouched-file chunks
   *  forward from the previous chunks.json. False = the shard is the repo's
   *  complete chunk set. */
  incremental: boolean;
  shardPath: string | null;
  fileIndex: Record<string, FileIndexEntry> | null;
  changedFiles: string[];
  deletedFiles: string[];
  chunkCount: number;
}

/** Chunk + build the AST graph for one repo. Writes a chunk shard + graph.json
 *  + GRAPH_REPORT.md to disk; returns the per-repo graph + metadata. Pure CPU +
 *  local FS — safe to run in a worker_thread. */
export async function processRepoPipeline(job: RepoJob): Promise<RepoResult> {
  await initTreeSitter(); // idempotent; first call per worker loads the WASM grammars
  if (!job.cloneUrl) return processCheckout(job);
  // Bounded-scratch writer mode: clone → process → ALWAYS discard the clone,
  // so a failed repo can't leak scratch across the run.
  execSync(
    `git clone --depth=1 --quiet ${JSON.stringify(job.cloneUrl)} ${JSON.stringify(job.repoPath)}`,
    { stdio: 'pipe', timeout: 600_000 },
  );
  try {
    return await processCheckout(job);
  } finally {
    try { rmSync(job.repoPath, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function processCheckout(job: RepoJob): Promise<RepoResult> {
  const { repoName, repoPath, basePath, project, chunking, doChunk, force } = job;
  // Chunk shards are LOCAL SCRATCH (streamed to disk, folded into chunks.json by
  // the indexer) — they stay on the local fs regardless of blob backend.
  const repoKbDir = join(basePath, repoName);
  mkdirSync(repoKbDir, { recursive: true });

  // KB artifacts (index_meta, graph.json, GRAPH_REPORT.md) go through the blob
  // port, reconstructed from the job's serializable storage block.
  const blobs: BlobStorePort = job.storage
    ? resolveStorage(project, { storage: job.storage } as KnowledgeConfig).blobs
    : new FsBlobStore(basePath);

  const meta = force ? null : await readRepoIndexMeta(basePath, repoName, blobs);
  const diff = force ? null : (meta?.lastIndexedSha ? getAllChanges(repoPath, meta.lastIndexedSha) : null);
  const useIncremental =
    !!diff && !diff.fallbackToFull && diff.added.length + diff.modified.length + diff.deleted.length > 0;

  let workspaceMap: WorkspaceMap | null = null;
  try {
    const ws = detectWorkspace(repoPath);
    if (ws.packages.length > 0) workspaceMap = ws;
  } catch {
    /* non-fatal */
  }

  let chunkCount = 0;
  let incremental = false;
  let shardPath: string | null = null;
  let fileIndex: Record<string, FileIndexEntry> | null = null;
  let changedFiles: string[] = [];
  let deletedFiles: string[] = [];
  if (doChunk) {
    shardPath = join(repoKbDir, 'chunks.shard.ndjson');
    // Stream chunks straight to the shard as the chunker produces them — never
    // hold a repo's full chunk set in memory. This bounds per-lane memory in the
    // worker pool (a big repo's chunks would otherwise be multi-GB × concurrency).
    const writer = createChunkWriter(shardPath);
    let result: Awaited<ReturnType<typeof chunkRepo>>;
    try {
      result = useIncremental
        ? await chunkChangedFiles(repoPath, repoName, project, chunking, diff!, writer.write)
        : await chunkRepo(repoPath, repoName, project, chunking, meta?.files ?? undefined, writer.write);
    } finally {
      writer.close();
    }
    incremental = useIncremental;
    fileIndex = result.fileIndex;
    chunkCount = Object.values(result.fileIndex).reduce((s, f) => s + (f as FileIndexEntry).chunkCount, 0);
    changedFiles = result.changedFiles ?? [];
    deletedFiles = result.deletedFiles ?? [];
  }

  let graph: GraphifyOutput | null = null;
  try {
    const graphKey = `${repoName}/graph.json`;
    const existingGraph = useIncremental ? await blobs.getJson<GraphifyOutput>(graphKey) : null;
    if (existingGraph) {
      graph = await incrementalGraphUpdate(
        existingGraph,
        getChangedFilesList(diff!),
        getDeletedFilesList(diff!),
        repoPath,
        { workspaceMap: workspaceMap ?? undefined },
      );
    } else {
      graph = await buildAstGraph(repoPath, { workspaceMap: workspaceMap ?? undefined });
    }
    // graph.json stays compact (JSON.stringify, no indent) for byte-parity.
    await blobs.putText(graphKey, JSON.stringify(graph));
    await blobs.putText(`${repoName}/GRAPH_REPORT.md`, generateGraphReport(repoName, graph));
  } catch {
    graph = null; // AST failure is non-fatal (matches prior buildKB behavior)
  }

  // Cross-repo signals: extracted HERE because this is the only moment the
  // working tree is guaranteed to exist (the bounded-scratch writer discards
  // the clone right after this function returns). Correlation joins these
  // persisted bundles later, on the main thread, without any tree.
  try {
    await blobs.putJson(`${repoName}/signals.json`, extractCrossRepoSignals(repoPath));
  } catch {
    // Non-fatal: this repo contributes no cross-repo edges until its next index.
  }

  return {
    repoName,
    language: job.language,
    sha: getRepoSha(repoPath),
    graph,
    workspaceMap,
    chunked: doChunk,
    incremental,
    shardPath,
    fileIndex,
    changedFiles,
    deletedFiles,
    chunkCount,
  };
}
