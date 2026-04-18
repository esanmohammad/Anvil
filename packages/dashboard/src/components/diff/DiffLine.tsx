import React from 'react';
import type { DiffLineData } from './parseDiff.js';

export interface DiffLineProps {
  line: DiffLineData;
  showSplit?: boolean;
}

const bgColors: Record<DiffLineData['type'], string> = {
  add: 'rgba(0, 178, 137, 0.1)',
  delete: 'rgba(255, 73, 73, 0.1)',
  context: 'transparent',
};

const prefixColors: Record<DiffLineData['type'], string> = {
  add: 'var(--color-success)',
  delete: 'var(--color-error)',
  context: 'var(--text-muted)',
};

const prefixChars: Record<DiffLineData['type'], string> = {
  add: '+',
  delete: '-',
  context: ' ',
};

export function DiffLine({ line }: DiffLineProps) {
  return (
    <div
      className="diff-line"
      style={{
        display: 'flex',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        lineHeight: '20px',
        background: bgColors[line.type],
      }}
    >
      <span style={{ width: 50, textAlign: 'right', padding: '0 8px', color: 'var(--text-muted)', userSelect: 'none', flexShrink: 0 }}>
        {line.oldLineNumber ?? ''}
      </span>
      <span style={{ width: 50, textAlign: 'right', padding: '0 8px', color: 'var(--text-muted)', userSelect: 'none', flexShrink: 0 }}>
        {line.newLineNumber ?? ''}
      </span>
      <span style={{ width: 16, textAlign: 'center', color: prefixColors[line.type], userSelect: 'none', flexShrink: 0 }}>
        {prefixChars[line.type]}
      </span>
      <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all', padding: '0 4px' }}>
        {line.content}
      </span>
    </div>
  );
}

export default DiffLine;
