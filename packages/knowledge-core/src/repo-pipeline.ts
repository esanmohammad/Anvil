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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { chunkRepo, chunkChangedFiles } from './chunker.js';
import { buildAstGraph, incrementalGraphUpdate, generateGraphReport } from './ast-graph-builder.js';
import { detectWorkspace } from './workspace-detector.js';
import { getAllChanges, getChangedFilesList, getDeletedFilesList } from './git-diff.js';
import { writeChunksFile } from './chunks-io.js';
import { initTreeSitter } from './tree-sitter-parser.js';
// Type-only (erased at runtime — keeps the worker lean): from the package barrel.
import type { FileIndexEntry, WorkspaceMap, GraphifyOutput } from '@esankhan3/anvil-knowledge-core';

export interface RepoIndexMeta {
  lastIndexedSha: string;
  lastIndexedAt: string;
  chunkCount: number;
  embeddingProvider: string;
  files?: Record<string, FileIndexEntry>;
}

export function getRepoSha(repoPath: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoPath, stdio: 'pipe', encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

export function readRepoIndexMeta(basePath: string, repoName: string): RepoIndexMeta | null {
  const metaPath = join(basePath, repoName, 'index_meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'));
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
}

export interface RepoResult {
  repoName: string;
  language: string;
  sha: string | null;
  graph: GraphifyOutput | null;
  workspaceMap: WorkspaceMap | null;
  chunked: boolean;
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
  const { repoName, repoPath, basePath, project, chunking, doChunk, force } = job;
  const repoKbDir = join(basePath, repoName);
  mkdirSync(repoKbDir, { recursive: true });

  const meta = force ? null : readRepoIndexMeta(basePath, repoName);
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
  let shardPath: string | null = null;
  let fileIndex: Record<string, FileIndexEntry> | null = null;
  let changedFiles: string[] = [];
  let deletedFiles: string[] = [];
  if (doChunk) {
    const result = useIncremental
      ? await chunkChangedFiles(repoPath, repoName, project, chunking, diff!)
      : await chunkRepo(repoPath, repoName, project, chunking, meta?.files ?? undefined);
    shardPath = join(repoKbDir, 'chunks.shard.ndjson');
    writeChunksFile(shardPath, result.chunks);
    fileIndex = result.fileIndex;
    chunkCount = Object.values(result.fileIndex).reduce((s, f) => s + (f as FileIndexEntry).chunkCount, 0);
    changedFiles = result.changedFiles ?? [];
    deletedFiles = result.deletedFiles ?? [];
  }

  let graph: GraphifyOutput | null = null;
  try {
    const existingGraphPath = join(repoKbDir, 'graph.json');
    if (useIncremental && existsSync(existingGraphPath)) {
      const existingGraph = JSON.parse(readFileSync(existingGraphPath, 'utf-8'));
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
    writeFileSync(existingGraphPath, JSON.stringify(graph));
    writeFileSync(join(repoKbDir, 'GRAPH_REPORT.md'), generateGraphReport(repoName, graph));
  } catch {
    graph = null; // AST failure is non-fatal (matches prior buildKB behavior)
  }

  return {
    repoName,
    language: job.language,
    sha: getRepoSha(repoPath),
    graph,
    workspaceMap,
    chunked: doChunk,
    shardPath,
    fileIndex,
    changedFiles,
    deletedFiles,
    chunkCount,
  };
}
