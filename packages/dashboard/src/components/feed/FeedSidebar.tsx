import React from 'react';
import { ActionBar2 } from '../actions/ActionBar2.js';
import type { QuickAction } from '../actions/ActionBar2.js';

/**
 * Feed sidebar — Phase 7 from Hivemind parity plan.
 *
 * Shows activity history in sections: In Progress, Today, Earlier.
 * Bottom: tool shortcuts (Build Feature, Conventions, Memory, Stats).
 * Quick actions bar at bottom.
 */

export interface FeedItem {
  id: string;
  type: 'pipeline' | 'fix' | 'review' | 'spike';
  label: string;
  status: 'running' | 'completed' | 'failed';
  cost?: number;
  timestamp: number;
  project: string;
}

export interface FeedSidebarProps {
  items: FeedItem[];
  selectedItem: string | null;
  onSelectItem: (id: string) => void;
  projectName: string | null;
  onQuickAction: (action: QuickAction) => void;
  onToolClick: (tool: string) => void;
}

const TYPE_COLORS: Record<string, string> = {
  pipeline: 'var(--color-info)',
  fix: 'var(--color-warning)',
  review: '#a855f7',
  spike: 'var(--color-success)',
};

const TYPE_ICONS: Record<string, string> = {
  pipeline: '\u2728',
  fix: '\u{1F527}',
  review: '\u{1F440}',
  spike: '\u{1F50D}',
};

const STATUS_BADGES: Record<string, { color: string; label: string }> = {
  running: { color: 'var(--color-success)', label: 'running' },
  completed: { color: 'var(--text-muted)', label: 'done' },
  failed: { color: 'var(--color-error)', label: 'error' },
};

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function isToday(ts: number): boolean {
  const d = new Date(ts);
  const now = new Date();
  return d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

export function FeedSidebar({
  items,
  selectedItem,
  onSelectItem,
  projectName,
  onQuickAction,
  onToolClick,
}: FeedSidebarProps) {
  const inProgress = items.filter((i) => i.status === 'running');
  const today = items.filter((i) => i.status !== 'running' && isToday(i.timestamp));
  const earlier = items.filter((i) => i.status !== 'running' && !isToday(i.timestamp));

  const renderSection = (title: string, sectionItems: FeedItem[]) => {
    if (sectionItems.length === 0) return null;
    return (
      <div style={{ marginBottom: 'var(--space-md)' }}>
        <div style={{
          fontSize: '10px',
          fontWeight: 600,
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
          letterSpacing: '0.5px',
          padding: '0 8px',
          marginBottom: 4,
        }}>
          {title}
        </div>
        {sectionItems.map((item) => {
          const badge = STATUS_BADGES[item.status];
          const isSelected = selectedItem === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelectItem(item.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '6px 8px',
                background: isSelected ? 'var(--bg-hover)' : 'transparent',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: '12px', color: TYPE_COLORS[item.type] }}>
                {TYPE_ICONS[item.type]}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '12px',
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {item.label}
                </div>
                <div style={{
                  display: 'flex',
                  gap: 6,
                  fontSize: '10px',
                  color: 'var(--text-muted)',
                }}>
                  <span style={{ color: badge.color }}>
                    {item.status === 'running' && (
                      <span style={{
                        display: 'inline-block',
                        width: 5,
                        height: 5,
                        borderRadius: '50%',
                        background: 'var(--color-success)',
                        animation: 'pulse 1.5s ease-in-out infinite',
                        marginRight: 3,
                        verticalAlign: 'middle',
                      }} />
                    )}
                    {badge.label}
                  </span>
                  {item.cost != null && item.cost > 0 && (
                    <span style={{ fontFamily: 'var(--font-mono)' }}>${item.cost.toFixed(2)}</span>
                  )}
                  <span>{formatRelativeTime(item.timestamp)}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    );
  };

  const tools = [
    { id: 'build', label: 'Build Feature', icon: '\u2728' },
    { id: 'conventions', label: 'Coding Conventions', icon: '\u{1F4CB}' },
    { id: 'memory', label: 'Project Memory', icon: '\u{1F9E0}' },
    { id: 'stats', label: 'Usage & Costs', icon: '\u{1F4CA}' },
  ];

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
    }}>
      {/* Feed items */}
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 4px' }}>
        {renderSection('In Progress', inProgress)}
        {renderSection('Today', today)}
        {renderSection('Earlier', earlier)}

        {items.length === 0 && (
          <div style={{
            padding: 'var(--space-lg)',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: '12px',
          }}>
            No activity yet
          </div>
        )}
      </div>

      {/* Tool shortcuts */}
      <div style={{
        borderTop: '1px solid var(--border-default)',
        padding: '8px 4px',
        flexShrink: 0,
      }}>
        <div style={{
          fontSize: '10px',
          fontWeight: 600,
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
          letterSpacing: '0.5px',
          padding: '0 8px',
          marginBottom: 4,
        }}>
          Workspace Tools
        </div>
        {tools.map((tool) => (
          <button
            key={tool.id}
            onClick={() => onToolClick(tool.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '5px 8px',
              background: 'transparent',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              fontSize: '12px',
              color: 'var(--text-secondary)',
              textAlign: 'left',
            }}
          >
            <span>{tool.icon}</span>
            {tool.label}
          </button>
        ))}
      </div>

      {/* Quick actions */}
      <div style={{ flexShrink: 0, borderTop: '1px solid var(--border-default)' }}>
        <ActionBar2 projectName={projectName} onAction={onQuickAction} />
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

export default FeedSidebar;
