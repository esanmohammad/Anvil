import React from 'react';

export interface RepoTabsProps {
  repos: Array<{
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    cost?: number;
    agentId?: string;
  }>;
  selectedRepo: string | null;
  onSelectRepo: (repoName: string | null) => void;
}

const statusDotColor: Record<string, string> = {
  pending: 'var(--text-muted)',
  running: 'var(--color-success)',
  completed: 'var(--color-success)',
  failed: 'var(--color-error)',
};

export function RepoTabs({ repos, selectedRepo, onSelectRepo }: RepoTabsProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 0,
        borderBottom: '2px solid var(--border-default)',
        overflowX: 'auto',
        fontFamily: 'var(--font-sans)',
        scrollbarWidth: 'thin',
      }}
    >
      {/* All tab */}
      <Tab
        label="All"
        isSelected={selectedRepo === null}
        onClick={() => onSelectRepo(null)}
      />

      {/* Per-repo tabs */}
      {repos.map((repo) => (
        <Tab
          key={repo.name}
          label={repo.name}
          status={repo.status}
          cost={repo.cost}
          isSelected={selectedRepo === repo.name}
          onClick={() => onSelectRepo(repo.name)}
        />
      ))}

      {/* Pulse animation for running dots */}
      <style>{`
        @keyframes repo-tab-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>
    </div>
  );
}

interface TabProps {
  label: string;
  status?: 'pending' | 'running' | 'completed' | 'failed';
  cost?: number;
  isSelected: boolean;
  onClick: () => void;
}

function Tab({ label, status, cost, isSelected, onClick }: TabProps) {
  const dotColor = status ? statusDotColor[status] : undefined;
  const isRunning = status === 'running';

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: 'var(--space-xs) var(--space-sm)',
        background: 'transparent',
        border: 'none',
        borderBottom: `2px solid ${isSelected ? 'var(--color-accent)' : 'transparent'}`,
        marginBottom: -2,
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-xs)',
        fontWeight: isSelected ? 600 : 400,
        color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
        whiteSpace: 'nowrap',
        transition: 'color 120ms ease, border-color 120ms ease',
      }}
    >
      {/* Status dot */}
      {dotColor && (
        <span
          style={{
            display: 'inline-block',
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: dotColor,
            flexShrink: 0,
            animation: isRunning ? 'repo-tab-pulse 1.5s ease-in-out infinite' : 'none',
          }}
        />
      )}

      <span>{label}</span>

      {/* Cost */}
      {cost != null && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-muted)',
          }}
        >
          ${cost.toFixed(2)}
        </span>
      )}
    </button>
  );
}

export default RepoTabs;
