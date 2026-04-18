import React from 'react';
import { Badge } from '../ui/Badge.js';

export interface Invariant {
  id: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'passing' | 'failing' | 'unknown';
  repo?: string;
}

export interface InvariantListProps {
  invariants: Invariant[];
}

const severityVariant: Record<string, 'error' | 'warning' | 'primary' | 'neutral'> = {
  critical: 'error',
  high: 'warning',
  medium: 'primary',
  low: 'neutral',
};

export function InvariantList({ invariants }: InvariantListProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
      <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 600, marginBottom: 'var(--space-xs)' }}>Invariants</h3>
      {invariants.map((inv) => (
        <div key={inv.id} className="card" style={{ padding: 'var(--space-sm)', display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <Badge variant={inv.status === 'passing' ? 'success' : inv.status === 'failing' ? 'error' : 'neutral'}>
            {inv.status}
          </Badge>
          <span style={{ flex: 1, fontSize: 'var(--text-sm)' }}>{inv.description}</span>
          <Badge variant={severityVariant[inv.severity]}>{inv.severity}</Badge>
          {inv.repo && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{inv.repo}</span>}
        </div>
      ))}
      {invariants.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>No invariants defined</span>}
    </div>
  );
}

export default InvariantList;
