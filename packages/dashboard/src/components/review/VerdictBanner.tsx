/**
 * VerdictBanner — Review Phase R9.
 *
 * Full-width card mounted at the top of the Review page that surfaces the
 * single synthesized verdict for the current review: approve / needs-changes /
 * blocker. Shows a big semantic icon, the headline from the synthesizer, and
 * a one-line subline with a severity breakdown. Clicking the card scrolls
 * (or calls the provided callback) to the findings list below.
 *
 * Loading state renders a subtle pulsing gray skeleton. The null state is a
 * quiet "Run review to see verdict" nudge so the banner does not scream when
 * nothing has been computed yet.
 *
 * No third-party deps beyond `lucide-react` (already used across the review
 * components). Inline style objects + CSS vars only.
 */

import React from 'react';
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────

type VerdictLevel = 'approve' | 'needs-changes' | 'blocker';

interface VerdictSummary {
  totalFindings: number;
  bySeverity: Record<string, number>;
  byPersona: Record<string, number>;
}

interface ReviewVerdictShape {
  level: VerdictLevel;
  headline: string;
  blockers: unknown[];
  mainFindings: unknown[];
  polish: unknown[];
  computedAt: string;
  immutableBlockerCount: number;
  summary: VerdictSummary;
}

export interface VerdictBannerProps {
  verdict: ReviewVerdictShape | null;
  loading?: boolean;
  onReview?: () => void;
}

// ── Theming ──────────────────────────────────────────────────────────────

interface LevelTheme {
  bg: string;
  border: string;
  accent: string;
  iconColor: string;
  Icon: React.ComponentType<{ size?: number; color?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
}

const THEMES: Record<VerdictLevel, LevelTheme> = {
  approve: {
    bg: 'color-mix(in srgb, var(--color-success, #22c55e) 10%, var(--bg-elevated-2, #1e1e22))',
    border: 'var(--color-success, #22c55e)',
    accent: 'var(--color-success, #22c55e)',
    iconColor: 'var(--color-success, #22c55e)',
    Icon: CheckCircle2,
  },
  'needs-changes': {
    bg: 'color-mix(in srgb, var(--color-warning, #f59e0b) 10%, var(--bg-elevated-2, #1e1e22))',
    border: 'var(--color-warning, #f59e0b)',
    accent: 'var(--color-warning, #f59e0b)',
    iconColor: 'var(--color-warning, #f59e0b)',
    Icon: AlertTriangle,
  },
  blocker: {
    bg: 'color-mix(in srgb, var(--color-error, #ef4444) 12%, var(--bg-elevated-2, #1e1e22))',
    border: 'var(--color-error, #ef4444)',
    accent: 'var(--color-error, #ef4444)',
    iconColor: 'var(--color-error, #ef4444)',
    Icon: XCircle,
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────

function formatSubline(summary: VerdictSummary): string {
  if (summary.totalFindings === 0) {
    return 'No findings.';
  }
  const order: Array<[string, string]> = [
    ['blocker', 'blocker'],
    ['high', 'high'],
    ['medium', 'medium'],
    ['low', 'low'],
    ['info', 'info'],
  ];
  const parts: string[] = [];
  for (const [key, label] of order) {
    const n = summary.bySeverity[key];
    if (typeof n === 'number' && n > 0) {
      parts.push(`${n} ${label}`);
    }
  }
  const total = summary.totalFindings;
  if (parts.length === 0) {
    return `${total} finding${total === 1 ? '' : 's'}.`;
  }
  return `${total} finding${total === 1 ? '' : 's'} — ${parts.join(', ')}.`;
}

function scrollToFindings() {
  if (typeof document === 'undefined') return;
  const target =
    document.getElementById('review-findings-list') ??
    document.querySelector('[data-review-findings]');
  if (target && target instanceof HTMLElement) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// ── Subcomponents ────────────────────────────────────────────────────────

function SkeletonBanner() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      style={{
        width: '100%',
        padding: '20px 24px',
        borderRadius: 'var(--radius-md, 10px)',
        background: 'var(--bg-elevated-2, #1e1e22)',
        border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        animation: 'pulse 1.6s ease-in-out infinite',
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          background: 'var(--bg-elevated-3, rgba(255,255,255,0.06))',
        }}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div
          style={{
            height: 16,
            width: '40%',
            borderRadius: 4,
            background: 'var(--bg-elevated-3, rgba(255,255,255,0.06))',
          }}
        />
        <div
          style={{
            height: 12,
            width: '65%',
            borderRadius: 4,
            background: 'var(--bg-elevated-3, rgba(255,255,255,0.06))',
          }}
        />
      </div>
    </div>
  );
}

function NullStateBanner() {
  return (
    <div
      role="status"
      style={{
        width: '100%',
        padding: '16px 20px',
        borderRadius: 'var(--radius-md, 10px)',
        background: 'var(--bg-elevated-2, #1e1e22)',
        border: '1px dashed var(--border-subtle, rgba(255,255,255,0.12))',
        color: 'var(--text-tertiary, rgba(255,255,255,0.55))',
        fontSize: 13,
      }}
    >
      Run review to see verdict.
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────

export function VerdictBanner({ verdict, loading, onReview }: VerdictBannerProps): React.ReactElement {
  if (loading) return <SkeletonBanner />;
  if (!verdict) return <NullStateBanner />;

  const theme = THEMES[verdict.level];
  const Icon = theme.Icon;
  const subline = formatSubline(verdict.summary);

  const handleClick = () => {
    if (onReview) {
      onReview();
    } else {
      scrollToFindings();
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKey}
      aria-label={`Review verdict: ${verdict.headline}. Click to jump to findings.`}
      style={{
        width: '100%',
        padding: '20px 24px',
        borderRadius: 'var(--radius-md, 10px)',
        background: theme.bg,
        border: `1px solid ${theme.border}`,
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        cursor: 'pointer',
        transition: 'transform 120ms ease, box-shadow 120ms ease',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        color: 'var(--text-primary, #f1f1f3)',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget).style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget).style.boxShadow = '0 1px 2px rgba(0,0,0,0.2)';
      }}
    >
      <Icon size={36} color={theme.iconColor} aria-hidden="true" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 18,
            fontWeight: 600,
            lineHeight: 1.25,
            color: 'var(--text-primary, #f1f1f3)',
          }}
        >
          {verdict.headline}
        </div>
        <div
          style={{
            marginTop: 6,
            fontSize: 13,
            color: 'var(--text-secondary, rgba(255,255,255,0.7))',
          }}
        >
          {subline}
          {verdict.immutableBlockerCount > 0 ? (
            <span
              style={{
                marginLeft: 8,
                padding: '2px 8px',
                borderRadius: 'var(--radius-md, 10px)',
                background: 'rgba(0,0,0,0.25)',
                color: theme.accent,
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 0.3,
                textTransform: 'uppercase',
              }}
            >
              {verdict.immutableBlockerCount} immutable
            </span>
          ) : null}
        </div>
      </div>
      <div
        aria-hidden="true"
        style={{
          fontSize: 12,
          color: 'var(--text-tertiary, rgba(255,255,255,0.55))',
          whiteSpace: 'nowrap',
        }}
      >
        View findings ↓
      </div>
    </div>
  );
}

export default VerdictBanner;
