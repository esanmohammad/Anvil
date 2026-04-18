import React from 'react';
import type { ActivityFilter } from '../../hooks/useActivityFeed.js';

export interface ActivityFiltersProps {
  filter: ActivityFilter;
  onFilterChange: (filter: ActivityFilter) => void;
  sources: string[];
  repos: string[];
}

export function ActivityFilters({ filter, onFilterChange, sources, repos }: ActivityFiltersProps) {
  return (
    <div className="activity-filters" style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap', marginBottom: 'var(--space-md)' }}>
      <input
        className="input"
        placeholder="Search messages..."
        value={filter.search ?? ''}
        onChange={(e) => onFilterChange({ ...filter, search: e.target.value || undefined })}
        style={{ maxWidth: 240 }}
      />
      <select
        className="input"
        value={filter.level ?? ''}
        onChange={(e) => onFilterChange({ ...filter, level: e.target.value || undefined })}
        style={{ width: 'auto', minWidth: 100 }}
      >
        <option value="">All levels</option>
        <option value="info">Info</option>
        <option value="warn">Warning</option>
        <option value="error">Error</option>
        <option value="debug">Debug</option>
      </select>
      <select
        className="input"
        value={filter.source ?? ''}
        onChange={(e) => onFilterChange({ ...filter, source: e.target.value || undefined })}
        style={{ width: 'auto', minWidth: 120 }}
      >
        <option value="">All sources</option>
        {sources.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <select
        className="input"
        value={filter.repo ?? ''}
        onChange={(e) => onFilterChange({ ...filter, repo: e.target.value || undefined })}
        style={{ width: 'auto', minWidth: 120 }}
      >
        <option value="">All repos</option>
        {repos.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
    </div>
  );
}

export default ActivityFilters;
