/** CostBreachHistoryPage — sortable table of past cost breaches with inline expand for details. */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { fmtUsd } from '../../lib/cost-tier.js';

type BreachStatus = 'pending' | 'raised' | 'rejected' | 'auto-resolved';
type BreachDecision = 'raise' | 'reject' | 'extend' | null;

interface BreachState {
  runId: string;
  project: string;
  status: BreachStatus;
  decision?: BreachDecision;
  decisionAt?: string;
  breachedAt: string;
  graceEndsAt: string;
  currentUsdAtBreach: number;
  limitUsdAtBreach: number;
  deltaUsdApproved?: number;
  extensionsUsed: number;
  topSpenders?: Array<{ stage: string; usd: number }>;
}

type SortKey = 'breachedAt' | 'overBy' | 'limit' | 'latency' | 'decision';
type SortDir = 'asc' | 'desc';

export interface CostBreachHistoryPageProps {
  project: string | null;
  ws: WebSocket | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isBreachState(v: unknown): v is BreachState {
  if (!isRecord(v)) return false;
  if (typeof v.runId !== 'string') return false;
  if (typeof v.project !== 'string') return false;
  if (typeof v.status !== 'string') return false;
  if (typeof v.breachedAt !== 'string') return false;
  if (typeof v.graceEndsAt !== 'string') return false;
  if (typeof v.currentUsdAtBreach !== 'number') return false;
  if (typeof v.limitUsdAtBreach !== 'number') return false;
  if (typeof v.extensionsUsed !== 'number') return false;
  return true;
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = Math.max(0, Date.now() - t);
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return `${mo}mo ago`;
}

function fmtLatency(breachedAt: string, decisionAt?: string): string {
  if (!decisionAt) return '—';
  const a = Date.parse(breachedAt);
  const b = Date.parse(decisionAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '—';
  const sec = Math.max(0, Math.round((b - a) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

function latencySeconds(breachedAt: string, decisionAt?: string): number | null {
  if (!decisionAt) return null;
  const a = Date.parse(breachedAt);
  const b = Date.parse(decisionAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 1000));
}

function decisionLabel(b: BreachState): string {
  if (b.status === 'auto-resolved') return 'auto-resolved';
  if (b.decision) return b.decision;
  return b.status;
}

function decisionPillColors(label: string): { bg: string; fg: string } {
  switch (label) {
    case 'raise':
    case 'raised':
      return { bg: 'rgba(34,197,94,0.12)', fg: 'var(--color-success)' };
    case 'reject':
    case 'rejected':
      return { bg: 'rgba(239,68,68,0.12)', fg: 'var(--color-error)' };
    case 'extend':
      return { bg: 'rgba(251,191,36,0.12)', fg: 'var(--color-warning)' };
    case 'auto-resolved':
      return { bg: 'rgba(148,163,184,0.12)', fg: 'var(--text-tertiary)' };
    case 'pending':
    default:
      return { bg: 'rgba(148,163,184,0.12)', fg: 'var(--text-tertiary)' };
  }
}

export function CostBreachHistoryPage({
  project,
  ws,
}: CostBreachHistoryPageProps): JSX.Element {
  const [breaches, setBreaches] = useState<BreachState[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [sortKey, setSortKey] = useState<SortKey>('breachedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const projectRef = useRef<string | null>(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  // Send list request on mount + when project changes.
  useEffect(() => {
    if (!ws) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    setLoading(() => true);
    setExpandedRunId(() => null);
    const payload: { action: string; project?: string } = { action: 'list-cost-breaches' };
    if (project) payload.project = project;
    ws.send(JSON.stringify(payload));
  }, [ws, project]);

  // Listen for cost-breaches messages.
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent): void => {
      let msg: { type?: string; payload?: unknown };
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (msg.type !== 'cost-breaches') return;
      if (!isRecord(msg.payload)) return;
      const list = msg.payload.breaches;
      if (!Array.isArray(list)) return;
      const next: BreachState[] = list.filter(isBreachState);
      const expectedProject = projectRef.current;
      const filtered = expectedProject
        ? next.filter((b) => b.project === expectedProject)
        : next;
      setBreaches(() => filtered);
      setLoading(() => false);
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  const sorted = useMemo(() => {
    const list = breaches.slice();
    list.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'breachedAt': {
          cmp = Date.parse(a.breachedAt) - Date.parse(b.breachedAt);
          break;
        }
        case 'overBy': {
          cmp =
            (a.currentUsdAtBreach - a.limitUsdAtBreach) -
            (b.currentUsdAtBreach - b.limitUsdAtBreach);
          break;
        }
        case 'limit': {
          cmp = a.limitUsdAtBreach - b.limitUsdAtBreach;
          break;
        }
        case 'latency': {
          const la = latencySeconds(a.breachedAt, a.decisionAt);
          const lb = latencySeconds(b.breachedAt, b.decisionAt);
          if (la === null && lb === null) cmp = 0;
          else if (la === null) cmp = 1;
          else if (lb === null) cmp = -1;
          else cmp = la - lb;
          break;
        }
        case 'decision': {
          cmp = decisionLabel(a).localeCompare(decisionLabel(b));
          break;
        }
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [breaches, sortKey, sortDir]);

  const aggregates = useMemo(() => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = breaches.filter((b) => {
      const t = Date.parse(b.breachedAt);
      return Number.isFinite(t) && t >= cutoff;
    });
    let raised = 0;
    let rejected = 0;
    let extended = 0;
    let autoResolved = 0;
    let latencySum = 0;
    let latencyCount = 0;
    for (const b of recent) {
      const label = decisionLabel(b);
      if (label === 'raise' || label === 'raised' || b.status === 'raised') raised += 1;
      else if (label === 'reject' || label === 'rejected' || b.status === 'rejected') rejected += 1;
      else if (label === 'extend') extended += 1;
      else if (label === 'auto-resolved') autoResolved += 1;
      const lat = latencySeconds(b.breachedAt, b.decisionAt);
      if (lat !== null) {
        latencySum += lat;
        latencyCount += 1;
      }
    }
    const avgLatency = latencyCount > 0 ? Math.round(latencySum / latencyCount) : null;
    return {
      total: recent.length,
      raised,
      rejected,
      extended,
      autoResolved,
      avgLatency,
    };
  }, [breaches]);

  const handleSort = (key: SortKey): void => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDir(() => (key === 'breachedAt' ? 'desc' : 'asc'));
      return key;
    });
  };

  const toggleExpand = (runId: string): void => {
    setExpandedRunId((prev) => (prev === runId ? null : runId));
  };

  if (loading) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: 'var(--text-tertiary)' }}>
        Loading breach history…
      </div>
    );
  }

  if (breaches.length === 0) {
    return (
      <div
        style={{
          padding: 24,
          borderRadius: 'var(--radius-md)',
          border: '1px dashed var(--separator)',
          color: 'var(--text-tertiary)',
          fontSize: 12,
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <ShieldCheck size={20} aria-hidden="true" />
        <span>No cost breaches recorded yet.</span>
      </div>
    );
  }

  const avgLatencyDisplay =
    aggregates.avgLatency === null
      ? '—'
      : aggregates.avgLatency < 60
        ? `${aggregates.avgLatency}s`
        : (() => {
            const m = Math.floor(aggregates.avgLatency / 60);
            const r = aggregates.avgLatency % 60;
            return r === 0 ? `${m}m` : `${m}m ${r}s`;
          })();

  return (
    <section
      style={{
        padding: 16,
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
          fontSize: 12,
          color: 'var(--text-secondary)',
          flexWrap: 'wrap',
        }}
      >
        <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>
          Last 30 days:
        </strong>
        <span>
          {aggregates.total} breach{aggregates.total === 1 ? '' : 'es'}
        </span>
        <span aria-hidden="true">·</span>
        <span>{aggregates.raised} raised</span>
        <span aria-hidden="true">·</span>
        <span>{aggregates.rejected} rejected</span>
        <span aria-hidden="true">·</span>
        <span>{aggregates.extended} extended</span>
        <span aria-hidden="true">·</span>
        <span>{aggregates.autoResolved} auto-resolved</span>
        <span aria-hidden="true">·</span>
        <span>avg decision latency {avgLatencyDisplay}</span>
      </header>

      <table
        style={{
          width: '100%',
          fontSize: 12,
          borderCollapse: 'collapse',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--text-tertiary)' }}>
            <SortHeader
              label="When"
              active={sortKey === 'breachedAt'}
              dir={sortDir}
              onClick={() => handleSort('breachedAt')}
            />
            <th style={{ padding: '4px 8px' }}>Run</th>
            <SortHeader
              label="Over by"
              active={sortKey === 'overBy'}
              dir={sortDir}
              onClick={() => handleSort('overBy')}
            />
            <SortHeader
              label="Limit"
              active={sortKey === 'limit'}
              dir={sortDir}
              onClick={() => handleSort('limit')}
            />
            <SortHeader
              label="Decision"
              active={sortKey === 'decision'}
              dir={sortDir}
              onClick={() => handleSort('decision')}
            />
            <SortHeader
              label="Latency"
              active={sortKey === 'latency'}
              dir={sortDir}
              onClick={() => handleSort('latency')}
            />
          </tr>
        </thead>
        <tbody>
          {sorted.map((b) => {
            const expanded = expandedRunId === b.runId;
            const overBy = Math.max(0, b.currentUsdAtBreach - b.limitUsdAtBreach);
            const label = decisionLabel(b);
            const pill = decisionPillColors(label);
            return (
              <React.Fragment key={b.runId}>
                <tr
                  onClick={() => toggleExpand(b.runId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleExpand(b.runId);
                    }
                  }}
                  tabIndex={0}
                  aria-expanded={expanded}
                  role="button"
                  style={{
                    borderTop: '1px solid var(--separator)',
                    cursor: 'pointer',
                    background: expanded ? 'var(--bg-hover, rgba(148,163,184,0.06))' : 'transparent',
                  }}
                >
                  <td style={{ padding: '8px' }}>{relativeTime(b.breachedAt)}</td>
                  <td
                    style={{
                      padding: '8px',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {b.runId.slice(0, 8)}
                  </td>
                  <td
                    style={{
                      padding: '8px',
                      color: 'var(--color-error)',
                      fontWeight: 600,
                    }}
                  >
                    {fmtUsd(overBy)}
                  </td>
                  <td style={{ padding: '8px' }}>{fmtUsd(b.limitUsdAtBreach)}</td>
                  <td style={{ padding: '8px' }}>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '2px 8px',
                        borderRadius: 'var(--radius-full, 9999px)',
                        background: pill.bg,
                        color: pill.fg,
                        fontSize: 11,
                        fontWeight: 600,
                        textTransform: 'capitalize',
                      }}
                    >
                      {label}
                    </span>
                  </td>
                  <td style={{ padding: '8px' }}>{fmtLatency(b.breachedAt, b.decisionAt)}</td>
                </tr>
                {expanded && (
                  <tr style={{ background: 'var(--bg-elevated-1, rgba(0,0,0,0.15))' }}>
                    <td colSpan={6} style={{ padding: '12px 16px' }}>
                      <BreachDetails breach={b} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}): JSX.Element {
  return (
    <th
      style={{
        padding: '4px 8px',
        cursor: 'pointer',
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={onClick}
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
          fontWeight: active ? 600 : 400,
          fontSize: 12,
          cursor: 'pointer',
          font: 'inherit',
        }}
      >
        {label}
        {active && (
          <span aria-hidden="true" style={{ marginLeft: 4 }}>
            {dir === 'asc' ? '▲' : '▼'}
          </span>
        )}
      </button>
    </th>
  );
}

function BreachDetails({ breach }: { breach: BreachState }): JSX.Element {
  const spenders = breach.topSpenders ?? [];
  const topMax = spenders.length > 0
    ? Math.max(1, ...spenders.map((s) => s.usd))
    : 1;
  const showDelta = (breach.status === 'raised' || breach.decision === 'raise') &&
    typeof breach.deltaUsdApproved === 'number';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', color: 'var(--text-secondary)' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Run</div>
          <div style={{ fontFamily: 'var(--font-mono)' }}>{breach.runId}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Extensions used</div>
          <div>{breach.extensionsUsed}</div>
        </div>
        {showDelta && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Δ approved</div>
            <div style={{ color: 'var(--color-success)', fontWeight: 600 }}>
              +{fmtUsd(breach.deltaUsdApproved)}
            </div>
          </div>
        )}
      </div>

      {spenders.length > 0 && (
        <div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              marginBottom: 6,
            }}
          >
            Top spenders
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {spenders.map((s) => (
              <div
                key={s.stage}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    width: 100,
                    textTransform: 'capitalize',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {s.stage}
                </span>
                <span
                  style={{
                    flex: 1,
                    height: 6,
                    background: 'var(--bg-hover, rgba(148,163,184,0.12))',
                    borderRadius: 'var(--radius-full, 9999px)',
                    overflow: 'hidden',
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      height: '100%',
                      width: `${Math.round((s.usd / topMax) * 100)}%`,
                      background: 'var(--color-error)',
                    }}
                  />
                </span>
                <span
                  style={{
                    width: 60,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {fmtUsd(s.usd)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default CostBreachHistoryPage;
