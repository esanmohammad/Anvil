import React from 'react';
import type { DiffFile } from './parseDiff.js';
import { getDiffStats } from './parseDiff.js';

export interface DiffStatsProps {
  files: DiffFile[];
}

export function DiffStats({ files }: DiffStatsProps) {
  const stats = getDiffStats(files);

  return (
    <div style={{ display: 'flex', gap: 'var(--space-md)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
      <span>{stats.filesChanged} file{stats.filesChanged !== 1 ? 's' : ''} changed</span>
      <span style={{ color: 'var(--color-success)' }}>+{stats.totalAdditions}</span>
      <span style={{ color: 'var(--color-error)' }}>-{stats.totalDeletions}</span>
    </div>
  );
}

export default DiffStats;
