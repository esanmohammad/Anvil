import React, { useState } from 'react';
import { DiffLine } from './DiffLine.js';
import type { DiffFile } from './parseDiff.js';

export type DiffViewMode = 'unified' | 'split';

export interface DiffViewerProps {
  file: DiffFile;
  mode?: DiffViewMode;
}

export function DiffViewer({ file, mode: initialMode = 'unified' }: DiffViewerProps) {
  const [mode, setMode] = useState<DiffViewMode>(initialMode);

  return (
    <div className="diff-viewer">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'var(--space-sm)', borderBottom: '1px solid var(--border-default)' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
          {file.newPath}
        </span>
        <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
          <button
            className={`btn btn-sm ${mode === 'unified' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setMode('unified')}
          >
            Unified
          </button>
          <button
            className={`btn btn-sm ${mode === 'split' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setMode('split')}
          >
            Split
          </button>
        </div>
      </div>
      <div style={{ overflow: 'auto' }}>
        {mode === 'unified' ? (
          file.hunks.map((hunk, hi) => (
            <div key={hi}>
              <div style={{ padding: '4px var(--space-sm)', background: 'var(--bg-hover)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@ {hunk.header}
              </div>
              {hunk.lines.map((line, li) => (
                <DiffLine key={li} line={line} />
              ))}
            </div>
          ))
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
            {file.hunks.map((hunk, hi) => (
              <React.Fragment key={hi}>
                <div>
                  {hunk.lines.filter((l) => l.type !== 'add').map((line, li) => (
                    <DiffLine key={li} line={line} />
                  ))}
                </div>
                <div style={{ borderLeft: '1px solid var(--border-default)' }}>
                  {hunk.lines.filter((l) => l.type !== 'delete').map((line, li) => (
                    <DiffLine key={li} line={line} />
                  ))}
                </div>
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default DiffViewer;
