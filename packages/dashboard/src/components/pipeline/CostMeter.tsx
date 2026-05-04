import React from 'react';

/**
 * Horizontal cost meter for a single run. Renders `X / $Y` as a filled bar
 * with a threshold-driven colour: green under 70%, amber from 70% up to
 * the limit, red at or above the limit (breach). When `projectedUsd` is
 * supplied we also render a forward-looking "ghost" fill to show where
 * spend is trending.
 *
 * The component is presentational — wiring to the modal is handled by the
 * parent view (Active Runs). `onClick` opens the breach modal.
 */

export interface CostMeterProps {
  totalUsd: number;
  limitUsd: number;
  projectedUsd?: number;
  onClick?: () => void;
  /** Compact variant renders a one-line badge suitable for run lists. */
  compact?: boolean;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

type MeterColor = 'green' | 'amber' | 'red';

function colorFor(pct: number): MeterColor {
  if (pct >= 1.0) return 'red';
  if (pct >= 0.7) return 'amber';
  return 'green';
}

const COLOR_VARS: Record<MeterColor, { bar: string; fg: string }> = {
  green: { bar: 'var(--color-success, #22c55e)', fg: 'var(--color-success, #22c55e)' },
  amber: { bar: 'var(--color-warning, #f59e0b)', fg: 'var(--color-warning, #f59e0b)' },
  red: { bar: 'var(--color-danger, #ef4444)', fg: 'var(--color-danger, #ef4444)' },
};

export function CostMeter({
  totalUsd,
  limitUsd,
  projectedUsd,
  onClick,
  compact = false,
}: CostMeterProps): React.ReactElement {
  const safeLimit = limitUsd > 0 ? limitUsd : 1;
  const pct = totalUsd / safeLimit;
  const fillPct = Math.min(pct, 1);
  const overFillPct = Math.max(0, Math.min(pct - 1, 1));
  const projPct = projectedUsd !== undefined
    ? Math.max(0, Math.min(projectedUsd / safeLimit, 1))
    : null;

  const tone = colorFor(pct);
  const colors = COLOR_VARS[tone];

  const clickable = typeof onClick === 'function';
  const handleClick = (): void => {
    if (clickable) onClick!();
  };

  const label = `${fmtUsd(totalUsd)} / ${fmtUsd(limitUsd)}`;
  const ariaLabel = `Cost ${label} (${Math.round(pct * 100)}% of limit)`;

  if (compact) {
    return (
      <button
        type="button"
        onClick={handleClick}
        aria-label={ariaLabel}
        title={projectedUsd !== undefined ? `Projected: ${fmtUsd(projectedUsd)}` : undefined}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 8px',
          borderRadius: 'var(--radius-full, 9999px)',
          border: `1px solid ${colors.fg}`,
          background: 'transparent',
          color: colors.fg,
          fontSize: 'var(--text-xs, 12px)',
          fontWeight: 600,
          cursor: clickable ? 'pointer' : 'default',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span aria-hidden="true">$</span>
        <span>{label.replace(/\$/g, '')}</span>
      </button>
    );
  }

  return (
    <div
      onClick={handleClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={ariaLabel}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 8,
        borderRadius: 'var(--radius-md, 8px)',
        background: 'var(--bg-subtle, #1a1a1a)',
        cursor: clickable ? 'pointer' : 'default',
        minWidth: 220,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 'var(--text-xs, 12px)',
          color: 'var(--text-muted, #888)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span style={{ fontWeight: 600, color: colors.fg }}>{label}</span>
        <span>{Math.min(999, Math.round(pct * 100))}%</span>
      </div>
      <div
        style={{
          position: 'relative',
          height: 6,
          background: 'var(--bg-hover, #2a2a2a)',
          borderRadius: 'var(--radius-full, 9999px)',
          overflow: 'hidden',
        }}
      >
        {projPct !== null && projPct > fillPct && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              width: `${projPct * 100}%`,
              background: colors.bar,
              opacity: 0.25,
            }}
          />
        )}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: `${fillPct * 100}%`,
            background: colors.bar,
            transition: 'width 200ms ease',
          }}
        />
        {overFillPct > 0 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              boxShadow: `inset 0 0 0 1px ${colors.fg}`,
              borderRadius: 'inherit',
            }}
          />
        )}
      </div>
    </div>
  );
}

export default CostMeter;
