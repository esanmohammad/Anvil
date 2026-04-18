import React from 'react';
import { Badge } from '../ui/Badge.js';

export interface ProjectCardData {
  name: string;
  title: string;
  status: 'online' | 'offline' | 'degraded';
  repoCount: number;
  activeRuns: number;
  lastActivity: number;
}

export interface ProjectCardProps {
  project: ProjectCardData;
  onClick: (name: string) => void;
}

export function ProjectCard({ project, onClick }: ProjectCardProps) {
  const statusVariant = project.status === 'online' ? 'success' : project.status === 'offline' ? 'error' : 'warning';
  const ago = Math.round((Date.now() - project.lastActivity) / 60000);
  const agoLabel = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;

  return (
    <div className="card" style={{ cursor: 'pointer' }} onClick={() => onClick(project.name)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-sm)' }}>
        <span style={{ fontWeight: 600, fontSize: 'var(--text-base)' }}>{project.title || project.name}</span>
        <Badge variant={statusVariant}>{project.status}</Badge>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-md)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        <span>{project.repoCount} repos</span>
        <span>{project.activeRuns} active</span>
        <span>{agoLabel}</span>
      </div>
    </div>
  );
}

export default ProjectCard;
