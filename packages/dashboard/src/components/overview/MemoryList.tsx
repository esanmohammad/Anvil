import React from 'react';

export interface Memory {
  id: string;
  key: string;
  value: string;
  category: string;
  timestamp: number;
}

export interface MemoryListProps {
  memories: Memory[];
}

export function MemoryList({ memories }: MemoryListProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      {memories.map((mem) => (
        <div key={mem.id} className="card" style={{ padding: '10px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 6 }}>
            <span style={{
              fontSize: 11, fontWeight: 500,
              padding: '1px 6px', borderRadius: 'var(--radius-xs)',
              background: 'var(--accent-subtle)', color: 'var(--accent)',
            }}>
              {mem.category}
            </span>
            <code style={{ fontSize: 12, color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>{mem.key}</code>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>
              {new Date(mem.timestamp).toLocaleString()}
            </span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{mem.value}</div>
        </div>
      ))}
      {memories.length === 0 && (
        <div style={{
          padding: '14px 16px',
          background: 'var(--bg-elevated-2)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--text-tertiary)',
          fontSize: 13, lineHeight: 1.6,
        }}>
          <p style={{ margin: '0 0 8px' }}>No memories yet for this project.</p>
          <p style={{ margin: 0, fontSize: 12 }}>
            Memories are accumulated automatically as pipelines run — architecture patterns,
            user preferences, conventions, and lessons learned. They persist across sessions.
          </p>
        </div>
      )}
    </div>
  );
}

export default MemoryList;
