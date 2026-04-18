import React, { useMemo } from 'react';
import { BarChart3, TrendingUp, TrendingDown, DollarSign, Clock, CheckCircle2 } from 'lucide-react';
import type { RunSummary } from '../history/RunRow.js';

export interface StatsPageProps {
  runs: RunSummary[];
  features: Array<{
    slug: string;
    project: string;
    description: string;
    status: string;
    totalCost: number;
    updatedAt: string;
  }>;
  projects: Array<{ name: string; repoCount: number }>;
  prs: Array<{ status: string; repo: string }>;
}

/* ─── Helpers ──────────────────────────────────────────────── */

function getWeeklyData(features: Array<{ updatedAt: string }>): number[] {
  const now = Date.now();
  const weeks: number[] = new Array(8).fill(0);
  for (const f of features) {
    const age = now - new Date(f.updatedAt).getTime();
    const weekIndex = Math.floor(age / (7 * 24 * 60 * 60 * 1000));
    if (weekIndex < 8) {
      weeks[7 - weekIndex]++;
    }
  }
  return weeks;
}

function getWeekLabel(index: number, total: number): string {
  const weeksAgo = total - 1 - index;
  if (weeksAgo === 0) return 'This week';
  if (weeksAgo === 1) return 'Last week';
  return `${weeksAgo}w ago`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function getDailyCosts(runs: RunSummary[], days: number): Array<{ label: string; cost: number }> {
  const now = new Date();
  const result: Array<{ label: string; cost: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const dayCost = runs
      .filter((r) => r.startedAt >= dayStart && r.startedAt < dayEnd)
      .reduce((sum, r) => sum + (r.totalCost || 0), 0);
    const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    result.push({ label, cost: dayCost });
  }
  return result;
}

function getModelColor(model: string): string {
  if (model.includes('claude') || model.includes('opus') || model.includes('sonnet') || model.includes('haiku')) {
    return 'var(--accent)';
  }
  if (model.includes('gpt') || model.includes('o1') || model.includes('o3') || model.includes('o4')) {
    return 'var(--color-info)';
  }
  if (model.includes('gemini')) {
    return 'var(--color-warning)';
  }
  return 'var(--text-tertiary)';
}

/* ─── Shared styles ────────────────────────────────────────── */

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-elevated-2)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-md)',
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 'var(--text-base)',
  fontWeight: 600,
  color: 'var(--text-primary)',
  marginBottom: 'var(--space-md)',
};

/* ─── Sub-components ───────────────────────────────────────── */

function SuccessRateRing({
  rate,
  completed,
  failed,
}: {
  rate: number;
  completed: number;
  failed: number;
}) {
  const circumference = 2 * Math.PI * 24;
  const strokeLength = (rate / 100) * circumference;
  const rateColor = rate >= 50 ? 'var(--color-success)' : 'var(--color-error)';

  return (
    <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-sm)' }}>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>Success Rate</div>
      <div
        style={{ position: 'relative', width: 64, height: 64 }}
        role="img"
        aria-label={`Success rate: ${rate}%. ${completed} completed, ${failed} failed.`}
      >
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
          <circle
            cx="32"
            cy="32"
            r="24"
            fill="none"
            stroke="var(--bg-elevated-3)"
            strokeWidth="5"
          />
          <circle
            cx="32"
            cy="32"
            r="24"
            fill="none"
            stroke={rateColor}
            strokeWidth="5"
            strokeDasharray={`${strokeLength} ${circumference}`}
            strokeLinecap="round"
            transform="rotate(-90 32 32)"
            style={{ transition: 'stroke-dasharray var(--duration-slow) ease-out' }}
          />
        </svg>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 'var(--text-lg)',
            fontWeight: 700,
            fontFamily: 'var(--font-mono)',
            color: rateColor,
          }}
        >
          {rate}%
        </div>
      </div>
      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-tertiary)' }}>
        {completed} completed &middot; {failed} failed
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  subtitle,
  trend,
  icon,
}: {
  label: string;
  value: string | number;
  subtitle?: string;
  trend?: { direction: 'up' | 'down' | 'neutral'; text: string };
  icon: React.ReactNode;
}) {
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-sm)' }}>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>{label}</span>
        <span style={{ color: 'var(--text-tertiary)', opacity: 0.6 }}>{icon}</span>
      </div>
      <div
        style={{
          fontSize: 'var(--text-2xl)',
          fontWeight: 700,
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-primary)',
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      {trend && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            marginTop: 'var(--space-xs)',
            fontSize: 'var(--text-xs)',
            color:
              trend.direction === 'up'
                ? 'var(--color-success)'
                : trend.direction === 'down'
                  ? 'var(--color-error)'
                  : 'var(--text-tertiary)',
          }}
        >
          {trend.direction === 'up' && <TrendingUp size={12} aria-hidden="true" />}
          {trend.direction === 'down' && <TrendingDown size={12} aria-hidden="true" />}
          <span>{trend.text}</span>
        </div>
      )}
      {subtitle && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 'var(--space-xs)' }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

