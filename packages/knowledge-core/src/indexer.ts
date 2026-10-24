import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

import type { FileIndexEntry } from '@esankhan3/anvil-knowledge-core';
import { createEmbeddingProvider } from '@esankhan3/anvil-knowledge-core';
import { resolveStorage, invalidateGraphStores } from './storage/resolve.js';
import type { BlobStorePort, StorageBundle } from './storage/ports.js';
import { maintainVectorIndex, readVectorIndexHealth } from './vector-index-maintenance.js';
import { contentHash } from './vector-store.js';
import { cosineSimilarity } from './query-router.js';
import { FsBlobStore } from './storage/fs-blob-store.js';
import { ProjectGraphBuilder } from '@esankhan3/anvil-knowledge-core';
import { correlateCrossRepoEdges, CROSS_REPO_SIGNALS_VERSION } from './cross-repo-detector.js';
import { getWorkingTreeState, sameWorkingTreeState } from './git-diff.js';
import type { WorkingTreeState } from './git-diff.js';
import type { CrossRepoSignals } from './cross-repo-detector.js';
import { HybridRetriever } from './retriever.js';
import { loadKnowledgeConfig, getKnowledgeBasePath } from '@esankhan3/anvil-knowledge-core';
import type { KnowledgeConfig } from '@esankhan3/anvil-knowledge-core';
import type { CodeChunk, IndexStats, WorkspaceMap, GraphifyOutput } from '@esankhan3/anvil-knowledge-core';
import { profileProject, loadAllProfiles } from '@esankhan3/anvil-knowledge-core';
import { inferServiceMesh } from '@esankhan3/anvil-knowledge-core';
import { CHUNK_ID_VERSION } from './chunker.js';
import { createQueryRouter } from '@esankhan3/anvil-knowledge-core';
import { iterateChunksFile } from './chunks-io.js';
import { writeSystemGraphSqlite, createSystemGraphSqliteWriter } from './graph-store.js';
import { resolveIndexConcurrency, runReposPooled } from './index-pool.js';
import { processRepoPipeline, getRepoSha, getRemoteSha, readRepoIndexMeta } from './repo-pipeline.js';
import type { RepoJob, RepoResult, RepoIndexMeta } from './repo-pipeline.js';

// ---------------------------------------------------------------------------
// SHA-based staleness detection
// ---------------------------------------------------------------------------

// RepoIndexMeta, getRepoSha, readRepoIndexMeta moved to repo-pipeline.ts (shared
// with the worker). writeRepoIndexMeta stays here — only buildKB writes meta.
// Routed through BlobStorePort (P0c); putJson pretty-prints, byte-identical to
// the prior JSON.stringify(meta, null, 2).
async function writeRepoIndexMeta(blobs: BlobStorePort, repoName: string, meta: RepoIndexMeta): Promise<void> {
  await blobs.putJson(`${repoName}/index_meta.json`, meta);
}

/**
 * Merge the per-repo shards (+ chunks carried forward from the previous
 * corpus) into chunks.json, streaming: one chunk at a time plus a Set of ids,
 * never the whole corpus. Every repo keeps its own copy of shared code —
 * identical code in two repos is two searchable, separately-scoped chunks.
 */
