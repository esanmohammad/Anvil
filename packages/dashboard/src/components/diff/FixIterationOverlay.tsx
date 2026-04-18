import React from 'react';
import { Badge } from '../ui/Badge.js';

export interface FixIteration {
  id: string;
  label: string;
  timestamp: number;
  status: 'pending' | 'applied' | 'rejected';
}

export interface FixIterationOverlayProps {
  iterations: FixIteration[];
  currentIteration: string | null;
  onSelectIteration: (id: string) => void;
}

export function FixIterationOverlay({ iterations, currentIteration, onSelectIteration }: FixIterationOverlayProps) {
  if (iterations.length === 0) return null;

  return (
    <div style={{ display: 'flex', gap: 'var(--space-xs)', padding: 'var(--space-sm)', borderBottom: '1px solid var(--border-default)', overflowX: 'auto' }}>
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Fix iterations:</span>
      {iterations.map((iter) => (
        <button
          key={iter.id}
          className={`btn btn-sm ${currentIteration === iter.id ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => onSelectIteration(iter.id)}
        >
          {iter.label}
          <Badge variant={iter.status === 'applied' ? 'success' : iter.status === 'rejected' ? 'error' : 'neutral'}>
            {iter.status}
          </Badge>
        </button>
      ))}
    </div>
  );
}

export default FixIterationOverlay;
