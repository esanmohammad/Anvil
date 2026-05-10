/**
 * Durable execution timeline view (Phase F8).
 *
 * Renders the per-event log for a single run by reading from the
 * durable store via the `get-durable-timeline` WS message
 * (Phase D5 endpoint). Vertical list, one row per event:
 *   seq · kind · stepId · effectKey · summary
 *
 * Filter chips: step:* / effect:* / signal:* / all.
 *
 * Lightweight by design — the dashboard's existing `RunTimeline`
 * shows high-level stage status; this component is the diagnostic
 * deep-dive surface for replay debugging.
 */

import React, { useEffect, useMemo, useState } from 'react';

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

type Filter = 'all' | 'steps' | 'effects' | 'signals' | 'web' | 'browser' | 'computer';

const KIND_COLORS: Record<string, string> = {
  'step:started': 'var(--color-primary, #0066ff)',
  'step:completed': 'var(--color-success, #00b289)',
  'step:failed': 'var(--color-error, #ff4949)',
  'step:skipped': 'var(--color-text-muted, #888)',
  'effect:started': 'var(--color-primary, #0066ff)',
  'effect:completed': 'var(--color-text, #fff)',
  'effect:failed': 'var(--color-error, #ff4949)',
  'signal:received': 'var(--color-warning, #ffaa00)',
  'reviewer:decision': 'var(--color-warning, #ffaa00)',
};

function summarisePayload(payload: unknown, effectKey: string | null = null): string {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') return payload.slice(0, 80);
  if (typeof payload !== 'object') return String(payload);
  const obj = payload as Record<string, unknown>;
  // Phase H9 — surface web/browser/computer summaries up front.
  if (effectKey?.startsWith('web:search')) {
    if (typeof obj.query === 'string') return `q="${obj.query.slice(0, 60)}"`;
  }
  if (effectKey?.startsWith('web:fetch')) {
    if (typeof obj.url === 'string') return obj.url.slice(0, 80);
  }
  if (effectKey?.startsWith('browser:navigate')) {
    if (typeof obj.url === 'string') return obj.url.slice(0, 80);
  }
  if (effectKey?.startsWith('browser:click')) {
    if (typeof obj.index === 'number') return `[${obj.index}]`;
  }
  if (effectKey?.startsWith('browser:screenshot')) {
    return `(thumbnail)`;
  }
  if (effectKey?.startsWith('computer:action')) {
    if (typeof obj.action === 'string') return obj.action;
  }
  if (typeof obj.message === 'string') return obj.message.slice(0, 80);
  if (typeof obj.idempotencyKey === 'string') return `key=${obj.idempotencyKey}`;
  if (typeof obj.version === 'number') return `v${obj.version}`;
  if (typeof obj.durationMs === 'number') return `${Math.round(obj.durationMs as number)}ms`;
  if (typeof obj.reason === 'string') return obj.reason;
  try {
    const json = JSON.stringify(obj);
    return json.length > 80 ? json.slice(0, 77) + '...' : json;
  } catch {
    return '';
  }
}

