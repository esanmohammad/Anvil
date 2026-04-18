import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, basename } from 'node:path';

import { chunkRepo, chunkChangedFiles } from './chunker.js';
import type { FileIndexEntry } from './chunker.js';
import { buildAstGraph, generateGraphReport, incrementalGraphUpdate } from './ast-graph-builder.js';
import { getAllChanges, getChangedFilesList, getDeletedFilesList } from './git-diff.js';
import type { GitDiff } from './git-diff.js';
import { createEmbeddingProvider } from './embedder.js';
import { VectorStore } from './vector-store.js';
import { ProjectGraphBuilder } from './project-graph-builder.js';
import { detectCrossRepoEdges } from './cross-repo-detector.js';
import { detectWorkspace } from './workspace-detector.js';
import { HybridRetriever } from './retriever.js';
import { loadKnowledgeConfig, getKnowledgeBasePath, DEFAULT_CONFIG } from './config.js';
import type { KnowledgeConfig } from './config.js';
import type { CodeChunk, IndexStats, WorkspaceMap } from './types';
import { profileProject, loadAllProfiles } from './repo-profiler.js';
import { inferServiceMesh } from './service-mesh-inferrer.js';
import { computeStructuralHashes, deduplicateByStructure } from './structural-hasher.js';
import { createQueryRouter } from './query-router.js';

// ---------------------------------------------------------------------------
// SHA-based staleness detection
// ---------------------------------------------------------------------------

interface RepoIndexMeta {
  lastIndexedSha: string;
  lastIndexedAt: string;
  chunkCount: number;
  embeddingProvider: string;
  files?: Record<string, FileIndexEntry>;
}

