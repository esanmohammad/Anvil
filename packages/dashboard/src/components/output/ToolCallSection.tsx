import React, { useState } from 'react';
import { Badge } from '../ui/Badge.js';

export interface ToolCallSectionProps {
  toolName: string;
  content: string;
  timestamp: number;
}

export function ToolCallSection({ toolName, content, timestamp }: ToolCallSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const time = new Date(timestamp).toLocaleTimeString();

  return (
    <div
      className="card"
      style={{
        padding: 'var(--space-sm)',
        margin: 'var(--space-xs) 0',
        borderLeft: '3px solid var(--color-primary)',
      }}
    >
      <button
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', width: '100%', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)' }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ fontSize: 'var(--text-xs)' }}>{expanded ? '\u25BC' : '\u25B6'}</span>
        <Badge variant="primary">Tool</Badge>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>{toolName}</span>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{time}</span>
      </button>
      {expanded && (
        <pre style={{
          marginTop: 'var(--space-sm)',
          padding: 'var(--space-sm)',
          background: 'var(--bg-root)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 'var(--text-xs)',
          fontFamily: 'var(--font-mono)',
          overflow: 'auto',
          maxHeight: 300,
          whiteSpace: 'pre-wrap',
          color: 'var(--text-secondary)',
        }}>
          {content}
        </pre>
      )}
    </div>
  );
}

export default ToolCallSection;
