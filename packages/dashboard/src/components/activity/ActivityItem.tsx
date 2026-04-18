import React from 'react';
import { Badge } from '../ui/Badge.js';
import type { ActivityEntry } from '../../../server/types.js';

export interface ActivityItemProps {
  entry: ActivityEntry;
  style?: React.CSSProperties;
}

const levelVariant: Record<string, 'primary' | 'success' | 'error' | 'warning' | 'neutral'> = {
  info: 'primary',
  warn: 'warning',
  error: 'error',
  debug: 'neutral',
};

export function ActivityItem({ entry, style }: ActivityItemProps) {
  const time = new Date(entry.timestamp).toLocaleTimeString();

  return (
    <div
      className="activity-item"
      style={{
        display: 'flex',
        gap: 'var(--space-sm)',
        padding: 'var(--space-xs) var(--space-md)',
        borderBottom: '1px solid var(--border-default)',
        fontSize: 'var(--text-sm)',
        alignItems: 'flex-start',
        ...style,
      }}
    >
      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', whiteSpace: 'nowrap', minWidth: 70 }}>
        {time}
      </span>
      <Badge variant={levelVariant[entry.level] ?? 'neutral'}>{entry.level}</Badge>
      <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
        [{entry.source}]
      </span>
      <span style={{ flex: 1, color: entry.level === 'error' ? 'var(--color-error)' : 'var(--text-primary)' }}>
        {entry.message}
      </span>
      {entry.repo && (
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)' }}>
          {entry.repo}
        </span>
      )}
    </div>
  );
}

export default ActivityItem;
