import React from 'react';

export interface Convention {
  id: string;
  pattern: string;
  description: string;
  repo?: string;
}

export interface ConventionListProps {
  conventions: Convention[];
}

export function ConventionList({ conventions }: ConventionListProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
      <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 600, marginBottom: 'var(--space-xs)' }}>Conventions</h3>
      {conventions.map((conv) => (
        <div key={conv.id} className="card" style={{ padding: 'var(--space-sm)' }}>
          <code style={{ fontSize: 'var(--text-xs)', color: 'var(--color-accent)', background: 'var(--bg-hover)', padding: '1px 4px', borderRadius: 'var(--radius-sm)' }}>
            {conv.pattern}
          </code>
          <div style={{ fontSize: 'var(--text-sm)', marginTop: 4 }}>{conv.description}</div>
          {conv.repo && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>{conv.repo}</div>}
        </div>
      ))}
      {conventions.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>No conventions documented</span>}
    </div>
  );
}

export default ConventionList;