function ActivitySection({ weekData }: { weekData: number[] }) {
  const maxCount = Math.max(...weekData, 1);

  return (
    <section aria-label="Weekly activity">
      <h3 style={sectionTitleStyle}>Activity</h3>
      <div style={{ ...cardStyle, padding: 'var(--space-md)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          {weekData.map((count, i) => {
            const isCurrentWeek = i === weekData.length - 1;
            const barWidth = maxCount > 0 ? (count / maxCount) * 100 : 0;
            return (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '80px 1fr 32px',
                  alignItems: 'center',
                  gap: 'var(--space-sm)',
                }}
              >
                <span
                  style={{
                    fontSize: 'var(--text-xs)',
                    color: isCurrentWeek ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    fontWeight: isCurrentWeek ? 500 : 400,
                  }}
                >
                  {getWeekLabel(i, weekData.length)}
                </span>
                <div
                  style={{
                    height: 6,
                    borderRadius: 'var(--radius-full)',
                    background: 'var(--bg-elevated-3)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.max(barWidth, count > 0 ? 2 : 0)}%`,
                      borderRadius: 'var(--radius-full)',
                      background: isCurrentWeek ? 'var(--accent)' : 'var(--bg-elevated-4)',
                      transition: 'width var(--duration-slow) ease-out',
                    }}
                  />
                </div>
                <span
                  style={{
                    fontSize: 'var(--text-xs)',
                    fontFamily: 'var(--font-mono)',
                    color: isCurrentWeek ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    textAlign: 'right',
                  }}
                >
                  {count}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ModelUsageSection({
  modelCounts,
  totalModelRuns,
}: {
  modelCounts: Record<string, { count: number; cost: number }>;
  totalModelRuns: number;
}) {
  const sortedModels = useMemo(
    () => Object.entries(modelCounts).sort(([, a], [, b]) => b.count - a.count),
    [modelCounts],
  );

  return (
    <section aria-label="Model usage distribution">
      <h3 style={sectionTitleStyle}>Model Usage</h3>
      <div style={{ ...cardStyle, padding: 'var(--space-md)' }}>
        {/* Stacked horizontal bar */}
        <div
          style={{
            display: 'flex',
            height: 10,
            borderRadius: 'var(--radius-full)',
            overflow: 'hidden',
            background: 'var(--bg-elevated-3)',
          }}
          role="img"
          aria-label={`Model usage: ${sortedModels.map(([m, s]) => `${m} ${s.count} runs`).join(', ')}`}
        >
          {sortedModels.map(([model, stats]) => (
            <div
              key={model}
              style={{
                width: `${(stats.count / totalModelRuns) * 100}%`,
                background: getModelColor(model),
                transition: 'width var(--duration-slow) ease-out',
              }}
            />
          ))}
        </div>
        {/* Legend */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-md)', marginTop: 'var(--space-sm)' }}>
          {sortedModels.map(([model, stats]) => {
            const shortName = model
              .replace('claude-', '')
              .replace(/-2025\d{4}/, '')
              .replace(/-2024\d{4}/, '');
            return (
              <div key={model} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)' }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: getModelColor(model),
                    flexShrink: 0,
                  }}
                  aria-hidden="true"
                />
                <span style={{ color: 'var(--text-secondary)' }}>{shortName}</span>
                <span style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>{stats.count}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ProjectBreakdownSection({
  projectStats,
}: {
  projectStats: Array<{ name: string; runs: number; successRate: number; avgCost: number }>;
}) {
  return (
    <section aria-label="Per-project breakdown">
      <h3 style={sectionTitleStyle}>Per Project</h3>
      <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
        <table
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}
          role="table"
        >
          <thead>
            <tr>
              {['Project', 'Runs', 'Success Rate', 'Avg Cost'].map((header) => (
                <th
                  key={header}
                  style={{
                    textAlign: header === 'Project' ? 'left' : 'right',
                    padding: '10px 14px',
                    fontSize: 'var(--text-xs)',
                    fontWeight: 500,
                    color: 'var(--text-tertiary)',
                    borderBottom: '1px solid var(--separator)',
                    background: 'var(--bg-elevated-3)',
                  }}
                  scope="col"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projectStats.map((s, i) => (
              <tr
                key={s.name}
                style={{
                  background: i % 2 === 1 ? 'rgba(255,255,255,0.015)' : 'transparent',
                }}
              >
                <td
                  style={{
                    padding: '10px 14px',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 500,
                    color: 'var(--text-primary)',
                  }}
                >
                  {s.name}
                </td>
                <td
                  style={{
                    padding: '10px 14px',
                    textAlign: 'right',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {s.runs}
                </td>
                <td
                  style={{
                    padding: '10px 14px',
                    textAlign: 'right',
                    fontFamily: 'var(--font-mono)',
                    color: s.successRate >= 50 ? 'var(--color-success)' : 'var(--color-error)',
                  }}
                >
                  {s.successRate}%
                </td>
                <td
                  style={{
                    padding: '10px 14px',
                    textAlign: 'right',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-tertiary)',
                  }}
                >
                  ${s.avgCost.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CostTimelineSection({ dailyCosts }: { dailyCosts: Array<{ label: string; cost: number }> }) {
  const maxCost = Math.max(...dailyCosts.map((d) => d.cost), 0.01);

  return (
    <section aria-label="Daily cost timeline">
      <h3 style={sectionTitleStyle}>Cost Timeline</h3>
      <div style={{ ...cardStyle, padding: 'var(--space-md)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 3,
            height: 80,
          }}
        >
          {dailyCosts.map((day, i) => {
            const barHeight = maxCost > 0 ? (day.cost / maxCost) * 100 : 0;
            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  height: '100%',
                  justifyContent: 'flex-end',
                }}
                title={`${day.label}: $${day.cost.toFixed(2)}`}
              >
                <div
                  style={{
                    width: '100%',
                    height: `${Math.max(barHeight, day.cost > 0 ? 3 : 0)}%`,
                    background: day.cost > 0 ? 'var(--accent)' : 'transparent',
                    borderRadius: '2px 2px 0 0',
                    opacity: day.cost > 0 ? 0.7 : 0,
                    transition: 'height var(--duration-slow) ease-out',
                  }}
                />
              </div>
            );
          })}
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 'var(--text-2xs)',
            color: 'var(--text-tertiary)',
            marginTop: 'var(--space-xs)',
          }}
        >
          <span>{dailyCosts[0]?.label}</span>
          <span>{dailyCosts[dailyCosts.length - 1]?.label}</span>
        </div>
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: 'var(--space-3xl) 0',
        color: 'var(--text-tertiary)',
      }}
    >
      <BarChart3
        size={40}
        strokeWidth={1.25}
        style={{ margin: '0 auto var(--space-md)', opacity: 0.4 }}
        aria-hidden="true"
      />
      <div style={{ fontSize: 'var(--text-base)', marginBottom: 'var(--space-xs)' }}>
        No data yet
      </div>
      <div style={{ fontSize: 'var(--text-sm)' }}>
        Run a few features and insights will appear here.
      </div>
    </div>
  );
}

/* ─── Main Component ───────────────────────────────────────── */

export function StatsPage({ runs, features, projects, prs: _prs }: StatsPageProps) {
  const totalFeatures = features.length;
  const completed = features.filter((f) => f.status === 'completed').length;
  const failed = features.filter((f) => f.status === 'failed').length;

  const runOnlyCost = runs
    .filter((r) => !features.some((f) => f.slug === r.featureSlug))
    .reduce((sum, r) => sum + (r.totalCost || 0), 0);
  const dedupedCost = features.reduce((sum, f) => sum + (f.totalCost || 0), 0) + runOnlyCost;

  const successRate = totalFeatures > 0 ? Math.round((completed / totalFeatures) * 100) : 0;

  // Weekly activity
  const weekData = useMemo(() => getWeeklyData(features), [features]);
  const thisWeek = weekData.length > 0 ? weekData[weekData.length - 1] : 0;
  const lastWeek = weekData.length > 1 ? weekData[weekData.length - 2] : 0;
  const weekTrend = thisWeek - lastWeek;

  // Average duration
  const avgDurationMs = useMemo(() => {
    const runsWithDuration = runs.filter((r) => r.durationMs && r.durationMs > 0);
    if (runsWithDuration.length === 0) return 0;
    return runsWithDuration.reduce((sum, r) => sum + (r.durationMs || 0), 0) / runsWithDuration.length;
  }, [runs]);

  // Daily average cost
  const dailyAvgCost = useMemo(() => {
    if (runs.length === 0) return 0;
    const sorted = [...runs].sort((a, b) => a.startedAt - b.startedAt);
    const firstDay = sorted[0].startedAt;
    const daySpan = Math.max(1, Math.ceil((Date.now() - firstDay) / (24 * 60 * 60 * 1000)));
    return dedupedCost / daySpan;
  }, [runs, dedupedCost]);

  // Model usage
  const { modelCounts, totalModelRuns } = useMemo(() => {
    const counts: Record<string, { count: number; cost: number }> = {};
    for (const f of features) {
      const model = (f as any).model || 'unknown';
      if (!counts[model]) counts[model] = { count: 0, cost: 0 };
      counts[model].count++;
      counts[model].cost += f.totalCost || 0;
    }
    for (const r of runs) {
      if (r.model && !features.some((f) => f.slug === r.featureSlug)) {
        if (!counts[r.model]) counts[r.model] = { count: 0, cost: 0 };
        counts[r.model].count++;
        counts[r.model].cost += r.totalCost || 0;
      }
    }
    const total = Object.values(counts).reduce((s, m) => s + m.count, 0);
    return { modelCounts: counts, totalModelRuns: total };
  }, [features, runs]);

  // Per-project breakdown
  const projectStats = useMemo(() => {
    return projects
      .map((p) => {
        const projFeatures = features.filter((f) => f.project === p.name);
        const projCompleted = projFeatures.filter((f) => f.status === 'completed').length;
        const totalCost = projFeatures.reduce((sum, f) => sum + (f.totalCost || 0), 0);
        return {
          name: p.name,
          runs: projFeatures.length,
          successRate: projFeatures.length > 0 ? Math.round((projCompleted / projFeatures.length) * 100) : 0,
          avgCost: projFeatures.length > 0 ? totalCost / projFeatures.length : 0,
        };
      })
      .filter((s) => s.runs > 0)
      .sort((a, b) => b.runs - a.runs);
  }, [features, projects]);

  // Cost timeline (last 14 days)
  const dailyCosts = useMemo(() => getDailyCosts(runs, 14), [runs]);
  const hasAnyCost = dailyCosts.some((d) => d.cost > 0);

  const isEmpty = totalFeatures === 0 && runs.length === 0;

  if (isEmpty) {
    return (
      <div
        className="page-enter"
        style={{
          padding: 'var(--space-lg)',
          maxWidth: 900,
          margin: '0 auto',
          overflowY: 'auto',
          height: '100%',
        }}
      >
        <h2 style={{ fontSize: 'var(--text-2xl)', fontWeight: 600, marginBottom: 'var(--space-lg)' }}>
          Insights
        </h2>
        <EmptyState />
      </div>
    );
  }

  return (
    <div
      className="page-enter"
      style={{
        padding: 'var(--space-lg)',
        maxWidth: 900,
        margin: '0 auto',
        overflowY: 'auto',
        height: '100%',
      }}
    >
      <h2 style={{ fontSize: 'var(--text-2xl)', fontWeight: 600, marginBottom: 'var(--space-lg)', color: 'var(--text-primary)' }}>
        Insights
      </h2>

      {/* ── Top Metric Cards ── */}
      <div
        className="stagger"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 'var(--space-sm)',
          marginBottom: 'var(--space-xl)',
        }}
      >
        <MetricCard
          label="Total Features"
          value={totalFeatures}
          subtitle="features built"
          trend={
            weekTrend !== 0
              ? {
                  direction: weekTrend > 0 ? 'up' : 'down',
                  text: `${weekTrend > 0 ? '+' : ''}${weekTrend} this week`,
                }
              : undefined
          }
          icon={<TrendingUp size={16} strokeWidth={1.5} aria-hidden="true" />}
        />

        <SuccessRateRing rate={successRate} completed={completed} failed={failed} />

        <MetricCard
          label="Total Cost"
          value={`$${dedupedCost.toFixed(2)}`}
          subtitle={`$${dailyAvgCost.toFixed(2)} daily avg`}
          icon={<DollarSign size={16} strokeWidth={1.5} aria-hidden="true" />}
        />

        <MetricCard
          label="Avg Duration"
          value={avgDurationMs > 0 ? formatDuration(avgDurationMs) : '--'}
          subtitle={runs.length > 0 ? `across ${runs.length} runs` : undefined}
          icon={<Clock size={16} strokeWidth={1.5} aria-hidden="true" />}
        />
      </div>

      {/* ── Activity ── */}
      {weekData.some((c) => c > 0) && (
        <div style={{ marginBottom: 'var(--space-xl)' }}>
          <ActivitySection weekData={weekData} />
        </div>
      )}

      {/* ── Model Usage ── */}
      {totalModelRuns > 0 && (
        <div style={{ marginBottom: 'var(--space-xl)' }}>
          <ModelUsageSection modelCounts={modelCounts} totalModelRuns={totalModelRuns} />
        </div>
      )}

      {/* ── Per-Project Breakdown ── */}
      {projectStats.length > 0 && (
        <div style={{ marginBottom: 'var(--space-xl)' }}>
          <ProjectBreakdownSection projectStats={projectStats} />
        </div>
      )}

      {/* ── Cost Timeline ── */}
      {hasAnyCost && (
        <div style={{ marginBottom: 'var(--space-xl)' }}>
          <CostTimelineSection dailyCosts={dailyCosts} />
        </div>
      )}
    </div>
  );
}

export default StatsPage;
