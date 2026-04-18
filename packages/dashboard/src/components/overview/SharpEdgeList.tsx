import React from 'react';

export interface SharpEdge {
  id: string;
  description: string;
  repo?: string;
  workaround?: string;
}

export interface SharpEdgeListProps {
  edges: SharpEdge[];
}

export function SharpEdgeList({ edges }: SharpEdgeListProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
      <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 600, marginBottom: 'var(--space-xs)' }}>Sharp Edges</h3>
      {edges.map((edge) => (
        <div key={edge.id} className="card" style={{ padding: 'var(--space-sm)', borderLeft: '3px solid var(--color-warning)' }}>
          <div style={{ fontSize: 'var(--text-sm)', marginBottom: 4 }}>{edge.description}</div>
          {edge.workaround && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              Workaround: {edge.workaround}
            </div>
          )}
          {edge.repo && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{edge.repo}</div>}
        </div>
      ))}
      {edges.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>No sharp edges documented</span>}
    </div>
  );
}

export default SharpEdgeList;
