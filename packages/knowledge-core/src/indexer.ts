import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';

import type { FileIndexEntry } from '@esankhan3/anvil-knowledge-core';
import { createEmbeddingProvider } from '@esankhan3/anvil-knowledge-core';
import { VectorStore } from '@esankhan3/anvil-knowledge-core';
import { ProjectGraphBuilder } from '@esankhan3/anvil-knowledge-core';
import { detectCrossRepoEdges } from '@esankhan3/anvil-knowledge-core';
import { HybridRetriever } from './retriever.js';
import { loadKnowledgeConfig, getKnowledgeBasePath } from '@esankhan3/anvil-knowledge-core';
import type { KnowledgeConfig } from '@esankhan3/anvil-knowledge-core';
import type { CodeChunk, IndexStats, WorkspaceMap } from '@esankhan3/anvil-knowledge-core';
import { profileProject, loadAllProfiles } from '@esankhan3/anvil-knowledge-core';
import { inferServiceMesh } from '@esankhan3/anvil-knowledge-core';
import { computeStructuralHash } from '@esankhan3/anvil-knowledge-core';
import { createQueryRouter } from '@esankhan3/anvil-knowledge-core';
import { createChunkWriter, iterateChunksFile } from './chunks-io.js';
import { writeSystemGraphSqlite } from './graph-store.js';
import { resolveIndexConcurrency, runReposPooled } from './index-pool.js';
import { processRepoPipeline, getRepoSha, readRepoIndexMeta } from './repo-pipeline.js';
import type { RepoJob, RepoResult, RepoIndexMeta } from './repo-pipeline.js';

// ---------------------------------------------------------------------------
// SHA-based staleness detection
// ---------------------------------------------------------------------------

