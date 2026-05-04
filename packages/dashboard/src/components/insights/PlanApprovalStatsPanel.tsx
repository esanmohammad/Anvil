import React from 'react';
import { TrendingUp, FileEdit, XCircle, Clock } from 'lucide-react';
import type { PlanApprovalStats } from '../../../server/pipeline-learnings-types.js';

export interface PlanApprovalStatsPanelProps {
  stats: PlanApprovalStats | null;
  loading: boolean;
}

// ── Formatting helpers ────────────────────────────────────────────────

function formatPct(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

/**
 * Format a duration in ms as "2h 15m" / "12m 5s" / "34s". We cap at hour
 * granularity for anything longer than 60m because the panel is sized for a
 * single line — and the *average* decision latency rarely benefits from finer
 * detail given the statistical noise.
 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function rateColor(rate: number): string {
  if (rate >= 0.75) return 'var(--color-success)';
  if (rate >= 0.5) return 'var(--color-warning)';
  return 'var(--color-error)';
}

// ── Shared styles ────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  background: 'var(--bg-elevated-2)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-lg)',
  fontFamily: 'var(--font-sans)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-lg)',
};

const kpiGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 'var(--space-md)',
};

const kpiCardStyle: React.CSSProperties = {
  background: 'var(--bg-elevated-1)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--space-md)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--text-tertiary)',
  fontWeight: 600,
  marginBottom: 8,
};

// ── Sub-components ───────────────────────────────────────────────────

function KpiCard(props: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div style={kpiCardStyle}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--text-tertiary)',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          fontWeight: 600,
        }}
      >
        {props.icon}
        <span>{props.label}</span>
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          fontFamily: 'var(--font-mono)',
          color: props.valueColor ?? 'var(--text-primary)',
        }}
      >
        {props.value}
      </div>
    </div>
  );
}

function ApprovalBar({ rate }: { rate: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(rate * 100)));
  return (
    <div
      style={{
        height: 6,
        width: '100%',
        background: 'var(--bg-elevated-3)',
        borderRadius: 'var(--radius-full)',
        overflow: 'hidden',
      }}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Approval rate"
    >
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          background: rateColor(rate),
          transition: 'width var(--duration-normal) var(--ease-default)',
        }}
      />
    </div>
  );
}

function LoadingSkeleton() {
  const barStyle: React.CSSProperties = {
    height: 80,
    background: 'var(--bg-elevated-1)',
    borderRadius: 'var(--radius-sm)',
    animation: 'pulse var(--duration-slow, 1s) ease-in-out infinite',
    opacity: 0.6,
  };
  return (
    <div style={{ ...panelStyle, gap: 'var(--space-md)' }} aria-busy="true" aria-label="Loading approval stats">
      <div style={barStyle} />
      <div style={barStyle} />
      <div style={barStyle} />
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ ...panelStyle, alignItems: 'center', textAlign: 'center', padding: 'var(--space-xl)' }}>
      <TrendingUp size={32} strokeWidth={1.5} color="var(--text-tertiary)" aria-hidden="true" />
      <div style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>No plan decisions yet</div>
      <div style={{ color: 'var(--text-tertiary)', fontSize: 13, maxWidth: 360 }}>
        Once users start approving, modifying, or rejecting plans at the risk gate, approval trends
        will appear here and feed back into planner calibration.
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────

export function PlanApprovalStatsPanel({ stats, loading }: PlanApprovalStatsPanelProps) {
  if (loading) return <LoadingSkeleton />;
  if (!stats || stats.totalPlans === 0) return <EmptyState />;

  return (
    <section style={panelStyle} aria-label="Plan approval statistics">
      {/* KPI strip */}
      <div style={kpiGridStyle}>
        <KpiCard
          icon={<TrendingUp size={12} strokeWidth={2} aria-hidden="true" />}
          label="Approval rate"
          value={formatPct(stats.approvalRate)}
          valueColor={rateColor(stats.approvalRate)}
        />
        <KpiCard
          icon={<FileEdit size={12} strokeWidth={2} aria-hidden="true" />}
          label="Modification rate"
          value={formatPct(stats.modificationRate)}
        />
        <KpiCard
          icon={<Clock size={12} strokeWidth={2} aria-hidden="true" />}
          label="Avg decision time"
          value={formatDuration(stats.avgDecisionLatencyMs)}
        />
      </div>

      {/* Per-path table */}
      {stats.byPath.length > 0 && (
        <div>
          <div style={sectionTitleStyle}>By top-level path</div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.6fr 0.6fr 1.2fr 0.8fr',
              gap: 6,
              alignItems: 'center',
              fontSize: 12,
            }}
          >
            <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Path</div>
            <div style={{ fontWeight: 600, color: 'var(--text-secondary)', textAlign: 'right' }}>Total</div>
            <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Approval</div>
            <div style={{ fontWeight: 600, color: 'var(--text-secondary)', textAlign: 'right' }}>Rejection</div>
            {stats.byPath.map((p) => {
              const rejRate = p.total === 0 ? 0 : p.rejected / p.total;
              return (
                <React.Fragment key={p.path}>
                  <div
                    style={{
                      color: 'var(--text-primary)',
                      fontFamily: 'var(--font-mono)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={p.path}
                  >
                    {p.path}
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', textAlign: 'right', color: 'var(--text-secondary)' }}>
                    {p.total}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <ApprovalBar rate={p.approvalRate} />
                    </div>
                    <span
                      style={{
                        minWidth: 40,
                        textAlign: 'right',
                        color: rateColor(p.approvalRate),
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                      }}
                    >
                      {formatPct(p.approvalRate)}
                    </span>
                  </div>
                  <div
                    style={{
                      textAlign: 'right',
                      fontFamily: 'var(--font-mono)',
                      color: rejRate > 0.3 ? 'var(--color-error)' : 'var(--text-tertiary)',
                    }}
                  >
                    {formatPct(rejRate)}
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}

      {/* Risk tier breakdown */}
      <div>
        <div style={sectionTitleStyle}>By risk tier</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-md)' }}>
          {(['low', 'med', 'high'] as const).map((tier) => {
            const bucket = stats.byRiskTier[tier];
            const tierColor =
              tier === 'low'
                ? 'var(--color-success)'
                : tier === 'med'
                  ? 'var(--color-warning)'
                  : 'var(--color-error)';
            return (
              <div key={tier} style={kpiCardStyle}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    color: tierColor,
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                    fontWeight: 700,
                  }}
                >
                  <span>{tier === 'med' ? 'Medium' : tier.charAt(0).toUpperCase() + tier.slice(1)}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>n={bucket.total}</span>
                </div>
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    fontFamily: 'var(--font-mono)',
                    color: bucket.total === 0 ? 'var(--text-tertiary)' : rateColor(bucket.approvalRate),
                  }}
                >
                  {bucket.total === 0 ? '—' : formatPct(bucket.approvalRate)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>approval rate</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Top rejection reasons */}
      {stats.topRejectionReasons.length > 0 && (
        <div>
          <div style={sectionTitleStyle}>Top rejection reasons</div>
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {stats.topRejectionReasons.map((r) => (
              <li
                key={r.reason}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 10px',
                  background: 'var(--bg-elevated-1)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13,
                }}
              >
                <XCircle
                  size={13}
                  strokeWidth={1.75}
                  style={{ color: 'var(--color-error)', flexShrink: 0 }}
                  aria-hidden="true"
                />
                <span style={{ flex: 1, color: 'var(--text-primary)' }}>{r.reason}</span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-tertiary)',
                    fontSize: 12,
                  }}
                >
                  x{r.count}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default PlanApprovalStatsPanel;
