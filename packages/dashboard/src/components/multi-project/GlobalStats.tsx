import React from 'react';

export interface GlobalStatsData {
  totalSystems: number;
  onlineSystems: number;
  totalRepos: number;
  activeRuns: number;
  completedRuns: number;
  failedRuns: number;
}

export interface GlobalStatsProps {
  stats: GlobalStatsData;
}

export function GlobalStats({ stats }: GlobalStatsProps) {
  const statItems = [
    { label: 'projects', value: `${stats.onlineSystems}/${stats.totalSystems}`, sub: 'online' },
    { label: 'Repos', value: stats.totalRepos, sub: 'total' },
    { label: 'Active', value: stats.activeRuns, sub: 'runs' },
    { label: 'Completed', value: stats.completedRuns, sub: 'runs' },
    { label: 'Failed', value: stats.failedRuns, sub: 'runs' },
  ];

  return (
    <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
      {statItems.map((item) => (
        <div key={item.label} className="card" style={{ padding: 'var(--space-md)', minWidth: 120, textAlign: 'center' }}>
          <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, color: 'var(--color-accent)' }}>{item.value}</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{item.label}</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{item.sub}</div>
        </div>
      ))}
    </div>
  );
}

export default GlobalStats;
