import React from 'react';
import { Badge } from '../ui/Badge.js';

export interface RepoBreakdown {
  name: string;
  status: 'ready' | 'busy' | 'error' | 'done';
  currentStage?: string;
  progress?: number;
}

export interface RepoBreakdownListProps {
  repos: RepoBreakdown[];
  expandedRepos: Set<string>;
  onToggleRepo: (repo: string) => void;
}

const statusVariant: Record<string, 'primary' | 'success' | 'error' | 'warning' | 'neutral'> = {
  ready: 'neutral',
  busy: 'primary',
  error: 'error',
  done: 'success',
};

export function RepoBreakdownList({ repos, expandedRepos, onToggleRepo }: RepoBreakdownListProps) {
  return (
    <div className="repo-breakdown" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
      {repos.map((repo) => (
        <div key={repo.name} className="card" style={{ padding: 'var(--space-sm) var(--space-md)' }}>
          <button
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', width: '100%', background: 'none', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 'var(--text-sm)' }}
            onClick={() => onToggleRepo(repo.name)}
          >
            <span>{expandedRepos.has(repo.name) ? '\u25BC' : '\u25B6'}</span>
            <span style={{ flex: 1, textAlign: 'left', fontFamily: 'var(--font-mono)' }}>{repo.name}</span>
            <Badge variant={statusVariant[repo.status] ?? 'neutral'}>{repo.status}</Badge>
          </button>
          {expandedRepos.has(repo.name) && (
            <div style={{ paddingTop: 'var(--space-sm)', paddingLeft: 'var(--space-lg)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
              {repo.currentStage && <div>Stage: {repo.currentStage}</div>}
              {repo.progress != null && <div>Progress: {repo.progress}%</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default RepoBreakdownList;
