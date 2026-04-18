// Graph data transformation utilities for react-force-graph-2d

export interface GraphNode {
  id: string;
  label: string;
  type: string;        // module, function, class, interface, type, struct, const, repo
  repo?: string;
  file?: string;
  community?: number;
  degree?: number;
  val?: number;         // node size for force graph
  color?: string;
  __level?: 'project' | 'repo';
}

export interface GraphLink {
  source: string;
  target: string;
  type: string;         // imports, calls, contains, inherits, sync-http, async-event, etc.
  label?: string;
  color?: string;
  width?: number;
  curvature?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

// Color palette for repos and communities
const REPO_COLORS = [
  '#6366f1', // indigo
  '#22d3ee', // cyan
  '#f59e0b', // amber
  '#ef4444', // red
  '#10b981', // emerald
  '#8b5cf6', // violet
  '#f97316', // orange
  '#ec4899', // pink
  '#14b8a6', // teal
  '#84cc16', // lime
];

const TYPE_COLORS: Record<string, string> = {
  module: '#4b5563',     // gray
  function: '#60a5fa',   // blue
  class: '#a78bfa',      // purple
  struct: '#a78bfa',     // purple
  interface: '#2dd4bf',  // teal
  trait: '#2dd4bf',      // teal
  type: '#fb923c',       // orange
  const: '#94a3b8',      // slate
  method: '#60a5fa',     // blue
  enum: '#fbbf24',       // yellow
  impl: '#c084fc',       // purple light
  repo: '#6366f1',       // indigo
  package: '#34d399',    // emerald — workspace packages
};

const EDGE_COLORS: Record<string, string> = {
  imports: '#4b5563',
  calls: '#60a5fa',
  contains: '#374151',
  inherits: '#a78bfa',
  'sync-http': '#22d3ee',
  'async-event': '#f59e0b',
  'shared-db': '#ef4444',
  'shared-types': '#2dd4bf',
  'workspace-dep': '#34d399',  // emerald — package dependencies
  'workspace-import': '#34d399',
  http: '#22d3ee',
  kafka: '#f59e0b',
  tcp: '#ef4444',
};

/**
 * Transform raw graph.json (per-repo AST graph) into ForceGraph data.
 * Filters out 'contains' edges and tiny nodes for readability.
 */
export function transformRepoGraph(
  graphJson: { nodes: any[]; links: any[] },
  repoName: string,
): GraphData {
  // Build degree map (include all edge types for packages)
  const degreeMap = new Map<string, number>();
  for (const e of graphJson.links) {
    const src = e.source ?? '';
    const tgt = e.target ?? '';
    // For degree calculation, skip file-level contains but count package edges
    if (e.type === 'contains' && !src.startsWith('pkg::')) continue;
    degreeMap.set(src, (degreeMap.get(src) ?? 0) + 1);
    degreeMap.set(tgt, (degreeMap.get(tgt) ?? 0) + 1);
  }

  // Keep all nodes with connections or special types (no limit)
  const nodeList = graphJson.nodes
    .map((n: any) => ({
      ...n,
      degree: degreeMap.get(n.id) ?? 0,
    }))
    .filter((n: any) => n.type === 'package' || n.degree > 0);

  const nodeIds = new Set(nodeList.map((n: any) => n.id));

  const nodes: GraphNode[] = nodeList.map((n: any) => ({
    id: n.id,
    label: n.label ?? n.id.split('::').pop() ?? n.id,
    type: n.type ?? 'unknown',
    repo: repoName,
    file: n.file,
    community: n.community,
    degree: n.degree,
    val: Math.max(2, Math.min(20, (n.degree ?? 0) / 2 + 2)),
    color: TYPE_COLORS[n.type] ?? '#6b7280',
    __level: 'repo',
  }));

  const links: GraphLink[] = graphJson.links
    .filter((e: any) => {
      const src = e.source ?? '';
      const tgt = e.target ?? '';
      // Filter out file-level contains (noisy), keep package-level contains
      if (e.type === 'contains' && !src.startsWith('pkg::')) return false;
      return nodeIds.has(src) && nodeIds.has(tgt);
    })
    .map((e: any) => ({
      source: e.source,
      target: e.target,
      type: e.type ?? 'unknown',
      color: EDGE_COLORS[e.type] ?? '#4b5563',
      width: e.type === 'calls' ? 1 : e.type === 'contains' && (e.source ?? '').startsWith('pkg::') ? 0.3 : 0.5,
    }));

  return { nodes, links };
}

/**
 * Transform PROJECT_GRAPH.json into a high-level project view.
 * Repos become large nodes, relationships become edges.
 */
export function transformProjectGraph(
  projectGraph: {
    repoRoles?: Record<string, { role: string; criticality: string; ownsData?: string[] }>;
    relationships?: Array<{ from: string; to: string; type: string; description: string; criticality: string; direction: string }>;
    keyFlows?: Array<{ name: string; steps: Array<{ repo: string }> }>;
  },
  repoStats: Array<{ repoName: string; nodeCount: number; language?: string }>,
): GraphData {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];

  // Create repo nodes
  for (let i = 0; i < repoStats.length; i++) {
    const r = repoStats[i];
    nodes.push({
      id: r.repoName,
      label: r.repoName,
      type: 'repo',
      val: Math.max(15, Math.min(50, r.nodeCount / 20 + 15)),
      color: REPO_COLORS[i % REPO_COLORS.length],
      degree: 0,
      __level: 'project',
    });
  }

  // Create relationship edges
  if (projectGraph.relationships) {
    for (const rel of projectGraph.relationships) {
      if (!nodes.find(n => n.id === rel.from) || !nodes.find(n => n.id === rel.to)) continue;
      links.push({
        source: rel.from,
        target: rel.to,
        type: rel.type,
        label: rel.description?.slice(0, 40) ?? rel.type,
        color: EDGE_COLORS[rel.type] ?? '#6b7280',
        width: rel.criticality === 'high' ? 3 : rel.criticality === 'medium' ? 2 : 1,
        curvature: 0.2,
      });
    }
  }

  // If no LLM relationships, fall back to repoStats-based connections
  if (links.length === 0 && repoStats.length > 1) {
    // Just show repos as disconnected nodes — user needs to build project graph
  }

  return { nodes, links };
}

/**
 * Transform factory.yaml connects into fallback project-level edges.
 * Used when PROJECT_GRAPH.json doesn't exist.
 */
export function transformConnects(
  connects: Array<{ from: string; to: string; protocol: string; notes?: string }>,
  repoNames: string[],
): GraphLink[] {
  const links: GraphLink[] = [];
  const repoSet = new Set(repoNames);

  for (const c of connects) {
    // Only include edges between known repos (skip infra like postgres, kafka, redis)
    if (repoSet.has(c.from) && repoSet.has(c.to)) {
      links.push({
        source: c.from,
        target: c.to,
        type: c.protocol === 'kafka' ? 'async-event' : 'sync-http',
        label: c.notes?.slice(0, 40) ?? c.protocol,
        color: EDGE_COLORS[c.protocol] ?? '#6b7280',
        width: 2,
        curvature: 0.2,
      });
    }
  }

  return links;
}

/** Get a human-readable label for a node type */
export function typeLabel(type: string): string {
  const labels: Record<string, string> = {
    module: 'File',
    function: 'Function',
    class: 'Class',
    struct: 'Struct',
    interface: 'Interface',
    trait: 'Trait',
    type: 'Type',
    const: 'Constant',
    method: 'Method',
    enum: 'Enum',
    impl: 'Impl',
    repo: 'Repository',
    package: 'Package',
  };
  return labels[type] ?? type;
}
