import React from 'react';
import { Shield, TrendingUp, AlertCircle, Clock } from 'lucide-react';
import type { RegressionGuardMetrics } from '../../../server/regression-metrics-types.js';

export interface RegressionGuardPanelProps {
  metrics: RegressionGuardMetrics | null;
  loading: boolean;
}

// ── Formatting helpers ────────────────────────────────────────────────

function formatPct(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

/**
 * Format a duration in ms as "2h 15m" / "12m 5s" / "34s". We truncate at
 * hour-granularity for anything over 60m because bind latency is reported
 * as a single-line KPI.
 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}d ${remHours}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function rateColor(rate: number): string {
  if (rate >= 0.75) return 'var(--color-success)';
  if (rate >= 0.5) return 'var(--color-warning)';
  return 'var(--color-error)';
}

function severityColor(sev: string | undefined): string {
  switch ((sev ?? '').toLowerCase()) {
    case 'p1': return 'var(--color-error)';
    case 'p2': return 'var(--color-warning)';
    case 'p3': return 'var(--color-info, var(--text-secondary))';
    default: return 'var(--text-tertiary)';
  }
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
  gridTemplateColumns: 'repeat(4, 1fr)',
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

/**
 * Inline dual-series sparkline. We draw two polylines (guards + catches) in a
 * fixed viewBox; SVG scales crisply regardless of container width. We keep
 * the chart minimal — no axes — because this panel is a rollup, not an
 * analysis tool.
 */
function Sparkline({
  data,
  width = 120,
  height = 40,
}: {
  data: Array<{ guards: number; catches: number }>;
  width?: number;
  height?: number;
}) {
  if (data.length === 0) return null;
  const maxY = Math.max(1, ...data.flatMap((d) => [d.guards, d.catches]));
  const stepX = data.length <= 1 ? 0 : width / (data.length - 1);
  const y = (v: number): number => height - (v / maxY) * (height - 4) - 2;
  const toPath = (key: 'guards' | 'catches'): string =>
    data.map((d, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(2)},${y(d[key]).toFixed(2)}`).join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Guards and catches over the last 30 days"
    >
      <path
        d={toPath('guards')}
        fill="none"
        stroke="var(--color-success, #22c55e)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={toPath('catches')}
        fill="none"
        stroke="var(--color-error, #ef4444)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SeverityPill({ severity }: { severity?: string }) {
  if (!severity) return null;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: 'var(--radius-full)',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        color: severityColor(severity),
        border: `1px solid ${severityColor(severity)}`,
      }}
    >
      {severity}
    </span>
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
    <div
      style={{ ...panelStyle, gap: 'var(--space-md)' }}
      aria-busy="true"
      aria-label="Loading regression guard metrics"
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-md)' }}>
        <div style={barStyle} />
        <div style={barStyle} />
        <div style={barStyle} />
        <div style={barStyle} />
      </div>
      <div style={{ ...barStyle, height: 120 }} />
      <div style={{ ...barStyle, height: 100 }} />
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        ...panelStyle,
        alignItems: 'center',
        textAlign: 'center',
        padding: 'var(--space-xl)',
      }}
    >
      <Shield size={32} strokeWidth={1.5} color="var(--text-tertiary)" aria-hidden="true" />
      <div style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>No incidents yet</div>
      <div style={{ color: 'var(--text-tertiary)', fontSize: 13, maxWidth: 360 }}>
        Once production incidents are ingested and replayed, Regression Guard will start binding
        tests to them. Catch rate and bind-latency will surface here as soon as the first guard
        goes in.
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────

export function RegressionGuardPanel({ metrics, loading }: RegressionGuardPanelProps) {
  if (loading) return <LoadingSkeleton />;
  if (!metrics || metrics.totalIncidents === 0) return <EmptyState />;

  const topFiles = metrics.topGuardedFiles.slice(0, 5);
  const unguarded = metrics.incidentsWithoutGuard.slice(0, 5);

  return (
    <section style={panelStyle} aria-label="Regression guard insights">
      {/* KPI strip */}
      <div style={kpiGridStyle}>
        <KpiCard
          icon={<Shield size={12} strokeWidth={2} aria-hidden="true" />}
          label="Guarded incidents"
          value={formatPct(metrics.percentGuarded)}
          valueColor={rateColor(metrics.percentGuarded)}
        />
        <KpiCard
          icon={<TrendingUp size={12} strokeWidth={2} aria-hidden="true" />}
          label="Catch rate"
          value={formatPct(metrics.catchRate)}
          valueColor={rateColor(metrics.catchRate)}
        />
        <KpiCard
          icon={<Clock size={12} strokeWidth={2} aria-hidden="true" />}
          label="Avg bind latency"
          value={formatDuration(metrics.avgBindLatencyMs)}
        />
        <KpiCard
          icon={<AlertCircle size={12} strokeWidth={2} aria-hidden="true" />}
          label="Overrides (30d)"
          value={String(metrics.overridesLast30d)}
          valueColor={metrics.overridesLast30d > 0 ? 'var(--color-warning)' : 'var(--text-primary)'}
        />
      </div>

      {/* Sparkline */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={sectionTitleStyle}>Guards vs catches (30d)</div>
          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-tertiary)' }}>
            <span>
              <span style={{ color: 'var(--color-success, #22c55e)' }}>●</span> guards
            </span>
            <span>
              <span style={{ color: 'var(--color-error, #ef4444)' }}>●</span> catches
            </span>
          </div>
        </div>
        <Sparkline data={metrics.timeSeries} width={120} height={40} />
      </div>

      {/* Top guarded files */}
      {topFiles.length > 0 && (
        <div>
          <div style={sectionTitleStyle}>Top guarded files</div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              gap: 6,
              alignItems: 'center',
              fontSize: 12,
            }}
          >
            <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>File</div>
            <div style={{ fontWeight: 600, color: 'var(--text-secondary)', textAlign: 'right' }}>Incidents</div>
            {topFiles.map((f) => (
              <React.Fragment key={f.filePath}>
                <div
                  style={{
                    color: 'var(--text-primary)',
                    fontFamily: 'var(--font-mono)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={f.filePath}
                >
                  {f.filePath}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    textAlign: 'right',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {f.incidentCount}
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {/* Incidents without a guard */}
      {unguarded.length > 0 && (
        <div>
          <div style={sectionTitleStyle}>Incidents without a guard</div>
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
            {unguarded.map((u) => (
              <li
                key={u.incidentId}
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
                <AlertCircle
                  size={13}
                  strokeWidth={1.75}
                  style={{ color: 'var(--color-warning)', flexShrink: 0 }}
                  aria-hidden="true"
                />
                <span
                  style={{
                    flex: 1,
                    color: 'var(--text-primary)',
                    fontFamily: 'var(--font-mono)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={u.incidentId}
                >
                  {u.incidentId}
                </span>
                <SeverityPill severity={u.severity} />
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', fontSize: 11 }}>
                  {u.createdAt ? u.createdAt.slice(0, 10) : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default RegressionGuardPanel;