// RepoIndexMeta, getRepoSha, readRepoIndexMeta moved to repo-pipeline.ts (shared
// with the worker). writeRepoIndexMeta stays here — only buildKB writes meta.
function writeRepoIndexMeta(basePath: string, repoName: string, meta: RepoIndexMeta): void {
  const dir = join(basePath, repoName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

/**
 * Structural dedup, streaming: read each per-repo shard line-by-line, keep the
 * first chunk per structural hash, write survivors to chunks.json. Bounded
 * memory — a Set of hashes + one chunk at a time, never the whole corpus (this
 * replaces the in-RAM deduplicateByStructure(allChunks) that OOM'd at org scale).
 * Keeps first-seen per hash (repo order) rather than smallest-id, but the
 * survivors are structurally identical, so dedup is functionally equivalent.
 */
async function dedupShardsToChunks(
  shardPaths: string[],
  chunksPath: string,
): Promise<{ kept: number; dropped: number; tokens: number }> {
  const seen = new Set<string>();
  const writer = createChunkWriter(chunksPath);
  let kept = 0, dropped = 0, tokens = 0;
  try {
    for (const sp of shardPaths) {
      if (!existsSync(sp)) continue;
      for await (const c of iterateChunksFile(sp)) {
        const h = computeStructuralHash(c.content, c.language).hash;
        if (seen.has(h)) { dropped++; continue; }
        seen.add(h);
        writer.write(c);
        kept++;
        tokens += c.tokens;
      }
    }
  } finally {
    writer.close();
  }
  return { kept, dropped, tokens };
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

    // 2. LLM Repo Profiling (WS-1) — skipped if LLM_MODE=none
    const { isLlmAvailable } = await import('./claude-runner.js');
    if (isLlmAvailable()) {
      report({ phase: 'profiling', message: `Profiling ${repos.length} repos with LLM...`, percent: 3, etaSeconds: -1, reposTotal: repos.length, reposProcessed: 0 });
      log(`Profiling ${repos.length} repos with LLM...`);
      try {
        const profiles = await profileProject(project, repos, {
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
    } else {
      log('LLM profiling disabled (CODE_SEARCH_LLM_MODE=none) — skipping');
      report({ phase: 'profiling', message: 'Skipped (LLM disabled)', percent: 8, etaSeconds: -1 });
    }

    // 3. Chunk repos — use git diff for incremental detection
    report({ phase: 'chunking', message: `Chunking ${reposToIndex.length} repos...`, percent: 10, etaSeconds: -1, reposTotal: repos.length, reposProcessed: skippedRepos.length, skippedRepos });
    log(`Chunking ${reposToIndex.length} repos (${skippedRepos.length} skipped — unchanged)...`);
    // Process each repo (chunk + AST graph + workspace) through a persistent
    // worker pool across cores — the CPU-bound bottleneck. Each repo streams its
    // chunks to a per-repo shard on disk and returns only its (small) graph +
    // metadata, so the main thread never accumulates the whole corpus (bounded
    // memory). Concurrency is adaptive; a worker failure falls back to in-thread.
    const repoStats: Array<{ name: string; chunkCount: number; language: string }> = [];
    const repoChunkResults = new Map<string, { changedFiles: string[]; deletedFiles: string[]; fileIndex: Record<string, FileIndexEntry> }>();
    const workspaceMaps = new Map<string, WorkspaceMap>();
    const shardPaths: string[] = [];
    const graphBuilder = new ProjectGraphBuilder();
    await graphBuilder.init();

    const toIndex = new Set(reposToIndex.map((r) => r.name));
    const jobs: RepoJob[] = repos.map((r) => ({
      repoName: r.name,
      repoPath: r.path,
      language: r.language,
      basePath,
      project,
      chunking: config.chunking,
      doChunk: toIndex.has(r.name),
      force: !!opts?.force,
    }));
    const concurrency = resolveIndexConcurrency(jobs.length);
    const workerUrl = concurrency > 1 ? new URL('./index-worker.js', import.meta.url) : null;
    log(`Processing ${jobs.length} repos (chunk + AST) — concurrency ${concurrency}${workerUrl ? ' (workers)' : ' (in-thread)'}, ${skippedRepos.length} skipped`);
    report({ phase: 'chunking', message: `Chunking + graphing ${jobs.length} repos (×${concurrency})...`, percent: 15, etaSeconds: -1, reposTotal: repos.length, reposProcessed: 0, skippedRepos });

    let processed = 0;
    await runReposPooled<RepoJob, RepoResult>(jobs, {
      concurrency,
      workerUrl,
      log,
      inThread: (job) => processRepoPipeline(job),
      toMessage: (job) => job,
      onResult: (res) => {
        if (res.graph) {
          try { graphBuilder.addRepoGraph(res.repoName, res.graph); }
          catch (e) { log(`Warning: addRepoGraph failed for ${res.repoName}: ${e}`); }
        }
        if (res.workspaceMap && res.workspaceMap.packages.length > 0) workspaceMaps.set(res.repoName, res.workspaceMap);
        repoStats.push({ name: res.repoName, chunkCount: res.chunkCount, language: res.language });
        if (res.chunked) {
          repoChunkResults.set(res.repoName, { changedFiles: res.changedFiles, deletedFiles: res.deletedFiles, fileIndex: res.fileIndex ?? {} });
          if (res.shardPath) shardPaths.push(res.shardPath);
        }
        processed++;
        if (processed % 10 === 0 || processed === jobs.length) {
          report({ phase: 'graphing', message: `Processed ${processed}/${jobs.length} repos`, percent: Math.round(15 + (processed / jobs.length) * 50), etaSeconds: -1 });
        }
      },
    });
    for (const name of skippedRepos) {
      const meta = readRepoIndexMeta(basePath, name);
      repoStats.push({ name, chunkCount: meta?.chunkCount ?? 0, language: '' });
    }

    // Structural dedup — streaming over the per-repo shards into chunks.json
    // (bounded memory; replaces the in-RAM dedup that OOM'd at org scale).
    report({ phase: 'dedup', message: 'Deduplicating chunks (streaming)...', percent: 68, etaSeconds: -1 });
    const chunksPath = join(basePath, 'chunks.json');
    const dedup = await dedupShardsToChunks(shardPaths, chunksPath);
    const dedupedChunkCount = dedup.kept;
    const dedupedTokenSum = dedup.tokens;
    if (dedup.dropped > 0) log(`Structural dedup: ${dedup.dropped} duplicates removed`);
    log(`Saved ${dedupedChunkCount} chunks to ${chunksPath}`);
    for (const sp of shardPaths) { try { rmSync(sp, { force: true }); } catch { /* ok */ } }

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

    // 8. LLM Service Mesh Inference (WS-2) — skipped if LLM_MODE=none
    if (isLlmAvailable()) {
      report({ phase: 'service-mesh', message: 'Inferring service mesh from profiles...', percent: 80, etaSeconds: -1 });
      try {
        const profiles = loadAllProfiles(project);
        if (profiles.length > 0) {
          log(`Inferring service mesh from ${profiles.length} profiles...`);
          const meshEdges = await inferServiceMesh(profiles, {
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
    } else {
      log('LLM service mesh inference disabled — skipping');
      report({ phase: 'service-mesh', message: 'Skipped (LLM disabled)', percent: 85, etaSeconds: -1 });
    }

    // 9. Community detection
    report({ phase: 'graphing', message: 'Detecting communities...', percent: 90, etaSeconds: -1 });
    graphBuilder.detectCommunities();

    // 10. Save the project graph. Stream it into SQLite (system_graph.sqlite):
    // queryable in slices and free of V8's ~512MB string ceiling, which the
    // old single-JSON-blob write hit at org scale (900k+ nodes / 2.4M+ edges).
    // Fall back to the legacy JSON blob only when no sqlite driver is available
    // (small graphs); at org scale that path degrades gracefully — search +
    // embeddings are unaffected, only the cross-repo graph tools lose the file.
    try {
      const wroteSqlite = await writeSystemGraphSqlite(basePath, graphBuilder);
      if (wroteSqlite) {
        log(`Saved project graph to ${join(basePath, 'system_graph.sqlite')}`);
      } else {
        const graphOutputPath = join(basePath, 'system_graph_v2.json');
        writeFileSync(graphOutputPath, JSON.stringify(graphBuilder.exportJson()));
        log(`Saved project graph to ${graphOutputPath} (no sqlite driver; JSON fallback)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[knowledge-core] Could not persist system graph (${graphBuilder.nodeCount} nodes, ${graphBuilder.edgeCount} edges): ${msg}. Cross-repo graph tools will be unavailable; search and embeddings are unaffected.`);
    }

    // 11. (chunks.json was written + the chunk arrays freed right after dedup,
    // above — so ~810k chunk objects don't sit in memory through the graph build.)

    // 11b. Save stale files list (for incremental embedding cleanup).
    // Includes both deleted AND modified files: chunk.id is position-keyed
    // (chunker.ts:179), so an in-place edit at the same line range produces
    // an identical id and the embedder's id-set filter would otherwise leave
    // the old vector in LanceDB unchanged. Listing modified files here lets
    // embedChunks() wipe their old chunks before re-embedding.
    const allStaleFiles: Array<{ repoName: string; filePath: string }> = [];
    for (const repo of reposToIndex) {
      const result = repoChunkResults.get(repo.name);
      if (!result) continue;
      for (const f of result.deletedFiles ?? []) {
        allStaleFiles.push({ repoName: repo.name, filePath: f });
      }
      for (const f of result.changedFiles ?? []) {
        allStaleFiles.push({ repoName: repo.name, filePath: f });
      }
    }
    const deletedPath = join(basePath, 'deleted_files.json');
    writeFileSync(deletedPath, JSON.stringify(allStaleFiles));

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
    report({ phase: 'done', message: `KB built: ${dedupedChunkCount} chunks, ${crossRepoEdgeCount} edges in ${formatEta(Math.ceil(durationMs / 1000))}`, percent: 100, etaSeconds: 0, skippedRepos });

    return {
      project,
      repos: repoStats,
      totalChunks: dedupedChunkCount,
      totalTokens: dedupedTokenSum,
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

    const chunksPath = join(basePath, 'chunks.json');
    if (!existsSync(chunksPath)) {
      throw new Error(`No chunks found — run Build KB first. Expected: ${chunksPath}`);
    }

    // Open vector store. healCorrupt: this is the write/rebuild path, so if a
    // prior run left the table corrupt (killed mid-write → 0-byte fragment),
    // drop it and rebuild from chunks.json rather than failing every reindex.
    const dbPath = join(basePath, 'lancedb');
    const vectorStore = new VectorStore(dbPath);
    await vectorStore.init({ healCorrupt: true });

    // Which chunks are already embedded (id-set diff). Bounded: holds only the
    // id strings, never the chunk bodies.
    const existingIds = new Set<string>();
    try {
      const stats = await vectorStore.getStats();
      if (stats && stats.rowCount > 0) {
        const existingChunks = await vectorStore.getChunkIds(project);
        for (const id of existingChunks) existingIds.add(id);
      }
    } catch { /* first run — no existing data */ }

    const deletedFiles = this.getDeletedFiles(basePath);

    // Pass 1 — stream chunks.json to tally totals + how many need embedding,
    // WITHOUT ever holding all chunks in memory. At org scale (~810k chunks,
    // each carrying full source + contextualized text) the old
    // `readChunksFile()` array was multi-GB and OOM'd the embed step (the
    // crash surfaced during "Removing stale chunks", but the array — loaded
    // here, before deletion — was the resident hog). Streaming bounds memory
    // to the id-set + one in-flight batch (see pass 2 below).
    let totalChunks = 0;
    let totalTokens = 0;
    let newChunkCount = 0;
    const repoChunkCounts = new Map<string, number>();
    for await (const c of iterateChunksFile(chunksPath)) {
      totalChunks++;
      totalTokens += c.tokens;
      repoChunkCounts.set(c.repoName, (repoChunkCounts.get(c.repoName) ?? 0) + 1);
      if (!existingIds.has(c.id)) newChunkCount++;
    }
    log(`Loaded ${totalChunks} chunks from ${chunksPath}`);
    const repoNames = [...repoChunkCounts.keys()];

    if (newChunkCount === 0 && deletedFiles.length === 0) {
      // All vectors already present, so DON'T re-embed. But still (re)build the
      // full-text (BM25) index over the existing rows: a prior run that wrote
      // vectors then aborted before the post-loop FTS build (e.g. killed/aborted
      // mid-run) leaves BM25 permanently degraded, and this "nothing new" path is
      // the only one a re-run reaches. Cheap relative to embedding; idempotent.
      log('All chunks already embedded — ensuring full-text index is built (no re-embed).');
      await vectorStore.ensureFtsIndex();
      report({ phase: 'done', message: 'All chunks already embedded', percent: 100, etaSeconds: 0 });
      return {
        project,
        repos: repoNames.map((n) => ({ name: n, chunkCount: repoChunkCounts.get(n) ?? 0, language: '' })),
        totalChunks,
        totalTokens,
        embeddingProvider: 'cached',
        embeddingDimensions: 0,
        crossRepoEdges: 0,
        lastIndexed: new Date().toISOString(),
        indexDurationMs: Date.now() - startTime,
      };
    }

    // Delete chunks for files that were removed — use file path matching, not chunk IDs
    if (deletedFiles.length > 0) {
      // Group by repo for efficient deletion
      const byRepo = new Map<string, string[]>();
      for (const d of deletedFiles) {
        const list = byRepo.get(d.repoName) ?? [];
        list.push(d.filePath);
        byRepo.set(d.repoName, list);
      }
      for (const [repoName, filePaths] of byRepo) {
        log(`Removing stale chunks for ${filePaths.length} changed/deleted files from ${repoName}...`);
        await vectorStore.deleteFileChunks(project, repoName, filePaths);
      }
    }

    // Embed only new/changed chunks.
    const embedder = createEmbeddingProvider(config.embedding);
    const isOllama = embedder.name === 'ollama';
    // Operational tuning. Cloud providers (OpenAI, etc.) parallelize across many
    // in-flight requests, so embedding throughput scales ~linearly with
    // concurrency until the provider's TPM rate limit kicks in (then embedFetch's
    // 429 backoff paces it). Ollama is a local single-runtime — concurrency
    // doesn't help and oversubscribes the GPU/CPU — so keep it serial. Override
    // per deployment (e.g. raise concurrency on a higher OpenAI tier):
    //   CODE_SEARCH_EMBEDDING_CONCURRENCY (default 8), _BATCH_SIZE (default 128).
    const envInt = (key: string, dflt: number): number => {
      const n = parseInt(process.env[key] ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : dflt;
    };
    const batchSize = envInt('CODE_SEARCH_EMBEDDING_BATCH_SIZE', isOllama ? 10 : 128);
    const concurrency = isOllama ? 1 : envInt('CODE_SEARCH_EMBEDDING_CONCURRENCY', 8);

    log(`Embedding ${newChunkCount} new chunks with ${embedder.name} (${totalChunks - newChunkCount} cached, batch ${batchSize} × concurrency ${concurrency})...`);

    // Stream chunks.json a second time and embed only the new ones, in batches.
    // Up to `concurrency` batches are in flight at once; each is written to
    // LanceDB the instant its embeddings return (writes serialized via
    // writeChain — LanceDB's add must not run concurrently on one table).
    // Crucially we NEVER materialize the full chunk set nor a pre-sliced
    // `batches[][]`: the producer reads one chunk at a time, fills a batch,
    // dispatches it, then blocks until an in-flight slot frees. Memory stays
    // bounded to the id-set + ~concurrency batches regardless of corpus size.
    // The run stays resumable: new chunks are diffed against ids already in the
    // store, so a crash loses only the few in-flight batches and a re-run
    // continues from there. FTS is built once after the loop (skipIndex defers
    // the per-batch rebuild).
    const totalBatches = Math.max(1, Math.ceil(newChunkCount / batchSize));
    let batchesDone = 0;
    let stored = 0;
    const embedStartTime = Date.now();
    let writeChain: Promise<void> = Promise.resolve();

    // When any batch fails, signal the producer + siblings to stop and surface
    // the error after all in-flight batches settle — otherwise a failed batch
    // rejects while its siblings keep embedding + mutating progress in the
    // background ("zombie" workers), so the run reads as failed yet the count
    // keeps rising.
    let aborted: unknown = null;
    const inFlight = new Set<Promise<void>>();

    const dispatch = (batchChunks: CodeChunk[]): void => {
      const task = (async () => {
        if (aborted) return;
        try {
          const batchEmbeddings = await embedder.embed(batchChunks.map((c) => c.contextualizedContent));
          const batchRows = batchChunks.map((chunk, j) => ({ ...chunk, embedding: batchEmbeddings[j] }));
          // Serialize the LanceDB write by chaining onto the previous one, and
          // await only the promise we just appended.
          const myWrite = (writeChain = writeChain.then(() =>
            vectorStore.addChunks(batchRows, { skipIndex: true }),
          ));
          await myWrite;
          if (aborted) return;
          stored += batchRows.length;
          batchesDone++;

          const elapsed = Date.now() - embedStartTime;
          const msPerBatch = elapsed / batchesDone;
          const etaSeconds = Math.ceil((msPerBatch * (totalBatches - batchesDone)) / 1000);
          const percent = Math.round(5 + (batchesDone / totalBatches) * 85);

          report({
            phase: 'embedding',
            message: `Embedding: ${stored}/${newChunkCount} new (~${etaSeconds}s remaining)`,
            percent, etaSeconds,
            chunksTotal: newChunkCount, chunksProcessed: stored,
          });

          if (batchesDone % 10 === 0 || batchesDone === totalBatches) {
            log(`  Embedded ${stored}/${newChunkCount} (ETA: ${formatEta(etaSeconds)})`);
          }
        } catch (err) {
          aborted = err; // stop producer + siblings; rethrown after all settle
        }
      })();
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    };

    let batch: CodeChunk[] = [];
    for await (const c of iterateChunksFile(chunksPath)) {
      if (aborted) break;
      if (existingIds.has(c.id)) continue;
      batch.push(c);
      if (batch.length >= batchSize) {
        dispatch(batch);
        batch = [];
        // Back-pressure: never let more than `concurrency` batches be resident.
        while (inFlight.size >= concurrency && !aborted) await Promise.race(inFlight);
      }
    }
    if (batch.length > 0 && !aborted) dispatch(batch);
    await Promise.all(inFlight);
    if (aborted) throw aborted; // no zombies left running; fail the run cleanly

    // Build the full-text index once, after all batches are inserted.
    report({ phase: 'storing', message: 'Building full-text index...', percent: 92, etaSeconds: -1 });
    if (newChunkCount > 0) {
      await vectorStore.ensureFtsIndex();
    }
    log(`Stored ${newChunkCount} new chunks in LanceDB (${deletedFiles.length} removed)`);

    // Update metadata (repoNames was computed during pass 1).
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
    report({ phase: 'done', message: `Embedded ${newChunkCount} new chunks (${deletedFiles.length} removed) in ${formatEta(Math.ceil(durationMs / 1000))}`, percent: 100, etaSeconds: 0 });

    return {
      project,
      repos: repoNames.map((n) => ({ name: n, chunkCount: repoChunkCounts.get(n) ?? 0, language: '' })),
      totalChunks,
      totalTokens,
      embeddingProvider: embedder.name,
      embeddingDimensions: embedder.dimensions,
      crossRepoEdges: 0,
      lastIndexed: new Date().toISOString(),
      indexDurationMs: durationMs,
    };
  }

  /** Read the deleted files list saved by buildKB */
  private getDeletedFiles(basePath: string): Array<{ repoName: string; filePath: string }> {
    const deletedPath = join(basePath, 'deleted_files.json');
    if (!existsSync(deletedPath)) return [];
    try {
      return JSON.parse(readFileSync(deletedPath, 'utf-8'));
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
    /** Explicit config — overrides the default project-yaml/env lookup. P2 entry point. */
    config?: KnowledgeConfig;
  },
): Promise<BuildKBResult> {
  const log = opts?.onProgress ?? (() => {});
  log(`Scanning ${directoryPath} for repos...`);
  const repos = discoverRepos(directoryPath);
  if (repos.length === 0) throw new Error(`No git repos found in ${directoryPath}`);
  log(`Discovered ${repos.length} repos`);
  const indexer = new KnowledgeIndexer();
  const config = opts?.config ?? loadKnowledgeConfig(projectName);
  return indexer.buildKB(projectName, repos, config, opts);
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
    /** Explicit config — overrides the default project-yaml/env lookup. */
    config?: KnowledgeConfig;
  },
): Promise<IndexStats> {
  const indexer = new KnowledgeIndexer();
  const config = opts?.config ?? loadKnowledgeConfig(projectName);
  return indexer.embedChunks(projectName, config, opts);
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
    /** Explicit config — overrides the default project-yaml/env lookup. */
    config?: KnowledgeConfig;
  },
): Promise<IndexStats> {
  const log = opts?.onProgress ?? (() => {});
  log(`Scanning ${directoryPath} for repos...`);
  const repos = discoverRepos(directoryPath);
  if (repos.length === 0) throw new Error(`No git repos found in ${directoryPath}`);
  log(`Discovered ${repos.length} repos`);
  const indexer = new KnowledgeIndexer();
  const config = opts?.config ?? loadKnowledgeConfig(projectName);
  return indexer.indexProject(projectName, repos, config, opts);
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

/**
 * Load an existing index and return a configured HybridRetriever with
 * query routing. Caller may pass an explicit config to bypass the
 * project-yaml/env lookup (P2 entry point).
 *
 * Cross-cutting safety: validates that the configured embedding provider
 * matches what was used at index time. On mismatch, throws a hard error
 * before any vector search runs — silent vector-space drift is the
 * canonical "results are garbage and there's no error" symptom.
 */
export async function getRetriever(
  project: string,
  configOverride?: KnowledgeConfig,
): Promise<HybridRetriever> {
  const config = configOverride ?? loadKnowledgeConfig(project);
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

  // Vector-space safety: refuse to run if the index was embedded with a
  // different provider/dimension than what the current config resolves to.
  // Garbage results from silent space mismatch are worse than a hard error.
  try {
    if (existsSync(basePath)) {
      for (const entry of readdirSync(basePath)) {
        const meta = readRepoIndexMeta(basePath, entry);
        if (!meta || !meta.embeddingProvider || meta.embeddingProvider === 'pending') continue;
        if (meta.embeddingProvider !== embedder.name) {
          throw new Error(
            `[knowledge-core] Vector-space mismatch for repo "${entry}": ` +
            `index built with "${meta.embeddingProvider}" but retrieval is using "${embedder.name}". ` +
            `Reindex with consistent embedding provider, or revert the config change. ` +
            `(set CODE_SEARCH_EMBEDDING_PROVIDER or config.embedding.provider to match the index.)`,
          );
        }
      }
    }
  } catch (err) {
    // Only re-throw the explicit mismatch error; ignore IO errors.
    if (err instanceof Error && err.message.startsWith('[knowledge-core] Vector-space mismatch')) throw err;
  }

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
