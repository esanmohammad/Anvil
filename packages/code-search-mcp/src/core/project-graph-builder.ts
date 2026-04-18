// eslint-disable-next-line @typescript-eslint/no-var-requires
import type { CrossRepoEdge, GraphifyOutput } from './types';

// Graphology + Louvain — loaded dynamically to handle ESM/CJS compat
let _Graph: any;
let _louvain: any;

async function ensureGraphology(): Promise<void> {
  if (_Graph) return;
  const graphMod = await import('graphology');
  _Graph = graphMod.default ?? graphMod;
  const louvainMod = await import('graphology-communities-louvain');
  _louvain = louvainMod.default ?? louvainMod;
}

function getGraphClass(): any {
  if (!_Graph) throw new Error('Call ensureGraphology() before using graph operations');
  return _Graph;
}

export class ProjectGraphBuilder {
  private graph: any;

  constructor() {
    // Graph will be initialized lazily via init()
    this.graph = null;
  }

  /** Must be called before using the builder */
  async init(): Promise<void> {
    await ensureGraphology();
    const G = getGraphClass();
    this.graph = new G({ type: 'directed', multi: true });
  }

  /** Expose the underlying graph for query functions */
  getGraph(): any { return this.graph; }

  /** Load a per-repo graph.json from Graphify and merge into the project graph.
   * Namespace all nodes as "repoName::originalId" to avoid collisions. */
  addRepoGraph(repoName: string, graphJson: GraphifyOutput): void {
    for (const node of graphJson.nodes) {
      const nsId = `${repoName}::${node.id}`;
      if (!this.graph.hasNode(nsId)) {
        this.graph.addNode(nsId, {
          repo: repoName,
          label: node.label ?? node.id,
          community: node.community,
          type: node.type,
          file: node.file,
        });
      }
    }
    for (const edge of graphJson.links) {
      const src = `${repoName}::${edge.source}`;
      const tgt = `${repoName}::${edge.target}`;
      if (this.graph.hasNode(src) && this.graph.hasNode(tgt)) {
        this.graph.addEdge(src, tgt, {
          type: edge.type ?? 'depends',
          confidence: edge.confidence ?? 0.8,
        });
      }
    }
  }

  /** Add cross-repo edges detected by the cross-repo detector */
  addCrossRepoEdges(edges: CrossRepoEdge[]): void {
    for (const edge of edges) {
      // Find or create synthetic nodes for cross-repo connections
      const srcId = `${edge.sourceRepo}::${edge.sourceNode}`;
      const tgtId = `${edge.targetRepo}::${edge.targetNode}`;
      if (!this.graph.hasNode(srcId)) {
        this.graph.addNode(srcId, { repo: edge.sourceRepo, label: edge.sourceNode, type: 'external' });
      }
      if (!this.graph.hasNode(tgtId)) {
        this.graph.addNode(tgtId, { repo: edge.targetRepo, label: edge.targetNode, type: 'external' });
      }
      this.graph.addEdge(srcId, tgtId, {
        type: edge.edgeType,
        evidence: edge.evidence,
        confidence: edge.confidence,
        crossRepo: true,
      });
    }
  }

  /** Run Louvain community detection on the merged graph */
  detectCommunities(): Map<string, number> {
    if (this.graph.order === 0) return new Map();
    // Louvain needs undirected — create a copy
    const G = getGraphClass();
    const undirected = new G({ type: 'undirected' });
    this.graph.forEachNode((node: string, attrs: any) => {
      undirected.mergeNode(node, attrs);
    });
    this.graph.forEachEdge((_edge: string, attrs: any, src: string, tgt: string) => {
      undirected.mergeEdge(src, tgt, attrs);
    });
    const communities = _louvain(undirected);
    // Store back on directed graph
    for (const [node, community] of Object.entries(communities)) {
      if (this.graph.hasNode(node)) {
        this.graph.setNodeAttribute(node, 'systemCommunity', community);
      }
    }
    return new Map(Object.entries(communities).map(([k, v]) => [k, v as number]));
  }

