/**
 * ReviewerCalibrationPanel — table of per-persona accept/dismiss rates and
 * calibration delta. Read-only; fed by the server's CalibrationSnapshotBundle.
 */

import React, { useEffect, useState, useRef } from 'react';
import { Activity, AlertCircle } from 'lucide-react';
import { RowSkeleton } from '../common/Skeleton.js';

interface PersonaRow {
  personaId: string;
  findingsSeen: number;
  empiricalAcceptRate: number;
  statedConfidenceMean: number;
  calibrationDelta: number;
}

interface CalibrationBundle {
  project: string;
  window: number;
  personas: PersonaRow[];
  computedAt: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function deltaColor(delta: number): string {
  if (delta >= 0.1) return 'var(--color-success)';
  if (delta <= -0.3) return 'var(--color-error)';
  if (delta <= -0.1) return 'var(--color-warning)';
  return 'var(--text-secondary)';
}

export function ReviewerCalibrationPanel({
  project, ws,
}: { project: string | null; ws: WebSocket | null }): JSX.Element {
  const [bundle, setBundle] = useState<CalibrationBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const projectRef = useRef(project);
  useEffect(() => { projectRef.current = project; }, [project]);

  useEffect(() => {
    if (!ws || !project) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    setLoading(() => true);
    ws.send(JSON.stringify({ action: 'get-reviewer-calibration', project }));
  }, [ws, project]);

  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent): void => {
      let msg: { type?: string; payload?: unknown };
      try { msg = JSON.parse(event.data as string); } catch { return; }
      if (msg.type !== 'reviewer-calibration') return;
      if (!isRecord(msg.payload)) return;
      const b = msg.payload.bundle;
      if (!isRecord(b)) return;
      if (typeof b.project === 'string' && b.project !== projectRef.current) return;
      if (!Array.isArray(b.personas)) return;
      setBundle(() => b as unknown as CalibrationBundle);
      setLoading(() => false);
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  if (loading) {
    return (
      <div style={{ padding: 16 }} aria-busy="true" aria-label="Loading reviewer calibration">
        <RowSkeleton count={5} height={28} />
      </div>
    );
  }

  if (!bundle || bundle.personas.length === 0) {
    return (
      <div style={{
        padding: 16, borderRadius: 'var(--radius-md)', border: '1px dashed var(--separator)',
        color: 'var(--text-tertiary)', fontSize: 12, textAlign: 'center',
      }}>
        Not enough data yet — dismiss/apply 10+ findings per persona to see calibration.
      </div>
    );
  }

  return (
    <section style={{
      padding: 16, borderRadius: 'var(--radius-md)',
      background: 'var(--bg-elevated-2)', border: '1px solid var(--separator)',
    }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Activity size={14} aria-hidden="true" />
        <strong style={{ fontSize: 13 }}>Reviewer calibration</strong>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>
          rolling window: {bundle.window}
        </span>
      </header>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--text-tertiary)' }}>
            <th style={{ padding: '4px 8px' }}>Persona</th>
            <th style={{ padding: '4px 8px' }}>Seen</th>
            <th style={{ padding: '4px 8px' }}>Accept rate</th>
            <th style={{ padding: '4px 8px' }}>Stated</th>
            <th style={{ padding: '4px 8px' }}>Delta</th>
            <th style={{ padding: '4px 8px' }}></th>
          </tr>
        </thead>
        <tbody>
          {bundle.personas.map((p) => (
            <tr key={p.personaId} style={{ borderTop: '1px solid var(--separator)' }}>
              <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>{p.personaId}</td>
              <td style={{ padding: '6px 8px' }}>{p.findingsSeen}</td>
              <td style={{ padding: '6px 8px' }}>{pct(p.empiricalAcceptRate)}</td>
              <td style={{ padding: '6px 8px' }}>{pct(p.statedConfidenceMean)}</td>
              <td style={{ padding: '6px 8px', color: deltaColor(p.calibrationDelta), fontWeight: 600 }}>
                {p.calibrationDelta >= 0 ? '+' : ''}{(p.calibrationDelta * 100).toFixed(0)}
              </td>
              <td style={{ padding: '6px 8px' }}>
                {p.calibrationDelta <= -0.3 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--color-warning)', fontSize: 11 }}>
                    <AlertCircle size={11} aria-hidden="true" /> needs tuning
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
