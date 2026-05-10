/**
 * SandboxPanel — Phase S10.
 *
 * Renders the live sandbox state for a run: which sandboxes are
 * currently up, their runtime + age + busy flag, and the per-stage
 * resource usage snapshot from `LimitMonitorSnapshot`. Mounted in
 * the run-detail view next to the durable timeline.
 *
 * Reads two WS streams:
 *   - `sandbox-stats` — pushed when the runner sweeps + on demand via
 *     `get-sandbox-stats` request.
 */

import { useEffect, useState, useMemo } from 'react';

interface SandboxEntry {
  id: string;
  runtime: 'none' | 'docker' | 'podman' | 'firecracker' | 'gvisor';
  ageMs: number;
  busy: boolean;
  /** Optional limit-monitor snapshot. */
  monitor?: {
    memoryUsedMiB: number;
    memoryCapMiB: number;
    cpuPercent: number;
    pidsUsed: number;
    pidsCap: number;
  };
}

export interface SandboxPanelProps {
  runId: string;
  ws?: WebSocket | null;
}

export function SandboxPanel({ runId, ws }: SandboxPanelProps) {
  const [entries, setEntries] = useState<SandboxEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setLoading(true);
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'sandbox-stats' && msg.payload?.runId === runId) {
          setEntries(Array.isArray(msg.payload.entries) ? msg.payload.entries : []);
          setLoading(false);
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ type: 'get-sandbox-stats', runId }));
    return () => ws.removeEventListener('message', handler);
  }, [ws, runId]);

  const total = entries.length;
  const busy = useMemo(() => entries.filter((e) => e.busy).length, [entries]);

  if (loading) return <div style={styles.muted}>Loading sandbox state…</div>;
  if (total === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>Sandboxes</div>
        <div style={styles.muted}>No sandboxes active for this run.</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        Sandboxes ({total} total, {busy} busy)
      </div>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.thLeft}>ID</th>
            <th style={styles.thLeft}>Runtime</th>
            <th style={styles.thRight}>Age</th>
            <th style={styles.thRight}>Memory</th>
            <th style={styles.thRight}>CPU</th>
            <th style={styles.thRight}>PIDs</th>
            <th style={styles.thLeft}>Status</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td style={styles.tdMono}>{e.id.slice(0, 12)}</td>
              <td style={styles.td}>{e.runtime}</td>
              <td style={styles.tdRight}>{Math.round(e.ageMs / 1000)}s</td>
              <td style={styles.tdRight}>
                {e.monitor ? `${e.monitor.memoryUsedMiB}/${e.monitor.memoryCapMiB} MiB` : '—'}
              </td>
              <td style={styles.tdRight}>
                {e.monitor ? `${e.monitor.cpuPercent.toFixed(1)}%` : '—'}
              </td>
              <td style={styles.tdRight}>
                {e.monitor ? `${e.monitor.pidsUsed}/${e.monitor.pidsCap}` : '—'}
              </td>
              <td style={styles.td}>{e.busy ? 'busy' : 'idle'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    border: '1px solid var(--color-border, #333)',
    borderRadius: 6,
    padding: 12,
    margin: '12px 0',
  },
  header: {
    fontWeight: 600,
    marginBottom: 8,
    fontSize: 13,
  },
  muted: {
    color: 'var(--color-text-muted, #888)',
    fontSize: 12,
    fontStyle: 'italic',
  },
  table: { width: '100%', fontSize: 12, borderCollapse: 'collapse' },
  thLeft: { textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--color-border, #333)' },
  thRight: { textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid var(--color-border, #333)' },
  td: { padding: '4px 8px' },
  tdRight: { textAlign: 'right', padding: '4px 8px' },
  tdMono: { padding: '4px 8px', fontFamily: 'ui-monospace, monospace' },
};
