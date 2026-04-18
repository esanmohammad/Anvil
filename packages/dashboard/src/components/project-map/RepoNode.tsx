import React from 'react';
import type { TopologyNode } from './types.js';

export interface RepoNodeProps {
  node: TopologyNode & { cx: number; cy: number };
  isSelected: boolean;
  onClick: (id: string) => void;
}

const statusColors: Record<TopologyNode['status'], string> = {
  healthy: '#00B289',
  degraded: '#FFB020',
  error: '#FF4949',
  unknown: '#666666',
};

const typeIcons: Record<TopologyNode['type'], string> = {
  repo: '\u{1F4E6}',
  service: '\u2699',
  database: '\u{1F5C4}',
  queue: '\u{1F4E8}',
  external: '\u{1F310}',
};

export function RepoNode({ node, isSelected, onClick }: RepoNodeProps) {
  const radius = 30;

  return (
    <g
      className="repo-node"
      onClick={() => onClick(node.id)}
      style={{ cursor: 'pointer' }}
    >
      <circle
        cx={node.cx}
        cy={node.cy}
        r={radius}
        fill="#1A1A1A"
        stroke={isSelected ? '#00B289' : statusColors[node.status]}
        strokeWidth={isSelected ? 3 : 2}
      />
      <text
        x={node.cx}
        y={node.cy - 4}
        textAnchor="middle"
        fontSize="14"
        fill="white"
      >
        {typeIcons[node.type]}
      </text>
      <text
        x={node.cx}
        y={node.cy + radius + 16}
        textAnchor="middle"
        fontSize="11"
        fill="#A0A0A0"
      >
        {node.label}
      </text>
      {/* Status indicator */}
      <circle
        cx={node.cx + radius - 6}
        cy={node.cy - radius + 6}
        r={5}
        fill={statusColors[node.status]}
      />
    </g>
  );
}

export default RepoNode;
