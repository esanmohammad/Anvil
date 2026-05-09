import { PRBoard } from './PRBoard.js';
import { Skeleton } from '../common/Skeleton.js';
import type { PRData } from './usePRData.js';

export interface PRBoardContainerProps {
  prs: PRData[];
  loading: boolean;
  onPRClick?: (pr: PRData) => void;
}

// Mirrors the column set rendered by PRBoard so the skeleton matches the
// real layout (header rule, count pill, stack of cards) and there's no
// layout shift when the data lands.
const SKELETON_COLUMNS: Array<{ label: string; color: string; cards: number }> = [
  { label: 'Open', color: 'var(--accent)', cards: 3 },
  { label: 'In Review', color: 'var(--color-warning)', cards: 2 },
  { label: 'Merged', color: 'var(--color-success)', cards: 4 },
];

function PRCardSkeleton() {
  return (
    <div style={{
      padding: 'var(--space-md)',
      background: 'var(--bg-elevated-2)',
      border: '1px solid var(--separator)',
      borderRadius: 'var(--radius-md)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <Skeleton height={13} width="80%" />
      <div style={{ display: 'flex', gap: 6 }}>
        <Skeleton height={16} width={48} radius="--radius-full" />
        <Skeleton height={16} width={62} radius="--radius-full" />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
        <Skeleton height={11} width="40%" />
        <Skeleton height={11} width="22%" />
      </div>
    </div>
  );
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
          display: 'grid',
          gridTemplateColumns: `repeat(${SKELETON_COLUMNS.length}, 1fr)`,
          gap: 'var(--space-md)',
          flex: 1, minHeight: 0,
        }}>
          {SKELETON_COLUMNS.map((col) => (
            <div key={col.label} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
                marginBottom: 'var(--space-sm)', paddingBottom: 'var(--space-sm)',
                borderBottom: `2px solid ${col.color}`,
              }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)' }}>{col.label}</h3>
                <Skeleton height={14} width={20} radius="--radius-full" />
              </div>
              <div style={{
                flex: 1, overflow: 'hidden',
                display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)',
              }}>
                {Array.from({ length: col.cards }, (_, i) => <PRCardSkeleton key={i} />)}
              </div>
            </div>
          ))}
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
