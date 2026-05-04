import React from 'react';
import { CheckCircle2, AlertCircle, MessageCircle } from 'lucide-react';
import type { PRData, PRReviewSummary } from './usePRData.js';

export interface PRCardProps {
  pr: PRData;
  onClick?: (pr: PRData) => void;
}

const LABEL_COLORS: Record<string, { bg: string; fg: string }> = {
  bug: { bg: 'rgba(201,115,115,0.15)', fg: 'var(--color-error)' },
  enhancement: { bg: 'var(--accent-muted)', fg: 'var(--accent)' },
  anvil: { bg: 'rgba(136,85,255,0.15)', fg: '#8855ff' },
  spike: { bg: 'rgba(212,162,74,0.15)', fg: 'var(--color-warning)' },
  review: { bg: 'rgba(107,138,171,0.15)', fg: 'var(--color-info)' },
};

function labelColor(label: string): { bg: string; fg: string } {
  return LABEL_COLORS[label.toLowerCase()] ?? { bg: 'var(--bg-elevated-3)', fg: 'var(--text-secondary)' };
}

/* ─── Review verdict badge ─────────────────────────────────── */

interface ReviewBadgeProps {
  review: PRReviewSummary | null | undefined;
}

function ReviewBadge({ review }: ReviewBadgeProps) {
  // Pending review: muted grey "— not reviewed" with no icon
  if (!review) {
    return (
      <span
        aria-label="Not reviewed yet"
        style={{
          fontSize: 10,
          fontWeight: 500,
          padding: '1px 7px',
          borderRadius: 'var(--radius-full)',
          background: 'var(--bg-elevated-3)',
          color: 'var(--text-tertiary)',
          fontStyle: 'italic',
        }}
      >
        — not reviewed
      </span>
    );
  }

  const { verdict, blockers, errors, summary, reviewId } = review;

  let icon: React.ReactNode = null;
  let label = '';
  let color: string = 'var(--text-tertiary)';
  let ariaLabel = '';

  if (verdict === 'approve') {
    color = 'var(--color-success)';
    icon = <CheckCircle2 size={10} strokeWidth={2} aria-hidden="true" style={{ color }} />;
    label = 'Approved';
    ariaLabel = `Review: approved. ${summary}`;
  } else if (verdict === 'request-changes') {
    color = 'var(--color-error)';
    icon = <AlertCircle size={10} strokeWidth={2} aria-hidden="true" style={{ color }} />;
    const issueCount = (blockers ?? 0) + (errors ?? 0);
    label = `${issueCount} issue${issueCount === 1 ? '' : 's'}`;
    ariaLabel = `Review: changes requested. ${issueCount} issue${issueCount === 1 ? '' : 's'}. ${summary}`;
  } else {
    // comment
    color = 'var(--color-warning)';
    icon = <MessageCircle size={10} strokeWidth={2} aria-hidden="true" style={{ color }} />;
    label = 'Comments';
    ariaLabel = `Review: comments. ${summary}`;
  }

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    window.location.hash = `#/review?reviewId=${encodeURIComponent(reviewId)}`;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      window.location.hash = `/review?reviewId=${encodeURIComponent(reviewId)}`;
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      title={summary}
      aria-label={ariaLabel}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 10,
        fontWeight: 500,
        padding: '1px 7px',
        borderRadius: 'var(--radius-full)',
        background: 'var(--bg-elevated-3)',
        color,
        border: '1px solid var(--separator)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        lineHeight: 1.4,
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
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
      <div style={{
        display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6,
        alignItems: 'center',
      }}>
        {pr.labels?.map((label) => (
          <span key={label} style={{
            fontSize: 10, fontWeight: 500,
            padding: '1px 7px', borderRadius: 'var(--radius-full)',
            background: labelColor(label).bg,
            color: labelColor(label).fg,
          }}>
            {label}
          </span>
        ))}
        <ReviewBadge review={pr.review} />
      </div>
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
