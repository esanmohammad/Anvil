/**
 * PatchApplier — modal that previews a proposed patch and applies it via WS.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { GitCommit, PlayCircle, X, FileDiff } from 'lucide-react';

export interface ApplyPatchResult {
  applied: boolean;
  commitSha?: string;
  testsPassed?: boolean;
  error?: string;
}

interface PatchApplierProps {
  ws: WebSocket | null;
  project: string | null;
  findingId: string;
  proposedPatch: string;
  targetFile: string;
  onApply: (result: ApplyPatchResult) => void;
  onClose: () => void;
}

function colorizeDiff(patch: string): React.ReactNode[] {
  return patch.split('\n').map((line, idx) => {
    let color = 'var(--text-secondary)';
    if (line.startsWith('+') && !line.startsWith('+++')) color = 'var(--color-success)';
    else if (line.startsWith('-') && !line.startsWith('---')) color = 'var(--color-error)';
    else if (line.startsWith('@@')) color = 'var(--accent)';
    return (
      <div key={idx} style={{ color, fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'pre' }}>
        {line || ' '}
      </div>
    );
  });
}

export function PatchApplier({
  ws, project, findingId, proposedPatch, targetFile, onApply, onClose,
}: PatchApplierProps): JSX.Element {
  const [runTests, setRunTests] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent): void => {
      let msg: { type?: string; payload?: { findingId?: string; result?: ApplyPatchResult; message?: string } };
      try { msg = JSON.parse(event.data as string); } catch { return; }
      if (msg.payload?.findingId !== findingId) return;
      if (msg.type === 'review-patch-applied' && msg.payload.result) {
        setApplying(() => false);
        onApply(msg.payload.result);
      } else if (msg.type === 'review-patch-error') {
        setApplying(() => false);
        setError(() => msg.payload?.message ?? 'patch failed');
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, findingId, onApply]);

  const apply = useCallback(() => {
    if (!ws || !project) return;
    setApplying(() => true);
    setError(() => null);
    ws.send(JSON.stringify({
      action: 'apply-review-patch',
      project, findingId, proposedPatch, runTests,
    }));
  }, [ws, project, findingId, proposedPatch, runTests]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        width: 'min(720px, 92vw)', maxHeight: '85vh',
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <header style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--separator)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <FileDiff size={16} aria-hidden="true" />
          <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-sans)' }}>Apply patch</span>
          <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>{targetFile}</span>
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </header>
        <div style={{ flex: 1, overflow: 'auto', padding: 12, background: 'var(--bg-base)' }}>
          {colorizeDiff(proposedPatch)}
        </div>
        {error && (
          <div style={{ padding: '8px 16px', background: 'rgba(201,115,115,0.12)', color: 'var(--color-error)', fontSize: 12 }}>
            {error}
          </div>
        )}
        <footer style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--separator)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={runTests} onChange={(e) => setRunTests(() => e.target.checked)} />
            <PlayCircle size={12} aria-hidden="true" />
            Run tests before committing
          </label>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} disabled={applying} style={{
            padding: '6px 12px', borderRadius: 'var(--radius-sm)', fontSize: 12,
            background: 'transparent', border: '1px solid var(--separator)',
            color: 'var(--text-secondary)', cursor: applying ? 'not-allowed' : 'pointer',
          }}>Cancel</button>
          <button type="button" onClick={apply} disabled={applying} style={{
            padding: '6px 14px', borderRadius: 'var(--radius-sm)', fontSize: 12, fontWeight: 600,
            background: 'var(--accent)', color: 'var(--text-inverse)',
            border: 'none', cursor: applying ? 'not-allowed' : 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            <GitCommit size={12} aria-hidden="true" />
            {applying ? 'Applying…' : 'Apply + commit'}
          </button>
        </footer>
      </div>
    </div>
  );
}
