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
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectLoader } from './project-loader.js';

const execFileAsync = promisify(execFile);

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
}

export interface KBProjectStatus {
  project: string;
  repos: KBRepoStatus[];
  overallStatus: 'none' | 'partial' | 'ready' | 'stale' | 'building' | 'unavailable';
  lastRefreshed: string | null;
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

  private writeMetadata(project: string, repo: string, meta: KBMetadata): void {
    const dir = this.repoDir(project, repo);
    ensureDir(dir);
    writeFileSync(this.metadataPath(project, repo), JSON.stringify(meta, null, 2), 'utf-8');
  }

  // ── Git SHA detection ───────────────────────────────────────────────

  private async getCurrentCommitSha(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        timeout: 5000,
      });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  // ── Status ──────────────────────────────────────────────────────────

  async getRepoStatus(project: string, repoName: string, repoPath: string | null): Promise<KBRepoStatus> {
    const meta = this.readMetadata(project, repoName);
    const currentSha = repoPath ? await this.getCurrentCommitSha(repoPath) : null;

    if (!meta) {
      return {
        repoName,
        status: 'none',
        lastRefreshed: null,
        lastCommitSha: null,
        currentCommitSha: currentSha,
        nodeCount: 0,
        communityCount: 0,
        error: null,
      };
    }

    const isStale = currentSha && meta.lastCommitSha !== currentSha;

    return {
      repoName,
      status: meta.status === 'error' ? 'error' : (isStale ? 'stale' : 'ready'),
      lastRefreshed: meta.lastRefreshed,
      lastCommitSha: meta.lastCommitSha,
      currentCommitSha: currentSha,
      nodeCount: meta.nodeCount,
      communityCount: meta.communityCount,
      error: meta.error ?? null,
    };
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

    try {
      const repoPaths = this.projectLoader.getRepoLocalPaths(project);
      const repoNames = Object.keys(repoPaths);

      // Detect workspace structures for all repos upfront
      const workspaceMaps = new Map<string, any>();
      try {
        const { detectWorkspace } = await import(
          '@anvil-dev/cli/knowledge/workspace-detector' as string
        );
        for (const repoName of repoNames) {
          const repoPath = repoPaths[repoName];
          if (!repoPath || !existsSync(repoPath)) continue;
          try {
            const wsMap = detectWorkspace(repoPath);
            if (wsMap.packages.length > 0) {
              workspaceMaps.set(repoName, wsMap);
              console.log(`[kb] Detected workspace in ${repoName}: ${wsMap.packages.length} packages`);
            }
          } catch { /* workspace detection is best-effort */ }
        }
      } catch (err) {
        console.warn(`[kb] Workspace detection unavailable: ${err}`);
      }

      for (let i = 0; i < repoNames.length; i++) {
        const repoName = repoNames[i];
        const repoPath = repoPaths[repoName];

        if (!repoPath || !existsSync(repoPath)) {
          onProgress?.({
            project,
            repo: repoName,
            phase: 'skipped',
            repoIndex: i,
            totalRepos: repoNames.length,
            message: `Skipping ${repoName} — workspace not found`,
          });
          continue;
        }

        // Check if stale
        onProgress?.({
          project,
          repo: repoName,
          phase: 'checking',
          repoIndex: i,
          totalRepos: repoNames.length,
          message: `Checking ${repoName}...`,
        });

        const currentSha = await this.getCurrentCommitSha(repoPath);
        const meta = this.readMetadata(project, repoName);

        if (meta && meta.status === 'ready' && meta.lastCommitSha === currentSha) {
          // Touch lastRefreshed so the UI shows "just now" instead of stale hours
          this.writeMetadata(project, repoName, { ...meta, lastRefreshed: new Date().toISOString() });
          onProgress?.({
            project,
            repo: repoName,
            phase: 'skipped',
            repoIndex: i,
            totalRepos: repoNames.length,
            message: `${repoName} is up to date`,
          });
          continue;
        }

        // Build
        onProgress?.({
          project,
          repo: repoName,
          phase: 'building',
          repoIndex: i,
          totalRepos: repoNames.length,
          message: `Building knowledge graph for ${repoName}...`,
        });

        try {
          await this.refreshRepo(project, repoName, repoPath, workspaceMaps.get(repoName));

          onProgress?.({
            project,
            repo: repoName,
            phase: 'complete',
            repoIndex: i,
            totalRepos: repoNames.length,
            message: `${repoName} knowledge base updated`,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          onProgress?.({
            project,
            repo: repoName,
            phase: 'error',
            repoIndex: i,
            totalRepos: repoNames.length,
            message: `Error building ${repoName}: ${errorMsg}`,
          });
        }
      }

      // Generate project-level KB synthesis (cross-repo relationships)
      onProgress?.({
        project,
        repo: '(project)',
        phase: 'building',
        repoIndex: repoNames.length,
        totalRepos: repoNames.length + 1,
        message: `Synthesizing project-level knowledge base...`,
      });
      try {
        this.generateProjectReport(project, repoNames);
        this.buildProjectGraph(project, repoNames, workspaceMaps);
        this.buildProjectIndex(project, repoNames);

        // Build Graphology-format system_graph_v2.json for the retriever's graph expansion
        await this.buildRetrieverGraph(project, repoNames, repoPaths, workspaceMaps);

        onProgress?.({
          project,
          repo: '(project)',
          phase: 'complete',
          repoIndex: repoNames.length,
          totalRepos: repoNames.length + 1,
          message: `Project knowledge base synthesized (graph + index built)`,
        });
      } catch (err) {
        console.warn(`[kb] Failed to generate project report: ${err}`);
      }

      return this.getStatus(project);
    } finally {
      this.refreshing = false;
    }
  }

  async refreshRepo(project: string, repoName: string, repoPath: string, workspaceMap?: any): Promise<void> {
    const outputDir = this.repoDir(project, repoName);
    ensureDir(outputDir);

    const startTime = Date.now();

    try {
      // Use the in-house AST graph builder via workspace package export
      const { buildAstGraph, generateGraphReport } = await import(
        '@anvil-dev/cli/knowledge/ast-graph-builder' as string
      );

      const graph = await buildAstGraph(repoPath, { workspaceMap });

      // Write graph.json and GRAPH_REPORT.md
      writeFileSync(join(outputDir, 'graph.json'), JSON.stringify(graph), 'utf-8');
      writeFileSync(
        join(outputDir, 'GRAPH_REPORT.md'),
        generateGraphReport(repoName, graph),
        'utf-8',
      );

      const currentSha = await this.getCurrentCommitSha(repoPath);
      this.writeMetadata(project, repoName, {
        lastRefreshed: new Date().toISOString(),
        lastCommitSha: currentSha ?? '',
        graphifyVersion: 'anvil-ast-builder',
        fileCount: graph.nodes.filter((n: any) => n.type === 'module').length,
        nodeCount: graph.nodes.length,
        communityCount: 0,
        buildDurationMs: Date.now() - startTime,
        status: 'ready',
      });
    } catch (err: any) {
      const currentSha = await this.getCurrentCommitSha(repoPath);
      this.writeMetadata(project, repoName, {
        lastRefreshed: new Date().toISOString(),
        lastCommitSha: currentSha ?? '',
        graphifyVersion: 'anvil-ast-builder',
        fileCount: 0,
        nodeCount: 0,
        communityCount: 0,
        buildDurationMs: Date.now() - startTime,
        status: 'error',
        error: (err.message || String(err)).slice(0, 500),
      });
      throw err;
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
  getQueryContextForPrompt(project: string, featureDescription: string, maxChars = 20000): string {
    const result = this.queryKnowledgeBase(project, featureDescription, maxChars);
    if (result.contextChunks.length === 0 && result.matchedCommunities.length === 0) {
      // Fallback: return full reports (backward compat)
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
   */
  /**
   * Build system_graph_v2.json in Graphology export format.
   * This is the graph the retriever loads for BFS-based graph expansion.
   * Merges per-repo graph.json files + cross-repo edges into one Graphology graph.
   */
  private async buildRetrieverGraph(
    project: string,
    repoNames: string[],
    repoPaths: Record<string, string>,
    workspaceMaps: Map<string, any>,
  ): Promise<void> {
    try {
      const { ProjectGraphBuilder } = await import(
        '@anvil-dev/cli/knowledge/project-graph-builder' as string
      );
      const { detectCrossRepoEdges } = await import(
        '@anvil-dev/cli/knowledge/cross-repo-detector' as string
      );

      const graphBuilder = new ProjectGraphBuilder();
      await graphBuilder.init();

      // Merge per-repo graphs
      for (const repoName of repoNames) {
        const graphPath = join(this.repoDir(project, repoName), 'graph.json');
        if (!existsSync(graphPath)) continue;
        try {
          const graphData = JSON.parse(readFileSync(graphPath, 'utf-8'));
          graphBuilder.addRepoGraph(repoName, graphData);
        } catch { continue; }
      }

      // Cross-repo edges
      const repos = repoNames
        .filter(name => repoPaths[name])
        .map(name => ({ name, path: repoPaths[name], language: '' }));

      if (repos.length > 1 || workspaceMaps.size > 0) {
        try {
          const crossEdges = await detectCrossRepoEdges(repos, workspaceMaps);
          graphBuilder.addCrossRepoEdges(crossEdges);
        } catch { /* cross-repo detection is best-effort */ }
      }

      // Community detection
      graphBuilder.detectCommunities();

      // Write in Graphology format — this is what getRetriever() loads
      const outputPath = join(this.projectDir(project), 'system_graph_v2.json');
      writeFileSync(outputPath, JSON.stringify(graphBuilder.exportJson(), null, 2), 'utf-8');
      console.log(`[kb] Built retriever graph for "${project}": ${graphBuilder.nodeCount} nodes, ${graphBuilder.edgeCount} edges`);
    } catch (err) {
      console.warn(`[kb] Failed to build retriever graph: ${err}`);
    }
  }

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
