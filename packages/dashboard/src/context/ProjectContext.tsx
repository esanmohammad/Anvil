import React, { createContext, useContext, useState, useCallback } from 'react';

export interface ProjectInfo {
  name: string;
  title: string;
  owner: string;
  lifecycle: string;
  repoCount?: number;
}

export interface ProjectContextValue {
  currentProject: ProjectInfo | null;
  projects: ProjectInfo[];
  setCurrentProject: (project: ProjectInfo | null) => void;
  setProjects: (projects: ProjectInfo[]) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [currentProject, setCurrentProject] = useState<ProjectInfo | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);

  return (
    <ProjectContext.Provider value={{ currentProject, projects, setCurrentProject, setProjects }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useSystem(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return ctx;
}

export default ProjectContext;