function formatTs(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  } catch {
    return ts;
  }
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
  const [filter, setFilter] = useState<Filter>('all');

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
    ws.send(JSON.stringify({ type: 'get-durable-timeline', runId }));

    return () => {
      ws.removeEventListener('message', handler);
    };
  }, [ws, runId]);

  const filtered = useMemo(() => {
    if (filter === 'all') return events;
    return events.filter((e) => {
      if (filter === 'steps') return e.kind.startsWith('step:');
      if (filter === 'effects') return e.kind.startsWith('effect:');
      if (filter === 'signals') return e.kind.startsWith('signal:') || e.kind === 'reviewer:decision';
      // Phase H9 — web/browser/computer filter chips. effectKey shape is
      // `<namespace>:<verb>:...` (see core-pipeline browser-web-tools §J).
      if (filter === 'web') return (e.effectKey ?? '').startsWith('web:');
      if (filter === 'browser') return (e.effectKey ?? '').startsWith('browser:');
      if (filter === 'computer') return (e.effectKey ?? '').startsWith('computer:');
      return true;
    });
  }, [events, filter]);

  if (loading) return <div style={styles.muted}>Loading durable timeline…</div>;
  if (error) return <div style={styles.error}>{error}</div>;
  if (!run) {
    return (
      <div style={styles.muted}>
        No durable record for run <code>{runId}</code>.
        This run may pre-date durable execution; use the Activity tab for
        Pattern-1 audit log replay.
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div>
          <strong>Run:</strong> <code>{run.runId}</code>
          {' · '}
          <strong>Status:</strong> <span style={{ color: KIND_COLORS[`step:${run.status}`] ?? 'inherit' }}>{run.status}</span>
          {' · '}
          <strong>Cursor:</strong> {run.cursorSeq}
          {' · '}
          <strong>Workflow:</strong> v{run.workflowVer}
          {run.leaseHolder ? <> {' · '} <strong>Lease:</strong> {run.leaseHolder} </> : null}
        </div>
      </div>
      <div style={styles.filters}>
        {(['all', 'steps', 'effects', 'signals', 'web', 'browser', 'computer'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            style={{
              ...styles.filterButton,
              background: filter === f ? 'var(--color-primary, #0066ff)' : 'transparent',
              color: filter === f ? '#fff' : 'inherit',
            }}
          >
            {f} {f === filter ? `(${filtered.length})` : ''}
          </button>
        ))}
        <span style={styles.muted}>{events.length} total event(s)</span>
      </div>
      <div style={styles.list}>
        {filtered.length === 0 ? (
          <div style={styles.muted}>No events match this filter.</div>
        ) : (
          filtered.map((e) => (
            <div key={`${e.runId}-${e.seq}`} style={styles.row}>
              <div style={styles.seq}>{e.seq}</div>
              <div style={styles.ts}>{formatTs(e.ts)}</div>
              <div style={{ ...styles.kind, color: KIND_COLORS[e.kind] ?? 'inherit' }}>{e.kind}</div>
              <div style={styles.target}>
                {e.stepId ? <span style={styles.stepId}>{e.stepId}</span> : null}
                {e.effectKey ? (
                  <span style={styles.effectKey}>
                    {e.effectKey}{e.effectIdx !== null ? `#${e.effectIdx}` : ''}
                  </span>
                ) : null}
              </div>
              <div style={styles.summary}>{summarisePayload(e.payload, e.effectKey)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-sm)',
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: 12,
  },
  header: {
    padding: 'var(--space-sm)',
    background: 'var(--color-surface-2, #1a1a1a)',
    borderRadius: 'var(--radius-sm)',
  },
  filters: {
    display: 'flex',
    gap: 'var(--space-xs)',
    alignItems: 'center',
  },
  filterButton: {
    padding: '4px 10px',
    border: '1px solid var(--color-border, #333)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 11,
    cursor: 'pointer',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: 480,
    overflowY: 'auto',
    background: 'var(--color-surface-1, #0d0d0d)',
    border: '1px solid var(--color-border, #222)',
    borderRadius: 'var(--radius-sm)',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '40px 88px 130px 1fr 1.4fr',
    gap: 'var(--space-sm)',
    padding: '4px 8px',
    borderBottom: '1px solid var(--color-border-subtle, #181818)',
  },
  seq: { color: 'var(--color-text-muted, #888)', textAlign: 'right' },
  ts: { color: 'var(--color-text-muted, #888)' },
  kind: { fontWeight: 600 },
  target: { display: 'flex', flexDirection: 'column', gap: 1 },
  stepId: { color: 'var(--color-text, #fff)' },
  effectKey: { color: 'var(--color-text-muted, #aaa)', fontSize: 11 },
  summary: { color: 'var(--color-text-muted, #aaa)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  muted: { color: 'var(--color-text-muted, #888)', fontSize: 12, padding: 'var(--space-sm)' },
  error: { color: 'var(--color-error, #ff4949)', padding: 'var(--space-sm)' },
};

export default DurableTimeline;
