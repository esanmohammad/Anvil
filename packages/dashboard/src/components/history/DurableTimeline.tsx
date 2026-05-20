/**
 * Durable execution timeline view.
 *
 * Renders the per-stage execution log for a single run by reading the
 * durable event stream via the `get-durable-timeline` WS message.
 * Groups raw `step:started` + `step:completed` / `step:failed` events
 * into one row per stage with human-readable labels, status icons,
 * and elapsed durations. The raw event log is hidden behind a
 * "Show raw events" toggle for debugging.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, XCircle, Loader2, Circle, Clock, AlertCircle } from 'lucide-react';

interface DurableEvent {
  runId: string;
  seq: number;
  kind: string;
  stepId: string | null;
  effectKey: string | null;
  effectIdx: number | null;
  payload: unknown;
  ts: string;
}

interface DurableRun {
  runId: string;
  project: string;
  feature: string;
  featureSlug: string;
  status: string;
  currentStep: string | null;
  cursorSeq: number;
  startedAt: string;
  updatedAt: string;
  leaseHolder: string | null;
  leaseExpires: string | null;
  workflowVer: number;
}

interface StageRow {
  stepId: string;
  label: string;
  startedAt: string | null;
  endedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  errorMessage: string | null;
}

const STAGE_LABELS: Record<string, string> = {
  clarify: 'Understanding',
  requirements: 'Planning Requirements',
  'repo-requirements': 'Repo Requirements',
  specs: 'Writing Specs',
  tasks: 'Creating Tasks',
  build: 'Writing Code',
  test: 'Generating Tests',
  validate: 'Testing',
  ship: 'Shipping',
};

function humanStageLabel(stepId: string | null): string {
  if (!stepId) return 'Unknown';
  return STAGE_LABELS[stepId] ?? stepId;
}

function rollupStages(events: DurableEvent[]): StageRow[] {
  const byStep = new Map<string, StageRow>();
  const order: string[] = [];
  for (const ev of events) {
    if (!ev.stepId || !ev.kind.startsWith('step:')) continue;
    let row = byStep.get(ev.stepId);
    if (!row) {
      row = {
        stepId: ev.stepId,
        label: humanStageLabel(ev.stepId),
        startedAt: null,
        endedAt: null,
        status: 'running',
        errorMessage: null,
      };
      byStep.set(ev.stepId, row);
      order.push(ev.stepId);
    }
    if (ev.kind === 'step:started') {
      row.startedAt = ev.ts;
      row.status = 'running';
    } else if (ev.kind === 'step:completed') {
      row.endedAt = ev.ts;
      row.status = 'completed';
    } else if (ev.kind === 'step:failed') {
      row.endedAt = ev.ts;
      row.status = 'failed';
      const payload = ev.payload as { error?: { message?: string } } | null;
      row.errorMessage = payload?.error?.message ?? null;
    } else if (ev.kind === 'step:skipped') {
      row.endedAt = ev.ts;
      row.status = 'skipped';
    }
  }
  return order.map((id) => byStep.get(id)!);
}

function formatDuration(startISO: string | null, endISO: string | null): string {
  if (!startISO) return '';
  const start = Date.parse(startISO);
  const end = endISO ? Date.parse(endISO) : Date.now();
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

function formatClockTime(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return '';
  }
}

function StatusIcon({ status }: { status: StageRow['status'] }) {
  const size = 16;
  if (status === 'completed') return <CheckCircle2 size={size} style={{ color: 'var(--color-success, #00b289)' }} />;
  if (status === 'failed') return <XCircle size={size} style={{ color: 'var(--color-error, #ff4949)' }} />;
  if (status === 'skipped') return <Circle size={size} style={{ color: 'var(--text-muted, #666)' }} />;
  return <Loader2 size={size} style={{ color: 'var(--color-warning, #f0a020)', animation: 'spin 1.4s linear infinite' }} />;
}

export interface DurableTimelineProps {
  runId: string;
  ws?: WebSocket | null;
}

export function DurableTimeline({ runId, ws }: DurableTimelineProps) {
  const [run, setRun] = useState<DurableRun | null>(null);
  const [events, setEvents] = useState<DurableEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setLoading(true);
    setError(null);

    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'durable-timeline' && msg.payload?.runId === runId) {
          setRun(msg.payload.run ?? null);
          setEvents(Array.isArray(msg.payload.events) ? msg.payload.events : []);
          setLoading(false);
        }
        if (msg.type === 'error' && typeof msg.payload?.message === 'string'
            && msg.payload.message.includes('durable-timeline')) {
          setError(msg.payload.message);
          setLoading(false);
        }
      } catch {
        /* ignore malformed messages */
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ action: 'get-durable-timeline', runId }));

    return () => {
      ws.removeEventListener('message', handler);
    };
  }, [ws, runId]);

  const stages = useMemo(() => rollupStages(events), [events]);

  if (loading) return <div style={styles.muted}>Loading execution log…</div>;
  if (error) return <div style={styles.error}>{error}</div>;
  if (!run) {
    return (
      <div style={styles.empty}>
        <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>This run hasn't been logged to durable storage. It may pre-date durable execution; use the Activity tab to see what happened.</span>
      </div>
    );
  }
  if (stages.length === 0) {
    return (
      <div style={styles.empty}>
        <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>No stages were recorded for this run.</span>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.stageList}>
        {stages.map((stage, i) => (
          <div key={stage.stepId} style={styles.stageRow}>
            <div style={styles.stageIcon}><StatusIcon status={stage.status} /></div>
            <div style={styles.stageBody}>
              <div style={styles.stageHeader}>
                <span style={styles.stageNum}>{i + 1}</span>
                <span style={styles.stageName}>{stage.label}</span>
                <span style={{
                  ...styles.statusBadge,
                  ...(stage.status === 'completed' ? styles.badgeCompleted : {}),
                  ...(stage.status === 'failed' ? styles.badgeFailed : {}),
                  ...(stage.status === 'running' ? styles.badgeRunning : {}),
                  ...(stage.status === 'skipped' ? styles.badgeSkipped : {}),
                }}>{stage.status}</span>
              </div>
              <div style={styles.stageMeta}>
                {stage.startedAt && (
                  <span style={styles.metaItem}>
                    <Clock size={11} /> {formatClockTime(stage.startedAt)}
                    {stage.endedAt && stage.status !== 'running' ? ` · ${formatDuration(stage.startedAt, stage.endedAt)}` : null}
                    {stage.status === 'running' && ' · in progress…'}
                  </span>
                )}
              </div>
              {stage.errorMessage && (
                <div style={styles.errorBox}>{stage.errorMessage}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setShowRaw((v) => !v)}
        style={styles.rawToggle}
      >
        {showRaw ? '▼' : '▶'} Raw events ({events.length})
      </button>

      {showRaw && (
        <div style={styles.rawList}>
          {events.map((e) => (
            <div key={`${e.runId}-${e.seq}`} style={styles.rawRow}>
              <span style={styles.rawSeq}>{e.seq}</span>
              <span style={styles.rawTs}>{formatClockTime(e.ts)}</span>
              <span style={{
                ...styles.rawKind,
                color: e.kind.includes('completed') ? 'var(--color-success, #00b289)'
                  : e.kind.includes('failed') ? 'var(--color-error, #ff4949)'
                  : 'var(--text-secondary, #aaa)',
              }}>{e.kind}</span>
              <span style={styles.rawStep}>{e.stepId ?? e.effectKey ?? ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-sm)',
    fontSize: 13,
  },
  stageList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  stageRow: {
    display: 'flex',
    gap: 12,
    padding: '10px 12px',
    background: 'var(--bg-elevated-2, #1a1a1a)',
    border: '1px solid var(--border-default, #2a2a2a)',
    borderRadius: 'var(--radius-sm)',
  },
  stageIcon: {
    display: 'flex',
    alignItems: 'flex-start',
    paddingTop: 2,
  },
  stageBody: {
    flex: 1,
    minWidth: 0,
  },
  stageHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  stageNum: {
    fontSize: 11,
    color: 'var(--text-muted, #666)',
    fontFamily: 'var(--font-mono, monospace)',
    minWidth: 16,
  },
  stageName: {
    fontWeight: 600,
    fontSize: 13,
    color: 'var(--text-primary, #fff)',
  },
  statusBadge: {
    fontSize: 10,
    fontWeight: 500,
    padding: '2px 7px',
    borderRadius: 'var(--radius-xs, 3px)',
    textTransform: 'capitalize',
    background: 'var(--bg-elevated-3, #2a2a2a)',
    color: 'var(--text-secondary, #aaa)',
  },
  badgeCompleted: {
    background: 'rgba(0,178,137,0.12)',
    color: 'var(--color-success, #00b289)',
  },
  badgeFailed: {
    background: 'rgba(255,73,73,0.12)',
    color: 'var(--color-error, #ff4949)',
  },
  badgeRunning: {
    background: 'rgba(240,160,32,0.12)',
    color: 'var(--color-warning, #f0a020)',
  },
  badgeSkipped: {
    background: 'var(--bg-elevated-3, #2a2a2a)',
    color: 'var(--text-muted, #666)',
  },
  stageMeta: {
    display: 'flex',
    gap: 12,
    fontSize: 11,
    color: 'var(--text-tertiary, #888)',
  },
  metaItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontFamily: 'var(--font-mono, monospace)',
  },
  errorBox: {
    marginTop: 6,
    padding: '6px 10px',
    fontSize: 11,
    color: 'var(--color-error, #ff4949)',
    background: 'rgba(255,73,73,0.06)',
    border: '1px solid rgba(255,73,73,0.18)',
    borderRadius: 'var(--radius-xs, 3px)',
    fontFamily: 'var(--font-mono, monospace)',
    wordBreak: 'break-word',
  },
  rawToggle: {
    alignSelf: 'flex-start',
    background: 'none',
    border: 'none',
    color: 'var(--text-tertiary, #888)',
    fontSize: 11,
    cursor: 'pointer',
    padding: '4px 0',
    fontFamily: 'var(--font-mono, monospace)',
  },
  rawList: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: 320,
    overflowY: 'auto',
    background: 'var(--bg-elevated-1, #0d0d0d)',
    border: '1px solid var(--border-subtle, #1a1a1a)',
    borderRadius: 'var(--radius-xs, 3px)',
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: 11,
  },
  rawRow: {
    display: 'grid',
    gridTemplateColumns: '28px 64px 120px 1fr',
    gap: 8,
    padding: '3px 8px',
    borderBottom: '1px solid var(--border-subtle, #181818)',
  },
  rawSeq: { color: 'var(--text-muted, #666)', textAlign: 'right' },
  rawTs: { color: 'var(--text-muted, #666)' },
  rawKind: { fontWeight: 600 },
  rawStep: { color: 'var(--text-secondary, #aaa)' },
  muted: {
    color: 'var(--text-muted, #888)',
    fontSize: 12,
    padding: 'var(--space-sm)',
  },
  empty: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
    color: 'var(--text-tertiary, #888)',
    fontSize: 12,
    padding: 'var(--space-sm)',
    lineHeight: 1.5,
  },
  error: {
    color: 'var(--color-error, #ff4949)',
    padding: 'var(--space-sm)',
  },
};

export default DurableTimeline;
