/**
 * PolishDisclosure — collapsible "polish suggestions" list under a verdict.
 * Hidden by default; user opts in to see low-severity / demoted findings.
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';

interface PolishItem {
  id?: string;
  message?: string;
  filePath?: string;
  lineNumber?: number;
  personaId?: string;
}

export function PolishDisclosure({ polish }: { polish: unknown[] }): JSX.Element | null {
  const items = polish.filter((p): p is PolishItem => !!p && typeof p === 'object');
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div style={{
      marginTop: 12,
      border: '1px dashed var(--separator)',
      borderRadius: 'var(--radius-sm)',
      background: 'var(--bg-elevated-1)',
      overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        style={{
          width: '100%',
          padding: '8px 12px',
          background: 'transparent',
          border: 'none',
          color: 'var(--text-secondary)',
          fontSize: 12,
          fontFamily: 'var(--font-sans)',
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Sparkles size={12} aria-hidden="true" />
        <span>{open ? 'Hide' : 'Show'} {items.length} polish suggestion{items.length === 1 ? '' : 's'}</span>
      </button>
      {open && (
        <ul style={{
          margin: 0,
          padding: '4px 12px 10px 36px',
          fontSize: 12,
          color: 'var(--text-tertiary)',
          listStyle: 'disc',
        }}>
          {items.map((item, idx) => {
            const id = item.id ?? `polish-${idx}`;
            const where = item.filePath
              ? `${item.filePath}${item.lineNumber ? `:${item.lineNumber}` : ''}`
              : null;
            return (
              <li key={id} style={{ marginBottom: 4 }}>
                {item.message ?? 'Polish suggestion'}
                {where && <span style={{ marginLeft: 6, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>({where})</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
