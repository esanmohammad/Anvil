import React, { useMemo, useEffect, useState, useCallback } from 'react';
import { BarChart3, TrendingUp, TrendingDown, DollarSign, Clock, CheckCircle2, AlertCircle, MessageCircle, GitPullRequest, CalendarClock } from 'lucide-react';
import type { RunSummary } from '../history/RunRow.js';
import { useSystem } from '../../context/ProjectContext.js';
import { costTier, fmtUsd } from '../../lib/cost-tier.js';

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
  /** Live WebSocket reference used to subscribe to per-project cost snapshots. */
  ws?: WebSocket | null;
}

interface TodayCost {
  usd: number;
  limitUsd: number;
  alertAt?: number;
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

function CostTimelineSection({
  dailyCosts,
  dailyLimit,
  alertAt,
}: {
  dailyCosts: Array<{ label: string; cost: number }>;
  dailyLimit?: number;
  alertAt?: number;
}) {
  const hasLimit = typeof dailyLimit === 'number' && dailyLimit > 0;
  const maxCost = Math.max(
    ...dailyCosts.map((d) => d.cost),
    hasLimit ? (dailyLimit as number) : 0,
    0.01,
  );
  const limitTopPct = hasLimit ? 100 - ((dailyLimit as number) / maxCost) * 100 : 0;
  const alertFraction = typeof alertAt === 'number' && alertAt > 0 ? alertAt : 0.6;

  return (
    <section aria-label="Daily cost timeline">
      <h3 style={sectionTitleStyle}>Cost Timeline</h3>
      <div style={{ ...cardStyle, padding: 'var(--space-md)' }}>
        <div
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'flex-end',
            gap: 3,
            height: 80,
          }}
        >
          {hasLimit && (
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: `${Math.max(0, Math.min(100, limitTopPct))}%`,
                height: 0,
                borderTop: '1px dashed var(--color-warning)',
                opacity: 0.6,
                pointerEvents: 'none',
              }}
            />
          )}
          {dailyCosts.map((day, i) => {
            const barHeight = maxCost > 0 ? (day.cost / maxCost) * 100 : 0;
            let barColor = 'var(--accent)';
            if (hasLimit && day.cost > 0) {
              const limit = dailyLimit as number;
              if (day.cost >= limit) barColor = 'var(--color-error)';
              else if (day.cost >= limit * alertFraction) barColor = 'var(--color-warning)';
            }
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
                    background: day.cost > 0 ? barColor : 'transparent',
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
        {hasLimit && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 'var(--text-2xs)',
              color: 'var(--text-tertiary)',
              marginTop: 'var(--space-xs)',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 18,
                height: 0,
                borderTop: '1px dashed var(--color-warning)',
                opacity: 0.6,
              }}
            />
            <span>daily cap {fmtUsd(dailyLimit as number)}</span>
          </div>
        )}
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseHashProject(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash || '';
  const queryStart = hash.indexOf('?');
  if (queryStart === -1) return null;
  const params = new URLSearchParams(hash.slice(queryStart + 1));
  return params.get('project');
}

function formatRemaining(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '0m';
  const totalMinutes = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function TimeToExhaustionStrip({ today }: { today: TodayCost | null }) {
  if (!today) return null;
  const { usd, limitUsd } = today;
  if (!(limitUsd > 0) || !(usd > 0)) return null;

  if (usd >= limitUsd) {
    return (
      <div
        role="status"
        style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--color-error)',
          marginBottom: 'var(--space-sm)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        Today's budget already exhausted.
      </div>
    );
  }

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const hoursElapsed = (now.getTime() - startOfDay) / 3_600_000;
  if (!(hoursElapsed > 0)) return null;
  const usdPerHour = usd / hoursElapsed;
  if (!(usdPerHour > 0)) return null;
  const hoursRemaining = (limitUsd - usd) / usdPerHour;
  if (!Number.isFinite(hoursRemaining) || hoursRemaining <= 0) return null;

  if (hoursRemaining > 24) {
    return (
      <div
        style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--text-tertiary)',
          marginBottom: 'var(--space-sm)',
        }}
      >
        Today's budget on track.
      </div>
    );
  }

  return (
    <div
      style={{
        fontSize: 'var(--text-xs)',
        color: 'var(--text-tertiary)',
        marginBottom: 'var(--space-sm)',
      }}
    >
      At current pace, today's budget exhausts in {formatRemaining(hoursRemaining)}.
    </div>
  );
}

