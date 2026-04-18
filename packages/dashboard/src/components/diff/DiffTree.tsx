import React from 'react';
import { Badge } from '../ui/Badge.js';
import type { DiffFile } from './parseDiff.js';

export interface DiffTreeProps {
  files: DiffFile[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
}

const statusVariant: Record<DiffFile['status'], 'success' | 'error' | 'primary' | 'warning'> = {
  added: 'success',
  deleted: 'error',
  modified: 'primary',
  renamed: 'warning',
};

const statusLabel: Record<DiffFile['status'], string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
};

export function DiffTree({ files, selectedFile, onSelectFile }: DiffTreeProps) {
  return (
    <div className="diff-tree" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {files.map((file) => (
        <button
          key={file.newPath}
          onClick={() => onSelectFile(file.newPath)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-sm)',
            padding: 'var(--space-xs) var(--space-sm)',
            background: selectedFile === file.newPath ? 'var(--bg-hover)' : 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            color: 'var(--text-primary)',
            fontSize: 'var(--text-xs)',
            fontFamily: 'var(--font-mono)',
            textAlign: 'left',
            width: '100%',
          }}
        >
          <Badge variant={statusVariant[file.status]}>{statusLabel[file.status]}</Badge>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {file.newPath}
          </span>
          <span style={{ color: 'var(--color-success)', fontSize: 'var(--text-xs)' }}>+{file.additions}</span>
          <span style={{ color: 'var(--color-error)', fontSize: 'var(--text-xs)' }}>-{file.deletions}</span>
        </button>
      ))}
    </div>
  );
}

export default DiffTree;
