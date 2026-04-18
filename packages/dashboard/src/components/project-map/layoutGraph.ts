import type { ProjectTopology, GraphLayout, TopologyNode } from './types.js';

/** Simple force-directed-like layout for project topology */
export function layoutGraph(topology: ProjectTopology, width = 800, height = 600): GraphLayout {
  const nodes = topology.nodes.map((node, i) => {
    // Arrange in a circle if no positions set
    const angle = (2 * Math.PI * i) / topology.nodes.length;
    const radius = Math.min(width, height) * 0.35;
    const cx = node.x || (width / 2 + radius * Math.cos(angle));
    const cy = node.y || (height / 2 + radius * Math.sin(angle));
    return { ...node, cx, cy };
  });

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const edges = topology.edges.map((edge) => {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    return {
      ...edge,
      x1: source?.cx ?? 0,
      y1: source?.cy ?? 0,
      x2: target?.cx ?? 0,
      y2: target?.cy ?? 0,
    };
  });

  return { nodes, edges, width, height };
}

export default layoutGraph;
