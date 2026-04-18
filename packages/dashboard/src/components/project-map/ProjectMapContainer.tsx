import React from 'react';
import { ProjectMap } from './ProjectMap.js';
import { useNodeStatus } from './useNodeStatus.js';
import { Badge } from '../ui/Badge.js';
import type { ProjectTopology } from './types.js';

export interface ProjectMapContainerProps {
  topology: ProjectTopology | null;
  selectedNode: string | null;
  onSelectNode: (id: string) => void;
}

export function ProjectMapContainer({ topology, selectedNode, onSelectNode }: ProjectMapContainerProps) {
  const { statusCounts, overallHealth } = useNodeStatus(topology);

  if (!topology) {
    return (
      <div style={{ padding: 'var(--space-lg)', textAlign: 'center', color: 'var(--text-muted)' }}>
        No topology data available. Select a project to view its map.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-md)' }}>
        <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 600 }}>Project Map</h2>
        <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
          <Badge variant={overallHealth === 'healthy' ? 'success' : overallHealth === 'error' ? 'error' : 'warning'}>
            {overallHealth}
          </Badge>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {topology.nodes.length} nodes | {topology.edges.length} edges
          </span>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', justifyContent: 'center' }}>
        <ProjectMap
          topology={topology}
          selectedNode={selectedNode}
          onSelectNode={onSelectNode}
        />
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-md)', padding: 'var(--space-sm)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        <span style={{ color: 'var(--color-success)' }}>{statusCounts.healthy} healthy</span>
        <span style={{ color: 'var(--color-warning)' }}>{statusCounts.degraded} degraded</span>
        <span style={{ color: 'var(--color-error)' }}>{statusCounts.error} errors</span>
      </div>
    </div>
  );
}

export default ProjectMapContainer;
