/**
 * Per-tool cost panel (Phase H9). Reads the durable timeline events for
 * a run, aggregates payloads by effectKey namespace, and renders a
 * small per-tool spend table:
 *
 *   web.search    3 calls   $0.009
 *   web.fetch     5 calls   $0.045
 *   browser.*    12 calls   $0.180
 *   computer.*    2 calls   $0.090
 *
 * Lightweight client-only aggregation — no separate WS message; uses
 * the same `durable-timeline` payload as the existing
 * `DurableTimeline` component.
 */

import React, { useEffect, useMemo, useState } from 'react';

interface DurableEvent {
  runId: string;
  seq: number;
  kind: string;
  effectKey: string | null;
  payload: unknown;
  ts: string;
}

export interface ToolCostPanelProps {
  runId: string;
  ws?: WebSocket | null;
}

// Coarse per-tool unit cost estimates (matches §I of the plan; rounded).
const UNIT_USD: Record<string, number> = {
  'web:search': 0.003,
  'web:fetch': 0.01,
  'browser:navigate': 0.015,
  'browser:click': 0.015,
  'browser:input': 0.015,
  'browser:scroll': 0.015,
  'browser:screenshot': 0.045,
  'browser:extract': 0.012,
  'browser:evaluate': 0.015,
  'browser:console': 0.005,
  'browser:network': 0.005,
  'computer:action': 0.045,
};

function bucketFor(effectKey: string): string {
  for (const k of Object.keys(UNIT_USD)) {
    if (effectKey.startsWith(k)) return k;
  }
  return '';
}

interface Bucket { calls: number; usd: number }

export function ToolCostPanel({ runId, ws }: ToolCostPanelProps) {
  const [events, setEvents] = useState<DurableEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setLoading(true);
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'durable-timeline' && msg.payload?.runId === runId) {
          setEvents(Array.isArray(msg.payload.events) ? msg.payload.events : []);
          setLoading(false);
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ type: 'get-durable-timeline', runId }));
    return () => ws.removeEventListener('message', handler);
  }, [ws, runId]);

  const buckets = useMemo<Map<string, Bucket>>(() => {
    const out = new Map<string, Bucket>();
    let total = 0;
    for (const e of events) {
      if (!e.effectKey) continue;
      if (e.kind !== 'effect:completed') continue;
      const k = bucketFor(e.effectKey);
      if (!k) continue;
      const cur = out.get(k) ?? { calls: 0, usd: 0 };
      cur.calls += 1;
      cur.usd += UNIT_USD[k];
      out.set(k, cur);
      total += UNIT_USD[k];
    }
    out.set('TOTAL', { calls: events.length, usd: total });
    return out;
  }, [events]);

  if (loading) return <div style={styles.muted}>Loading tool costs…</div>;

  const rows: Array<[string, Bucket]> = [];
  for (const [k, v] of buckets.entries()) {
    if (k === 'TOTAL') continue;
    rows.push([k, v]);
  }
  rows.sort((a, b) => b[1].usd - a[1].usd);
  const total = buckets.get('TOTAL') ?? { calls: 0, usd: 0 };

  return (
    <div style={styles.container}>
      <div style={styles.header}>Per-tool cost (estimated)</div>
      {rows.length === 0 ? (
        <div style={styles.muted}>No web/browser/computer effects in this run.</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.thLeft}>Tool</th>
              <th style={styles.thRight}>Calls</th>
              <th style={styles.thRight}>Cost (USD)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td>{k.replace(':', '.')}</td>
                <td style={styles.tdRight}>{v.calls}</td>
                <td style={styles.tdRight}>${v.usd.toFixed(3)}</td>
              </tr>
            ))}
            <tr style={styles.totalRow}>
              <td><strong>Total tool spend</strong></td>
              <td style={styles.tdRight}>—</td>
              <td style={styles.tdRight}><strong>${total.usd.toFixed(3)}</strong></td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-xs)',
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: 12,
    padding: 'var(--space-sm)',
    background: 'var(--color-surface-1, #0d0d0d)',
    border: '1px solid var(--color-border, #222)',
    borderRadius: 'var(--radius-sm)',
  },
  header: { fontWeight: 600, marginBottom: 4 },
  table: { width: '100%', borderCollapse: 'collapse' as const },
  thLeft: { textAlign: 'left' as const, padding: '2px 4px', borderBottom: '1px solid var(--color-border, #333)' },
  thRight: { textAlign: 'right' as const, padding: '2px 4px', borderBottom: '1px solid var(--color-border, #333)' },
  tdRight: { textAlign: 'right' as const, padding: '2px 4px' },
  totalRow: { borderTop: '1px solid var(--color-border, #333)' },
  muted: { color: 'var(--color-text-muted, #888)' },
};

export default ToolCostPanel;
