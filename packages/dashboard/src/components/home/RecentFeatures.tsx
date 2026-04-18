import React from 'react';
import { CheckCircle2, XCircle, Clock } from 'lucide-react';

export interface RecentFeaturesProps {
  features: Array<{
    slug: string;
    project: string;
    description: string;
    status: string;
    totalCost: number;
    updatedAt: string;
  }>;
  onResume?: (project: string, slug: string) => void;
}

const statusConfig: Record<string, { color: string; Icon: React.ComponentType<{ size?: number; strokeWidth?: number; style?: React.CSSProperties }> }> = {
  'in-progress': { color: 'var(--color-warning)', Icon: Clock },
  completed: { color: 'var(--color-success)', Icon: CheckCircle2 },
  failed: { color: 'var(--color-error)', Icon: XCircle },
};

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function RecentFeatures({ features, onResume }: RecentFeaturesProps) {
  if (features.length === 0) {
    return (
      <div style={{
        color: 'var(--text-tertiary)',
        fontSize: 13,
        padding: '24px 0',
        textAlign: 'center',
      }}>
        Your feature history will build up here over time.
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      gap: 10,
      overflowX: 'auto',
      paddingBottom: 8,
      scrollbarWidth: 'thin',
    }}>
      {features.map((f) => {
        const cfg = statusConfig[f.status] ?? { color: 'var(--text-tertiary)', Icon: Clock };
        const StatusIcon = cfg.Icon;
        const isInProgress = f.status === 'in-progress';

        return (
          <button
            type="button"
            key={`${f.project}-${f.slug}`}
            onClick={() => onResume?.(f.project, f.slug)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              minWidth: 200,
              maxWidth: 240,
              padding: 14,
              background: 'var(--bg-elevated-2)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-md)',
              cursor: onResume ? 'pointer' : 'default',
              textAlign: 'left',
              fontFamily: 'var(--font-sans)',
              flexShrink: 0,
              transition: 'all var(--duration-fast) var(--ease-default)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = 'var(--shadow-md)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            {/* Top: status + time */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <StatusIcon
                  size={14}
                  strokeWidth={1.75}
                  style={{
                    color: cfg.color,
                    ...(isInProgress ? { animation: 'pulse 2s ease-in-out infinite' } : {}),
                  }}
                />
                <span style={{ fontSize: 11, color: cfg.color, textTransform: 'capitalize' as const }}>
                  {f.status.replace('-', ' ')}
                </span>
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                {relativeTime(f.updatedAt)}
              </span>
            </div>

            {/* Name */}
            <span style={{
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {f.slug.replace(/-/g, ' ')}
            </span>

            {/* Bottom: project + cost */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{
                fontSize: 11,
                color: 'var(--text-tertiary)',
                padding: '1px 6px',
                borderRadius: 'var(--radius-xs)',
                background: 'var(--bg-elevated-3)',
              }}>
                {f.project}
              </span>
              {f.totalCost > 0 && (
                <span style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-tertiary)',
                }}>
                  ${f.totalCost.toFixed(2)}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export default RecentFeatures;
