import React from 'react';
import type { ProjectInfo } from '../../context/ProjectContext.js';

export interface ProjectSelectorProps {
  projects: ProjectInfo[];
  current: ProjectInfo | null;
  onSelect: (project: ProjectInfo) => void;
}

export function ProjectSelector({ projects, current, onSelect }: ProjectSelectorProps) {
  return (
    <div className="project-selector" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
      <label htmlFor="project-select" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        Project:
      </label>
      <select
        id="project-select"
        className="input"
        style={{ width: 'auto', minWidth: 200 }}
        value={current?.name ?? ''}
        onChange={(e) => {
          const sys = projects.find((s) => s.name === e.target.value);
          if (sys) onSelect(sys);
        }}
      >
        <option value="" disabled>Select a project...</option>
        {projects.map((sys) => (
          <option key={sys.name} value={sys.name}>{sys.title || sys.name}</option>
        ))}
      </select>
    </div>
  );
}

export default ProjectSelector;
