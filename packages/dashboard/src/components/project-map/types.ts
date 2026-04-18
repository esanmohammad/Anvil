/** Project topology types for the interactive project map */

export interface TopologyNode {
  id: string;
  type: 'repo' | 'service' | 'database' | 'queue' | 'external';
  label: string;
  x: number;
  y: number;
  status: 'healthy' | 'degraded' | 'error' | 'unknown';
  metadata?: Record<string, unknown>;
}

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  transport: 'http' | 'grpc' | 'event' | 'database' | 'unknown';
  status: 'active' | 'inactive' | 'error';
}

export interface ProjectTopology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  project: string;
  updatedAt: number;
}

export interface GraphLayout {
  nodes: Array<TopologyNode & { cx: number; cy: number }>;
  edges: Array<TopologyEdge & { x1: number; y1: number; x2: number; y2: number }>;
  width: number;
  height: number;
}
