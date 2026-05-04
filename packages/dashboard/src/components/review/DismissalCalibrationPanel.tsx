/**
 * DismissalCalibrationPanel — R8 calibration surface for review
 * auto-filtering.
 *
 * Lists dismissal records the server has collected per
 * (personaId, claimType, filePattern) triple. Each row shows how many
 * times the key was dismissed, when it was last dismissed (relative),
 * and a "Re-enable" action that clears the record on the server so new
 * findings with that key start surfacing again.
 *
 * Talks to the dashboard WebSocket with two actions:
 *   - list-review-dismissals  → payload { records: DismissalRecord[] }
 *   - reset-review-dismissal  → payload { key, removed }
 *
 * All WS `setState` calls use the functional form to avoid stale-closure
 * bugs when multiple messages arrive in quick succession.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Filter, RotateCcw } from 'lucide-react';

// ── Types (mirror server review-dismissal-store.ts) ────────────────────

interface DismissalKey {
  personaId: string;
  claimType: string;
  filePattern: string;
}

interface DismissalRecord {
  key: DismissalKey;
  count: number;
  lastDismissedAt: string;
  reasons: string[];
}

export interface DismissalCalibrationPanelProps {
  project: string | null;
  ws: WebSocket | null;
}

// ── Helpers ────────────────────────────────────────────────────────────

function keyHash(key: DismissalKey): string {
  return `${key.personaId}\u0001${key.claimType}\u0001${key.filePattern}`;
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}

// ── Styles ─────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--separator)',
    borderRadius: '12px',
    padding: '20px',
    color: 'var(--text-primary)',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  titleIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    borderRadius: '6px',
    background: 'var(--bg-elevated-2)',
    color: 'var(--text-secondary)',
  },
  title: {
    fontSize: '15px',
    fontWeight: 600,
    margin: 0,
  },
  subtitle: {
    fontSize: '12px',
    color: 'var(--text-tertiary)',
    marginTop: '2px',
  },
  tableWrap: {
    overflowX: 'auto',
    border: '1px solid var(--separator)',
    borderRadius: '8px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '13px',
  },
  th: {
    textAlign: 'left',
    padding: '10px 12px',
    background: 'var(--bg-elevated-2)',
    borderBottom: '1px solid var(--separator)',
    color: 'var(--text-secondary)',
    fontWeight: 600,
    fontSize: '12px',
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
  },
  td: {
    padding: '10px 12px',
    borderBottom: '1px solid var(--separator)',
    color: 'var(--text-primary)',
    verticalAlign: 'middle',
  },
  mono: {
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
    fontSize: '12px',
  },
  countPill: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '999px',
    background: 'rgba(239, 68, 68, 0.12)',
    color: 'var(--color-error, #ef4444)',
    fontWeight: 600,
    fontSize: '12px',
  },
  reenableBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 10px',
    fontSize: '12px',
    background: 'var(--bg-elevated-2)',
    color: 'var(--text-primary)',
    border: '1px solid var(--separator)',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  reenableBtnBusy: {
    opacity: 0.6,
    cursor: 'wait',
  },
  emptyState: {
    padding: '28px 20px',
    textAlign: 'center',
    color: 'var(--text-tertiary)',
    background: 'var(--bg-elevated-2)',
    border: '1px dashed var(--separator)',
    borderRadius: '8px',
    fontSize: '13px',
    lineHeight: 1.5,
  },
  loading: {
    padding: '20px',
    textAlign: 'center',
    color: 'var(--text-tertiary)',
    fontSize: '13px',
  },
};

// ── Main component ─────────────────────────────────────────────────────

export function DismissalCalibrationPanel(props: DismissalCalibrationPanelProps) {
  const { project, ws } = props;

  const [records, setRecords] = useState<DismissalRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  // Request on mount / when project changes.
  useEffect(() => {
    if (!ws || !project) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    setLoading(true);
    setError(null);
    ws.send(JSON.stringify({ action: 'list-review-dismissals', project }));
  }, [ws, project]);

  // WebSocket handler — functional setState required.
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      let msg: unknown;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const envelope = msg as { type?: string; payload?: unknown };
      const payload = (envelope.payload ?? {}) as Record<string, unknown>;

      switch (envelope.type) {
        case 'review-dismissals': {
          const incoming = Array.isArray(payload.records)
            ? (payload.records as DismissalRecord[])
            : [];
          setRecords(() => incoming.slice());
          setLoading(() => false);
          setError(() => null);
          break;
        }
        case 'review-dismissal-reset': {
          const resetKey = payload.key as DismissalKey | undefined;
          if (!resetKey) break;
          const hash = keyHash(resetKey);
          setRecords((prev) => prev.filter((r) => keyHash(r.key) !== hash));
          setResetting((prev) => {
            if (!(hash in prev)) return prev;
            const next = { ...prev };
            delete next[hash];
            return next;
          });
          break;
        }
        case 'review-dismissal-error': {
          const message =
            typeof payload.message === 'string' ? payload.message : 'Dismissal action failed.';
          setError(() => message);
          setLoading(() => false);
          setResetting(() => ({}));
          break;
        }
        default:
          break;
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  const onReenable = useCallback(
    (record: DismissalRecord) => {
      if (!ws || !project) return;
      const hash = keyHash(record.key);
      setResetting((prev) => ({ ...prev, [hash]: true }));
      ws.send(
        JSON.stringify({
          action: 'reset-review-dismissal',
          project,
          key: record.key,
        }),
      );
    },
    [ws, project],
  );

  const hasRecords = useMemo(() => records.length > 0, [records]);

  return (
    <section style={styles.wrapper} aria-label="Dismissal calibration">
      <header style={styles.header}>
        <span style={styles.titleIcon} aria-hidden>
          <Filter size={16} />
        </span>
        <div>
          <h3 style={styles.title}>Auto-filtered findings</h3>
          <div style={styles.subtitle}>
            Keys dismissed 3+ times are auto-filtered from future reviews. Re-enable anytime.
          </div>
        </div>
      </header>

      {error ? (
        <div style={{ ...styles.emptyState, color: 'var(--color-error, #ef4444)' }}>
          {error}
        </div>
      ) : null}

      {loading && !hasRecords ? (
        <div style={styles.loading}>Loading dismissal records…</div>
      ) : null}

      {!loading && !hasRecords ? (
        <div style={styles.emptyState}>
          No auto-filtered findings yet — once you dismiss a finding 3 times with the same key,
          it&apos;ll show here.
        </div>
      ) : null}

      {hasRecords ? (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Persona</th>
                <th style={styles.th}>Claim type</th>
                <th style={styles.th}>File pattern</th>
                <th style={styles.th}>Count</th>
                <th style={styles.th}>Last dismissed</th>
                <th style={styles.th} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {records.map((record) => {
                const hash = keyHash(record.key);
                const busy = !!resetting[hash];
                return (
                  <tr key={hash}>
                    <td style={styles.td}>{record.key.personaId}</td>
                    <td style={styles.td}>{record.key.claimType}</td>
                    <td style={{ ...styles.td, ...styles.mono }}>{record.key.filePattern}</td>
                    <td style={styles.td}>
                      <span style={styles.countPill}>{record.count}×</span>
                    </td>
                    <td style={styles.td}>{relativeTime(record.lastDismissedAt)}</td>
                    <td style={{ ...styles.td, textAlign: 'right' }}>
                      <button
                        type="button"
                        onClick={() => onReenable(record)}
                        disabled={busy}
                        style={{
                          ...styles.reenableBtn,
                          ...(busy ? styles.reenableBtnBusy : null),
                        }}
                        aria-label={`Re-enable findings for ${record.key.personaId} / ${record.key.claimType}`}
                      >
                        <RotateCcw size={14} />
                        {busy ? 'Re-enabling…' : 'Re-enable'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export default DismissalCalibrationPanel;
