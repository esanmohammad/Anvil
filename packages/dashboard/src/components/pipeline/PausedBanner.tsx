// Top-of-run-view banner that appears when the current run is paused
// awaiting user approval. Compact: stage + reason + countdown + two
// buttons. Clicking "Review" opens the heavyweight PlanReviewModal;
// "Cancel" sends a confirm-then-reject-cancel.

import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { PausedRunData } from './pipeline-ui-types.js';

export interface PausedBannerProps {
  data: PausedRunData;
  onReview: () => void;
  onCancel: () => void;
}

function remainingText(iso?: string): string | null {
  if (!iso) return null;
  const until = new Date(iso).getTime();
  if (isNaN(until)) return null;
  const diff = until - Date.now();
  if (diff <= 0) return 'expired';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

export function PausedBanner({ data, onReview, onCancel }: PausedBannerProps) {
  const { pause } = data;

  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!pause.timeoutAt) return;
    const id = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [pause.timeoutAt]);

  const remaining = remainingText(pause.timeoutAt);
  const matched = pause.matchedRules?.[0];

  return (
    <>
      <style>{`
        @keyframes anvil-banner-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(212, 162, 74, 0.0); }
          50%      { box-shadow: 0 0 0 2px rgba(212, 162, 74, 0.25); }
        }
      `}</style>
      <div
        role="status"
        aria-live="polite"
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '10px 16px',
          margin: '8px 16px',
          background: 'rgba(212, 162, 74, 0.08)',
          border: '1px solid var(--color-warning)',
          borderRadius: 'var(--radius-md)',
          fontFamily: 'var(--font-sans)',
          animation: 'anvil-banner-pulse 2.4s ease-in-out infinite',
        }}
      >
        <AlertTriangle size={18} color="var(--color-warning)" strokeWidth={2} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}>
            Paused at <span style={{ textTransform: 'capitalize' }}>{pause.stage}</span> — awaiting approval
          </div>
          <div style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            marginTop: 2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {pause.reason}
            {matched ? <span style={{ color: 'var(--text-tertiary)' }}> · {matched}</span> : null}
            {remaining ? <span style={{ color: 'var(--text-tertiary)' }}> · timeout {remaining}</span> : null}
            {' · '}
            <a
              href={`#/policy${pause.project ? `?project=${encodeURIComponent(pause.project)}` : ''}`}
              style={{ color: 'var(--text-tertiary)', textDecoration: 'underline' }}
              title="Manage when Anvil pauses runs"
            >
              Why am I seeing this?
            </a>
          </div>
        </div>

        <button
          onClick={onReview}
          className="btn btn-primary btn-sm"
          style={{ flexShrink: 0 }}
        >
          Review
        </button>
        <button
          onClick={() => {
            if (window.confirm('Cancel this paused run? The pipeline will stop and cannot be resumed.')) {
              onCancel();
            }
          }}
          className="btn btn-ghost btn-sm"
          style={{ flexShrink: 0, color: 'var(--text-secondary)' }}
        >
          Cancel
        </button>
      </div>
    </>
  );
}

export default PausedBanner;
