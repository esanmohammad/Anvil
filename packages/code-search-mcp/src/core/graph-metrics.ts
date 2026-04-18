import type { GraphifyOutput, GraphifyNode, GraphifyEdge } from './types';

export interface GraphQualityReport {
  nodeCount: number;
  edgeCount: number;
  edgesByType: Record<string, number>;
  edgesByConfidence: { high: number; medium: number; low: number; unscored: number };
  orphanEntityCount: number;
  orphanEntityPercent: number;
  avgOutDegreeEntities: number;
  bfsReachability: {
    sampleSize: number;
    avgReachedDepth1: number;
    avgReachedDepth2: number;
    avgEntityReachedDepth2: number;
  };
  hubNodes: Array<{ id: string; degree: number; type: string }>;
  connectedComponents: number;
  largestComponentPercent: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEntityNode(node: GraphifyNode): boolean {
  return node.type !== 'module' && node.type !== 'package';
}

function isContainsEdge(edge: GraphifyEdge): boolean {
  return edge.type === 'contains';
}

/**
 * Deterministic sample of up to `n` items from `arr` without randomness.
 * Picks evenly spaced indices so results are reproducible.
 */
function deterministicSample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const result: T[] = [];
  for (let i = 0; i < n; i++) {
    result.push(arr[Math.floor(i * step)]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function generateGraphQualityReport(graph: GraphifyOutput): GraphQualityReport {
  const { nodes, links: edges } = graph;

  // --- Edge counts by type ---
  const edgesByType: Record<string, number> = {};
  for (const edge of edges) {
    const t = edge.type ?? 'unknown';
    edgesByType[t] = (edgesByType[t] ?? 0) + 1;
  }

  // --- Edge counts by confidence ---
  const edgesByConfidence = { high: 0, medium: 0, low: 0, unscored: 0 };
  for (const edge of edges) {
    const conf = (edge as any).confidence as number | undefined;
    if (conf == null) {
      edgesByConfidence.unscored++;
    } else if (conf > 0.8) {
      edgesByConfidence.high++;
    } else if (conf >= 0.5) {
      edgesByConfidence.medium++;
    } else {
      edgesByConfidence.low++;
    }
  }

  // --- Adjacency lists (non-contains edges only) ---
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  // Full adjacency (all edge types) for degree / component analysis
  const fullAdj = new Map<string, Set<string>>();

  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
    fullAdj.set(node.id, new Set());
  }

  for (const edge of edges) {
    // Full adjacency (undirected, all types)
    let setA = fullAdj.get(edge.source);
    if (!setA) { setA = new Set(); fullAdj.set(edge.source, setA); }
    setA.add(edge.target);

    let setB = fullAdj.get(edge.target);
    if (!setB) { setB = new Set(); fullAdj.set(edge.target, setB); }
    setB.add(edge.source);

    // Non-contains adjacency
    if (!isContainsEdge(edge)) {
      const out = outgoing.get(edge.source);
      if (out) out.push(edge.target);
      const inc = incoming.get(edge.target);
      if (inc) inc.push(edge.source);
    }
  }

  // --- Node index for fast lookup ---
  const nodeMap = new Map<string, GraphifyNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  // --- Entity nodes ---
  const entityNodes = nodes.filter(isEntityNode);

  // --- Orphan entities ---
  const orphanEntities = entityNodes.filter(
    (n) => (outgoing.get(n.id)?.length ?? 0) === 0,
  );
  const orphanEntityCount = orphanEntities.length;
  const orphanEntityPercent =
    entityNodes.length > 0
      ? Math.round((orphanEntityCount / entityNodes.length) * 10000) / 100
      : 0;

  // --- Avg out-degree for entity nodes ---
  let totalOutDegree = 0;
  for (const n of entityNodes) {
    totalOutDegree += outgoing.get(n.id)?.length ?? 0;
  }
  const avgOutDegreeEntities =
    entityNodes.length > 0
      ? Math.round((totalOutDegree / entityNodes.length) * 100) / 100
      : 0;

  // --- BFS reachability ---
  const seeds = deterministicSample(entityNodes, 20);

  let sumDepth1 = 0;
  let sumDepth2 = 0;
  let sumEntityDepth2 = 0;

  for (const seed of seeds) {
    const visited = new Set<string>([seed.id]);
    let frontier = [seed.id];

    // Depth 1 — follow non-contains outgoing edges from adjacency
    const depth1Frontier: string[] = [];
    for (const nid of frontier) {
      for (const neighbor of outgoing.get(nid) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          depth1Frontier.push(neighbor);
        }
      }
      // Also follow incoming non-contains edges for BFS (undirected reachability)
      for (const neighbor of incoming.get(nid) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          depth1Frontier.push(neighbor);
        }
      }
    }
    sumDepth1 += depth1Frontier.length;

    // Depth 2
    frontier = depth1Frontier;
    const depth2New: string[] = [];
    for (const nid of frontier) {
      for (const neighbor of outgoing.get(nid) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          depth2New.push(neighbor);
        }
      }
      for (const neighbor of incoming.get(nid) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          depth2New.push(neighbor);
        }
      }
    }

    const totalDepth2 = depth1Frontier.length + depth2New.length;
    sumDepth2 += totalDepth2;

    // Count entity nodes reached at depth <= 2
    let entityCount = 0;
    for (const nid of [...depth1Frontier, ...depth2New]) {
      const node = nodeMap.get(nid);
      if (node && isEntityNode(node)) entityCount++;
    }
    sumEntityDepth2 += entityCount;
  }

  const sampleSize = seeds.length;
  const bfsReachability = {
    sampleSize,
    avgReachedDepth1:
      sampleSize > 0 ? Math.round((sumDepth1 / sampleSize) * 100) / 100 : 0,
    avgReachedDepth2:
      sampleSize > 0 ? Math.round((sumDepth2 / sampleSize) * 100) / 100 : 0,
    avgEntityReachedDepth2:
      sampleSize > 0 ? Math.round((sumEntityDepth2 / sampleSize) * 100) / 100 : 0,
  };

  // --- Hub nodes (top 10 by total degree, all edge types) ---
  const degreeList: Array<{ id: string; degree: number; type: string }> = [];
  for (const node of nodes) {
    const deg = fullAdj.get(node.id)?.size ?? 0;
    degreeList.push({ id: node.id, degree: deg, type: node.type ?? 'unknown' });
  }
  degreeList.sort((a, b) => b.degree - a.degree);
  const hubNodes = degreeList.slice(0, 10);

  // --- Connected components (BFS on undirected full adjacency) ---
  const componentVisited = new Set<string>();
  const componentSizes: number[] = [];

  for (const node of nodes) {
    if (componentVisited.has(node.id)) continue;

    let size = 0;
    const queue = [node.id];
    componentVisited.add(node.id);

    while (queue.length > 0) {
      const current = queue.pop()!;
      size++;
      for (const neighbor of fullAdj.get(current) ?? []) {
        if (!componentVisited.has(neighbor)) {
          componentVisited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    componentSizes.push(size);
  }

  const connectedComponents = componentSizes.length;
  const largestComponent = componentSizes.length > 0 ? Math.max(...componentSizes) : 0;
  const largestComponentPercent =
    nodes.length > 0
      ? Math.round((largestComponent / nodes.length) * 10000) / 100
      : 0;

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    edgesByType,
    edgesByConfidence,
    orphanEntityCount,
    orphanEntityPercent,
    avgOutDegreeEntities,
    bfsReachability,
    hubNodes,
    connectedComponents,
    largestComponentPercent,
  };
}

// ---------------------------------------------------------------------------
// Markdown formatter
// ---------------------------------------------------------------------------

export function formatQualityReport(report: GraphQualityReport): string {
  const lines: string[] = [];

  lines.push('# Graph Quality Report');
  lines.push('');

  // Overview
  lines.push('## Overview');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Nodes | ${report.nodeCount} |`);
  lines.push(`| Edges | ${report.edgeCount} |`);
  lines.push(`| Connected components | ${report.connectedComponents} |`);
  lines.push(`| Largest component | ${report.largestComponentPercent}% of nodes |`);
  lines.push(`| Orphan entities | ${report.orphanEntityCount} (${report.orphanEntityPercent}%) |`);
  lines.push(`| Avg out-degree (entities) | ${report.avgOutDegreeEntities} |`);
  lines.push('');

  // Edges by type
  lines.push('## Edges by Type');
  lines.push('');
  lines.push('| Type | Count |');
  lines.push('|------|-------|');
  const sortedTypes = Object.entries(report.edgesByType).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sortedTypes) {
    lines.push(`| ${type} | ${count} |`);
  }
  lines.push('');

  // Edges by confidence
  lines.push('## Edges by Confidence');
  lines.push('');
  lines.push('| Bucket | Count |');
  lines.push('|--------|-------|');
  lines.push(`| High (>0.8) | ${report.edgesByConfidence.high} |`);
  lines.push(`| Medium (0.5-0.8) | ${report.edgesByConfidence.medium} |`);
  lines.push(`| Low (<0.5) | ${report.edgesByConfidence.low} |`);
  lines.push(`| Unscored | ${report.edgesByConfidence.unscored} |`);
  lines.push('');

  // BFS reachability
  lines.push('## BFS Reachability (non-contains edges)');
  lines.push('');
  lines.push(`Sample size: ${report.bfsReachability.sampleSize} entity nodes`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Avg reached at depth 1 | ${report.bfsReachability.avgReachedDepth1} |`);
  lines.push(`| Avg reached at depth 2 | ${report.bfsReachability.avgReachedDepth2} |`);
  lines.push(`| Avg entities reached at depth 2 | ${report.bfsReachability.avgEntityReachedDepth2} |`);
  lines.push('');

  // Hub nodes
  lines.push('## Hub Nodes (top 10 by degree)');
  lines.push('');
  lines.push('| Node | Degree | Type |');
  lines.push('|------|--------|------|');
  for (const hub of report.hubNodes) {
    lines.push(`| ${hub.id} | ${hub.degree} | ${hub.type} |`);
  }
  lines.push('');

  return lines.join('\n');
}