  /** Confidence-weighted BFS impact analysis from entry nodes.
   *  Only follows edges with confidence >= minConfidence.
   *  Sorts neighbors by confidence so high-quality paths are explored first. */
  impactAnalysis(
    entryNodes: string[],
    maxDepth: number = 3,
    opts?: { minConfidence?: number },
  ): string[] {
    const minConf = opts?.minConfidence ?? 0.0;
    const visited = new Set<string>();
    let frontier = entryNodes.filter(n => this.graph.hasNode(n));

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: Array<{ node: string; confidence: number }> = [];
      for (const node of frontier) {
        if (visited.has(node)) continue;
        visited.add(node);
        // Follow outgoing edges, respecting confidence threshold
        this.graph.forEachOutEdge(node, (_edge: string, attrs: any, _src: string, tgt: string) => {
          const conf = attrs.confidence ?? 0.8;
          if (conf >= minConf && !visited.has(tgt)) {
            nextFrontier.push({ node: tgt, confidence: conf });
          }
        });
      }
      // Sort by confidence descending — explore high-quality neighbors first
      nextFrontier.sort((a, b) => b.confidence - a.confidence);
      frontier = nextFrontier.map(f => f.node);
    }
    return [...visited];
  }

  /** Get node type for a given node ID */
  getNodeType(nodeId: string): string | null {
    if (!this.graph.hasNode(nodeId)) return null;
    return this.graph.getNodeAttribute(nodeId, 'type') ?? null;
  }

  /** Get highest-degree nodes (architectural hotspots) */
  getHotspots(topN: number = 20): Array<{ node: string; degree: number; repo: string }> {
    const nodes: Array<{ node: string; degree: number; repo: string }> = [];
    this.graph.forEachNode((node: string, attrs: any) => {
      nodes.push({ node, degree: this.graph.degree(node), repo: attrs.repo ?? '' });
    });
    nodes.sort((a, b) => b.degree - a.degree);
    return nodes.slice(0, topN);
  }

  /** Get cross-repo edges */
  getCrossRepoEdges(): Array<{ source: string; target: string; type: string; evidence: string }> {
    const edges: Array<{ source: string; target: string; type: string; evidence: string }> = [];
    this.graph.forEachEdge((_edge: string, attrs: any, src: string, tgt: string) => {
      if (attrs.crossRepo) {
        edges.push({ source: src, target: tgt, type: attrs.type, evidence: attrs.evidence ?? '' });
      }
    });
    return edges;
  }

  /** Export full graph as JSON */
  exportJson(): object {
    return this.graph.export();
  }

  /** Import from previously saved JSON */
  async importJson(data: any): Promise<void> {
    if (!this.graph) await this.init();
    this.graph.import(data);
  }

  /** Get node count */
  get nodeCount(): number { return this.graph.order; }

  /** Get edge count */
  get edgeCount(): number { return this.graph.size; }

  /** Export compact summary for agent prompt injection */
  exportForPrompt(maxChars: number = 5000): string {
    const sections: string[] = [];
    sections.push('## Project Architecture Graph\n');

    // Repo summary
    const repoNodes = new Map<string, number>();
    this.graph.forEachNode((_: string, attrs: any) => {
      const repo = attrs.repo ?? 'unknown';
      repoNodes.set(repo, (repoNodes.get(repo) ?? 0) + 1);
    });
    sections.push('### Repositories');
    for (const [repo, count] of repoNodes) {
      sections.push(`- **${repo}**: ${count} nodes`);
    }

    // Workspace packages
    const packageNodes: Array<{ node: string; repo: string }> = [];
    this.graph.forEachNode((node: string, attrs: any) => {
      if (attrs.type === 'package') packageNodes.push({ node, repo: attrs.repo });
    });
    if (packageNodes.length > 0) {
      sections.push('\n### Workspace Packages');
      for (const p of packageNodes) {
        sections.push(`- **${p.node}** (${p.repo})`);
      }
    }

    // Cross-repo connections (including workspace deps)
    const crossEdges = this.getCrossRepoEdges();
    if (crossEdges.length > 0) {
      sections.push('\n### Cross-Repo Connections');
      for (const edge of crossEdges.slice(0, 20)) {
        sections.push(`- ${edge.source} → ${edge.target} (${edge.type}: ${edge.evidence})`);
      }
    }

    // Hotspots
    const hotspots = this.getHotspots(10);
    if (hotspots.length > 0) {
      sections.push('\n### Architectural Hotspots');
      for (const h of hotspots) {
        sections.push(`- **${h.node}** (${h.repo}, degree: ${h.degree})`);
      }
    }

    let result = sections.join('\n');
    if (result.length > maxChars) result = result.slice(0, maxChars) + '\n[...]';
    return result;
  }
}
