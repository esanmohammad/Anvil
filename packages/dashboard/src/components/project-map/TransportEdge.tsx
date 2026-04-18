import React from 'react';
import type { TopologyEdge } from './types.js';

export interface TransportEdgeProps {
  edge: TopologyEdge & { x1: number; y1: number; x2: number; y2: number };
}

const transportColors: Record<TopologyEdge['transport'], string> = {
  http: '#3B82F6',
  grpc: '#8B5CF6',
  event: '#F59E0B',
  database: '#00B289',
  unknown: '#666666',
};

const transportDash: Record<TopologyEdge['transport'], string> = {
  http: 'none',
  grpc: '8,4',
  event: '4,4',
  database: '2,2',
  unknown: '6,3',
};

export function TransportEdge({ edge }: TransportEdgeProps) {
  const color = edge.status === 'error' ? '#FF4949' : edge.status === 'inactive' ? '#444444' : transportColors[edge.transport];
  const midX = (edge.x1 + edge.x2) / 2;
  const midY = (edge.y1 + edge.y2) / 2;

  return (
    <g className="transport-edge">
      <line
        x1={edge.x1}
        y1={edge.y1}
        x2={edge.x2}
        y2={edge.y2}
        stroke={color}
        strokeWidth={edge.status === 'active' ? 2 : 1}
        strokeDasharray={transportDash[edge.transport]}
        opacity={edge.status === 'inactive' ? 0.4 : 0.8}
      />
      {edge.label && (
        <text x={midX} y={midY - 6} textAnchor="middle" fontSize="9" fill="#666666">
          {edge.label}
        </text>
      )}
    </g>
  );
}

export default TransportEdge;
