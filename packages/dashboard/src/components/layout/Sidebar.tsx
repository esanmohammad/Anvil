import React, { useState, useRef, useEffect } from 'react';
import {
  Home, Radio, GitPullRequest,
  Clock, BarChart3, Server, Brain,
  PanelLeftClose, PanelLeft, ChevronDown,
  GitCompareArrows, TestTube, Map, Settings,
  Anvil,
} from 'lucide-react';

export interface NavItem {
  id: string;
  label: string;
  icon?: string;
  path: string;
  badge?: number;
  primary?: boolean;
  secondary?: boolean;
  comingSoon?: boolean;
}

export interface SystemOption {
  name: string;
  title: string;
  repoCount: number;
}

export interface SidebarProps {
  items: NavItem[];
  activeId: string;
  collapsed: boolean;
  onNavigate: (item: NavItem) => void;
  onToggleCollapse: () => void;
  projects?: SystemOption[];
  currentProject?: string | null;
  onProjectChange?: (name: string) => void;
}

const iconMap: Record<string, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  home: Home,
  runs: Radio,
  'pr-board': GitPullRequest,
  history: Clock,
  insights: BarChart3,
  project: Server,
  'knowledge-graph': Brain,
  'review': GitCompareArrows,
  'test-gen': TestTube,
  'plan': Map,
  'settings': Settings,
};

export function Sidebar({ items, activeId, collapsed, onNavigate, onToggleCollapse, projects, currentProject, onProjectChange }: SidebarProps) {
  const primary = items.filter((i) => i.primary !== false && !i.secondary);
  const secondary = items.filter((i) => i.secondary);

  const renderItem = (item: NavItem) => {
    const isActive = item.id === activeId;
    const Icon = iconMap[item.id];
    const disabled = !!item.comingSoon;

    return (
      <button
        key={item.id}
        onClick={() => !disabled && onNavigate(item)}
        title={collapsed ? (disabled ? `${item.label} (Coming Soon)` : item.label) : undefined}
        disabled={disabled}
        aria-current={isActive && !disabled ? 'page' : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          height: 36,
          padding: collapsed ? '0' : isActive && !disabled ? '0 10px' : '0 12px',
          justifyContent: collapsed ? 'center' : 'flex-start',
          background: isActive && !disabled ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
          border: 'none',
          borderLeft: isActive && !disabled && !collapsed ? '2px solid var(--accent)' : '2px solid transparent',
          borderRadius: 'var(--radius-sm)',
          cursor: disabled ? 'default' : 'pointer',
          color: disabled ? 'var(--text-tertiary)' : isActive ? 'var(--accent)' : 'var(--text-secondary)',
          opacity: disabled ? 0.55 : 1,
          fontSize: 13,
          fontWeight: isActive && !disabled ? 500 : 400,
          fontFamily: 'var(--font-sans)',
          transition: 'all var(--duration-fast) var(--ease-default)',
        }}
        onMouseEnter={(e) => {
          if (!isActive && !disabled) (e.currentTarget as HTMLElement).style.background = 'var(--surface-hover, var(--bg-elevated-3))';
        }}
        onMouseLeave={(e) => {
          if (!isActive && !disabled) (e.currentTarget as HTMLElement).style.background = 'transparent';
        }}
      >
        {Icon && <Icon size={18} strokeWidth={1.75} />}
        {!collapsed && <span>{item.label}</span>}
        {!collapsed && disabled && (
          <span style={{
            marginLeft: 'auto',
            height: 16,
            padding: '0 5px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--radius-full)',
            background: 'var(--bg-elevated-3)',
            color: 'var(--text-tertiary)',
            fontSize: 9,
            fontWeight: 500,
            lineHeight: 1,
            whiteSpace: 'nowrap',
          }}>
            Soon
          </span>
        )}
        {!collapsed && !disabled && item.badge != null && item.badge > 0 && (
          <span style={{
            marginLeft: 'auto',
            height: 18,
            minWidth: 18,
            padding: '0 5px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--radius-full)',
            background: 'var(--accent-muted)',
            color: 'var(--accent)',
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 1,
          }}>
            {item.badge}
          </span>
        )}
      </button>
    );
  };

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    color: 'var(--text-quaternary, var(--text-tertiary))',
    padding: '0 12px',
    marginBottom: 4,
    marginTop: 16,
    lineHeight: 1,
    userSelect: 'none',
  };

  return (
    <aside
      style={{
        width: collapsed ? 'var(--sidebar-collapsed)' : 'var(--sidebar-width)',
        background: 'var(--bg-elevated-1)',
        borderRight: '1px solid var(--separator)',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width var(--duration-normal) var(--ease-default)',
        overflow: 'hidden',
        height: '100%',
        flexShrink: 0,
      }}
    >
      {/* Logo mark */}
      <div style={{
        height: 'var(--header-height)',
        display: 'flex',
        alignItems: 'center',
        padding: collapsed ? '0' : '0 16px',
        justifyContent: collapsed ? 'center' : 'flex-start',
        flexShrink: 0,
        borderBottom: '1px solid var(--separator)',
      }}>
        <span style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 15,
          fontWeight: 700,
          color: 'var(--accent)',
          letterSpacing: '-0.02em',
          whiteSpace: 'nowrap',
        }}>
          <Anvil size={18} strokeWidth={1.75} />
          {!collapsed && 'Anvil'}
        </span>
      </div>

      {/* Project selector — hero element */}
      {!collapsed && projects && projects.length > 0 && onProjectChange && (
        <ProjectSelector
          projects={projects}
          currentProject={currentProject ?? null}
          onChange={onProjectChange}
        />
      )}
      {collapsed && currentProject && (
        <div title={currentProject} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '12px 0', flexShrink: 0,
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: 'var(--radius-sm)',
            background: 'var(--accent-muted)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
          }}>
            {currentProject.slice(0, 2).toUpperCase()}
          </div>
        </div>
      )}

      {/* Primary nav */}
      <nav
        aria-label="Main navigation"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          padding: collapsed ? '0 8px' : '0 8px',
          overflowY: 'auto',
        }}
      >
        {!collapsed && (
          <div style={sectionLabelStyle}>Workspace</div>
        )}
        {primary.map(renderItem)}

        {/* Secondary section */}
        {secondary.length > 0 && (
          <>
            {!collapsed ? (
              <div style={sectionLabelStyle}>Configure</div>
            ) : (
              <div style={{
                height: 1,
                background: 'var(--separator)',
                margin: '8px 0',
              }} />
            )}
            {secondary.map(renderItem)}
          </>
        )}
      </nav>

      {/* Collapse toggle */}
      <div style={{
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        flexShrink: 0,
        borderTop: '1px solid var(--separator)',
      }}>
        <button
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            gap: 12,
            width: '100%',
            height: 36,
            padding: collapsed ? '0' : '0 12px',
            background: 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            color: 'var(--text-tertiary)',
            fontSize: 13,
            fontFamily: 'var(--font-sans)',
            transition: 'all var(--duration-fast) var(--ease-default)',
          }}
          onMouseEnter={(e) => {
            const el = e.currentTarget as HTMLElement;
            el.style.color = 'var(--text-secondary)';
            el.style.background = 'var(--surface-hover, var(--bg-elevated-3))';
          }}
          onMouseLeave={(e) => {
            const el = e.currentTarget as HTMLElement;
            el.style.color = 'var(--text-tertiary)';
            el.style.background = 'transparent';
          }}
        >
          {collapsed ? <PanelLeft size={18} strokeWidth={1.75} /> : <PanelLeftClose size={18} strokeWidth={1.75} />}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}

