import React from 'react';

export interface ActiveRunItem {
  id: string;
  type: string;
  project: string;
  description: string;
  status: string;
  startedAt: number;
  activityCount: number;
}

interface RunSelectorProps {
  runs: ActiveRunItem[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}

export function RunSelector({ runs, selectedRunId, onSelect }: RunSelectorProps) {
  if (runs.length <= 1) return null;

  return (
    <div style={{
      display: 'flex',
      gap: 6,
      padding: '6px 12px',
      background: 'var(--bg-panel)',
      borderBottom: '1px solid var(--border-default)',
      overflowX: 'auto',
      flexShrink: 0,
    }}>
      {runs.map((r) => {
        const isSelected = r.id === selectedRunId;
        const isRunning = r.status === 'running';
        return (
          <button
            key={r.id}
            onClick={() => onSelect(r.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 12px',
              background: isSelected ? 'var(--bg-hover)' : 'transparent',
              border: isSelected ? '1px solid var(--border-default)' : '1px solid transparent',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 11,
              fontFamily: 'var(--font-sans)',
              color: isSelected ? 'var(--text-primary)' : 'var(--text-muted)',
              fontWeight: isSelected ? 600 : 400,
              whiteSpace: 'nowrap',
              maxWidth: 250,
            }}
          >
            <span style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: isRunning ? 'var(--color-success)' : r.status === 'completed' ? 'var(--color-success)' : 'var(--color-error)',
              animation: isRunning ? 'ff-pulse 1.5s ease-in-out infinite' : 'none',
            }} />
            <span style={{
              overflow: 'hidden', textOverflow: 'ellipsis',
              fontFamily: 'var(--font-mono)', fontSize: 10,
            }}>
              {r.project}
            </span>
            <span style={{
              overflow: 'hidden', textOverflow: 'ellipsis', flex: 1,
            }}>
              {r.description.length > 40 ? r.description.slice(0, 40) + '...' : r.description}
            </span>
          </button>
        );
      })}
      <style>{`@keyframes ff-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
    </div>
  );
}

export default RunSelector;
