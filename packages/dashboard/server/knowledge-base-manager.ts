/**
 * Knowledge Base Manager — AST-powered codebase knowledge layer.
 *
 * Manages per-project, per-repo knowledge graphs using the in-house AST builder.
 * Provides:
 *   - Status tracking (ready/stale/none) via SHA comparison
 *   - Refresh via built-in TypeScript AST graph builder
 *   - GRAPH_REPORT.md loading for agent context injection
 *
 * Storage layout:
 *   ~/.anvil/knowledge-base/<project>/<repo>/
 *     ├── graph.json         # AST-extracted knowledge graph
 *     ├── GRAPH_REPORT.md    # Low-token architectural overview
 *     └── metadata.json      # Tracking (lastRefreshed, commitSha, stats)
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectLoader } from './project-loader.js';

const execFileAsync = promisify(execFile);

/**
 * Branch refs the KB is anchored to, in order of preference. Picking the
 * canonical default branch (over local HEAD) keeps the index stable
 * across collaborators — uncommitted edits or feature branches don't
 * shift the index underneath us.
 */
const KB_BUILD_REFS: readonly string[] = ['origin/main', 'main', 'origin/master', 'master'];

/** index_meta.json shape written by `@esankhan3/anvil-knowledge-core`'s indexer. */
interface KnowledgeCoreIndexMeta {
  lastIndexedSha: string;
  lastIndexedAt: string;
  chunkCount?: number;
  embeddingProvider?: string;
}

// ── Constants ─────────────────────────────────────────────────────────

const ANVIL_HOME = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
const KB_DIR = join(ANVIL_HOME, 'knowledge-base');
// No size limit — all reports are loaded. Storage is local and context window is large enough.
// ── Types ─────────────────────────────────────────────────────────────

export interface KBMetadata {
  lastRefreshed: string;
  lastCommitSha: string;
  graphifyVersion: string;
  fileCount: number;
  nodeCount: number;
  communityCount: number;
  buildDurationMs: number;
  status: 'ready' | 'error';
  error?: string;
}

export interface KBRepoStatus {
  repoName: string;
  status: 'none' | 'building' | 'ready' | 'stale' | 'error';
  lastRefreshed: string | null;
  lastCommitSha: string | null;
  currentCommitSha: string | null;
  nodeCount: number;
  communityCount: number;
  error: string | null;
  // Vector-store status — populated when knowledge-core has embedded
  // chunks for this repo into LanceDB. `null` means "not embedded yet".
  vectorChunks: number | null;
  embeddingProvider: string | null;
  lastEmbeddedAt: string | null;
}

export interface KBProjectStatus {
  project: string;
  repos: KBRepoStatus[];
  overallStatus: 'none' | 'partial' | 'ready' | 'stale' | 'building' | 'unavailable';
  lastRefreshed: string | null;
  /**
   * In-flight build progress — populated only while
   * `overallStatus === 'building'`. Lets a client that revisits the
   * page mid-build pick up the latest message without re-broadcasting
   * every tick.
   */
  currentProgress: KBRefreshProgress | null;
}

export interface KBRefreshProgress {
  project: string;
  repo: string;
  phase: 'checking' | 'building' | 'complete' | 'skipped' | 'error';
  repoIndex: number;
  totalRepos: number;
  message: string;
}

// ── Project Graph & Index Types ────────────────────────────────────────

export interface ProjectGraphNode {
  id: string;              // namespaced: "repo::originalId"
  repo: string;
  label: string;
  community: string;       // "repo::communityNum"
}

export interface ProjectGraphEdge {
  source: string;
  target: string;
  relation: string;        // 'calls' | 'imports' | 'contains' | 'kafka' | 'redis' | 'http' | 'mongo' | 'depends_on'
  transport?: string;      // topic name, redis key, HTTP endpoint
}

export interface ProjectGraph {
  project: string;
  generatedAt: string;
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  crossRepoEdges: number;
}

export interface CommunityInfo {
  id: string;              // "repo::communityNum"
  repo: string;
  nodeCount: number;
  keywords: string[];      // top node labels
  entryPoints: string[];   // high-degree nodes
  summary: string;
}

export interface TransportEdge {
  type: string;            // 'kafka' | 'redis' | 'redis-cluster' | 'http' | 'mongo' | 'scylla'
  name: string;            // topic, key pattern, endpoint
  producers: string[];     // repo/component names
  consumers: string[];     // repo/component names
}

export interface ProjectIndex {
  project: string;
  generatedAt: string;
  repos: Array<{
    name: string;
    nodeCount: number;
    communityCount: number;
    language: string;
  }>;
  communities: CommunityInfo[];
  transports: TransportEdge[];
  entryPoints: Array<{
    nodeId: string;
    repo: string;
    degree: number;
    label: string;
  }>;
  keywordIndex: Record<string, string[]>; // keyword → community IDs
}

export interface KBQueryResult {
  query: string;
  matchedCommunities: CommunityInfo[];
  matchedTransports: TransportEdge[];
  contextChunks: Array<{
    repo: string;
    communityId: string;
    content: string;
  }>;
  totalChars: number;
}

// ── Knowledge Base Manager ────────────────────────────────────────────

export class KnowledgeBaseManager {
  private projectLoader: ProjectLoader;
  private refreshing = false;
  private lastProgress: KBRefreshProgress | null = null;
  /**
   * Cache of hybrid-retriever results, keyed by `${project}::${query}`.
   * Populated by prefetchHybridContext (called from pipeline-runner at run
   * start) and consumed by getQueryContextForPrompt as a preferred source
   * over keyword scoring on project_index.json.
   */
  private hybridContextCache = new Map<string, string>();

  constructor(projectLoader: ProjectLoader) {
    this.projectLoader = projectLoader;
    ensureDir(KB_DIR);
  }

  isAvailable(): boolean {
    return true; // AST graph builder is built-in, always available
  }

  isRefreshing(): boolean {
    return this.refreshing;
  }

  /**
   * In-flight progress snapshot — lets a freshly-connected dashboard
   * client see the current state of an in-flight build, instead of
   * waiting for the next progress event.
   */
  getCurrentProgress(): KBRefreshProgress | null {
    return this.lastProgress;
  }

  private emitProgress(
    cb: ((p: KBRefreshProgress) => void) | undefined,
    p: KBRefreshProgress,
  ): void {
    this.lastProgress = p;
    cb?.(p);
  }

  // ── Path helpers ────────────────────────────────────────────────────

  private projectDir(project: string): string {
    return join(KB_DIR, project);
  }

  private repoDir(project: string, repo: string): string {
    return join(KB_DIR, project, repo);
  }

  private metadataPath(project: string, repo: string): string {
    return join(this.repoDir(project, repo), 'metadata.json');
  }

  private graphReportPath(project: string, repo: string): string {
    return join(this.repoDir(project, repo), 'GRAPH_REPORT.md');
  }

  // ── Metadata I/O ────────────────────────────────────────────────────

