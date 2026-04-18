import { useMemo } from 'react';
import type { ProjectTopology, TopologyNode } from './types.js';

export function useNodeStatus(topology: ProjectTopology | null) {
  const statusCounts = useMemo(() => {
    if (!topology) return { healthy: 0, degraded: 0, error: 0, unknown: 0 };
    const counts = { healthy: 0, degraded: 0, error: 0, unknown: 0 };
    for (const node of topology.nodes) {
      counts[node.status]++;
    }
    return counts;
  }, [topology]);

  const getNodesByStatus = (status: TopologyNode['status']): TopologyNode[] => {
    return topology?.nodes.filter((n) => n.status === status) ?? [];
  };

  const overallHealth: TopologyNode['status'] = statusCounts.error > 0 ? 'error' : statusCounts.degraded > 0 ? 'degraded' : statusCounts.healthy > 0 ? 'healthy' : 'unknown';

  return { statusCounts, getNodesByStatus, overallHealth };
}

export default useNodeStatus;
