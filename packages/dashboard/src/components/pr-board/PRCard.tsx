import React from 'react';
import type { PRData } from './usePRData.js';

export interface PRCardProps {
  pr: PRData;
  onClick?: (pr: PRData) => void;
}

const LABEL_COLORS: Record<string, { bg: string; fg: string }> = {
  bug: { bg: 'rgba(248,81,73,0.15)', fg: '#f85149' },
  enhancement: { bg: 'rgba(52,211,153,0.15)', fg: '#34d399' },
  anvil: { bg: 'rgba(136,85,255,0.15)', fg: '#8855ff' },
  spike: { bg: 'rgba(251,191,36,0.15)', fg: '#fbbf24' },
  review: { bg: 'rgba(96,165,250,0.15)', fg: '#60a5fa' },
};

function labelColor(label: string): { bg: string; fg: string } {
  return LABEL_COLORS[label.toLowerCase()] ?? { bg: 'var(--bg-elevated-3)', fg: 'var(--text-secondary)' };
}

export function PRCard({ pr, onClick }: PRCardProps) {
  const age = Math.round((Date.now() - pr.createdAt) / (1000 * 60 * 60));
  const ageLabel = age < 24 ? `${age}h ago` : `${Math.round(age / 24)}d ago`;

  return (
    <div
      className="card"
      style={{
        padding: '12px 14px',
        cursor: onClick ? 'pointer' : undefined,
      }}
      onClick={() => onClick?.(pr)}
    >
      <div style={{
        fontSize: 13, fontWeight: 500, marginBottom: 6,
        color: 'var(--text-primary)', lineHeight: 1.4,
      }}>
        {pr.title}
      </div>
      {pr.labels && pr.labels.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
          {pr.labels.map((label) => (
            <span key={label} style={{
              fontSize: 10, fontWeight: 500,
              padding: '1px 7px', borderRadius: 'var(--radius-full)',
              background: labelColor(label).bg,
              color: labelColor(label).fg,
            }}>
              {label}
            </span>
          ))}
        </div>
      )}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
        flexWrap: 'wrap',
      }}>
        <span style={{
          fontSize: 11, color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono)',
          padding: '1px 6px', borderRadius: 'var(--radius-xs)',
          background: 'var(--bg-elevated-3)',
        }}>
          {pr.repo}
        </span>
        <span style={{ fontSize: 11, color: 'var(--color-success)' }}>+{pr.additions}</span>
        <span style={{ fontSize: 11, color: 'var(--color-error)' }}>-{pr.deletions}</span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>{ageLabel}</span>
      </div>
    </div>
  );
}

export default PRCard;
