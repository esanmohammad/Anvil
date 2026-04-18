import React, { useMemo } from 'react';
import { RepoNode } from './RepoNode.js';
import { TransportEdge } from './TransportEdge.js';
import { layoutGraph } from './layoutGraph.js';
import type { ProjectTopology } from './types.js';

export interface ProjectMapProps {
  topology: ProjectTopology;
  selectedNode: string | null;
  onSelectNode: (id: string) => void;
  width?: number;
  height?: number;
}

export function ProjectMap({ topology, selectedNode, onSelectNode, width = 800, height = 600 }: ProjectMapProps) {
  const layout = useMemo(() => layoutGraph(topology, width, height), [topology, width, height]);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="project-map"
      style={{ background: 'var(--bg-root)', borderRadius: 'var(--radius-md)' }}
    >
      {/* Edges first (behind nodes) */}
      {layout.edges.map((edge) => (
        <TransportEdge key={edge.id} edge={edge} />
      ))}

      {/* Nodes */}
      {layout.nodes.map((node) => (
        <RepoNode
          key={node.id}
          node={node}
          isSelected={selectedNode === node.id}
          onClick={onSelectNode}
        />
      ))}
    </svg>
  );
}

export default ProjectMap;