function getRepoSha(repoPath: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoPath, stdio: 'pipe', encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function readRepoIndexMeta(basePath: string, repoName: string): RepoIndexMeta | null {
  const metaPath = join(basePath, repoName, 'index_meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeRepoIndexMeta(basePath: string, repoName: string, meta: RepoIndexMeta): void {
  const dir = join(basePath, repoName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

export interface IndexProgress {
  phase: 'profiling' | 'chunking' | 'dedup' | 'embedding' | 'graphing' | 'storing' | 'service-mesh' | 'done';
  message: string;
  /** 0-100 */
  percent: number;
  /** Estimated seconds remaining, -1 if unknown */
  etaSeconds: number;
  chunksTotal?: number;
  chunksProcessed?: number;
  reposTotal?: number;
  reposProcessed?: number;
  skippedRepos?: string[];
}

// ---------------------------------------------------------------------------
// Knowledge Indexer
// ---------------------------------------------------------------------------

export interface BuildKBResult {
  project: string;
  repos: Array<{ name: string; chunkCount: number; language: string }>;
  totalChunks: number;
  totalTokens: number;
  crossRepoEdges: number;
  durationMs: number;
  /** Chunks saved to disk, ready for embedding */
  chunksPath: string;
}

export class KnowledgeIndexer {

  // ---------------------------------------------------------------------------
  // BUILD KB — fast, static, no embedding. Profiles + chunks + graphs + edges.
  // ---------------------------------------------------------------------------

  async buildKB(
    project: string,
    repos: Array<{ name: string; path: string; language: string }>,
    config: KnowledgeConfig,
    opts?: {
      onProgress?: (msg: string) => void;
      onDetailedProgress?: (progress: IndexProgress) => void;
      force?: boolean;
    },
  ): Promise<BuildKBResult> {
    const log = opts?.onProgress ?? (() => {});
    const report = opts?.onDetailedProgress ?? (() => {});
    const startTime = Date.now();
    const basePath = getKnowledgeBasePath(project);
    mkdirSync(basePath, { recursive: true });

    // 1. Determine which repos need re-indexing (SHA check)
    const reposToIndex: typeof repos = [];
    const skippedRepos: string[] = [];

    for (const repo of repos) {
      if (opts?.force) {
        reposToIndex.push(repo);
        continue;
      }
      const currentSha = getRepoSha(repo.path);
      const meta = readRepoIndexMeta(basePath, repo.name);
      if (meta && currentSha && meta.lastIndexedSha === currentSha) {
        skippedRepos.push(repo.name);
        log(`Skipping ${repo.name} — unchanged (${currentSha.slice(0, 7)})`);
      } else {
        reposToIndex.push(repo);
      }
    }

    if (reposToIndex.length === 0) {
      log('All repos up to date — nothing to build.');
      report({ phase: 'done', message: 'All repos up to date', percent: 100, etaSeconds: 0, skippedRepos });
      return { project, repos: [], totalChunks: 0, totalTokens: 0, crossRepoEdges: 0, durationMs: 0, chunksPath: join(basePath, 'chunks.json') };
    }

    // 2. LLM Repo Profiling (WS-1)
    report({ phase: 'profiling', message: `Profiling ${repos.length} repos with LLM...`, percent: 3, etaSeconds: -1, reposTotal: repos.length, reposProcessed: 0 });
    log(`Profiling ${repos.length} repos with Claude...`);
    try {
      const profiles = await profileProject(project, repos, {
        model: 'claude-sonnet-4-6',
        force: opts?.force,
        onProgress: (m) => {
          log(m);
          report({ phase: 'profiling', message: m, percent: 5, etaSeconds: -1 });
        },
      });
      log(`Profiled ${profiles.length} repos`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Warning: Repo profiling skipped: ${errMsg}`);
      report({ phase: 'profiling', message: `Profiling skipped: ${errMsg.slice(0, 100)}`, percent: 8, etaSeconds: -1 });
    }

    // 3. Chunk repos — use git diff for incremental detection
    report({ phase: 'chunking', message: `Chunking ${reposToIndex.length} repos...`, percent: 10, etaSeconds: -1, reposTotal: repos.length, reposProcessed: skippedRepos.length, skippedRepos });
    log(`Chunking ${reposToIndex.length} repos (${skippedRepos.length} skipped — unchanged)...`);
    const allChunks: CodeChunk[] = [];
    const repoStats: Array<{ name: string; chunkCount: number; language: string }> = [];
    const repoChunkResults = new Map<string, { changedFiles: string[]; deletedFiles: string[]; fileIndex: Record<string, FileIndexEntry> }>();
    const repoDiffs = new Map<string, GitDiff>();

    for (const repo of reposToIndex) {
      const meta = opts?.force ? null : readRepoIndexMeta(basePath, repo.name);

      // Use git diff for incremental change detection (O(1) via git's Merkle DAG)
      const diff = opts?.force ? null : (meta?.lastIndexedSha ? getAllChanges(repo.path, meta.lastIndexedSha) : null);
      const useIncremental = diff && !diff.fallbackToFull && (diff.added.length + diff.modified.length + diff.deleted.length) > 0;

      let result;
      if (useIncremental) {
        const changedCount = diff.added.length + diff.modified.length;
        const deletedCount = diff.deleted.length;
        log(`  ${repo.name}: git diff → ${changedCount} changed, ${deletedCount} deleted (incremental)`);
        result = await chunkChangedFiles(repo.path, repo.name, project, config.chunking, diff);
        repoDiffs.set(repo.name, diff);
      } else {
        // Full re-chunk (first index or force)
        result = await chunkRepo(repo.path, repo.name, project, config.chunking, meta?.files ?? undefined);
      }

      allChunks.push(...result.chunks);
      repoChunkResults.set(repo.name, result);
      const totalChunkCount = Object.values(result.fileIndex).reduce((sum: number, f: any) => sum + f.chunkCount, 0);
      repoStats.push({ name: repo.name, chunkCount: totalChunkCount, language: repo.language });
    }
    for (const name of skippedRepos) {
      const meta = readRepoIndexMeta(basePath, name);
      repoStats.push({ name, chunkCount: meta?.chunkCount ?? 0, language: '' });
    }
    log(`Chunked ${allChunks.length} chunks from ${reposToIndex.length} repos`);

    // 4. Structural dedup (WS-6)
    report({ phase: 'dedup', message: 'Deduplicating chunks by structure...', percent: 25, etaSeconds: -1 });
    const dedupResult = deduplicateByStructure(allChunks);
    const uniqueChunks = dedupResult.unique;
    if (dedupResult.savings.chunks > 0) {
      log(`Structural dedup: ${dedupResult.savings.chunks} duplicates removed`);
    }

    // 5. Detect workspace structures
    const workspaceMaps = new Map<string, WorkspaceMap>();
    for (const repo of repos) {
      try {
        const wsMap = detectWorkspace(repo.path);
        if (wsMap.packages.length > 0) {
          workspaceMaps.set(repo.name, wsMap);
          log(`Detected workspace in ${repo.name}: ${wsMap.packages.length} packages`);
        }
      } catch (err) {
        log(`Warning: Workspace detection failed for ${repo.name}: ${err}`);
      }
    }

    // 6. Build AST graphs — incremental when possible via git diff
    report({ phase: 'graphing', message: 'Building AST graphs...', percent: 40, etaSeconds: -1 });
    const graphBuilder = new ProjectGraphBuilder();
    await graphBuilder.init();

    for (const repo of repos) {
      try {
        const repoKbDir = join(basePath, repo.name);
        mkdirSync(repoKbDir, { recursive: true });
        const existingGraphPath = join(repoKbDir, 'graph.json');
        const diff = repoDiffs.get(repo.name);

        let graph;
        if (diff && !diff.fallbackToFull && existsSync(existingGraphPath)) {
          // Incremental graph update — only re-parse changed files
          const existingGraph = JSON.parse(readFileSync(existingGraphPath, 'utf-8'));
          graph = await incrementalGraphUpdate(
            existingGraph,
            getChangedFilesList(diff),
            getDeletedFilesList(diff),
            repo.path,
            { workspaceMap: workspaceMaps.get(repo.name) },
          );
          log(`Updated AST graph for ${repo.name} incrementally (${diff.added.length + diff.modified.length} files changed)`);
        } else {
          // Full rebuild
          graph = await buildAstGraph(repo.path, { workspaceMap: workspaceMaps.get(repo.name) });
          log(`Built AST graph for ${repo.name} (${graph.nodes.length} nodes, ${graph.links.length} edges)`);
        }

        graphBuilder.addRepoGraph(repo.name, graph);
        writeFileSync(join(repoKbDir, 'graph.json'), JSON.stringify(graph));
        writeFileSync(join(repoKbDir, 'GRAPH_REPORT.md'), generateGraphReport(repo.name, graph));
      } catch (err) {
        log(`Warning: AST graph build failed for ${repo.name}: ${err}`);
      }
    }

    // 7. Detect cross-repo edges (14 strategies)
    report({ phase: 'graphing', message: 'Detecting cross-repo edges...', percent: 70, etaSeconds: -1 });
    let crossRepoEdgeCount = 0;
    const hasWorkspaces = workspaceMaps.size > 0;
    if (repos.length > 1 || hasWorkspaces) {
      const crossEdges = await detectCrossRepoEdges(repos, workspaceMaps);
      graphBuilder.addCrossRepoEdges(crossEdges);
      crossRepoEdgeCount = crossEdges.length;
      log(`Detected ${crossEdges.length} cross-repo edges`);
    }

    // 8. LLM Service Mesh Inference (WS-2)
    report({ phase: 'service-mesh', message: 'Inferring service mesh from profiles...', percent: 80, etaSeconds: -1 });
    try {
      const profiles = loadAllProfiles(project);
      if (profiles.length > 0) {
        log(`Inferring service mesh from ${profiles.length} profiles...`);
        const meshEdges = await inferServiceMesh(profiles, {
          model: 'claude-sonnet-4-6',
          onProgress: (m) => {
            log(m);
            report({ phase: 'service-mesh', message: m, percent: 82, etaSeconds: -1 });
          },
        });
        if (meshEdges.length > 0) {
          graphBuilder.addCrossRepoEdges(meshEdges);
          crossRepoEdgeCount += meshEdges.length;
          log(`Service mesh: ${meshEdges.length} edges inferred`);
        }
      } else {
        log('No profiles found — skipping service mesh inference');
      }
    } catch (err) {
      log(`Warning: Service mesh inference failed (non-fatal): ${err}`);
    }

    // 9. Community detection
    report({ phase: 'graphing', message: 'Detecting communities...', percent: 90, etaSeconds: -1 });
    graphBuilder.detectCommunities();

    // 10. Save project graph
    const graphOutputPath = join(basePath, 'system_graph_v2.json');
    writeFileSync(graphOutputPath, JSON.stringify(graphBuilder.exportJson(), null, 2));
    log(`Saved project graph to ${graphOutputPath}`);

    // 11. Save chunks to disk (for later embedding)
    const chunksPath = join(basePath, 'chunks.json');
    writeFileSync(chunksPath, JSON.stringify(uniqueChunks));
    log(`Saved ${uniqueChunks.length} chunks to ${chunksPath}`);

    // 11b. Save deleted files list (for incremental embedding cleanup)
    const allDeletedFiles: Array<{ repoName: string; filePath: string }> = [];
    for (const repo of reposToIndex) {
      const result = repoChunkResults.get(repo.name);
      if (result?.deletedFiles) {
        for (const f of result.deletedFiles) {
          allDeletedFiles.push({ repoName: repo.name, filePath: f });
        }
      }
    }
    const deletedPath = join(basePath, 'deleted_files.json');
    writeFileSync(deletedPath, JSON.stringify(allDeletedFiles));

    // 12. Save per-repo metadata
    for (const repo of reposToIndex) {
      const sha = getRepoSha(repo.path);
      const result = repoChunkResults.get(repo.name);
      const totalChunkCount = result ? Object.values(result.fileIndex).reduce((sum: number, f: any) => sum + f.chunkCount, 0) : 0;
      if (sha) {
        writeRepoIndexMeta(basePath, repo.name, {
          lastIndexedSha: sha,
          lastIndexedAt: new Date().toISOString(),
          chunkCount: totalChunkCount,
          embeddingProvider: 'pending',
          files: result?.fileIndex,
        });
      }
    }

    const durationMs = Date.now() - startTime;
    report({ phase: 'done', message: `KB built: ${uniqueChunks.length} chunks, ${crossRepoEdgeCount} edges in ${formatEta(Math.ceil(durationMs / 1000))}`, percent: 100, etaSeconds: 0, skippedRepos });

    return {
      project,
      repos: repoStats,
      totalChunks: uniqueChunks.length,
      totalTokens: uniqueChunks.reduce((sum, c) => sum + c.tokens, 0),
      crossRepoEdges: crossRepoEdgeCount,
      durationMs,
      chunksPath,
    };
  }

  // ---------------------------------------------------------------------------
  // EMBED — incremental: only embeds new/changed chunks, preserves existing.
  // ---------------------------------------------------------------------------

  async embedChunks(
    project: string,
    config: KnowledgeConfig,
    opts?: {
      onProgress?: (msg: string) => void;
      onDetailedProgress?: (progress: IndexProgress) => void;
    },
  ): Promise<IndexStats> {
    const log = opts?.onProgress ?? (() => {});
    const report = opts?.onDetailedProgress ?? (() => {});
    const startTime = Date.now();
    const basePath = getKnowledgeBasePath(project);

    // Load chunks from disk (only new/changed chunks from buildKB)
    const chunksPath = join(basePath, 'chunks.json');
    if (!existsSync(chunksPath)) {
      throw new Error(`No chunks found — run Build KB first. Expected: ${chunksPath}`);
    }
    const chunks: CodeChunk[] = JSON.parse(readFileSync(chunksPath, 'utf-8'));
    log(`Loaded ${chunks.length} chunks from ${chunksPath}`);

    // Open vector store
    const dbPath = join(basePath, 'lancedb');
    const vectorStore = new VectorStore(dbPath);
    await vectorStore.init();

    // Determine which chunks actually need embedding by checking existing IDs
    const existingIds = new Set<string>();
    try {
      const stats = await vectorStore.getStats();
      if (stats && stats.rowCount > 0) {
        // Load existing chunk IDs from the store
        const existingChunks = await vectorStore.getChunkIds(project);
        for (const id of existingChunks) existingIds.add(id);
      }
    } catch { /* first run — no existing data */ }

    const newChunks = chunks.filter((c) => !existingIds.has(c.id));
    const deletedIds = this.getDeletedChunkIds(basePath, project);

    if (newChunks.length === 0 && deletedIds.length === 0) {
      log('All chunks already embedded — nothing to do.');
      report({ phase: 'done', message: 'All chunks already embedded', percent: 100, etaSeconds: 0 });
      const repoNames = [...new Set(chunks.map((c) => c.repoName))];
      return {
        project,
        repos: repoNames.map((n) => ({ name: n, chunkCount: chunks.filter((c) => c.repoName === n).length, language: '' })),
        totalChunks: chunks.length,
        totalTokens: chunks.reduce((sum, c) => sum + c.tokens, 0),
        embeddingProvider: 'cached',
        embeddingDimensions: 0,
        crossRepoEdges: 0,
        lastIndexed: new Date().toISOString(),
        indexDurationMs: Date.now() - startTime,
      };
    }

    // Delete chunks for files that were removed
    if (deletedIds.length > 0) {
      log(`Removing ${deletedIds.length} stale chunks from vector store...`);
      await vectorStore.deleteChunksByIds(deletedIds);
    }

    // Embed only new/changed chunks
    const embedder = createEmbeddingProvider(config.embedding);
    const isOllama = embedder.name === 'ollama';
    const batchSize = isOllama ? 10 : 50;
    const batchDelay = isOllama ? 50 : 100;

    log(`Embedding ${newChunks.length} new chunks with ${embedder.name} (${chunks.length - newChunks.length} cached, batch size: ${batchSize})...`);

    const texts = newChunks.map((c) => c.contextualizedContent);
    const embeddings: number[][] = [];
    const totalBatches = Math.ceil(texts.length / batchSize);
    let batchesDone = 0;
    const embedStartTime = Date.now();

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchEmbeddings = await embedder.embed(batch);
      embeddings.push(...batchEmbeddings);
      batchesDone++;

      const elapsed = Date.now() - embedStartTime;
      const msPerBatch = elapsed / batchesDone;
      const remainingBatches = totalBatches - batchesDone;
      const etaSeconds = Math.ceil((msPerBatch * remainingBatches) / 1000);
      const percent = Math.round(5 + (batchesDone / totalBatches) * 85);
      const processed = Math.min(i + batchSize, texts.length);

      report({
        phase: 'embedding',
        message: `Embedding: ${processed}/${texts.length} new (~${etaSeconds}s remaining)`,
        percent, etaSeconds,
        chunksTotal: texts.length, chunksProcessed: processed,
      });

      if (batchesDone % 10 === 0 || batchesDone === totalBatches) {
        log(`  Embedded ${processed}/${texts.length} (ETA: ${formatEta(etaSeconds)})`);
      }
      if (i + batchSize < texts.length && batchDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, batchDelay));
      }
    }

    const embeddedChunks = newChunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] }));

    // Add only new chunks to LanceDB (existing ones are preserved)
    report({ phase: 'storing', message: 'Saving new chunks to vector database...', percent: 92, etaSeconds: -1 });
    if (embeddedChunks.length > 0) {
      await vectorStore.addChunks(embeddedChunks);
    }
    log(`Stored ${embeddedChunks.length} new chunks in LanceDB (${deletedIds.length} removed)`);

    // Update metadata
    const repoNames = [...new Set(chunks.map((c) => c.repoName))];
    for (const repoName of repoNames) {
      const metaPath = join(basePath, repoName, 'index_meta.json');
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
          meta.embeddingProvider = embedder.name;
          meta.lastIndexedAt = new Date().toISOString();
          writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        } catch { /* ok */ }
      }
    }

    const durationMs = Date.now() - startTime;
    report({ phase: 'done', message: `Embedded ${newChunks.length} new chunks (${deletedIds.length} removed) in ${formatEta(Math.ceil(durationMs / 1000))}`, percent: 100, etaSeconds: 0 });

    return {
      project,
      repos: repoNames.map((n) => ({ name: n, chunkCount: chunks.filter((c) => c.repoName === n).length, language: '' })),
      totalChunks: chunks.length,
      totalTokens: chunks.reduce((sum, c) => sum + c.tokens, 0),
      embeddingProvider: embedder.name,
      embeddingDimensions: embedder.dimensions,
      crossRepoEdges: 0,
      lastIndexed: new Date().toISOString(),
      indexDurationMs: durationMs,
    };
  }

  /** Collect chunk IDs that should be deleted (from files that were removed) */
  private getDeletedChunkIds(basePath: string, project: string): string[] {
    // Read the deleted files list saved by buildKB
    const deletedPath = join(basePath, 'deleted_files.json');
    if (!existsSync(deletedPath)) return [];
    try {
      const deleted: Array<{ repoName: string; filePath: string }> = JSON.parse(readFileSync(deletedPath, 'utf-8'));
      // Chunk IDs follow the pattern: project/repoName/filePath:startLine
      // We match by prefix: project/repoName/filePath
      return deleted.map((d) => `${project}/${d.repoName}/${d.filePath}`);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // FULL INDEX — convenience: buildKB + embedChunks in one call
  // ---------------------------------------------------------------------------

  async indexProject(
    project: string,
    repos: Array<{ name: string; path: string; language: string }>,
    config: KnowledgeConfig,
    opts?: {
      onProgress?: (msg: string) => void;
      onDetailedProgress?: (progress: IndexProgress) => void;
      force?: boolean;
    },
  ): Promise<IndexStats> {
    // Phase 1: Build KB (fast)
    await this.buildKB(project, repos, config, opts);

    // Phase 2: Embed (slow)
    return this.embedChunks(project, config, opts);
  }

  /** Load index statistics for a project */
  async getStats(project: string): Promise<IndexStats> {
    const basePath = getKnowledgeBasePath(project);
    const dbPath = join(basePath, 'lancedb');
    const store = new VectorStore(dbPath);
    await store.init();
    const stats = await store.getStats();

    // Read metadata from per-repo index_meta.json files
    let provider = 'unknown';
    let lastIndexed = '';
    const repos: Array<{ name: string; chunkCount: number; language: string }> = [];

    try {
      const { readdirSync } = await import('node:fs');
      for (const entry of readdirSync(basePath)) {
        const meta = readRepoIndexMeta(basePath, entry);
        if (meta) {
          repos.push({ name: entry, chunkCount: meta.chunkCount, language: '' });
          if (meta.embeddingProvider !== 'unknown') provider = meta.embeddingProvider;
          if (meta.lastIndexedAt > lastIndexed) lastIndexed = meta.lastIndexedAt;
        }
      }
    } catch { /* ignore */ }

    return {
      project,
      repos,
      totalChunks: stats?.rowCount ?? 0,
      totalTokens: 0,
      embeddingProvider: provider,
      embeddingDimensions: 0,
      crossRepoEdges: 0,
      lastIndexed,
      indexDurationMs: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Path-based discovery — NO YAML, NO config. Just a directory path.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', 'build', '__pycache__', '.venv', 'vendor', 'target']);

/**
 * Discover repos from a directory path. Zero config required.
 *
 * - If path IS a git repo → single repo
 * - If path CONTAINS git repos → multi-repo (scans subdirs)
 */
export function discoverRepos(directoryPath: string): Array<{ name: string; path: string; language: string }> {
  if (!existsSync(directoryPath)) return [];

  const repos: Array<{ name: string; path: string; language: string }> = [];

  // Check if directory itself is a git repo
  if (existsSync(join(directoryPath, '.git'))) {
    repos.push({
      name: basename(directoryPath),
      path: directoryPath,
      language: detectLanguage(directoryPath),
    });
    return repos;
  }

  // Scan subdirectories for git repos
  try {
    for (const entry of readdirSync(directoryPath)) {
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
      const fullPath = join(directoryPath, entry);
      try {
        if (!statSync(fullPath).isDirectory()) continue;
      } catch { continue; }
      if (!existsSync(join(fullPath, '.git'))) continue;

      repos.push({
        name: entry,
        path: fullPath,
        language: detectLanguage(fullPath),
      });
    }
  } catch { /* ignore */ }

  return repos;
}

/** Detect primary language of a repo from manifest files and file extensions */
function detectLanguage(repoPath: string): string {
  // Manifest-based detection (most reliable)
  if (existsSync(join(repoPath, 'go.mod'))) return 'go';
  if (existsSync(join(repoPath, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(repoPath, 'pom.xml')) || existsSync(join(repoPath, 'build.gradle'))) return 'java';
  if (existsSync(join(repoPath, 'composer.json'))) return 'php';
  if (existsSync(join(repoPath, 'pyproject.toml')) || existsSync(join(repoPath, 'setup.py'))) return 'python';

  // Check package.json for TS vs JS
  if (existsSync(join(repoPath, 'package.json'))) {
    if (existsSync(join(repoPath, 'tsconfig.json'))) return 'typescript';
    return 'javascript';
  }

  return 'unknown';
}

/**
 * Build KB from a directory path — fast, no embedding.
 * Profiles repos, chunks files, builds AST graphs, detects cross-repo edges.
 * Saves chunks.json for later embedding.
 */
export async function buildKBFromPath(
  projectName: string,
  directoryPath: string,
  opts?: {
    onProgress?: (msg: string) => void;
    onDetailedProgress?: (progress: IndexProgress) => void;
    force?: boolean;
  },
): Promise<BuildKBResult> {
  const log = opts?.onProgress ?? (() => {});
  log(`Scanning ${directoryPath} for repos...`);
  const repos = discoverRepos(directoryPath);
  if (repos.length === 0) throw new Error(`No git repos found in ${directoryPath}`);
  log(`Discovered ${repos.length} repos`);
  const indexer = new KnowledgeIndexer();
  return indexer.buildKB(projectName, repos, DEFAULT_CONFIG, opts);
}

/**
 * Embed chunks for a project that already has KB built.
 * Reads chunks.json, embeds with Ollama bge-m3, stores in LanceDB.
 */
export async function embedFromPath(
  projectName: string,
  opts?: {
    onProgress?: (msg: string) => void;
    onDetailedProgress?: (progress: IndexProgress) => void;
  },
): Promise<IndexStats> {
  const indexer = new KnowledgeIndexer();
  return indexer.embedChunks(projectName, DEFAULT_CONFIG, opts);
}

/**
 * Full index from a directory path — buildKB + embed in one call.
 */
export async function indexFromPath(
  projectName: string,
  directoryPath: string,
  opts?: {
    onProgress?: (msg: string) => void;
    onDetailedProgress?: (progress: IndexProgress) => void;
    force?: boolean;
  },
): Promise<IndexStats> {
  const log = opts?.onProgress ?? (() => {});
  log(`Scanning ${directoryPath} for repos...`);
  const repos = discoverRepos(directoryPath);
  if (repos.length === 0) throw new Error(`No git repos found in ${directoryPath}`);
  log(`Discovered ${repos.length} repos`);
  const indexer = new KnowledgeIndexer();
  return indexer.indexProject(projectName, repos, DEFAULT_CONFIG, opts);
}

function formatEta(seconds: number): string {
  if (seconds < 0) return '...';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

// ---------------------------------------------------------------------------
// Convenience: get a ready-to-use retriever for an already-indexed project
// ---------------------------------------------------------------------------

/** Load an existing index and return a configured HybridRetriever with query routing. */
export async function getRetriever(project: string): Promise<HybridRetriever> {
  const config = loadKnowledgeConfig(project);
  const basePath = getKnowledgeBasePath(project);

  // Load vector store
  const dbPath = join(basePath, 'lancedb');
  const vectorStore = new VectorStore(dbPath);
  await vectorStore.init();

  // Load project graph (if available)
  let graph: ProjectGraphBuilder | null = null;
  const graphPath = join(basePath, 'system_graph_v2.json');
  if (existsSync(graphPath)) {
    try {
      const graphData = JSON.parse(readFileSync(graphPath, 'utf-8'));
      graph = new ProjectGraphBuilder();
      await graph.importJson(graphData);
    } catch {
      // Proceed without graph — vector + BM25 still work
    }
  }

  // Create embedding provider for query-time embedding
  const embedder = createEmbeddingProvider(config.embedding);

  // Create reranker (ollama by default, graceful fallback)
  let reranker = null;
  try {
    const { createReranker } = await import('./reranker.js');
    reranker = createReranker(config.retrieval.reranker);
  } catch {
    // Reranker module unavailable — proceed without
  }

  // Create query router (WS-8) — routes queries to relevant repos
  let queryRouter = null;
  try {
    queryRouter = await createQueryRouter(project, embedder);
    if (queryRouter) {
      // eslint-disable-next-line no-console
      console.log(`[knowledge] Query router ready (${queryRouter.repoCount} repo profiles)`);
    }
  } catch {
    // Query routing unavailable — search all repos
  }

  return new HybridRetriever(vectorStore, embedder, graph, {
    maxChunks: config.retrieval.maxChunks,
    maxTokens: config.retrieval.maxTokens,
    hybridWeights: config.retrieval.hybridWeights,
  }, reranker, queryRouter);
}
