import React, { useState, useMemo } from 'react';
import { DiffTree } from './DiffTree.js';
import { DiffViewer } from './DiffViewer.js';
import { DiffStats } from './DiffStats.js';
import { FixIterationOverlay } from './FixIterationOverlay.js';
import { parseDiff } from './parseDiff.js';
import type { FixIteration } from './FixIterationOverlay.js';

export interface DiffContainerProps {
  diffText: string;
  iterations?: FixIteration[];
}

export function DiffContainer({ diffText, iterations = [] }: DiffContainerProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [currentIteration, setCurrentIteration] = useState<string | null>(null);

  const files = useMemo(() => parseDiff(diffText), [diffText]);
  const activeFile = files.find((f) => f.newPath === selectedFile) ?? files[0] ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-sm)' }}>
        <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 600 }}>Diff Viewer</h2>
        <DiffStats files={files} />
      </div>

      {iterations.length > 0 && (
        <FixIterationOverlay
          iterations={iterations}
          currentIteration={currentIteration}
          onSelectIteration={setCurrentIteration}
        />
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 'var(--space-sm)' }}>
        <div style={{ width: 280, overflow: 'auto', borderRight: '1px solid var(--border-default)', paddingRight: 'var(--space-sm)' }}>
          <DiffTree files={files} selectedFile={selectedFile} onSelectFile={setSelectedFile} />
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {activeFile ? (
            <DiffViewer file={activeFile} />
          ) : (
            <div style={{ padding: 'var(--space-lg)', color: 'var(--text-muted)', textAlign: 'center' }}>
              No diff to display
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default DiffContainer;
