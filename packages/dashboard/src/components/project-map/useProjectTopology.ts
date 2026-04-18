import { useState, useEffect, useCallback } from 'react';
import type { ProjectTopology, TopologyNode } from './types.js';

export interface UseProjectTopologyOptions {
  project: string | null;
  lastMessage: unknown | null;
}

export function useProjectTopology({ project, lastMessage }: UseProjectTopologyOptions) {
  const [topology, setTopology] = useState<ProjectTopology | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  useEffect(() => {
    const msg = lastMessage as { channel?: string; event?: string; data?: ProjectTopology } | null;
    if (msg?.channel === 'project' && msg?.event === 'topology' && msg.data) {
      if (!project || msg.data.project === project) {
        setTopology(msg.data);
      }
    }
  }, [lastMessage, project]);

  const getNode = useCallback((id: string): TopologyNode | undefined => {
    return topology?.nodes.find((n) => n.id === id);
  }, [topology]);

  return { topology, selectedNode, setSelectedNode, getNode };
}

export default useProjectTopology;
