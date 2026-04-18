import React, { useMemo } from 'react';
import { ActivityFeed } from './ActivityFeed.js';
import { ActivityFilters } from './ActivityFilters.js';
import type { ActivityEntry } from '../../../server/types.js';
import type { ActivityFilter } from '../../hooks/useActivityFeed.js';

export interface ActivityContainerProps {
  entries: ActivityEntry[];
  filter: ActivityFilter;
  onFilterChange: (filter: ActivityFilter) => void;
  onClear: () => void;
}

export function ActivityContainer({ entries, filter, onFilterChange, onClear }: ActivityContainerProps) {
  const sources = useMemo(() => [...new Set(entries.map((e) => e.source))], [entries]);
  const repos = useMemo(() => [...new Set(entries.map((e) => e.repo).filter(Boolean) as string[])], [entries]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-sm)' }}>
        <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 600 }}>Activity Feed</h2>
        <button className="btn btn-ghost btn-sm" onClick={onClear}>Clear</button>
      </div>
      <ActivityFilters filter={filter} onFilterChange={onFilterChange} sources={sources} repos={repos} />
      <div style={{ flex: 1, minHeight: 0 }}>
        <ActivityFeed entries={entries} />
      </div>
      <div style={{ padding: 'var(--space-xs)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textAlign: 'right' }}>
        {entries.length} entries
      </div>
    </div>
  );
}

export default ActivityContainer;
