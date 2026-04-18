import React from 'react';
import { ProjectCard } from './ProjectCard.js';
import { GlobalStats } from './GlobalStats.js';
import type { ProjectCardData } from './ProjectCard.js';
import type { GlobalStatsData } from './GlobalStats.js';

export interface MultiProjectDashboardProps {
  projects: ProjectCardData[];
  stats: GlobalStatsData;
  onSelectProject: (name: string) => void;
}

export function MultiProjectDashboard({ projects, stats, onSelectProject }: MultiProjectDashboardProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
      <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 600 }}>Multi-Project Dashboard</h2>
      <GlobalStats stats={stats} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 'var(--space-md)' }}>
        {projects.map((sys) => (
          <ProjectCard key={sys.name} system={sys} onClick={onSelectProject} />
        ))}
      </div>
      {projects.length === 0 && (
        <div style={{ padding: 'var(--space-lg)', textAlign: 'center', color: 'var(--text-muted)' }}>No projects configured</div>
      )}
    </div>
  );
}

export default MultiProjectDashboard;