async function mergeShardsToChunks(
  shardPaths: string[],
  blobs: BlobStorePort,
  chunksKey: string,
  /** Local NDJSON copy of the PREVIOUS chunks.json + which of its chunks to
   *  keep. Absent on a full rebuild (every repo re-chunked) — the shards are
   *  then the complete corpus. */
  carryForward?: { prevPath: string; keep: (c: CodeChunk) => boolean },
): Promise<{ kept: number; tokens: number }> {
  // Shards are transient local scratch — read raw. Chunks stream straight into
  // the durable chunks blob via putNdjson; counts are tallied inside the
  // generator and read back after putNdjson drains it. Fresh shards stream
  // FIRST so a re-chunked chunk wins over a carried-forward one with its id.
  const seen = new Set<string>();
  let kept = 0, tokens = 0;
  async function* merged(): AsyncGenerator<CodeChunk> {
    const sources: Array<{ path: string; keep: (c: CodeChunk) => boolean }> =
      shardPaths.filter((sp) => existsSync(sp)).map((sp) => ({ path: sp, keep: () => true }));
    if (carryForward && existsSync(carryForward.prevPath)) sources.push({ path: carryForward.prevPath, keep: carryForward.keep });
    for (const { path, keep } of sources) {
      for await (const c of iterateChunksFile(path)) {
        if (!keep(c) || seen.has(c.id)) continue;
        seen.add(c.id);
        kept++;
        tokens += c.tokens;
        yield c;
      }
    }
  }
  await blobs.putNdjson(chunksKey, merged());
  return { kept, tokens };
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
    repos: Array<{ name: string; path: string; language: string; cloneUrl?: string }>,
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
    const storage = resolveStorage(project, config);
    const basePath = storage.basePath;
    mkdirSync(basePath, { recursive: true });

    // 1. Determine which repos need re-indexing (SHA check)
    const reposToIndex: typeof repos = [];
    const skippedRepos: string[] = [];
    const skippedMeta = new Map<string, RepoIndexMeta>();

    for (const repo of repos) {
      if (opts?.force) {
        reposToIndex.push(repo);
        continue;
      }
      // Remote repos: compare the ls-remote HEAD sha — unchanged repos never clone.
      const currentSha = repo.cloneUrl ? getRemoteSha(repo.cloneUrl) : getRepoSha(repo.path);
      const meta = await readRepoIndexMeta(basePath, repo.name, storage.blobs);
      // Unchanged = same HEAD AND (local checkouts) the same uncommitted edits
      // as last indexed — saved-but-uncommitted work must still be picked up.
      const treeUnchanged = repo.cloneUrl
        ? true
        : sameWorkingTreeState(meta?.workingTree ?? {}, getWorkingTreeState(repo.path));
      if (meta && currentSha && meta.lastIndexedSha === currentSha && treeUnchanged) {
        // A skipped repo is served entirely from its stored artifacts (graph +
        // cross-repo signals + chunks carried forward) — no clone, no AST
        // re-parse. An index whose signals are missing or in an older format,
        // or whose chunks use an older id scheme, must be re-indexed once.
        const signals = await storage.blobs
          .getJson<CrossRepoSignals>(`${repo.name}/signals.json`)
          .catch(() => null);
        const hasArtifacts =
          meta.chunkIdVersion === CHUNK_ID_VERSION &&
          (await storage.blobs.exists(`${repo.name}/graph.json`)) &&
          signals?.version === CROSS_REPO_SIGNALS_VERSION;
        if (hasArtifacts) {
          skippedRepos.push(repo.name);
          skippedMeta.set(repo.name, meta);
          log(`Skipping ${repo.name} — unchanged (${currentSha.slice(0, 7)})`);
        } else {
          reposToIndex.push(repo);
          log(`Re-indexing ${repo.name} — unchanged but stored graph/signals missing or outdated (pre-upgrade index)`);
        }
      } else {
        reposToIndex.push(repo);
      }
    }

    // Repos the last cycle indexed that are no longer in the workspace: their
    // chunks drop out of chunks.json below (embedChunks then sweeps their rows)
    // and their per-repo artifacts are deleted — so this cycle isn't a no-op.
    const currentRepoNames = new Set(repos.map((r) => r.name));
    const prevStats = await storage.blobs
      .getJson<{ repos?: Array<{ name: string }>; crossRepoEdges?: number }>('index_stats.json')
      .catch(() => null);
    const removedRepos = (prevStats?.repos ?? [])
      .map((r) => r.name)
      .filter((n) => n && n !== '.' && n !== '..' && !/[\\/]/.test(n) && !currentRepoNames.has(n));

    if (reposToIndex.length === 0 && removedRepos.length === 0) {
      log('All repos up to date — nothing to build.');
      report({ phase: 'done', message: 'All repos up to date', percent: 100, etaSeconds: 0, skippedRepos });
      return { project, repos: [], totalChunks: 0, totalTokens: 0, crossRepoEdges: prevStats?.crossRepoEdges ?? 0, durationMs: 0, chunksPath: join(basePath, 'chunks.json') };
    }

    // 2. LLM Repo Profiling (WS-1) — skipped if LLM_MODE=none
    const { isLlmAvailable } = await import('./claude-runner.js');
    if (isLlmAvailable()) {
      report({ phase: 'profiling', message: `Profiling ${repos.length} repos with LLM...`, percent: 3, etaSeconds: -1, reposTotal: repos.length, reposProcessed: 0 });
      log(`Profiling ${repos.length} repos with LLM...`);
      try {
        const profiles = await profileProject(project, repos, {
          force: opts?.force,
          config,
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
    const repoChunkResults = new Map<string, { changedFiles: string[]; deletedFiles: string[]; fileIndex: Record<string, FileIndexEntry>; sha: string | null; shardComplete: boolean; workingTree: WorkingTreeState }>();
    const workspaceMaps = new Map<string, WorkspaceMap>();
    const shardPaths: string[] = [];
    // System graph: stream per-repo nodes/edges straight to SQLite as repos
    // finish — never assemble the full graphology graph (~5GB at org scale, the
    // last unbounded structure). Fall back to the in-memory builder only when no
    // sqlite driver is available (small/local indexes; also gives the JSON
    // fallback + community detection that the streamed path drops as unused).
    const graphWriter = await createSystemGraphSqliteWriter(basePath);
    const graphBuilder = graphWriter ? null : new ProjectGraphBuilder();
    if (graphBuilder) await graphBuilder.init();

    // Only changed repos get jobs — skipped repos are served from their stored
    // graph.json/signals.json below, so they are never cloned or re-parsed.
    // This is what makes a partial cycle O(changed), not O(org).
    const jobs: RepoJob[] = reposToIndex.map((r) => ({
      repoName: r.name,
      repoPath: r.path,
      language: r.language,
      basePath,
      project,
      chunking: config.chunking,
      doChunk: true,
      force: !!opts?.force,
      storage: config.storage,
      cloneUrl: r.cloneUrl,
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
          try {
            if (graphWriter) graphWriter.addRepoGraph(res.repoName, res.graph);
            else graphBuilder!.addRepoGraph(res.repoName, res.graph);
          } catch (e) { log(`Warning: addRepoGraph failed for ${res.repoName}: ${e}`); }
        }
        if (res.workspaceMap && res.workspaceMap.packages.length > 0) workspaceMaps.set(res.repoName, res.workspaceMap);
        repoStats.push({ name: res.repoName, chunkCount: res.chunkCount, language: res.language });
        if (res.chunked) {
          repoChunkResults.set(res.repoName, { changedFiles: res.changedFiles, deletedFiles: res.deletedFiles, fileIndex: res.fileIndex ?? {}, sha: res.sha, shardComplete: res.shardComplete, workingTree: res.workingTree });
          if (res.shardPath) shardPaths.push(res.shardPath);
        }
        processed++;
        if (processed % 10 === 0 || processed === jobs.length) {
          report({ phase: 'graphing', message: `Processed ${processed}/${jobs.length} repos`, percent: Math.round(15 + (processed / jobs.length) * 50), etaSeconds: -1 });
        }
      },
    });
    // Skipped repos: their per-repo graphs were persisted when they were last
    // indexed — stream each into the system-graph writer (one at a time, the
    // graph never accumulates) and rehydrate the persisted workspace packages
    // for cross-repo correlation. No clone, no AST parse.
    for (const name of skippedRepos) {
      const meta = skippedMeta.get(name);
      repoStats.push({ name, chunkCount: meta?.chunkCount ?? 0, language: '' });
      try {
        const g = await storage.blobs.getJson<GraphifyOutput>(`${name}/graph.json`);
        if (g) {
          if (graphWriter) graphWriter.addRepoGraph(name, g);
          else graphBuilder!.addRepoGraph(name, g);
        }
      } catch (e) { log(`Warning: stored graph load failed for ${name}: ${e}`); }
      if (meta?.workspacePackages?.length) {
        workspaceMaps.set(name, {
          repoPath: '',
          packages: meta.workspacePackages,
          nameToPackage: new Map(meta.workspacePackages.map((pkg) => [pkg.name, pkg])),
          pathAliases: new Map(),
        });
      }
    }

    // Merge the per-repo shards into chunks.json, streaming (bounded memory).
    // PARTIAL CYCLES: the shards only cover repos re-chunked THIS cycle —
    // skipped repos' chunks and an incrementally-chunked repo's untouched
    // files must be carried forward from the previous chunks.json, or every
    // scheduled reindex silently shrinks the corpus to the changed set.
    report({ phase: 'dedup', message: 'Merging chunks (streaming)...', percent: 68, etaSeconds: -1 });
    const chunksPath = join(basePath, 'chunks.json');
    const anyPartialShard = [...repoChunkResults.values()].some((r) => !r.shardComplete);
    const needCarry = (skippedRepos.length > 0 || anyPartialShard) && (await storage.blobs.exists('chunks.json'));
    let carryForward: { prevPath: string; keep: (c: CodeChunk) => boolean } | undefined;
    if (needCarry) {
      // Pull the previous corpus to local scratch first — putNdjson overwrites
      // the blob (Mongo deletes the GridFS file before upload), so reading and
      // writing the same key concurrently would corrupt or truncate it.
      const prevPath = join(basePath, 'chunks.prev.ndjson');
      await storage.blobs.getBytes('chunks.json', { toFile: prevPath });
      const currentRepos = new Set(repos.map((r) => r.name));
      const fullyRechunked = new Set(
        [...repoChunkResults.entries()].filter(([, r]) => r.shardComplete).map(([name]) => name),
      );
      // A partial shard's fileIndex lists every file the repo still has: carry
      // forward only those, minus the ones re-chunked this cycle.
      const partial = new Map(
        [...repoChunkResults.entries()]
          .filter(([, r]) => !r.shardComplete)
          .map(([name, r]) => [name, { files: r.fileIndex, changed: new Set(r.changedFiles) }]),
      );
      carryForward = {
        prevPath,
        keep: (c) => {
          if (!currentRepos.has(c.repoName)) return false;    // repos removed from the org drop out
          if (fullyRechunked.has(c.repoName)) return false;   // complete shard = replaces the repo wholesale
          const p = partial.get(c.repoName);
          return !p || (c.filePath in p.files && !p.changed.has(c.filePath));
        },
      };
    }
    const merged = await mergeShardsToChunks(shardPaths, storage.blobs, 'chunks.json', carryForward);
    if (carryForward) { try { rmSync(carryForward.prevPath, { force: true }); } catch { /* scratch */ } }
    const mergedChunkCount = merged.kept;
    const mergedTokenSum = merged.tokens;
    log(`Saved ${mergedChunkCount} chunks to ${chunksPath}`);
    for (const sp of shardPaths) { try { rmSync(sp, { force: true }); } catch { /* ok */ } }

    // 7. Detect cross-repo edges (14 strategies) — correlated from the
    // per-repo signals persisted at index time. In the bounded-scratch writer
    // the clones are already discarded (and skipped repos were never cloned),
    // so the join runs on stored signals, not working trees.
    report({ phase: 'graphing', message: 'Detecting cross-repo edges...', percent: 70, etaSeconds: -1 });
    let crossRepoEdgeCount = 0;
    const hasWorkspaces = workspaceMaps.size > 0;
    if (repos.length > 1 || hasWorkspaces) {
      const signalsMap = new Map<string, CrossRepoSignals>();
      for (const r of repos) {
        try {
          const sig = await storage.blobs.getJson<CrossRepoSignals>(`${r.name}/signals.json`);
          if (sig) signalsMap.set(r.name, sig);
        } catch { /* a repo without signals just contributes no edges this cycle */ }
      }
      const crossEdges = correlateCrossRepoEdges(signalsMap, workspaceMaps);
      if (graphWriter) graphWriter.addCrossRepoEdges(crossEdges);
      else graphBuilder!.addCrossRepoEdges(crossEdges);
      crossRepoEdgeCount = crossEdges.length;
      log(`Detected ${crossEdges.length} cross-repo edges (signals from ${signalsMap.size}/${repos.length} repos)`);
    }

    // 8. LLM Service Mesh Inference (WS-2) — skipped if LLM_MODE=none
    if (isLlmAvailable()) {
      report({ phase: 'service-mesh', message: 'Inferring service mesh from profiles...', percent: 80, etaSeconds: -1 });
      try {
        const profiles = await loadAllProfiles(project, config);
        if (profiles.length > 0) {
          log(`Inferring service mesh from ${profiles.length} profiles...`);
          const meshEdges = await inferServiceMesh(profiles, {
            onProgress: (m) => {
              log(m);
              report({ phase: 'service-mesh', message: m, percent: 82, etaSeconds: -1 });
            },
          });
          if (meshEdges.length > 0) {
            if (graphWriter) graphWriter.addCrossRepoEdges(meshEdges);
            else graphBuilder!.addCrossRepoEdges(meshEdges);
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

    // 9. Persist the system graph.
    report({ phase: 'graphing', message: 'Saving system graph...', percent: 90, etaSeconds: -1 });
    if (graphWriter) {
      // Streamed path: nodes/edges already written per-repo; backfill degrees +
      // close. Community detection is skipped — `systemCommunity` has no readers.
      try {
        const { nodeCount, edgeCount } = graphWriter.finalize();
        log(`Saved project graph to ${join(basePath, 'system_graph.sqlite')} (streamed: ${nodeCount} nodes, ${edgeCount} edges)`);
        await uploadSystemGraphIfRemote(storage, basePath, log);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[knowledge-core] Could not persist system graph (streamed): ${msg}. Cross-repo graph tools will be unavailable; search and embeddings are unaffected.`);
      }
    } else {
      // In-memory fallback (no sqlite driver): detect communities, then write
      // the whole graph to sqlite if a driver appears, else the legacy JSON blob.
      graphBuilder!.detectCommunities();
      try {
        const wroteSqlite = await writeSystemGraphSqlite(basePath, graphBuilder!);
        if (wroteSqlite) {
          log(`Saved project graph to ${join(basePath, 'system_graph.sqlite')}`);
          await uploadSystemGraphIfRemote(storage, basePath, log);
        } else {
          // No sqlite driver → legacy compact JSON blob (byte-parity via putText).
          await storage.blobs.putText('system_graph_v2.json', JSON.stringify(graphBuilder!.exportJson()));
          log(`Saved project graph to ${join(basePath, 'system_graph_v2.json')} (no sqlite driver; JSON fallback)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[knowledge-core] Could not persist system graph (${graphBuilder!.nodeCount} nodes, ${graphBuilder!.edgeCount} edges): ${msg}. Cross-repo graph tools will be unavailable; search and embeddings are unaffected.`);
      }
    }

    // 11. (chunks.json was written + the chunk arrays freed right after merging,
    // above — so ~810k chunk objects don't sit in memory through the graph build.)

    // 11b. Save stale files list (for incremental embedding cleanup).
    // Includes both deleted AND modified files: chunk ids are position-keyed
    // (chunker.ts chunkId), so an in-place edit at the same line range produces
    // an identical id and the embedder's id-set filter would otherwise leave
    // the old vector in LanceDB unchanged. Listing modified files here lets
    // embedChunks() wipe their old chunks before re-embedding.
    const allStaleFiles: Array<{ repoName: string; filePath: string }> = [];
    for (const repo of reposToIndex) {
      const result = repoChunkResults.get(repo.name);
      // A repo indexed for the first time has no rows to wipe.
      if (!result || !(await readRepoIndexMeta(basePath, repo.name, storage.blobs))) continue;
      for (const f of result.deletedFiles ?? []) {
        allStaleFiles.push({ repoName: repo.name, filePath: f });
      }
      for (const f of result.changedFiles ?? []) {
        allStaleFiles.push({ repoName: repo.name, filePath: f });
      }
    }
    // Keep entries a previous embed hasn't applied yet (it failed or never ran):
    // overwriting would drop those files' pending wipes.
    const listed = new Set(allStaleFiles.map((f) => `${f.repoName}\0${f.filePath}`));
    for (const f of await this.getDeletedFiles(storage.blobs)) {
      if (!listed.has(`${f.repoName}\0${f.filePath}`)) allStaleFiles.push(f);
    }
    await storage.blobs.putText('deleted_files.json', JSON.stringify(allStaleFiles));

    // 12. Save per-repo metadata
    for (const repo of reposToIndex) {
      const result = repoChunkResults.get(repo.name);
      // Writer mode discards the clone before we get here — the sha was
      // captured inside the pipeline (pre-discard); fall back to the local
      // checkout only when the pipeline didn't run for this repo.
      const sha = result?.sha ?? getRepoSha(repo.path);
      const totalChunkCount = result ? Object.values(result.fileIndex).reduce((sum: number, f: any) => sum + f.chunkCount, 0) : 0;
      if (sha) {
        // The repo's unchanged rows keep the vector space they were embedded in
        // until the embed step records the next one.
        const prev = await readRepoIndexMeta(basePath, repo.name, storage.blobs);
        await writeRepoIndexMeta(storage.blobs, repo.name, {
          lastIndexedSha: sha,
          lastIndexedAt: new Date().toISOString(),
          chunkCount: totalChunkCount,
          embeddingProvider: 'pending',
          embeddingModel: prev?.embeddingModel,
          embeddingDimensions: prev?.embeddingDimensions,
          files: result?.fileIndex,
          workingTree: result?.workingTree,
          chunkIdVersion: CHUNK_ID_VERSION,
          // Serializable form (WorkspaceMap holds Maps) — rehydrated when this
          // repo is later skipped, for cross-repo workspace-dep correlation.
          workspacePackages: workspaceMaps.get(repo.name)?.packages,
        });
      }
    }

    for (const name of removedRepos) {
      try {
        await storage.blobs.deletePrefix(`${name}/`);
        log(`Removed ${name} — no longer in the workspace`);
      } catch (e) {
        log(`Warning: could not remove stored artifacts of ${name}: ${e}`);
      }
    }

    // Rolled-up stats: index_status / GET /status read ONE small blob instead
    // of walking every repo's index_meta (800 reads per call at org scale).
    try {
      await storage.blobs.putJson('index_stats.json', {
        repos: repoStats,
        totalChunks: mergedChunkCount,
        totalTokens: mergedTokenSum,
        crossRepoEdges: crossRepoEdgeCount,
        embeddingProvider: 'pending',
        lastIndexed: new Date().toISOString(),
      });
    } catch { /* rollup is an optimization — getStats falls back to the walk */ }

    // Signal read replicas: chunks + graph + metas for this cycle are visible.
    await bumpIndexGeneration(storage.blobs);

    const durationMs = Date.now() - startTime;
    report({ phase: 'done', message: `KB built: ${mergedChunkCount} chunks, ${crossRepoEdgeCount} edges in ${formatEta(Math.ceil(durationMs / 1000))}`, percent: 100, etaSeconds: 0, skippedRepos });

    return {
      project,
      repos: repoStats,
      totalChunks: mergedChunkCount,
      totalTokens: mergedTokenSum,
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
    const storage = resolveStorage(project, config);
    const basePath = storage.basePath;

    const chunksPath = join(basePath, 'chunks.json'); // for display in logs/errors
    if (!(await storage.blobs.exists('chunks.json'))) {
      throw new Error(`No chunks found — run Build KB first. Expected: ${chunksPath}`);
    }

    // Open vector store. healCorrupt: this is the write/rebuild path, so if a
    // prior run left the table corrupt (killed mid-write → 0-byte fragment),
    // drop it and rebuild from chunks.json rather than failing every reindex.
    const vectorStore = storage.vectors;
    await vectorStore.init({ healCorrupt: true });
    // Cross-repo edges are counted by buildKB (stats rollup), not here.
    const crossRepoEdges = (await storage.blobs
      .getJson<{ crossRepoEdges?: number }>('index_stats.json')
      .catch(() => null))?.crossRepoEdges ?? 0;

    // Rows of changed/deleted files (listed by buildKB) are stale. Chunk ids are
    // hash(repoName, filePath, startLine, endLine), so a changed file's new
    // chunks can take ids its old rows hold: note each stale row's
    // (id, contentHash), treat those ids as not embedded in the diff below, and
    // delete exactly those rows after the embed loop. Until then their vectors
    // stay in the table for reuse by content. A stale row whose id and text
    // both come back is simply kept.
    const deletedFiles = await this.getDeletedFiles(storage.blobs);
    const staleRows = new Map<string, Set<string>>(); // id → contentHashes
    if (deletedFiles.length > 0) {
      const byRepo = new Map<string, string[]>();
      for (const d of deletedFiles) {
        const list = byRepo.get(d.repoName) ?? [];
        list.push(d.filePath);
        byRepo.set(d.repoName, list);
      }
      for (const [repoName, filePaths] of byRepo) {
        log(`Re-planning ${filePaths.length} changed/deleted files from ${repoName}...`);
        for (const r of await vectorStore.getFileRowHashes(project, repoName, filePaths)) {
          const hashes = staleRows.get(r.id) ?? new Set<string>();
          hashes.add(r.contentHash);
          staleRows.set(r.id, hashes);
        }
      }
    }

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
    for (const id of staleRows.keys()) existingIds.delete(id);

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
    const listedIds = new Set<string>();
    for await (const c of storage.blobs.iterateNdjson<CodeChunk>('chunks.json')) {
      totalChunks++;
      totalTokens += c.tokens;
      repoChunkCounts.set(c.repoName, (repoChunkCounts.get(c.repoName) ?? 0) + 1);
      listedIds.add(c.id);
      if (existingIds.has(c.id)) continue;
      // Same id, same text as a stale row: keep that row as it is.
      const stale = staleRows.get(c.id);
      if (stale?.delete(contentHash(c.contextualizedContent))) {
        existingIds.add(c.id);
        continue;
      }
      newChunkCount++;
    }
    log(`Loaded ${totalChunks} chunks from ${chunksPath}`);

    // chunks.json is the corpus: rows it no longer lists — a removed repo, a
    // file deletion a fallback re-chunk caught, chunks from an older id scheme
    // — are swept, after the embed loop so their vectors can be reused first
    // (their ids can't collide with a listed chunk). An empty chunks.json is
    // treated as a failed build, not as "delete everything".
    const orphanIds = totalChunks > 0 ? [...existingIds].filter((id) => !listedIds.has(id)) : [];
    const staleLeft = [...staleRows].flatMap(([id, hashes]) => [...hashes].map((h) => ({ id, contentHash: h })));
    const sweep = async (): Promise<void> => {
      // A stale row whose id no listed chunk took can go by id (cheap IN-list
      // deletes); only ids a new chunk now holds need the exact pair.
      const takenIds = staleLeft.filter((r) => listedIds.has(r.id));
      const byId = [...staleLeft.filter((r) => !listedIds.has(r.id)).map((r) => r.id), ...orphanIds];
      if (staleLeft.length > 0) log(`Removing ${staleLeft.length} stale rows of changed/deleted files...`);
      if (orphanIds.length > 0) log(`Removing ${orphanIds.length} rows no longer in ${chunksPath}...`);
      await vectorStore.deleteRows(takenIds);
      await vectorStore.deleteChunksByIds(byId);
    };
    const repoNames = [...repoChunkCounts.keys()];

    if (newChunkCount === 0 && deletedFiles.length === 0) {
      await sweep();
      // All vectors already present, so DON'T re-embed. But build the full-text
      // (BM25) index if it is missing: a prior run that wrote vectors then
      // aborted before the post-loop FTS build leaves none, and this "nothing
      // new" path is the only one a re-run reaches. An existing index is kept;
      // maintainVectorIndex's optimize() folds in rows it doesn't cover yet.
      log('All chunks already embedded — ensuring full-text index is built (no re-embed).');
      await vectorStore.ensureFtsIndex();
      // Heal missing scalar + vector indexes too (a prior run could have aborted
      // before building them) so filtered search / graph expansion / vector search
      // stay index-backed rather than full-scanning, and run the vector-index step
      // (build / due retrain / optimize — a prior run may also have died before
      // folding its appends in).
      await vectorStore.ensureScalarIndexes();
      const vectorIndex = await maintainVectorIndex(vectorStore, storage.blobs, { rowsWritten: 0 });
      // optimize() prunes dataset versions past the retention window; readers
      // only reopen on a generation bump, so signal them or a reader pinned to
      // a pruned version would lose its files.
      await bumpIndexGeneration(storage.blobs);
      report({ phase: 'done', message: 'All chunks already embedded', percent: 100, etaSeconds: 0 });
      return {
        project,
        repos: repoNames.map((n) => ({ name: n, chunkCount: repoChunkCounts.get(n) ?? 0, language: '' })),
        totalChunks,
        totalTokens,
        embeddingProvider: 'cached',
        embeddingDimensions: 0,
        crossRepoEdges,
        lastIndexed: new Date().toISOString(),
        indexDurationMs: Date.now() - startTime,
        ...(vectorIndex ? { vectorIndex } : {}),
      };
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
    // The contentHash index must exist before the reuse lookups below (an
    // upgraded table gets the column and its index here, not after the loop).
    await vectorStore.ensureScalarIndexes();

    // Embedding reuse: a chunk whose exact text a row already holds takes that
    // row's vector instead of a provider call. Only within one embedding space:
    // the first batch with reusable vectors embeds one of those texts and
    // compares (every batch waits on that one answer), so a provider / model /
    // dimension change never reuses a vector.
    let reused = 0;
    let sameSpace: Promise<boolean> | undefined;
    const embedBatch = async (chunks: CodeChunk[]): Promise<number[][]> => {
      const texts = chunks.map((c) => c.contextualizedContent);
      const hashes = texts.map(contentHash);
      const known = await vectorStore.getVectorsByContentHash([...new Set(hashes)]);
      const vectors: Array<number[] | undefined> = hashes.map((h) => known.get(h));
      let fromStore = vectors.filter(Boolean).length;
      const hit = vectors.findIndex(Boolean);
      if (hit >= 0) {
        let probe: number[] | undefined;
        const stored = vectors[hit]!;
        sameSpace ??= embedder.embed([texts[hit]]).then(([v]) => {
          probe = v;
          return v.length === stored.length && cosineSimilarity(v, stored) > 0.99;
        });
        if (!(await sameSpace)) {
          vectors.fill(undefined);
          fromStore = 0;
        }
        if (probe) {
          if (vectors[hit]) fromStore--;
          vectors[hit] = probe;
        }
      }
      const missing = vectors.flatMap((v, i) => (v ? [] : [i]));
      if (missing.length > 0) {
        const fresh = await embedder.embed(missing.map((i) => texts[i]));
        missing.forEach((i, k) => { vectors[i] = fresh[k]; });
      }
      reused += fromStore;
      return vectors as number[][];
    };

    // Stream chunks.json a second time and embed only the new ones, in batches.
    // Up to `concurrency` batches are in flight at once. Embedded rows go into
    // a buffer that is appended to LanceDB once it holds WRITE_ROWS rows (and
    // once more at the end): every append is a LanceDB commit — a new version
    // plus a data file — so appending per embedding batch would make commits,
    // files and version-cleanup work scale with chunks / batchSize. Appends are
    // serialized via writeChain (LanceDB's add must not run concurrently on
    // one table). Crucially we NEVER materialize the full chunk set nor a
    // pre-sliced `batches[][]`: the producer reads one chunk at a time, fills a
    // batch, dispatches it, then blocks until an in-flight slot frees. Memory
    // stays bounded to the id-set + ~concurrency batches + one write buffer
    // regardless of corpus size. The run stays resumable: new chunks are
    // diffed against ids already in the store, so a crash loses at most the
    // unwritten buffer and a re-run continues from there. FTS is checked once
    // after the loop (skipIndex).
    const WRITE_ROWS = 4096;
    const totalBatches = Math.max(1, Math.ceil(newChunkCount / batchSize));
    let batchesDone = 0;
    let embedded = 0;
    let stored = 0;
    const embedStartTime = Date.now();
    let writeChain: Promise<void> = Promise.resolve();
    let pending: Array<CodeChunk & { embedding: number[] }> = [];
    // Append the buffered rows after any earlier append; resolves once written.
    const flush = (): Promise<void> => {
      const rows = pending;
      pending = [];
      if (rows.length === 0) return writeChain;
      return (writeChain = writeChain.then(async () => {
        await vectorStore.addChunks(rows, { skipIndex: true });
        stored += rows.length;
      }));
    };

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
          const batchEmbeddings = await embedBatch(batchChunks);
          if (aborted) return;
          pending.push(...batchChunks.map((chunk, j) => ({ ...chunk, embedding: batchEmbeddings[j] })));
          embedded += batchChunks.length;
          batchesDone++;
          if (pending.length >= WRITE_ROWS) await flush();
          if (aborted) return;

          const elapsed = Date.now() - embedStartTime;
          const msPerBatch = elapsed / batchesDone;
          const etaSeconds = Math.ceil((msPerBatch * (totalBatches - batchesDone)) / 1000);
          const percent = Math.round(5 + (batchesDone / totalBatches) * 85);

          report({
            phase: 'embedding',
            message: `Embedding: ${embedded}/${newChunkCount} new (~${etaSeconds}s remaining)`,
            percent, etaSeconds,
            chunksTotal: newChunkCount, chunksProcessed: embedded,
          });

          if (batchesDone % 10 === 0 || batchesDone === totalBatches) {
            log(`  Embedded ${embedded}/${newChunkCount} (ETA: ${formatEta(etaSeconds)})`);
          }
        } catch (err) {
          aborted = err; // stop producer + siblings; rethrown after all settle
        }
      })();
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    };

    let batch: CodeChunk[] = [];
    for await (const c of storage.blobs.iterateNdjson<CodeChunk>('chunks.json')) {
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
    if (!aborted) {
      try { await flush(); } catch (err) { aborted = err; }
    }
    if (aborted) throw aborted; // no zombies left running; fail the run cleanly
    await sweep();

    // Build the full-text + scalar indexes if missing, after all batches are
    // inserted; existing ones are kept and optimize() below folds the appends in.
    report({ phase: 'storing', message: 'Building search indexes...', percent: 92, etaSeconds: -1 });
    if (newChunkCount > 0) {
      await vectorStore.ensureFtsIndex();
    }
    // Scalar indexes (repoName/project/filePath/entityName/id) turn graph-expansion
    // + filtered search from full-table scans into indexed lookups; the vector
    // index (IVF_FLAT default, IVF_PQ when storage.vector.lancedb.index is set)
    // turns brute-force KNN into probed-partition reads — together the
    // query-latency win at org scale. maintainVectorIndex builds it once the
    // table is big enough, retrains it in place once the rows written since its
    // last training reach the retrain ratio, and optimizes (folds this run's
    // appends into every index, compacts, prunes).
    await vectorStore.ensureScalarIndexes();
    const vectorIndex = await maintainVectorIndex(vectorStore, storage.blobs, { rowsWritten: stored });
    log(`Stored ${newChunkCount} new chunks in LanceDB (${reused} reused by content, ${deletedFiles.length} files re-planned)`);
    // The stale-file list is applied — clear it, or a later no-change cycle
    // (buildKB returns early without rewriting it) would wipe those files again
    // with nothing left to re-embed them.
    if (deletedFiles.length > 0) await storage.blobs.putText('deleted_files.json', '[]');

    // Update metadata (repoNames was computed during pass 1).
    for (const repoName of repoNames) {
      const metaKey = `${repoName}/index_meta.json`;
      try {
        const meta = await storage.blobs.getJson<RepoIndexMeta>(metaKey);
        if (meta) {
          meta.embeddingProvider = embedder.name;
          meta.embeddingModel = embedder.model;
          meta.embeddingDimensions = embedder.dimensions;
          meta.lastIndexedAt = new Date().toISOString();
          await storage.blobs.putJson(metaKey, meta);
        }
      } catch { /* ok */ }
    }

    const durationMs = Date.now() - startTime;
    // Patch the stats rollup now that the embedding provider is committed.
    try {
      const rollup = await storage.blobs.getJson<Record<string, unknown>>('index_stats.json');
      if (rollup) {
        await storage.blobs.putJson('index_stats.json', {
          ...rollup,
          embeddingProvider: embedder.name,
          lastIndexed: new Date().toISOString(),
        });
      }
    } catch { /* optimization only */ }

    // Signal read replicas: the vector + FTS state for this cycle is visible.
    await bumpIndexGeneration(storage.blobs);
    report({ phase: 'done', message: `Embedded ${newChunkCount} new chunks (${deletedFiles.length} removed) in ${formatEta(Math.ceil(durationMs / 1000))}`, percent: 100, etaSeconds: 0 });

    return {
      project,
      repos: repoNames.map((n) => ({ name: n, chunkCount: repoChunkCounts.get(n) ?? 0, language: '' })),
      totalChunks,
      totalTokens,
      embeddingProvider: embedder.name,
      embeddingDimensions: embedder.dimensions,
      crossRepoEdges,
      lastIndexed: new Date().toISOString(),
      indexDurationMs: durationMs,
      ...(vectorIndex ? { vectorIndex } : {}),
    };
  }

  /** Read the deleted files list saved by buildKB */
  private async getDeletedFiles(blobs: BlobStorePort): Promise<Array<{ repoName: string; filePath: string }>> {
    try {
      return (await blobs.getJson<Array<{ repoName: string; filePath: string }>>('deleted_files.json')) ?? [];
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
  async getStats(project: string, config?: KnowledgeConfig): Promise<IndexStats> {
    const storage = resolveStorage(project, config);
    const basePath = storage.basePath;
    const vectorIndex = await readVectorIndexHealth(storage.blobs);
    const withVectorIndex = (s: IndexStats): IndexStats => (vectorIndex ? { ...s, vectorIndex } : s);

    // Fast path: the writer's rolled-up stats — one small blob read instead of
    // a vector-store connect + a meta read per repo.
    try {
      const rollup = await storage.blobs.getJson<{
        repos: Array<{ name: string; chunkCount: number; language: string }>;
        totalChunks: number;
        totalTokens: number;
        crossRepoEdges: number;
        embeddingProvider: string;
        lastIndexed: string;
      }>('index_stats.json');
      if (rollup) {
        return withVectorIndex({
          project,
          repos: rollup.repos,
          totalChunks: rollup.totalChunks,
          totalTokens: rollup.totalTokens,
          embeddingProvider: rollup.embeddingProvider,
          embeddingDimensions: 0,
          crossRepoEdges: rollup.crossRepoEdges,
          lastIndexed: rollup.lastIndexed,
          indexDurationMs: 0,
        });
      }
    } catch { /* fall back to the walk */ }

    const store = storage.vectors;
    await store.init();
    const stats = await store.getStats();

    // Read metadata from per-repo index_meta.json files
    let provider = 'unknown';
    let lastIndexed = '';
    const repos: Array<{ name: string; chunkCount: number; language: string }> = [];

    try {
      for (const entry of await listRepoNames(storage)) {
        const meta = await readRepoIndexMeta(basePath, entry, storage.blobs);
        if (meta) {
          repos.push({ name: entry, chunkCount: meta.chunkCount, language: '' });
          if (meta.embeddingProvider !== 'unknown') provider = meta.embeddingProvider;
          if (meta.lastIndexedAt > lastIndexed) lastIndexed = meta.lastIndexedAt;
        }
      }
    } catch { /* ignore */ }

    return withVectorIndex({
      project,
      repos,
      totalChunks: stats?.rowCount ?? 0,
      totalTokens: 0,
      embeddingProvider: provider,
      embeddingDimensions: 0,
      crossRepoEdges: 0,
      lastIndexed,
      indexDurationMs: 0,
    });
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
/** Bounded-scratch writer entry (k8s CronJob): index repos straight from
 *  their clone URLs. Unchanged repos are skipped via `git ls-remote` without
 *  cloning; changed ones are shallow-cloned into scratchDir, processed, and
 *  discarded — peak disk = pool concurrency × largest repo. */
export async function indexFromRemotes(
  project: string,
  remotes: Array<{ name: string; cloneUrl: string; language?: string }>,
  opts: {
    config: KnowledgeConfig;
    scratchDir?: string;
    force?: boolean;
    onProgress?: (msg: string) => void;
    onDetailedProgress?: (progress: IndexProgress) => void;
  },
): Promise<IndexStats> {
  const scratch = opts.scratchDir ?? join(tmpdir(), 'code-search-scratch', project);
  mkdirSync(scratch, { recursive: true });
  const repos = remotes.map((r) => ({
    name: r.name,
    path: join(scratch, r.name),
    language: r.language ?? '',
    cloneUrl: r.cloneUrl,
  }));
  const indexer = new KnowledgeIndexer();
  await indexer.buildKB(project, repos, opts.config, opts);
  return indexer.embedChunks(project, opts.config, opts);
}

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
/**
 * Retriever cache. Building a retriever opens LanceDB + SQLite, reads every
 * repo's index_meta, and loads the query router — seconds of work that used to
 * run on EVERY query (getRetriever was called per search). We build it once per
 * (project, embedding-space) and reuse it; the embedding space is in the key so
 * a config change to the embedder rebuilds rather than serving a mismatched
 * store. Promises are cached so concurrent first-hits share one build.
 *
 * Invalidated by {@link invalidateRetriever} when a reindex writes new data (the
 * writer serve process); read-only replicas that don't reindex in-process get
 * freshness separately (Step 2 — checkoutLatest).
 */
interface RetrieverCacheEntry {
  retriever: Promise<HybridRetriever>;
  fingerprint: string; // on-disk index fingerprint at build time
  checkedAt: number;   // last freshness check (ms epoch)
}
const retrieverCache = new Map<string, RetrieverCacheEntry>();

/**
 * How often a cached retriever re-checks whether the on-disk index changed.
 * The in-process writer invalidates its own cache on reindex (immediate); a
 * READ-ONLY replica (separate process sharing the same volume) can't be
 * invalidated that way, so it relies on this TTL check to notice the writer's
 * reindex and rebuild. 0 disables. env: CODE_SEARCH_RETRIEVER_TTL_MS.
 */
export function retrieverFreshnessMs(): number {
  const ms = parseInt(process.env.CODE_SEARCH_RETRIEVER_TTL_MS ?? '', 10);
  return Number.isFinite(ms) && ms >= 0 ? ms : 30_000;
}
const RETRIEVER_FRESHNESS_MS = retrieverFreshnessMs();

function retrieverCacheKey(project: string, config: KnowledgeConfig): string {
  const e = config.embedding;
  return `${project}::${e.provider}:${e.model ?? ''}:${e.dimensions ?? ''}::${JSON.stringify(config.retrieval)}`;
}

/** Cheap change-signal for a project's index. Primary: the `index_generation`
 *  blob the writer bumps after every cycle — works on EVERY backend (a Mongo
 *  findOne / a local file read) and is what lets remote read replicas notice a
 *  reindex without a redeploy. Fallback for indexes written before the
 *  generation blob existed: mtimes of the local LanceDB dir + system-graph
 *  sqlite (meaningful on the fs backend only). */
async function indexFingerprint(basePath: string, blobs: BlobStorePort): Promise<string> {
  try {
    const gen = await blobs.getJson<{ generation?: number }>('index_generation');
    if (gen?.generation !== undefined) return `gen:${gen.generation}`;
  } catch { /* fall through to local mtimes */ }
  const mt = (p: string): number => { try { return statSync(p).mtimeMs; } catch { return 0; } };
  return `${mt(join(basePath, 'lancedb'))}:${mt(join(basePath, 'system_graph.sqlite'))}`;
}

/** Bump the change-signal read replicas poll on their freshness TTL. Written
 *  after every completed write phase (buildKB, embedChunks) — non-fatal, the
 *  in-process invalidate still covers the writer's own cache. */
async function bumpIndexGeneration(blobs: BlobStorePort): Promise<void> {
  try {
    await blobs.putJson('index_generation', { generation: Date.now(), updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(`[knowledge-core] index_generation bump failed (read replicas will not refresh until redeploy): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Non-fs backends only: the sqlite system graph is produced on local scratch
 *  by the writer and shipped as a blob artifact; readers pull it back through
 *  the graph thunk (resolveStorage). Non-fatal — on failure readers keep the
 *  previously-uploaded graph. (Whole-file buffer: acceptable for the graph's
 *  size class; a streaming put needs a fromFile port extension.) */
async function uploadSystemGraphIfRemote(
  storage: StorageBundle,
  basePath: string,
  log: (m: string) => void,
): Promise<void> {
  if (storage.blobs instanceof FsBlobStore) return;
  const localPath = join(basePath, 'system_graph.sqlite');
  if (!existsSync(localPath)) return;
  try {
    await storage.blobs.putBytes('system_graph.sqlite', readFileSync(localPath));
    log('Uploaded system_graph.sqlite to the blob backend');
    // On a remote backend the local copy is writer scratch — the blob store is
    // the durable home (readers pull it to their cache dir). Discard it so a
    // remote deployment leaves zero durable artifacts on the local fs.
    rmSync(localPath, { force: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[knowledge-core] system graph upload failed (readers keep the previous graph): ${msg.slice(0, 160)}`);
  }
}

/** Repo names that carry KB artifacts. fs fast-path: shallow top-level dir
 *  scan (readRepoIndexMeta returns null for non-repo entries — same as the
 *  prior readdirSync walk). Non-fs backends derive names from a blob list
 *  (a metadata query), keyed on index_meta.json. */
async function listRepoNames(storage: StorageBundle): Promise<string[]> {
  if (storage.blobs instanceof FsBlobStore) {
    try {
      if (!existsSync(storage.basePath)) return [];
      return readdirSync(storage.basePath);
    } catch {
      return [];
    }
  }
  const names = new Set<string>();
  try {
    for (const key of await storage.blobs.list('')) {
      const m = /^([^/]+)\/index_meta\.json$/.exec(key);
      if (m) names.add(m[1]);
    }
  } catch { /* unreadable */ }
  return [...names];
}

export async function getRetriever(
  project: string,
  configOverride?: KnowledgeConfig,
): Promise<HybridRetriever> {
  const config = configOverride ?? loadKnowledgeConfig(project);
  const key = retrieverCacheKey(project, config);
  const basePath = getKnowledgeBasePath(project);
  const entry = retrieverCache.get(key);
  const freshnessBlobs = resolveStorage(project, config).blobs;
  if (entry) {
    const now = Date.now();
    if (RETRIEVER_FRESHNESS_MS === 0 || now - entry.checkedAt < RETRIEVER_FRESHNESS_MS) {
      return entry.retriever; // within TTL — serve cached, no storage touch
    }
    // TTL elapsed: one cheap generation read; rebuild ONLY if the index
    // actually advanced (the sole writer reindexed). Steady state = one small
    // read every TTL.
    if (await indexFingerprint(basePath, freshnessBlobs) === entry.fingerprint) {
      entry.checkedAt = now;
      return entry.retriever;
    }
    retrieverCache.delete(key);
    entry.retriever.then((r) => r.close()).catch(() => { /* ignore */ });
    // The graph tools' shared store is part of the same index generation.
    await invalidateGraphStores(project);
  }
  const fingerprint = await indexFingerprint(basePath, freshnessBlobs);
  const building = buildRetriever(project, config);
  retrieverCache.set(key, { retriever: building, fingerprint, checkedAt: Date.now() });
  // Evict a failed build so a transient error doesn't poison the cache forever.
  building.catch(() => { const e = retrieverCache.get(key); if (e && e.retriever === building) retrieverCache.delete(key); });
  return building;
}

/**
 * Drop cached retrievers (closing their SQLite handles) so the next query
 * rebuilds against fresh index data. Called after an in-process reindex. No arg
 * = clear all projects. (Read replicas refresh via the freshness TTL instead.)
 */
export async function invalidateRetriever(project?: string): Promise<void> {
  const entries = [...retrieverCache.entries()].filter(([k]) => !project || k.startsWith(`${project}::`));
  for (const [k, e] of entries) {
    retrieverCache.delete(k);
    try { (await e.retriever).close(); } catch { /* already closed / build failed */ }
  }
  // The shared graph-store cache follows the same reindex lifecycle.
  await invalidateGraphStores(project);
}

async function buildRetriever(
  project: string,
  config: KnowledgeConfig,
): Promise<HybridRetriever> {
  // All storage (vectors / blobs / graph) resolves through the bundle so the
  // retriever serves fs/LanceDB-local AND object-store deployments alike. Note:
  // the freshness fingerprint in getRetriever stats the LOCAL layout — on a
  // remote backend it degrades to invalidate-on-reindex only.
  const storage = resolveStorage(project, config);
  const basePath = storage.basePath;

  // Load vector store
  const vectorStore = storage.vectors;
  await vectorStore.init();

  // Open the system-graph store for graph-augmented retrieval. It prefers
  // system_graph.sqlite (org scale, bounded slice queries) and falls back to
  // the legacy JSON for small/old indexes; null if neither exists → retrieval
  // runs vector + BM25 only. This replaces loading the whole graph into an
  // in-memory graphology graph per query — which at org scale either didn't
  // exist (only the sqlite is written) or was multi-GB to parse.
  const graphStore = await storage.graph();

  // Create embedding provider for query-time embedding
  const embedder = createEmbeddingProvider(config.embedding);

  // Vector-space safety: refuse to run if the index was embedded with a
  // different provider, model or dimension than the current config resolves
  // to. Garbage results from silent space mismatch are worse than a hard error.
  try {
    for (const entry of await listRepoNames(storage)) {
      const meta = await readRepoIndexMeta(basePath, entry, storage.blobs);
      if (!meta) continue;
      const built =
        (meta.embeddingProvider && meta.embeddingProvider !== 'pending' && meta.embeddingProvider !== embedder.name && `provider "${meta.embeddingProvider}"`) ||
        (meta.embeddingModel !== undefined && embedder.model !== undefined && meta.embeddingModel !== embedder.model && `model "${meta.embeddingModel}"`) ||
        (meta.embeddingDimensions !== undefined && meta.embeddingDimensions !== embedder.dimensions && `${meta.embeddingDimensions} dimensions`);
      if (built) {
        throw new Error(
          `[knowledge-core] Vector-space mismatch for repo "${entry}": ` +
          `index built with ${built} but retrieval is using "${embedder.name}" model "${embedder.model ?? ''}" (${embedder.dimensions} dimensions). ` +
          `Reindex with force, or revert the config change ` +
          `(CODE_SEARCH_EMBEDDING_PROVIDER / _MODEL / _DIMENSIONS or config.embedding).`,
        );
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
    queryRouter = await createQueryRouter(project, embedder, config);
    if (queryRouter) {
      console.error(`[knowledge] Query router ready (${queryRouter.repoCount} repo profiles)`);
    }
  } catch {
    // Query routing unavailable — search all repos
  }

  return new HybridRetriever(vectorStore, embedder, graphStore, {
    maxChunks: config.retrieval.maxChunks,
    maxTokens: config.retrieval.maxTokens,
    hybridWeights: config.retrieval.hybridWeights,
  }, reranker, queryRouter);
}
