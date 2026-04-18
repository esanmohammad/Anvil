import React from 'react';

export interface RepoBreadcrumbsProps {
  repo: string | null;
  stage: string | null;
  onSelectRepo: (repo: string | null) => void;
  onSelectStage: (stage: string | null) => void;
  availableRepos: string[];
  availableStages: string[];
}

export function RepoBreadcrumbs({ repo, stage, onSelectRepo, onSelectStage, availableRepos, availableStages }: RepoBreadcrumbsProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', fontSize: 'var(--text-sm)' }}>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => { onSelectRepo(null); onSelectStage(null); }}
        style={{ color: !repo ? 'var(--color-accent)' : 'var(--text-secondary)' }}
      >
        All
      </button>
      {availableRepos.length > 0 && (
        <>
          <span style={{ color: 'var(--text-muted)' }}>/</span>
          <select
            className="input"
            value={repo ?? ''}
            onChange={(e) => { onSelectRepo(e.target.value || null); onSelectStage(null); }}
            style={{ width: 'auto', minWidth: 120, padding: '2px 8px' }}
          >
            <option value="">All repos</option>
            {availableRepos.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </>
      )}
      {repo && availableStages.length > 0 && (
        <>
          <span style={{ color: 'var(--text-muted)' }}>/</span>
          <select
            className="input"
            value={stage ?? ''}
            onChange={(e) => onSelectStage(e.target.value || null)}
            style={{ width: 'auto', minWidth: 100, padding: '2px 8px' }}
          >
            <option value="">All stages</option>
            {availableStages.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </>
      )}
    </div>
  );
}

export default RepoBreadcrumbs;