  private readMetadata(project: string, repo: string): KBMetadata | null {
    const path = this.metadataPath(project, repo);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return null;
    }
  }

  // ── Git SHA + worktree (build-from-main anchoring) ──────────────────

  /**
   * Resolve the SHA we should build the KB from. Prefers `origin/main` →
   * `main` → `origin/master` → `master`, in that order. Returns `null`
   * when none of the canonical references exist.
   *
   * Anchoring on the canonical default branch (rather than HEAD) means a
   * feature branch with un-merged work doesn't move the index SHA.
   */
  private async getKbBuildSha(repoPath: string): Promise<{ sha: string; ref: string } | null> {
    for (const ref of KB_BUILD_REFS) {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', ref], {
          cwd: repoPath,
          timeout: 5000,
        });
        const sha = stdout.trim();
        if (sha) return { sha, ref };
      } catch { /* try next ref */ }
    }
    return null;
  }

  /**
   * Stand up a detached git worktree at `<sha>` in a tmp dir, hand the
   * path to `fn`, and clean up afterward. The user's working tree is
   * never touched — uncommitted edits stay put.
   */
  private async withMainWorktree<T>(
    repoPath: string,
    sha: string,
    fn: (worktreePath: string) => Promise<T>,
  ): Promise<T> {
    const worktreePath = mkdtempSync(join(tmpdir(), 'anvil-kb-worktree-'));
    // mkdtemp creates the dir; `git worktree add` rejects an existing
    // non-empty path, so remove the placeholder before adding.
    rmSync(worktreePath, { recursive: true, force: true });

    try {
      await execFileAsync('git', ['worktree', 'add', '--detach', '--quiet', worktreePath, sha], {
        cwd: repoPath,
        timeout: 30_000,
      });
    } catch (err) {
      throw new Error(
        `git worktree add failed at ${repoPath} for ${sha}: ` +
        (err instanceof Error ? err.message : String(err)),
      );
    }

    try {
      return await fn(worktreePath);
    } finally {
      // Best-effort cleanup; a failure here doesn't undo a successful build.
      try {
        await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
          cwd: repoPath,
          timeout: 30_000,
        });
      } catch (err) {
        console.warn(
          `[kb] git worktree remove failed for ${worktreePath}: ` +
          (err instanceof Error ? err.message : String(err)),
        );
        try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Read the index_meta.json that knowledge-core's KnowledgeIndexer
   * writes during embedding. Used to surface vector-store status in the
   * dashboard.
   */
  private readKnowledgeCoreMeta(project: string, repo: string): KnowledgeCoreIndexMeta | null {
    const metaPath = join(this.repoDir(project, repo), 'index_meta.json');
    if (!existsSync(metaPath)) return null;
    try {
      return JSON.parse(readFileSync(metaPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  // ── Status ──────────────────────────────────────────────────────────

  async getRepoStatus(project: string, repoName: string, repoPath: string | null): Promise<KBRepoStatus> {
    // Stale-detection compares the build SHA (main), not local HEAD.
    const buildRef = repoPath ? await this.getKbBuildSha(repoPath) : null;
    const currentSha = buildRef?.sha ?? null;

    // Vector-store status — read from knowledge-core's index_meta.json
    // (written during the embedding pass).
    const kcMeta = this.readKnowledgeCoreMeta(project, repoName);
    const vectorChunks = typeof kcMeta?.chunkCount === 'number' ? kcMeta.chunkCount : null;
    const embeddingProvider = kcMeta?.embeddingProvider ?? null;
    const lastEmbeddedAt = kcMeta?.lastIndexedAt ?? null;

    const meta = this.readMetadata(project, repoName);

    // Knowledge-core (the new indexer) writes index_meta.json, not metadata.json.
    // When metadata.json is missing, fall back to index_meta.json so a successful
    // refresh isn't permanently mislabelled "stale" / "none".
    if (!meta) {
      if (kcMeta?.lastIndexedSha) {
        const isStale = currentSha != null && kcMeta.lastIndexedSha !== currentSha;
        const nodeCount = this.countGraphNodes(project, repoName);
        return {
          repoName,
          status: isStale ? 'stale' : 'ready',
          lastRefreshed: kcMeta.lastIndexedAt,
          lastCommitSha: kcMeta.lastIndexedSha,
          currentCommitSha: currentSha,
          nodeCount,
          communityCount: 0,
          error: null,
          vectorChunks,
          embeddingProvider,
          lastEmbeddedAt,
        };
      }
      return {
        repoName,
        status: 'none',
        lastRefreshed: null,
        lastCommitSha: null,
        currentCommitSha: currentSha,
        nodeCount: 0,
        communityCount: 0,
        error: null,
        vectorChunks,
        embeddingProvider,
        lastEmbeddedAt,
      };
    }

    // When both metadata.json and index_meta.json exist, prefer whichever was
    // written more recently — knowledge-core only updates index_meta.json on
    // refresh, so a fresh refresh would otherwise still be reported via the
    // older legacy SHA in metadata.json.
    const kcAt = kcMeta?.lastIndexedAt ? new Date(kcMeta.lastIndexedAt).getTime() : 0;
    const metaAt = meta.lastRefreshed ? new Date(meta.lastRefreshed).getTime() : 0;
    const useKc = kcMeta?.lastIndexedSha != null && kcAt >= metaAt;
    const effectiveSha = useKc ? kcMeta!.lastIndexedSha : meta.lastCommitSha;
    const effectiveRefreshedAt = useKc ? kcMeta!.lastIndexedAt : meta.lastRefreshed;
    const isStale = currentSha != null && effectiveSha !== currentSha;

    return {
      repoName,
      status: meta.status === 'error' ? 'error' : (isStale ? 'stale' : 'ready'),
      lastRefreshed: effectiveRefreshedAt,
      lastCommitSha: effectiveSha,
      currentCommitSha: currentSha,
      nodeCount: meta.nodeCount,
      communityCount: meta.communityCount,
      error: meta.error ?? null,
      vectorChunks,
      embeddingProvider,
      lastEmbeddedAt,
    };
  }

  private countGraphNodes(project: string, repo: string): number {
    const graphPath = join(this.repoDir(project, repo), 'graph.json');
    if (!existsSync(graphPath)) return 0;
    try {
      const data = JSON.parse(readFileSync(graphPath, 'utf-8'));
      return Array.isArray(data?.nodes) ? data.nodes.length : 0;
    } catch {
      return 0;
    }
  }

  async getStatus(project: string): Promise<KBProjectStatus> {
    const repoPaths = this.projectLoader.getRepoLocalPaths(project);
    const repoNames = Object.keys(repoPaths);

    if (repoNames.length === 0) {
      // Try to get repo names from project info
      try {
        const projects = await this.projectLoader.listProjects();
        const sys = projects.find((s) => s.name === project);
        if (sys) {
          for (const r of sys.repos) {
            repoNames.push(r.name);
          }
        }
      } catch { /* ok */ }
    }

    const repos: KBRepoStatus[] = [];
    for (const name of repoNames) {
      const status = await this.getRepoStatus(project, name, repoPaths[name] ?? null);
      repos.push(status);
    }

    // Determine overall status
    let overallStatus: KBProjectStatus['overallStatus'] = 'none';
    if (this.refreshing) {
      overallStatus = 'building';
    } else if (repos.length > 0) {
      const readyCount = repos.filter((r) => r.status === 'ready').length;
      const staleCount = repos.filter((r) => r.status === 'stale').length;
      if (readyCount === repos.length) overallStatus = 'ready';
      else if (readyCount > 0 || staleCount > 0) overallStatus = staleCount > 0 ? 'stale' : 'partial';
    }

    const lastRefreshed = repos
      .filter((r) => r.lastRefreshed)
      .sort((a, b) => (b.lastRefreshed ?? '').localeCompare(a.lastRefreshed ?? ''))
      [0]?.lastRefreshed ?? null;

    return {
      project,
      repos,
      overallStatus,
      lastRefreshed,
      currentProgress: this.refreshing ? this.lastProgress : null,
    };
  }

  // ── Refresh ─────────────────────────────────────────────────────────

  async refreshProject(
    project: string,
    onProgress?: (p: KBRefreshProgress) => void,
  ): Promise<KBProjectStatus> {
    if (this.refreshing) {
      throw new Error('A knowledge base refresh is already in progress');
    }
    this.refreshing = true;
    this.lastProgress = null;

    interface RepoBuild {
      name: string;
      originalPath: string;
      worktreePath: string;
      ref: { sha: string; ref: string };
      language: string;
    }

    const builds: RepoBuild[] = [];

    try {
      const repoPaths = this.projectLoader.getRepoLocalPaths(project);
      const repoNames = Object.keys(repoPaths);

      // Resolve language hints from project loader (purely informational —
      // knowledge-core doesn't gate behavior on it).
      const languageByRepo = new Map<string, string>();
      try {
        const projects = await this.projectLoader.listProjects();
        const sys = projects.find((s) => s.name === project);
        for (const r of sys?.repos ?? []) {
          languageByRepo.set(r.name, r.language ?? 'unknown');
        }
      } catch { /* language is best-effort */ }

      // Phase 1 — resolve main SHA per repo + create detached worktrees.
      // The user's working tree is never touched: the index is anchored
      // to a stable shared ref (origin/main → main → master), not local
      // HEAD, so feature-branch divergence won't shift the KB.
      for (let i = 0; i < repoNames.length; i++) {
        const repoName = repoNames[i];
        const origPath = repoPaths[repoName];
        this.emitProgress(onProgress, {
          project, repo: repoName, phase: 'checking',
          repoIndex: i, totalRepos: repoNames.length,
          message: `Resolving build SHA for ${repoName}...`,
        });

        if (!origPath || !existsSync(origPath)) {
          this.emitProgress(onProgress, {
            project, repo: repoName, phase: 'skipped',
            repoIndex: i, totalRepos: repoNames.length,
            message: `Skipping ${repoName} — workspace path not found on disk`,
          });
          continue;
        }
        const ref = await this.getKbBuildSha(origPath);
        if (!ref) {
          this.emitProgress(onProgress, {
            project, repo: repoName, phase: 'skipped',
            repoIndex: i, totalRepos: repoNames.length,
            message: `Skipping ${repoName} — no main/master branch in git history`,
          });
          continue;
        }

        const worktreePath = mkdtempSync(join(tmpdir(), `anvil-kb-${repoName}-`));
        rmSync(worktreePath, { recursive: true, force: true });
        try {
          await execFileAsync(
            'git', ['worktree', 'add', '--detach', '--quiet', worktreePath, ref.sha],
            { cwd: origPath, timeout: 30_000 },
          );
        } catch (err) {
          this.emitProgress(onProgress, {
            project, repo: repoName, phase: 'error',
            repoIndex: i, totalRepos: repoNames.length,
            message: `git worktree add failed for ${repoName} at ${ref.ref}: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }
        builds.push({
          name: repoName,
          originalPath: origPath,
          worktreePath,
          ref,
          language: languageByRepo.get(repoName) ?? 'unknown',
        });
      }

      if (builds.length === 0) {
        throw new Error(
          'No repos to index — check that each cloned repo has a main/master branch',
        );
      }

      // Phase 2 — delegate to knowledge-core's KnowledgeIndexer. Knowledge-
      // core handles the heavy lifting it was designed for: SHA-based
      // skip-if-unchanged, incremental chunking via git diff, structural
      // dedup (the merkle bit), AST graph build, cross-repo edges, and
      // vector embeddings. The dashboard used to reimplement a thinner
      // version of this — that path has been removed.
      const { KnowledgeIndexer, loadKnowledgeConfig } = await import('@esankhan3/anvil-knowledge-core');
      const config = loadKnowledgeConfig(project);
      const indexer = new KnowledgeIndexer();

      const reposForIndexer = builds.map((b) => ({
        name: b.name,
        path: b.worktreePath,
        language: b.language,
      }));

      const buildSummary = builds
        .map((b) => `${b.name}@${b.ref.ref}(${b.ref.sha.slice(0, 7)})`)
        .join(', ');
      this.emitProgress(onProgress, {
        project, repo: '(indexer)', phase: 'building',
        repoIndex: 0, totalRepos: builds.length,
        message: `Indexing ${builds.length} repo(s) at canonical refs: ${buildSummary}`,
      });

      try {
        await indexer.indexProject(project, reposForIndexer, config, {
          onProgress: (msg) => {
            this.emitProgress(onProgress, {
              project, repo: '(indexer)', phase: 'building',
              repoIndex: 0, totalRepos: builds.length, message: msg,
            });
          },
          onDetailedProgress: (p) => {
            this.emitProgress(onProgress, {
              project, repo: '(indexer)',
              phase: p.phase === 'done' ? 'complete' : 'building',
              repoIndex: p.reposProcessed ?? 0,
              totalRepos: p.reposTotal ?? builds.length,
              message: p.message,
            });
          },
        });
      } finally {
        // Phase 3 — always clean up worktrees, even on indexer failure.
        for (const b of builds) {
          try {
            await execFileAsync(
              'git', ['worktree', 'remove', '--force', b.worktreePath],
              { cwd: b.originalPath, timeout: 30_000 },
            );
          } catch (err) {
            console.warn(
              `[kb] git worktree remove failed for ${b.worktreePath}: ` +
              (err instanceof Error ? err.message : String(err)),
            );
            try { rmSync(b.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
          }
        }
      }

      // Phase 4 — dashboard-specific post-processing on top of what
      // knowledge-core already wrote per repo (graph.json, GRAPH_REPORT.md,
      // index_meta.json, system_graph_v2.json):
      //   - SYSTEM_REPORT.md: deterministic cross-repo synthesis read by
      //     getProjectReport. Guaranteed to exist even when no LLM is
      //     available (knowledge-core's PROJECT_SUMMARY.md needs an LLM).
      //   - project_index.json: keyword community/transport index used by
      //     queryKnowledgeBase + getQueryContextForPrompt.
      const builtRepoNames = builds.map((b) => b.name);
      try {
        this.generateProjectReport(project, builtRepoNames);
      } catch (err) {
        console.warn(
          `[kb] generateProjectReport failed: ` +
          (err instanceof Error ? err.message : String(err)),
        );
      }
      try {
        this.buildProjectIndex(project, builtRepoNames);
      } catch (err) {
        console.warn(
          `[kb] buildProjectIndex failed: ` +
          (err instanceof Error ? err.message : String(err)),
        );
      }

      this.emitProgress(onProgress, {
        project, repo: '(complete)', phase: 'complete',
        repoIndex: builds.length, totalRepos: builds.length,
        message: `Knowledge base updated for ${builds.length} repo(s) at main`,
      });

      return this.getStatus(project);
    } finally {
      this.refreshing = false;
      this.lastProgress = null;
    }
  }

  // ── Project-Level KB Synthesis ───────────────────────────────────────

  /**
   * Generate a SYSTEM_REPORT.md that synthesizes cross-repo relationships
   * from individual repo graph.json files. This gives agents a unified
   * architectural view of the entire project.
   */
  private generateProjectReport(project: string, repoNames: string[]): void {
    const sysDir = this.projectDir(project);

    // Collect per-repo graph data
    const repoGraphs: Array<{
      repo: string;
      nodeCount: number;
      communityCount: number;
      nodes: string[];
      imports: string[];
      exports: string[];
    }> = [];

    for (const repo of repoNames) {
      const graphPath = join(this.repoDir(project, repo), 'graph.json');
      const meta = this.readMetadata(project, repo);
      if (!existsSync(graphPath) || !meta || meta.status !== 'ready') continue;

      try {
        const graphData = JSON.parse(readFileSync(graphPath, 'utf-8'));
        const nodes: string[] = (graphData.nodes || []).map((n: any) => n.id || n.name || '').filter(Boolean);
        // Extract imports/exports by looking for cross-repo references
        const imports: string[] = [];
        const exports: string[] = [];

        for (const link of (graphData.links || graphData.edges || [])) {
          const src = link.source || link.from || '';
          const tgt = link.target || link.to || '';
          // Detect cross-repo references (files referencing other repo names)
          for (const otherRepo of repoNames) {
            if (otherRepo === repo) continue;
            if (typeof tgt === 'string' && tgt.includes(otherRepo)) imports.push(`${src} → ${tgt}`);
            if (typeof src === 'string' && src.includes(otherRepo)) exports.push(`${src} → ${tgt}`);
          }
        }

        repoGraphs.push({
          repo,
          nodeCount: meta.nodeCount,
          communityCount: meta.communityCount,
          nodes: nodes.slice(0, 50), // Top nodes for overview
          imports,
          exports,
        });
      } catch { continue; }
    }

    if (repoGraphs.length === 0) return;

    // Build project report
    const sections: string[] = [];

    sections.push(`# Project Knowledge Base: ${project}`);
    sections.push(`\n> Auto-synthesized from ${repoGraphs.length} repository knowledge graphs.\n`);

    // Project overview table
    sections.push(`## Repository Overview\n`);
    sections.push(`| Repository | Nodes | Communities | Cross-repo imports | Cross-repo exports |`);
    sections.push(`|---|---|---|---|---|`);
    for (const rg of repoGraphs) {
      sections.push(`| ${rg.repo} | ${rg.nodeCount} | ${rg.communityCount} | ${rg.imports.length} | ${rg.exports.length} |`);
    }

    // Cross-repo dependency map
    const allImports = repoGraphs.flatMap((rg) => rg.imports.map((i) => ({ repo: rg.repo, ref: i })));
    const allExports = repoGraphs.flatMap((rg) => rg.exports.map((e) => ({ repo: rg.repo, ref: e })));

    if (allImports.length > 0 || allExports.length > 0) {
      sections.push(`\n## Cross-Repository Dependencies\n`);
      if (allImports.length > 0) {
        sections.push(`### Imports (repo depends on another repo)\n`);
        for (const { repo, ref } of allImports.slice(0, 30)) {
          sections.push(`- **${repo}**: ${ref}`);
        }
      }
      if (allExports.length > 0) {
        sections.push(`\n### Exports (repo is depended on by another repo)\n`);
        for (const { repo, ref } of allExports.slice(0, 30)) {
          sections.push(`- **${repo}**: ${ref}`);
        }
      }
    }

    // Shared patterns — look for nodes that appear in multiple repos
    const nodeToRepos = new Map<string, string[]>();
    for (const rg of repoGraphs) {
      for (const node of rg.nodes) {
        // Normalize: strip repo-specific prefixes, look at function/type names
        const baseName = node.split('/').pop()?.split('.')[0] ?? node;
        if (baseName.length < 4) continue; // Skip very short names
        if (!nodeToRepos.has(baseName)) nodeToRepos.set(baseName, []);
        const repos = nodeToRepos.get(baseName)!;
        if (!repos.includes(rg.repo)) repos.push(rg.repo);
      }
    }
    const sharedNodes = [...nodeToRepos.entries()]
      .filter(([_, repos]) => repos.length > 1)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 20);

    if (sharedNodes.length > 0) {
      sections.push(`\n## Shared Concepts Across Repos\n`);
      sections.push(`These names/patterns appear in multiple repositories, suggesting shared interfaces or conventions:\n`);
      for (const [name, repos] of sharedNodes) {
        sections.push(`- **${name}** — found in: ${repos.join(', ')}`);
      }
    }

    // Architecture summary
    sections.push(`\n## Architecture Summary\n`);
    sections.push(`The ${project} project comprises ${repoGraphs.length} repositories:\n`);
    for (const rg of repoGraphs) {
      const depNote = rg.imports.length > 0
        ? ` (imports from ${[...new Set(rg.imports.map((i) => i.split('→')[1]?.trim().split('/')[0]).filter(Boolean))].join(', ')})`
        : '';
      sections.push(`- **${rg.repo}**: ${rg.nodeCount} code nodes, ${rg.communityCount} module clusters${depNote}`);
    }

    const report = sections.join('\n');
    const reportPath = join(sysDir, 'SYSTEM_REPORT.md');
    writeFileSync(reportPath, report, 'utf-8');
    console.log(`[kb] Generated project report for "${project}" (${report.length} chars)`);
  }

  // ── Project Graph & Index ──────────────────────────────────────────

  /**
   * Build a unified project graph by merging all repo graphs and adding
   * cross-repo transport edges parsed from project.yaml.
   */
  buildProjectGraph(project: string, repoNames?: string[], workspaceMaps?: Map<string, any>): ProjectGraph | null {
    const sysDir = this.projectDir(project);
    if (!existsSync(sysDir)) return null;

    const repos = repoNames ?? readdirSync(sysDir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);

    const allNodes: ProjectGraphNode[] = [];
    const allEdges: ProjectGraphEdge[] = [];

    // 1. Load and namespace each repo's graph
    for (const repo of repos) {
      const graphPath = join(this.repoDir(project, repo), 'graph.json');
      if (!existsSync(graphPath)) continue;
      try {
        const data = JSON.parse(readFileSync(graphPath, 'utf-8'));
        const nodes = data.nodes || [];
        const links = data.links || data.edges || [];

        for (const n of nodes) {
          const id = n.id || n.name || '';
          if (!id) continue;
          allNodes.push({
            id: `${repo}::${id}`,
            repo,
            label: typeof n.label === 'string' ? n.label : id.split('/').pop() || id,
            community: `${repo}::${n.community ?? n.group ?? 0}`,
          });
        }

        for (const e of links) {
          const src = e.source || e.from || '';
          const tgt = e.target || e.to || '';
          if (!src || !tgt) continue;
          allEdges.push({
            source: `${repo}::${src}`,
            target: `${repo}::${tgt}`,
            relation: e.relation || e.type || 'contains',
          });
        }
      } catch { continue; }
    }

    // 2. Parse transports from project.yaml and add cross-repo edges
    const transports = this.extractTransportsFromProject(project);
    let crossRepoEdgeCount = 0;

    for (const t of transports) {
      for (const prod of t.producers) {
        for (const cons of t.consumers) {
          if (prod === cons) continue;
          allEdges.push({
            source: `${prod}::__transport_out__`,
            target: `${cons}::__transport_in__`,
            relation: t.type,
            transport: t.name,
          });
          crossRepoEdgeCount++;
        }
      }
    }

    // 3. Add workspace dependency edges (package→package within monorepos)
    if (workspaceMaps && workspaceMaps.size > 0) {
      for (const [repoName, wsMap] of workspaceMaps) {
        if (wsMap.packages.length < 2) continue;
        for (const pkg of wsMap.packages) {
          for (const depName of pkg.dependencies) {
            const target = wsMap.nameToPackage.get(depName);
            if (target && target.name !== pkg.name) {
              allEdges.push({
                source: `${repoName}::pkg::${pkg.name}`,
                target: `${repoName}::pkg::${target.name}`,
                relation: 'workspace-dep',
              });
              crossRepoEdgeCount++;
            }
          }
        }
      }
    }

    const graph: ProjectGraph = {
      project,
      generatedAt: new Date().toISOString(),
      nodes: allNodes,
      edges: allEdges,
      crossRepoEdges: crossRepoEdgeCount,
    };

    // Write to disk
    ensureDir(sysDir);
    writeFileSync(join(sysDir, 'system_graph.json'), JSON.stringify(graph), 'utf-8');
    console.log(`[kb] Built project graph for "${project}": ${allNodes.length} nodes, ${allEdges.length} edges, ${crossRepoEdgeCount} cross-repo`);

    return graph;
  }

  /**
   * Build a compact project index from the project graph.
   * This is the lightweight (~3-5KB) structure injected into agent prompts
   * instead of the full 80K+ KB blob.
   */
  buildProjectIndex(project: string, repoNames?: string[]): ProjectIndex | null {
    const sysDir = this.projectDir(project);

    // Load or build project graph
    let graph: ProjectGraph | null = null;
    const graphPath = join(sysDir, 'system_graph.json');
    if (existsSync(graphPath)) {
      try { graph = JSON.parse(readFileSync(graphPath, 'utf-8')); } catch { /* rebuild */ }
    }
    if (!graph) {
      graph = this.buildProjectGraph(project, repoNames);
    }
    if (!graph || graph.nodes.length === 0) return null;

    // Build degree map for entry point detection
    const degreeMap = new Map<string, number>();
    for (const e of graph.edges) {
      degreeMap.set(e.target, (degreeMap.get(e.target) || 0) + 1);
      degreeMap.set(e.source, (degreeMap.get(e.source) || 0) + 1);
    }

    // Group nodes by community
    const communityNodes = new Map<string, ProjectGraphNode[]>();
    for (const n of graph.nodes) {
      const list = communityNodes.get(n.community) || [];
      list.push(n);
      communityNodes.set(n.community, list);
    }

    // Build community info
    const communities: CommunityInfo[] = [];
    for (const [cid, nodes] of communityNodes.entries()) {
      const repo = nodes[0]?.repo || '';
      // Extract keywords from node labels (top 5 by frequency/degree)
      const labelCounts = new Map<string, number>();
      for (const n of nodes) {
        const words = n.label.toLowerCase().replace(/[^a-z0-9_]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
        for (const w of words) {
          labelCounts.set(w, (labelCounts.get(w) || 0) + 1);
        }
      }
      const keywords = [...labelCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 7)
        .map(([w]) => w);

      // Entry points: highest-degree nodes in this community
      const sorted = nodes.sort((a, b) => (degreeMap.get(b.id) || 0) - (degreeMap.get(a.id) || 0));
      const entryPoints = sorted.slice(0, 3).map((n) => n.label);

      // Summary from top labels
      const topLabels = sorted.slice(0, 4).map((n) => n.label).join(', ');
      const summary = `${repo}: ${topLabels} (${nodes.length} nodes)`;

      communities.push({ id: cid, repo, nodeCount: nodes.length, keywords, entryPoints, summary });
    }

    // Sort communities by node count (most important first), limit to top 50
    communities.sort((a, b) => b.nodeCount - a.nodeCount);
    const topCommunities = communities.slice(0, 50);

    // Build keyword inverted index
    const keywordIndex: Record<string, string[]> = {};
    for (const c of topCommunities) {
      for (const kw of c.keywords) {
        if (!keywordIndex[kw]) keywordIndex[kw] = [];
        keywordIndex[kw].push(c.id);
      }
    }

    // Project-wide entry points (top 20 highest degree)
    const entryPoints = [...degreeMap.entries()]
      .filter(([id]) => !id.includes('__transport_'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([id, degree]) => {
        const node = graph!.nodes.find((n) => n.id === id);
        return {
          nodeId: id,
          repo: node?.repo || id.split('::')[0],
          degree,
          label: node?.label || id.split('::').pop() || id,
        };
      });

    // Repo summaries
    const repoStats = new Map<string, { nodes: number; communities: number }>();
    for (const n of graph.nodes) {
      const s = repoStats.get(n.repo) || { nodes: 0, communities: 0 };
      s.nodes++;
      repoStats.set(n.repo, s);
    }
    for (const c of communities) {
      const s = repoStats.get(c.repo);
      if (s) s.communities++;
    }

    const transports = this.extractTransportsFromProject(project);

    // Get language info from metadata
    const repos = [...repoStats.entries()].map(([name, s]) => {
      return { name, nodeCount: s.nodes, communityCount: s.communities, language: '' };
    });

    const index: ProjectIndex = {
      project,
      generatedAt: new Date().toISOString(),
      repos,
      communities: topCommunities,
      transports,
      entryPoints,
      keywordIndex,
    };

    writeFileSync(join(sysDir, 'project_index.json'), JSON.stringify(index, null, 2), 'utf-8');
    console.log(`[kb] Built project index for "${project}": ${topCommunities.length} communities, ${transports.length} transports, ${entryPoints.length} entry points (~${JSON.stringify(index).length} chars)`);

    return index;
  }

  /**
   * Query the knowledge base by keyword, returning focused context chunks
   * instead of the full KB blob.
   */
  queryKnowledgeBase(project: string, query: string, maxChars = 15000): KBQueryResult {
    // Load or build index
    let index = this.getProjectIndex(project);
    if (!index) {
      index = this.buildProjectIndex(project) ?? undefined as any;
    }
    if (!index) {
      return { query, matchedCommunities: [], matchedTransports: [], contextChunks: [], totalChars: 0 };
    }

    // Tokenize query
    const keywords = query.toLowerCase()
      .replace(/[^a-z0-9_\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2);

    // Score communities
    const scored = index.communities.map((c) => {
      let score = 0;
      for (const kw of keywords) {
        // Direct keyword match
        if (c.keywords.some((ck) => ck.includes(kw) || kw.includes(ck))) score += 3;
        // Summary match
        if (c.summary.toLowerCase().includes(kw)) score += 2;
        // Entry point match
        if (c.entryPoints.some((ep) => ep.toLowerCase().includes(kw))) score += 2;
      }
      return { community: c, score };
    });

    // Score transports
    const scoredTransports = index.transports.map((t) => {
      let score = 0;
      for (const kw of keywords) {
        if (t.name.toLowerCase().includes(kw)) score += 3;
        if (t.type.toLowerCase().includes(kw)) score += 1;
        if (t.producers.some((p) => p.toLowerCase().includes(kw))) score += 1;
        if (t.consumers.some((c) => c.toLowerCase().includes(kw))) score += 1;
      }
      return { transport: t, score };
    });

    const matchedCommunities = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((s) => s.community);

    const matchedTransports = scoredTransports
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((s) => s.transport);

    // Load GRAPH_REPORT sections for matched communities
    const contextChunks: KBQueryResult['contextChunks'] = [];
    let totalChars = 0;

    // Group by repo to avoid reading the same report multiple times
    const repoCommunitiesMap = new Map<string, CommunityInfo[]>();
    for (const c of matchedCommunities) {
      const list = repoCommunitiesMap.get(c.repo) || [];
      list.push(c);
      repoCommunitiesMap.set(c.repo, list);
    }

    for (const [repo, comms] of repoCommunitiesMap) {
      const report = this.getGraphReport(project, repo);
      if (!report) continue;

      // Try to extract community-specific sections from the report
      // Reports typically have "### Community N:" headers
      const sections = report.split(/(?=###?\s+Community\s+\d)/i);

      for (const comm of comms) {
        if (totalChars >= maxChars) break;

        // Try to find the specific community section
        const commNum = comm.id.split('::')[1] || '';
        const matchingSection = sections.find((s) =>
          s.match(new RegExp(`community\\s+${commNum}\\b`, 'i'))
        );

        if (matchingSection) {
          const chunk = matchingSection.slice(0, Math.min(matchingSection.length, maxChars - totalChars));
          contextChunks.push({ repo, communityId: comm.id, content: chunk });
          totalChars += chunk.length;
        }
      }

      // If no community sections matched, include a portion of the full report
      if (contextChunks.filter((c) => c.repo === repo).length === 0 && totalChars < maxChars) {
        const chunk = report.slice(0, Math.min(report.length, maxChars - totalChars));
        contextChunks.push({ repo, communityId: `${repo}::full`, content: chunk });
        totalChars += chunk.length;
      }
    }

    return { query, matchedCommunities, matchedTransports, contextChunks, totalChars };
  }

  /**
   * Load the project index from disk.
   */
  getProjectIndex(project: string): ProjectIndex | null {
    const indexPath = join(this.projectDir(project), 'project_index.json');
    if (!existsSync(indexPath)) return null;
    try {
      return JSON.parse(readFileSync(indexPath, 'utf-8'));
    } catch { return null; }
  }

  /**
   * Get a compact index string for agent prompt injection.
   * Returns just the index (~3-5KB) instead of the full KB blob (80K+).
   */
  getIndexForPrompt(project: string): string {
    const index = this.getProjectIndex(project);
    if (!index) return '';

    // Format as a human-readable compact index
    const parts: string[] = [];
    parts.push(`# Project Knowledge Index: ${project}`);
    parts.push(`> ${index.repos.length} repos, ${index.communities.length} communities, ${index.transports.length} transports\n`);

    parts.push('## Repositories');
    for (const r of index.repos) {
      parts.push(`- **${r.name}**: ${r.nodeCount} nodes, ${r.communityCount} communities`);
    }

    parts.push('\n## Key Module Clusters');
    for (const c of index.communities.slice(0, 20)) {
      parts.push(`- **${c.id}** (${c.nodeCount} nodes): ${c.summary}`);
      parts.push(`  Keywords: ${c.keywords.join(', ')}`);
      parts.push(`  Entry points: ${c.entryPoints.join(', ')}`);
    }

    if (index.transports.length > 0) {
      parts.push('\n## Cross-Repo Transports');
      for (const t of index.transports) {
        const prods = t.producers.join(', ') || '(external)';
        const cons = t.consumers.join(', ') || '(external)';
        parts.push(`- **${t.type}:${t.name}**: ${prods} → ${cons}`);
      }
    }

    parts.push('\n## Top Entry Points (highest connectivity)');
    for (const ep of index.entryPoints.slice(0, 10)) {
      parts.push(`- ${ep.label} (${ep.repo}, degree: ${ep.degree})`);
    }

    return parts.join('\n');
  }

  /**
   * Pre-query the KB for a specific feature/task and return focused context.
   * Used during prompt assembly to inject only relevant KB sections.
   */
  /**
   * Prefetch the hybrid-retriever context for a (project, query) pair so
   * sync prompt builders can use it without an await in the hot path.
   * Pipeline-runner calls this once per run before any stage fires; the
   * result is cached on `this.hybridContextCache`.
   *
   * Failures are silent — getQueryContextForPrompt falls back to the
   * keyword-scoring path if no cached entry is present.
   */
  async prefetchHybridContext(project: string, query: string, maxTokens = 12000): Promise<void> {
    if (!query) return;
    const key = this.hybridContextCacheKey(project, query);
    if (this.hybridContextCache.has(key)) return;

    try {
      const { getRetriever } = await import('@esankhan3/anvil-knowledge-core');
      const retriever = await getRetriever(project);
      const result = await retriever.retrieve(query, { maxTokens });
      if (result.chunks.length > 0) {
        const formatted = this.formatHybridChunks(result, query);
        this.hybridContextCache.set(key, formatted);
      }
    } catch (err) {
      // Vector store missing / not yet indexed — keyword path will take over.
      console.warn(
        `[kb] prefetchHybridContext fallback for "${project}": ` +
        (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private hybridContextCacheKey(project: string, query: string): string {
    return `${project}::${query}`;
  }

  private formatHybridChunks(
    result: { chunks: Array<{ chunk: { repoName: string; filePath: string; content: string; entityName?: string; entityType?: string; language?: string }; score: number }>; graphContext: string; totalTokens: number },
    query: string,
  ): string {
    const parts: string[] = [];
    parts.push(`# Knowledge Base Context (hybrid-retrieved for: "${query.slice(0, 100)}")\n`);

    if (result.graphContext && result.graphContext.trim().length > 0) {
      parts.push(`## Project Architecture\n\n${result.graphContext}\n`);
    }

    // Group by repo → file for readability.
    const byRepo = new Map<string, Map<string, typeof result.chunks>>();
    for (const sc of result.chunks) {
      const repo = sc.chunk.repoName;
      const file = sc.chunk.filePath;
      if (!byRepo.has(repo)) byRepo.set(repo, new Map());
      const fileMap = byRepo.get(repo)!;
      if (!fileMap.has(file)) fileMap.set(file, []);
      fileMap.get(file)!.push(sc);
    }

    for (const [repo, fileMap] of byRepo) {
      parts.push(`### ${repo}\n`);
      for (const [file, scoredChunks] of fileMap) {
        parts.push(`#### \`${file}\``);
        scoredChunks.sort((a, b) => b.score - a.score);
        for (const sc of scoredChunks) {
          const entity = sc.chunk.entityName
            ? `${sc.chunk.entityType ?? 'block'}: ${sc.chunk.entityName}`
            : sc.chunk.entityType ?? 'block';
          const pct = Math.round(sc.score * 100);
          parts.push(`// ${entity} (relevance: ${pct}%)`);
          parts.push('```' + (sc.chunk.language ?? ''));
          parts.push(sc.chunk.content);
          parts.push('```\n');
        }
      }
    }

    return parts.join('\n');
  }

  getQueryContextForPrompt(project: string, featureDescription: string, maxChars = 20000): string {
    // 1. Hybrid-retriever path (vector ⫽ BM25 → RRF → AST expansion → rerank)
    //    when prefetchHybridContext has been awaited at run start. Falls
    //    through silently when the LanceDB store is empty.
    const hybridKey = this.hybridContextCacheKey(project, featureDescription);
    const hybrid = this.hybridContextCache.get(hybridKey);
    if (hybrid && hybrid.length > 0) {
      return hybrid.length > maxChars ? hybrid.slice(0, maxChars) + '\n\n[... truncated]' : hybrid;
    }

    // 2. Legacy keyword-scoring path on project_index.json.
    const result = this.queryKnowledgeBase(project, featureDescription, maxChars);
    if (result.contextChunks.length === 0 && result.matchedCommunities.length === 0) {
      // 3. Fallback: full GRAPH_REPORT.md blob (backward compat).
      return this.getAllGraphReports(project);
    }

    const parts: string[] = [];
    parts.push(`# Knowledge Base Context (query-matched for: "${featureDescription.slice(0, 100)}")\n`);

    // Include matched transports for cross-repo understanding
    if (result.matchedTransports.length > 0) {
      parts.push('## Relevant Cross-Repo Transports');
      for (const t of result.matchedTransports) {
        parts.push(`- **${t.type}:${t.name}**: ${t.producers.join(', ') || '(external)'} → ${t.consumers.join(', ') || '(external)'}`);
      }
      parts.push('');
    }

    // Include matched community details
    if (result.matchedCommunities.length > 0) {
      parts.push('## Matched Module Clusters');
      for (const c of result.matchedCommunities) {
        parts.push(`- **${c.id}** (${c.repo}, ${c.nodeCount} nodes): ${c.summary}`);
      }
      parts.push('');
    }

    // Include detailed context chunks from GRAPH_REPORT
    if (result.contextChunks.length > 0) {
      parts.push('## Detailed Context\n');
      for (const chunk of result.contextChunks) {
        parts.push(`### ${chunk.repo} (${chunk.communityId})\n`);
        parts.push(chunk.content);
        parts.push('');
      }
    }

    return parts.join('\n');
  }

  /**
   * Extract transport edges from project.yaml using a stateful line scanner.
   * Handles Kafka produces/consumes, depends_on (redis, mongo), and HTTP interfaces.
   *
   * Note: system_graph_v2.json is written directly by knowledge-core's
   * KnowledgeIndexer (via ProjectGraphBuilder), so the dashboard no longer
   * needs its own builder.
   */
  private extractTransportsFromProject(project: string): TransportEdge[] {
    const transports: TransportEdge[] = [];

    // Try to load factory.yaml or legacy project.yaml
    let rawYaml = '';
    const yamlPaths = [
      join(ANVIL_HOME, 'projects', project, 'factory.yaml'),
      join(this.projectDir(project), 'factory.yaml'),
      join(this.projectDir(project), 'project.yaml'),
      join(ANVIL_HOME, 'projects', project, 'project.yaml'),
    ];

    for (const p of yamlPaths) {
      if (existsSync(p)) {
        try { rawYaml = readFileSync(p, 'utf-8'); break; } catch { /* try next */ }
      }
    }
    if (!rawYaml) return transports;

    // Stateful line-by-line scanner
    const lines = rawYaml.split('\n');
    let currentRepo = '';
    let currentComponent = '';
    let inKafka = false;
    let inProduces = false;
    let inConsumes = false;
    let inDependsOn = false;
    let inInterfaces = false;
    let interfaceDirection = ''; // 'consumes' or 'exposes'

    // Track Kafka topics → producers/consumers for later edge creation
    const kafkaTopics = new Map<string, { producers: Set<string>; consumers: Set<string> }>();
    const dependsOnEdges: TransportEdge[] = [];

    for (const line of lines) {
      const stripped = line.trimEnd();
      const indent = line.length - line.trimStart().length;

      // Detect repo-level entries: "  - name: repoName" at indent 2-4
      const repoMatch = stripped.match(/^\s{2,4}-\s+name:\s*(.+)/);
      if (repoMatch && indent <= 4) {
        currentRepo = repoMatch[1].trim();
        currentComponent = '';
        inKafka = false; inProduces = false; inConsumes = false;
        inDependsOn = false; inInterfaces = false;
        continue;
      }

      // Detect component entries: "      - name: componentName" at indent 6-10
      const compMatch = stripped.match(/^\s{6,10}-\s+name:\s*(.+)/);
      if (compMatch && currentRepo) {
        currentComponent = compMatch[1].trim();
        inKafka = false; inProduces = false; inConsumes = false;
        continue;
      }

      // Detect kafka block
      if (stripped.match(/^\s+kafka:\s*$/)) {
        inKafka = true; inProduces = false; inConsumes = false;
        continue;
      }

      if (inKafka) {
        if (stripped.match(/^\s+produces:\s*$/)) { inProduces = true; inConsumes = false; continue; }
        if (stripped.match(/^\s+consumes:\s*$/)) { inConsumes = true; inProduces = false; continue; }

        // topic entries: "- topic: topicName" or "- topicName"
        const topicMatch = stripped.match(/^\s+-\s+(?:topic:\s*)?(\S+)/);
        if (topicMatch && (inProduces || inConsumes)) {
          const topic = topicMatch[1].trim();
          if (!kafkaTopics.has(topic)) kafkaTopics.set(topic, { producers: new Set(), consumers: new Set() });
          const entry = kafkaTopics.get(topic)!;
          const label = currentComponent || currentRepo;
          if (inProduces) entry.producers.add(label);
          if (inConsumes) entry.consumers.add(label);
        }

        // Exit kafka block on de-indent
        if (indent <= 6 && !stripped.match(/^\s+-/) && !stripped.match(/^\s+(?:produces|consumes):/)) {
          inKafka = false; inProduces = false; inConsumes = false;
        }
      }

      // Detect depends_on block
      if (stripped.match(/^\s+depends_on:\s*$/)) {
        inDependsOn = true; inKafka = false; inInterfaces = false;
        continue;
      }

      if (inDependsOn) {
        // "- type: redis-cluster" pattern
        const typeMatch = stripped.match(/^\s+-\s+type:\s*(\S+)/);
        if (typeMatch) {
          const depType = typeMatch[1].trim();
          // Look ahead for name on next line or same entry
          const nameMatch = stripped.match(/name:\s*(\S+)/);
          // Simple: capture type, look for name in subsequent lines
          // For now, create edge with repo context
          dependsOnEdges.push({
            type: depType,
            name: nameMatch ? nameMatch[1].trim() : depType,
            producers: [currentRepo],
            consumers: [],
          });
        }
        // "  name: someName" as continuation of depends_on entry
        const depNameMatch = stripped.match(/^\s+name:\s*(\S+)/);
        if (depNameMatch && dependsOnEdges.length > 0) {
          const lastEdge = dependsOnEdges[dependsOnEdges.length - 1];
          lastEdge.name = depNameMatch[1].trim();
        }

        if (indent <= 4 && !stripped.match(/^\s+-/) && !stripped.match(/^\s+\w+:/)) {
          inDependsOn = false;
        }
      }

      // Detect interfaces block
      if (stripped.match(/^\s+interfaces:\s*$/)) {
        inInterfaces = true; inKafka = false; inDependsOn = false;
        continue;
      }

      if (inInterfaces) {
        if (stripped.match(/^\s+consumes:\s*$/)) { interfaceDirection = 'consumes'; continue; }
        if (stripped.match(/^\s+exposes:\s*$/)) { interfaceDirection = 'exposes'; continue; }

        // HTTP endpoints
        const httpMatch = stripped.match(/^\s+-\s+(\S+)/);
        if (httpMatch && interfaceDirection) {
          const endpoint = httpMatch[1].trim();
          if (endpoint.startsWith('http') || endpoint.includes('/api/') || endpoint.includes('/')) {
            transports.push({
              type: 'http',
              name: endpoint,
              producers: interfaceDirection === 'exposes' ? [currentRepo] : [],
              consumers: interfaceDirection === 'consumes' ? [currentRepo] : [],
            });
          }
        }

        if (indent <= 4 && !stripped.match(/^\s+-/) && !stripped.match(/^\s+\w+:/)) {
          inInterfaces = false;
        }
      }
    }

    // Convert Kafka topic map to transport edges
    for (const [topic, { producers, consumers }] of kafkaTopics) {
      transports.push({
        type: 'kafka',
        name: topic,
        producers: [...producers],
        consumers: [...consumers],
      });
    }

    // Merge depends_on edges: group by name+type, merge producers
    const depMap = new Map<string, TransportEdge>();
    for (const dep of dependsOnEdges) {
      const key = `${dep.type}:${dep.name}`;
      if (!depMap.has(key)) {
        depMap.set(key, { ...dep, producers: [...dep.producers] });
      } else {
        const existing = depMap.get(key)!;
        for (const p of dep.producers) {
          if (!existing.producers.includes(p)) existing.producers.push(p);
        }
      }
    }
    for (const dep of depMap.values()) {
      transports.push(dep);
    }

    // Parse "connects:" section — simple format used in project.yaml
    // Format: connects:
    //   - from: repoA
    //     to: repoB
    //     protocol: http|kafka|tcp
    //     topic: topicName (optional)
    //     notes: "description" (optional)
    const connectsMatch = rawYaml.match(/^connects:\s*\n([\s\S]*?)(?=\n[a-z]|\n$)/m);
    if (connectsMatch) {
      const connectsBlock = connectsMatch[1];
      const entries = connectsBlock.split(/\n\s{2}-\s+/);
      for (const entry of entries) {
        if (!entry.trim()) continue;
        const fromMatch = entry.match(/from:\s*(\S+)/);
        const toMatch = entry.match(/to:\s*(\S+)/);
        const protocolMatch = entry.match(/protocol:\s*(\S+)/);
        const topicMatch = entry.match(/topic:\s*(\S+)/);
        const notesMatch = entry.match(/notes:\s*"?([^"\n]+)"?/);
        if (fromMatch && toMatch) {
          const protocol = protocolMatch?.[1] ?? 'http';
          transports.push({
            type: protocol,
            name: topicMatch?.[1] ?? notesMatch?.[1]?.slice(0, 60) ?? `${fromMatch[1]} → ${toMatch[1]}`,
            producers: [fromMatch[1]],
            consumers: [toMatch[1]],
          });
        }
      }
    }

    return transports;
  }

  // ── Graph Report Loading ────────────────────────────────────────────

  getGraphHtmlPath(project: string, repo: string): string | null {
    const path = join(this.repoDir(project, repo), 'graph.html');
    return existsSync(path) ? path : null;
  }

  getGraphReport(project: string, repo: string): string {
    const path = this.graphReportPath(project, repo);
    if (!existsSync(path)) return '';
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return '';
    }
  }

  /**
   * Load the project-level report (cross-repo synthesis).
   */
  getProjectReport(project: string): string {
    const reportPath = join(this.projectDir(project), 'SYSTEM_REPORT.md');
    if (!existsSync(reportPath)) return '';
    try {
      return readFileSync(reportPath, 'utf-8');
    } catch {
      return '';
    }
  }

  getAllGraphReports(project: string): string {
    const sysDir = this.projectDir(project);
    if (!existsSync(sysDir)) {
      console.log(`[kb] getAllGraphReports("${project}"): dir not found at ${sysDir}`);
      return '';
    }

    const sections: string[] = [];

    // Prepend project-level synthesis (cross-repo relationships) if available
    const projectReport = this.getProjectReport(project);
    if (projectReport) {
      sections.push(projectReport);
    }

    try {
      const repos = readdirSync(sysDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      // Load reports, filter out empty/junk ones (0 nodes), sort largest first
      // so the most valuable reports get included within the budget
      const reportsWithSize: Array<{ repo: string; report: string }> = [];
      for (const repo of repos) {
        const report = this.getGraphReport(project, repo);
        if (!report) continue;
        // Skip junk reports: 0 nodes means this isn't a real repo KB
        if (/0 nodes/i.test(report) && report.length < 1000) continue;
        reportsWithSize.push({ repo, report });
      }
      reportsWithSize.sort((a, b) => b.report.length - a.report.length);

      for (const { repo, report } of reportsWithSize) {
        sections.push(`## ${repo}\n\n${report}`);
      }
    } catch { /* ok */ }

    const result = sections.join('\n\n---\n\n');
    console.log(`[kb] getAllGraphReports("${project}"): ${result.length} chars, ${sections.length} sections (incl. project report)`);
    return result;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