function TodayBudgetBar({ today }: { today: TodayCost | null }) {
  if (!today || !(today.limitUsd > 0)) return null;
  const { usd, limitUsd, alertAt } = today;
  const tier = costTier(usd, limitUsd, alertAt);
  const pct = Math.max(0, Math.min(1, usd / limitUsd));

  let fill: string;
  if (tier === 'safe') fill = 'var(--color-success)';
  else if (tier === 'warning') fill = 'var(--color-warning)';
  else fill = 'var(--color-error)';

  const breachStripes =
    tier === 'breach'
      ? 'repeating-linear-gradient(45deg, var(--color-error) 0 4px, rgba(255,255,255,0.25) 4px 8px)'
      : undefined;

  return (
    <div
      role="img"
      aria-label={`Today: ${fmtUsd(usd)} of ${fmtUsd(limitUsd)} (${Math.round(pct * 100)}%)`}
      style={{
        height: 3,
        borderRadius: 'var(--radius-full)',
        background: 'var(--bg-elevated-3)',
        overflow: 'hidden',
        marginTop: 'var(--space-xs)',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${Math.max(pct * 100, usd > 0 ? 2 : 0)}%`,
          background: breachStripes ?? fill,
          borderRadius: 'var(--radius-full)',
          transition: 'width var(--duration-slow) ease-out',
        }}
      />
    </div>
  );
}

export function StatsPage({ runs, features, projects, prs: _prs, ws }: StatsPageProps) {
  const { currentProject, projects: ctxProjects } = useSystem();

  // Resolve which project's budget to subscribe to.
  const activeProject = useMemo<string | null>(() => {
    const fromHash = parseHashProject();
    if (fromHash) return fromHash;
    if (currentProject?.name) return currentProject.name;
    if (ctxProjects.length > 0) return ctxProjects[0].name;
    if (projects.length > 0) return projects[0].name;
    return null;
  }, [currentProject, ctxProjects, projects]);

  const [today, setToday] = useState<TodayCost | null>(null);

  // Subscribe to per-project cost snapshots while mounted / project active.
  useEffect(() => {
    if (!ws || !activeProject) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'subscribe-cost', project: activeProject }));
    return () => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'unsubscribe-cost', project: activeProject }));
        }
      } catch {
        /* noop */
      }
    };
  }, [ws, activeProject]);

  // Listen for cost-snapshot messages and capture today's spend + limit.
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent): void => {
      let msg: { type?: string; payload?: unknown };
      try { msg = JSON.parse(event.data as string); } catch { return; }
      if (msg.type !== 'cost-snapshot') return;
      if (!isRecord(msg.payload)) return;
      const payload = msg.payload;
      if (typeof payload.project === 'string' && activeProject && payload.project !== activeProject) {
        return;
      }
      const t = isRecord(payload.today) ? payload.today : null;
      if (!t) return;
      const nextUsd = typeof t.usd === 'number' ? t.usd : 0;
      const nextLimit = typeof t.limitUsd === 'number' ? t.limitUsd : 0;
      const nextAlert = typeof t.alertAt === 'number' ? t.alertAt : undefined;
      setToday(() => ({ usd: nextUsd, limitUsd: nextLimit, alertAt: nextAlert }));
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, activeProject]);

  // Reset today's data when project changes so we don't render stale numbers.
  useEffect(() => {
    setToday(() => null);
  }, [activeProject]);

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
        <div style={{ marginTop: 'var(--space-xl)' }}>
          <ReviewsSection />
        </div>
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

      {/* ── Time-to-exhaustion strip ── */}
      <TimeToExhaustionStrip today={today} />

      {/* ── Top Metric Cards ── */}
      <div
        className="stagger"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
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

        <div>
          <MetricCard
            label="Today"
            value={fmtUsd(today?.usd ?? 0)}
            subtitle={
              today && today.limitUsd > 0
                ? `/ ${fmtUsd(today.limitUsd)}`
                : 'no daily cap configured'
            }
            icon={<CalendarClock size={16} strokeWidth={1.5} aria-hidden="true" />}
          />
          <TodayBudgetBar today={today} />
        </div>

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
          <CostTimelineSection
            dailyCosts={dailyCosts}
            dailyLimit={today && today.limitUsd > 0 ? today.limitUsd : undefined}
            alertAt={today?.alertAt}
          />
        </div>
      )}

      {/* ── PR Reviews ── */}
      <div style={{ marginBottom: 'var(--space-xl)' }}>
        <ReviewsSection />
      </div>
    </div>
  );
}

/* ─── PR Reviews Section ───────────────────────────────────── */

type ReviewVerdict = 'approve' | 'request-changes' | 'comment';

interface ReviewSeverityCounts {
  blocker: number;
  error: number;
  warn: number;
  info: number;
  nit: number;
}

interface ReviewResolutionCounts {
  pending: number;
  addressed: number;
  dismissed: number;
  'wont-fix': number;
}

interface ReviewListItem {
  reviewId: string;
  prUrl: string;
  prTitle: string;
  project: string;
  verdict: ReviewVerdict;
  createdAt: number;
  severityCounts: ReviewSeverityCounts;
  resolutionCounts: ReviewResolutionCounts;
  topCategory: string | null;
}

/**
 * Starts of each of the last `days` days (UTC midnight), ordered oldest first.
 */
function getLastNDayStarts(days: number): number[] {
  const now = new Date();
  const starts: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    starts.push(d.getTime());
  }
  return starts;
}

function formatAge(createdAt: number): string {
  const hours = Math.max(0, Math.round((Date.now() - createdAt) / (1000 * 60 * 60)));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function verdictColor(verdict: ReviewVerdict): string {
  if (verdict === 'approve') return 'var(--color-success)';
  if (verdict === 'request-changes') return 'var(--color-error)';
  return 'var(--color-warning)';
}

function navigateToReview(reviewId: string) {
  window.location.hash = `/review?reviewId=${encodeURIComponent(reviewId)}`;
}

function VerdictBadge({ verdict }: { verdict: ReviewVerdict }) {
  const color = verdictColor(verdict);
  const Icon =
    verdict === 'approve' ? CheckCircle2 :
    verdict === 'request-changes' ? AlertCircle :
    MessageCircle;
  const label =
    verdict === 'approve' ? 'Approved' :
    verdict === 'request-changes' ? 'Changes' :
    'Comment';

  return (
    <span
      aria-label={`Verdict: ${label}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 'var(--text-2xs)', fontWeight: 500,
        padding: '1px 7px', borderRadius: 'var(--radius-full)',
        background: 'var(--bg-elevated-3)',
        color,
        border: '1px solid var(--separator)',
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={10} strokeWidth={2} aria-hidden="true" />
      {label}
    </span>
  );
}

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
}

function Sparkline({ data, width = 180, height = 32 }: SparklineProps) {
  if (data.length === 0) return null;
  const max = Math.max(...data, 1);
  const stepX = data.length > 1 ? width / (data.length - 1) : width;

  const points = data
    .map((v, i) => {
      const x = data.length === 1 ? width / 2 : i * stepX;
      const y = height - (v / max) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const lastIdx = data.length - 1;
  const lastX = data.length === 1 ? width / 2 : lastIdx * stepX;
  const lastY = height - (data[lastIdx] / max) * (height - 2) - 1;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Verdict counts per day for the last ${data.length} days: ${data.join(', ')}`}
    >
      <polyline
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
      />
      <circle cx={lastX} cy={lastY} r={2} fill="var(--accent)" aria-hidden="true" />
    </svg>
  );
}

function VerdictMixBar({
  approveCount,
  changesCount,
  commentCount,
}: {
  approveCount: number;
  changesCount: number;
  commentCount: number;
}) {
  const total = approveCount + changesCount + commentCount;
  if (total === 0) {
    return (
      <div
        style={{
          height: 6,
          borderRadius: 'var(--radius-full)',
          background: 'var(--bg-elevated-3)',
        }}
      />
    );
  }
  return (
    <div
      role="img"
      aria-label={`Verdict mix: ${approveCount} approved, ${changesCount} changes requested, ${commentCount} comment`}
      style={{
        display: 'flex',
        height: 6,
        borderRadius: 'var(--radius-full)',
        overflow: 'hidden',
        background: 'var(--bg-elevated-3)',
      }}
    >
      {approveCount > 0 && (
        <div style={{ width: `${(approveCount / total) * 100}%`, background: 'var(--color-success)' }} />
      )}
      {changesCount > 0 && (
        <div style={{ width: `${(changesCount / total) * 100}%`, background: 'var(--color-error)' }} />
      )}
      {commentCount > 0 && (
        <div style={{ width: `${(commentCount / total) * 100}%`, background: 'var(--color-warning)' }} />
      )}
    </div>
  );
}

function ReviewsSection() {
  const { currentProject } = useSystem();
  const project = currentProject?.name ?? null;

  const [reviews, setReviews] = useState<ReviewListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Open a short-lived WebSocket to fetch the review list. Kept local so we
  // don't have to touch main.tsx's shared connection wiring.
  useEffect(() => {
    if (!project) {
      setReviews([]);
      return;
    }

    let cancelled = false;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;

    setLoading(true);
    setError(null);

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      setError('Could not connect to review service');
      setLoading(false);
      return;
    }

    const handleOpen = () => {
      ws?.send(JSON.stringify({ action: 'list-reviews', project, limit: 200 }));
    };
    const handleMessage = (event: MessageEvent) => {
      if (cancelled) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg?.type === 'reviews') {
          const payload = msg.payload?.reviews;
          setReviews(Array.isArray(payload) ? payload : []);
          setLoading(false);
          ws?.close();
        }
      } catch { /* ignore non-JSON */ }
    };
    const handleError = () => {
      if (cancelled) return;
      setError('Could not reach review service');
      setLoading(false);
    };

    ws.addEventListener('open', handleOpen);
    ws.addEventListener('message', handleMessage);
    ws.addEventListener('error', handleError);

    return () => {
      cancelled = true;
      ws?.removeEventListener('open', handleOpen);
      ws?.removeEventListener('message', handleMessage);
      ws?.removeEventListener('error', handleError);
      if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    };
  }, [project]);

  const handleRowClick = useCallback((reviewId: string) => {
    navigateToReview(reviewId);
  }, []);

  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTableRowElement>, reviewId: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        navigateToReview(reviewId);
      }
    },
    [],
  );

  // ── Derived metrics ──────────────────────────────────────
  const metrics = useMemo(() => {
    if (!reviews) return null;

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const thisWeek = reviews.filter((r) => r.createdAt >= weekAgo);

    let approveCount = 0;
    let changesCount = 0;
    let commentCount = 0;
    for (const r of thisWeek) {
      if (r.verdict === 'approve') approveCount++;
      else if (r.verdict === 'request-changes') changesCount++;
      else commentCount++;
    }

    // Average findings per review (this week only; meaningful when we have data)
    const findingsThisWeek = thisWeek.reduce((sum, r) => {
      const sc = r.severityCounts;
      return sum + (sc.blocker + sc.error + sc.warn + sc.info + sc.nit);
    }, 0);
    const avgFindings = thisWeek.length > 0 ? findingsThisWeek / thisWeek.length : 0;

    // Top finding category this week
    const categoryCounts: Record<string, number> = {};
    for (const r of thisWeek) {
      if (r.topCategory) {
        categoryCounts[r.topCategory] = (categoryCounts[r.topCategory] ?? 0) + 1;
      }
    }
    const topCategory = Object.entries(categoryCounts).sort(([, a], [, b]) => b - a)[0]?.[0] ?? null;

    // Verdict counts per day for last 14 days (any reviews in range)
    const dayStarts = getLastNDayStarts(14);
    const dayMs = 24 * 60 * 60 * 1000;
    const daily: number[] = dayStarts.map((start) => {
      const end = start + dayMs;
      return reviews.filter((r) => r.createdAt >= start && r.createdAt < end).length;
    });

    // False-positive rate across all reviews
    let totalFindings = 0;
    let dismissed = 0;
    for (const r of reviews) {
      const sc = r.severityCounts;
      totalFindings += sc.blocker + sc.error + sc.warn + sc.info + sc.nit;
      dismissed += r.resolutionCounts.dismissed ?? 0;
    }
    const fpRate = totalFindings > 0 ? (dismissed / totalFindings) * 100 : 0;
    const hasDismissals = dismissed > 0;

    return {
      thisWeekCount: thisWeek.length,
      approveCount,
      changesCount,
      commentCount,
      avgFindings,
      topCategory,
      daily,
      totalFindings,
      dismissed,
      fpRate,
      hasDismissals,
    };
  }, [reviews]);

  const recentReviews = useMemo(() => {
    if (!reviews) return [];
    return [...reviews].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
  }, [reviews]);

  // ── Render ───────────────────────────────────────────────
  return (
    <section aria-label="PR Reviews">
      <h3 style={sectionTitleStyle}>PR Reviews</h3>

      {loading && !reviews && (
        <div style={{ ...cardStyle, padding: 'var(--space-md)', color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>
          Loading reviews...
        </div>
      )}

      {error && !loading && (
        <div style={{ ...cardStyle, padding: 'var(--space-md)', color: 'var(--color-error)', fontSize: 'var(--text-sm)' }} role="alert">
          {error}
        </div>
      )}

      {!loading && !error && reviews && reviews.length === 0 && (
        <div
          style={{
            ...cardStyle,
            padding: 'var(--space-lg)',
            textAlign: 'center',
            color: 'var(--text-tertiary)',
            fontSize: 'var(--text-sm)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--space-sm)',
          }}
        >
          <GitPullRequest size={24} strokeWidth={1.25} style={{ opacity: 0.5 }} aria-hidden="true" />
          <div>
            No reviews yet. Reviews appear after <code style={{ fontFamily: 'var(--font-mono)' }}>anvil review &lt;pr-url&gt;</code>
            {' '}or automatically after pipeline Ship stage.
          </div>
        </div>
      )}

      {!loading && !error && reviews && reviews.length > 0 && metrics && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
          {/* Summary tiles */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 'var(--space-sm)',
            }}
          >
            <div style={cardStyle}>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-xs)' }}>
                Reviews this week
              </div>
              <div
                style={{
                  fontSize: 'var(--text-2xl)', fontWeight: 700,
                  fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', lineHeight: 1.2,
                }}
              >
                {metrics.thisWeekCount}
              </div>
            </div>

            <div style={cardStyle}>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-xs)' }}>
                Verdict mix
              </div>
              <VerdictMixBar
                approveCount={metrics.approveCount}
                changesCount={metrics.changesCount}
                commentCount={metrics.commentCount}
              />
              <div
                style={{
                  display: 'flex', gap: 'var(--space-sm)', marginTop: 'var(--space-xs)',
                  fontSize: 'var(--text-2xs)', fontFamily: 'var(--font-mono)',
                }}
              >
                <span style={{ color: 'var(--color-success)' }}>{metrics.approveCount}</span>
                <span style={{ color: 'var(--color-error)' }}>{metrics.changesCount}</span>
                <span style={{ color: 'var(--color-warning)' }}>{metrics.commentCount}</span>
              </div>
            </div>

            <div style={cardStyle}>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-xs)' }}>
                Avg findings / review
              </div>
              <div
                style={{
                  fontSize: 'var(--text-2xl)', fontWeight: 700,
                  fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', lineHeight: 1.2,
                }}
              >
                {metrics.avgFindings.toFixed(1)}
              </div>
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-tertiary)', marginTop: 'var(--space-xs)' }}>
                last 7 days
              </div>
            </div>

            <div style={cardStyle}>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-xs)' }}>
                Top category
              </div>
              <div
                style={{
                  fontSize: 'var(--text-base)', fontWeight: 600,
                  color: 'var(--text-primary)', lineHeight: 1.2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
                title={metrics.topCategory ?? undefined}
              >
                {metrics.topCategory ?? '—'}
              </div>
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-tertiary)', marginTop: 'var(--space-xs)' }}>
                last 7 days
              </div>
            </div>
          </div>

          {/* Verdict over time (sparkline) + FP rate */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-sm)' }}>
            <div style={cardStyle}>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-sm)' }}>
                Reviews over last 14 days
              </div>
              <Sparkline data={metrics.daily} />
            </div>

            <div style={cardStyle}>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-sm)' }}>
                False-positive rate
              </div>
              {metrics.hasDismissals ? (
                <div
                  style={{
                    fontSize: 'var(--text-lg)', fontWeight: 600,
                    fontFamily: 'var(--font-mono)', color: 'var(--text-primary)',
                  }}
                >
                  {metrics.fpRate.toFixed(1)}%
                  <span
                    style={{
                      marginLeft: 'var(--space-sm)',
                      fontSize: 'var(--text-xs)', fontWeight: 400,
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    ({metrics.dismissed} of {metrics.totalFindings} findings dismissed)
                  </span>
                </div>
              ) : (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                  No dismissals yet — waiting for signal.
                </div>
              )}
            </div>
          </div>

          {/* Recent reviews table */}
          <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
            <table
              style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}
              aria-label="Recent reviews"
            >
              <thead>
                <tr>
                  {['PR', 'Verdict', 'Findings', 'Age'].map((header, idx) => (
                    <th
                      key={header}
                      scope="col"
                      style={{
                        textAlign: idx === 0 ? 'left' : idx === 3 ? 'right' : 'left',
                        padding: '10px 14px',
                        fontSize: 'var(--text-xs)',
                        fontWeight: 500,
                        color: 'var(--text-tertiary)',
                        borderBottom: '1px solid var(--separator)',
                        background: 'var(--bg-elevated-3)',
                      }}
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentReviews.map((r, i) => {
                  const sc = r.severityCounts;
                  const blockerCount = sc.blocker ?? 0;
                  const errorCount = sc.error ?? 0;
                  const warnCount = sc.warn ?? 0;
                  return (
                    <tr
                      key={r.reviewId}
                      tabIndex={0}
                      role="link"
                      aria-label={`Open review for ${r.prTitle}`}
                      onClick={() => handleRowClick(r.reviewId)}
                      onKeyDown={(e) => handleRowKeyDown(e, r.reviewId)}
                      style={{
                        background: i % 2 === 1 ? 'rgba(255,255,255,0.015)' : 'transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <td
                        style={{
                          padding: '10px 14px',
                          color: 'var(--text-primary)',
                          maxWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={r.prTitle}
                      >
                        {r.prTitle}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <VerdictBadge verdict={r.verdict} />
                      </td>
                      <td
                        style={{
                          padding: '10px 14px',
                          fontSize: 'var(--text-xs)',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text-secondary)',
                          display: 'flex',
                          gap: 'var(--space-sm)',
                        }}
                      >
                        {blockerCount > 0 && (
                          <span style={{ color: 'var(--color-error)' }} title="Blockers">
                            B:{blockerCount}
                          </span>
                        )}
                        {errorCount > 0 && (
                          <span style={{ color: 'var(--color-error)' }} title="Errors">
                            E:{errorCount}
                          </span>
                        )}
                        {warnCount > 0 && (
                          <span style={{ color: 'var(--color-warning)' }} title="Warnings">
                            W:{warnCount}
                          </span>
                        )}
                        {blockerCount + errorCount + warnCount === 0 && (
                          <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: '10px 14px',
                          textAlign: 'right',
                          fontSize: 'var(--text-xs)',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text-tertiary)',
                        }}
                      >
                        {formatAge(r.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

export default StatsPage;
