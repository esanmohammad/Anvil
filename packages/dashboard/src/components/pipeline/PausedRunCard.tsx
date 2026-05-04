// Compact, pulsing card that surfaces a paused pipeline run in the Active
// Runs list. Clicking "Review" opens the full PlanReviewModal.

import React, { useEffect, useState } from 'react';
import { AlertTriangle, Clock, FileText, ShieldCheck } from 'lucide-react';
import type { PausedRunData, RiskTier } from './pipeline-ui-types.js';

export interface PausedRunCardProps {
  data: PausedRunData;
  onOpenReview: () => void;
}

const tierColors: Record<RiskTier, { color: string; bg: string; label: string }> = {
  low:  { color: 'var(--color-success)', bg: 'rgba(111, 175, 138, 0.12)', label: 'Low' },
  med:  { color: 'var(--color-warning)', bg: 'rgba(212, 162, 74, 0.12)',  label: 'Med' },
  high: { color: 'var(--color-error)',   bg: 'rgba(201, 115, 115, 0.12)', label: 'High' },
};

function remainingText(iso?: string): string | null {
  if (!iso) return null;
  const until = new Date(iso).getTime();
  const diff = until - Date.now();
  if (isNaN(until)) return null;
  if (diff <= 0) return 'expired';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

function firstLine(text: string | undefined, max = 110): string {
  if (!text) return '';
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function PausedRunCard({ data, onOpenReview }: PausedRunCardProps) {
  const { pause, riskScore, planSummary, touchedFiles } = data;

  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!pause.timeoutAt) return;
    const id = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [pause.timeoutAt]);

  const remaining = remainingText(pause.timeoutAt);
  const tier = riskScore ? tierColors[riskScore.tier] : null;
  const RiskIcon = riskScore?.tier === 'low' ? ShieldCheck : AlertTriangle;
  const fileCount = touchedFiles?.length ?? 0;
  const summary = firstLine(planSummary);

  return (
    <>
      <style>{`
        @keyframes anvil-pulse-paused-border {
          0%, 100% { box-shadow: 0 0 0 0 rgba(212, 162, 74, 0.0); }
          50%      { box-shadow: 0 0 0 2px rgba(212, 162, 74, 0.30); }
        }
        @keyframes anvil-pulse-paused-dot {
          0%, 100% { opacity: 1;   transform: scale(1); }
          50%      { opacity: 0.55; transform: scale(1.25); }
        }
      `}</style>

      <article
        className="anvil-pulse-paused"
        aria-label={`Paused run ${pause.runId.slice(0, 8)} at ${pause.stage}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: 12,
          background: 'var(--bg-elevated-2)',
          border: '1px solid var(--color-warning)',
          borderRadius: 'var(--radius-md)',
          fontFamily: 'var(--font-sans)',
          animation: 'anvil-pulse-paused-border 2.4s ease-in-out infinite',
        }}
      >
        {/* Left: stage + paused pill */}
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 4,
          minWidth: 120, flexShrink: 0,
        }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center',
            padding: '2px 8px',
            background: 'var(--bg-elevated-3)',
            borderRadius: 'var(--radius-full)',
            fontSize: 10, fontWeight: 700,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase', letterSpacing: 0.4,
            width: 'fit-content',
          }}>
            {pause.stage}
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 11,
            color: 'var(--color-warning)',
            fontWeight: 600,
          }}>
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 7, height: 7,
                borderRadius: 'var(--radius-full)',
                background: 'var(--color-warning)',
                animation: 'anvil-pulse-paused-dot 1.4s ease-in-out infinite',
              }}
            />
            Paused awaiting user
          </span>
        </div>

        {/* Middle: summary + risk + files */}
        <div style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{
            fontSize: 13,
            color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {summary || <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
              {pause.reason}
            </span>}
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            flexWrap: 'wrap',
          }}>
            {tier && riskScore && (
              <span
                title={`Overall risk ${Math.round(riskScore.overall * 100)}%`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 8px',
                  background: tier.bg,
                  color: tier.color,
                  borderRadius: 'var(--radius-full)',
                  fontSize: 10, fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: 0.3,
                }}
              >
                <RiskIcon size={10} strokeWidth={2} aria-hidden="true" />
                {tier.label} risk
              </span>
            )}
            <span
              title={`${fileCount} file${fileCount !== 1 ? 's' : ''} touched`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 8px',
                background: 'var(--bg-elevated-3)',
                color: 'var(--text-secondary)',
                borderRadius: 'var(--radius-full)',
                fontSize: 10, fontWeight: 600,
                fontFamily: 'var(--font-mono)',
              }}
            >
              <FileText size={10} strokeWidth={1.75} aria-hidden="true" />
              {fileCount} {fileCount === 1 ? 'file' : 'files'}
            </span>
            <span style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)',
            }}>
              run:{pause.runId.slice(0, 8)}
            </span>
          </div>
        </div>

        {/* Right: countdown + review button */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          flexShrink: 0,
        }}>
          {remaining && (
            <span
              title="Time until auto-timeout"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 11,
                color: remaining === 'expired' ? 'var(--color-error)' : 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <Clock size={11} strokeWidth={1.75} aria-hidden="true" />
              {remaining}
            </span>
          )}
          <button
            onClick={onOpenReview}
            aria-label={`Review paused run ${pause.runId.slice(0, 8)}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              height: 30, padding: '0 14px',
              background: 'var(--accent)',
              color: 'var(--text-inverse)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12, fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            Review →
          </button>
        </div>
      </article>
    </>
  );
}

export default PausedRunCard;
