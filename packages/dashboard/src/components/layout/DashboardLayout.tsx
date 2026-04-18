import React, { useState, useCallback } from 'react';
import { Sidebar } from './Sidebar.js';
import type { NavItem, SystemOption } from './Sidebar.js';
import type { ProjectInfo } from '../../context/ProjectContext.js';

export interface DashboardLayoutProps {
  navItems: NavItem[];
  activeNavId: string;
  onNavigate: (item: NavItem) => void;
  projects: ProjectInfo[];
  currentProject: ProjectInfo | null;
  onProjectSelect: (project: ProjectInfo) => void;
  /** Contextual header content — replaces the old static header */
  headerLeft?: React.ReactNode;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}

export function DashboardLayout({
  navItems,
  activeNavId,
  onNavigate,
  projects,
  currentProject,
  onProjectSelect,
  headerLeft,
  headerRight,
  children,
}: DashboardLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const toggleSidebar = useCallback(() => setSidebarCollapsed((c) => !c), []);

  return (
    <div
      className="dashboard-layout"
      style={{
        display: 'flex',
        height: '100vh',
        background: 'var(--bg-base)',
        overflow: 'hidden',
      }}
    >
      {/* Sidebar */}
      <Sidebar
        items={navItems}
        activeId={activeNavId}
        collapsed={sidebarCollapsed}
        onNavigate={onNavigate}
        onToggleCollapse={toggleSidebar}
        projects={projects?.map((s) => ({ name: s.name, title: s.title, repoCount: s.repoCount }))}
        currentProject={currentProject?.name ?? null}
        onProjectChange={(name) => {
          const sys = projects?.find((s) => s.name === name);
          if (sys && onProjectSelect) onProjectSelect(sys);
        }}
      />

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Contextual header */}
        {(headerLeft || headerRight) && (
          <header
            className="frosted"
            style={{
              height: 'var(--header-height)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 var(--space-lg)',
              borderBottom: '1px solid var(--separator)',
              background: 'rgba(17,17,17,0.8)',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
              {headerLeft}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
              {headerRight}
            </div>
          </header>
        )}

        {/* Main content */}
        <main style={{ flex: 1, overflow: 'auto' }}>
          {children}
        </main>
      </div>
    </div>
  );
}

export default DashboardLayout;
