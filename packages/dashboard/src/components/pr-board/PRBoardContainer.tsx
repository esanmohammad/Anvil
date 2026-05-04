import React from 'react';
import { PRBoard } from './PRBoard.js';
import { CardSkeleton } from '../common/Skeleton.js';
import type { PRData } from './usePRData.js';

export interface PRBoardContainerProps {
  prs: PRData[];
  loading: boolean;
  onPRClick?: (pr: PRData) => void;
}

export function PRBoardContainer({ prs, loading, onPRClick }: PRBoardContainerProps) {
  return (
    <div className="page-enter" style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      padding: 'var(--space-lg)',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 'var(--space-md)',
      }}>
        <h2 style={{ fontSize: 22, fontWeight: 600 }}>Pull Requests</h2>
      </div>

      {loading ? (
        <div style={{
          flex: 1, minHeight: 0, overflow: 'auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 'var(--space-md)',
        }}>
          {Array.from({ length: 6 }, (_, i) => <CardSkeleton key={i} lines={3} />)}
        </div>
      ) : prs.length === 0 ? (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-tertiary)', fontSize: 14,
        }}>
          Pull requests will appear here as features are shipped.
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0 }}>
          <PRBoard prs={prs} onPRClick={onPRClick} />
        </div>
      )}
    </div>
  );
}

export default PRBoardContainer;
