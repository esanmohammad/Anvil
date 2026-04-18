import { useState, useEffect, useRef } from 'react';
import type { ProjectStatus } from '../../server/types.js';

export interface UseProjectStatusOptions {
  subscribe: (channel: string, filters?: Record<string, string>) => void;
  unsubscribe: (channel: string) => void;
  lastMessage: unknown | null;
}

export function useProjectStatus({ subscribe, unsubscribe, lastMessage }: UseProjectStatusOptions) {
  const [projects, setProjects] = useState<Map<string, ProjectStatus>>(new Map());
  const subscribedRef = useRef(false);

  useEffect(() => {
    if (!subscribedRef.current) {
      subscribe('project');
      subscribedRef.current = true;
    }
    return () => {
      unsubscribe('project');
      subscribedRef.current = false;
    };
  }, [subscribe, unsubscribe]);

  useEffect(() => {
    const msg = lastMessage as { channel?: string; event?: string; data?: ProjectStatus } | null;
    if (msg?.channel === 'project' && msg.data) {
      setProjects((prev) => {
        const next = new Map(prev);
        next.set(msg.data!.project, msg.data!);
        return next;
      });
    }
  }, [lastMessage]);

  const getProject = (name: string): ProjectStatus | undefined => projects.get(name);
  const allProjects = Array.from(projects.values());

  return { projects: allProjects, getProject, projectMap: projects };
}

export default useProjectStatus;
