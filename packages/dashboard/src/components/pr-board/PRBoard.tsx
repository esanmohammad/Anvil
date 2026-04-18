import React, { useState } from 'react';
import { PRCard } from './PRCard.js';
import type { PRData, PRStatus } from './usePRData.js';

export interface PRBoardProps {
  prs: PRData[];
  onPRClick?: (pr: PRData) => void;
}

const columns: { status: PRStatus; label: string; color: string }[] = [
  { status: 'open', label: 'Open', color: 'var(--accent)' },
  { status: 'in_review', label: 'In Review', color: 'var(--color-warning)' },
  { status: 'merged', label: 'Merged', color: 'var(--color-success)' },
];

const filterStatuses: PRStatus[] = ['draft', 'closed'];

export function PRBoard({ prs, onPRClick }: PRBoardProps) {
  const [showFilter, setShowFilter] = useState<PRStatus | null>(null);

  // Include draft/closed PRs in their logical column when filter active
  const getPRsForColumn = (status: PRStatus): PRData[] => {
    if (status === 'open' && showFilter === 'draft') {
      return prs.filter((p) => p.status === 'open' || p.status === 'draft');
    }
    if (status === 'merged' && showFilter === 'closed') {
      return prs.filter((p) => p.status === 'merged' || p.status === 'closed');
    }
    return prs.filter((p) => p.status === status);
  };

  const draftCount = prs.filter((p) => p.status === 'draft').length;
  const closedCount = prs.filter((p) => p.status === 'closed').length;

  return (
    <div className="page-enter" style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 16 }}>
      {/* Filter toggles for draft/closed */}
      {(draftCount > 0 || closedCount > 0) && (
        <div style={{ display: 'flex', gap: 6, padding: '0 4px' }}>
          {draftCount > 0 && (
            <button
              onClick={() => setShowFilter(showFilter === 'draft' ? null : 'draft')}
              className={`btn btn-sm ${showFilter === 'draft' ? '' : 'btn-ghost'}`}
              style={showFilter === 'draft' ? {
                background: 'var(--bg-elevated-3)', color: 'var(--text-primary)',
              } : {}}
            >
              +{draftCount} Draft
            </button>
          )}
          {closedCount > 0 && (
            <button
              onClick={() => setShowFilter(showFilter === 'closed' ? null : 'closed')}
              className={`btn btn-sm ${showFilter === 'closed' ? '' : 'btn-ghost'}`}
              style={showFilter === 'closed' ? {
                background: 'var(--bg-elevated-3)', color: 'var(--text-primary)',
              } : {}}
            >
              +{closedCount} Closed
            </button>
          )}
        </div>
      )}

      {/* 3-column board */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns.length}, 1fr)`,
        gap: 'var(--space-md)',
        flex: 1,
        minHeight: 0,
      }}>
        {columns.map((col) => {
          const colPRs = getPRsForColumn(col.status);
          return (
            <div key={col.status} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
                marginBottom: 'var(--space-sm)', paddingBottom: 'var(--space-sm)',
                borderBottom: `2px solid ${col.color}`,
              }}>
                <h3 style={{ fontSize: 14, fontWeight: 600 }}>{col.label}</h3>
                <span style={{
                  fontSize: 11, color: 'var(--text-tertiary)',
                  background: 'var(--bg-elevated-3)',
                  padding: '1px 7px', borderRadius: 'var(--radius-full)',
                }}>
                  {colPRs.length}
                </span>
              </div>
              <div className="stagger" style={{
                flex: 1, overflow: 'auto',
                display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)',
              }}>
                {colPRs.map((pr) => (
                  <PRCard key={pr.id} pr={pr} onClick={onPRClick} />
                ))}
                {colPRs.length === 0 && (
                  <div style={{
                    padding: 'var(--space-lg)', textAlign: 'center',
                    color: 'var(--text-tertiary)', fontSize: 13,
                  }}>
                    No PRs
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default PRBoard;