function ProjectSelector({
  projects,
  currentProject,
  onChange,
}: {
  projects: SystemOption[];
  currentProject: string | null;
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selected = projects.find((s) => s.name === currentProject);

  return (
    <div ref={ref} style={{ padding: '8px 8px 12px', flexShrink: 0, position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          width: '100%', padding: '8px 10px',
          background: 'var(--bg-base)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
          color: 'var(--text-primary)',
          fontSize: 12, fontWeight: 600,
          fontFamily: 'var(--font-sans)',
          transition: 'border-color var(--duration-fast) var(--ease-default)',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'; }}
        onMouseLeave={(e) => { if (!open) (e.currentTarget as HTMLElement).style.borderColor = 'var(--separator)'; }}
      >
        <Server size={14} strokeWidth={1.75} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.title || selected?.name || 'Select project'}
        </span>
        <ChevronDown size={12} style={{
          color: 'var(--text-tertiary)', flexShrink: 0,
          transform: open ? 'rotate(180deg)' : 'none',
          transition: 'transform var(--duration-fast) var(--ease-default)',
        }} />
      </button>

      <div
        role="listbox"
        aria-label="Project list"
        style={{
          position: 'absolute', top: '100%', left: 8, right: 8, zIndex: 100,
          background: 'var(--bg-elevated-2)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-sm)',
          boxShadow: open ? 'var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.4))' : 'none',
          maxHeight: 240, overflow: 'auto',
          padding: '4px',
          marginTop: 2,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transform: open ? 'translateY(0)' : 'translateY(-4px)',
          transition: 'opacity 150ms var(--ease-default), transform 150ms var(--ease-default)',
        }}
      >
        {projects.map((s) => {
          const isActive = s.name === currentProject;
          return (
            <button
              key={s.name}
              role="option"
              aria-selected={isActive}
              onClick={() => { onChange(s.name); setOpen(false); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', padding: '8px 10px',
                background: isActive ? 'var(--accent-muted)' : 'transparent',
                border: 'none', borderRadius: 'var(--radius-xs)',
                cursor: 'pointer',
                color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                fontSize: 12, fontFamily: 'var(--font-sans)',
                textAlign: 'left',
                transition: 'background var(--duration-fast) var(--ease-default)',
              }}
              onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'var(--surface-hover, var(--bg-elevated-3))'; }}
              onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: isActive ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.title || s.name}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 1 }}>
                  {s.name} · {s.repoCount} repos
                </div>
              </div>
              {isActive && (
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default Sidebar;
