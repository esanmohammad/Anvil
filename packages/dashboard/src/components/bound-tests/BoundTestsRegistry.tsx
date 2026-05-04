// BoundTestsRegistry — Regression Guard Phase 2 UI.
//
// Presents the full set of incident-bound regression tests for a project in a
// searchable, sortable table. Row-click opens an OverrideModal to either
// remove the binding (with a mandatory reason) or verify the bound test.
//
// All WS message handlers use functional setState — the dashboard polices
// stale-closure reads.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  RefreshCw,
  Shield,
  X,
} from 'lucide-react';
import type {
  BoundRecord,
  BoundSeverity,
  VerifyResult,
} from './bound-tests-types.js';
import { OverrideModal } from './OverrideModal.js';

export interface BoundTestsRegistryProps {
  project: string | null;
  ws: WebSocket | null;
}

type SortKey = 'filePath' | 'incidentId' | 'addedAt' | 'lastVerifiedAt' | 'severity';
type SortDir = 'asc' | 'desc';

interface WsEnvelope {
  type?: string;
  payload?: unknown;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function parseBoundRecords(payload: unknown): BoundRecord[] | null {
  if (!isRecord(payload)) return null;
  const list = payload.records;
  if (!Array.isArray(list)) return null;
  return list.filter((r): r is BoundRecord =>
    isRecord(r) &&
    typeof r.filePath === 'string' &&
    typeof r.incidentId === 'string' &&
    typeof r.replayId === 'string' &&
    typeof r.addedAt === 'string',
  );
}

function parseVerifyResult(payload: unknown): VerifyResult | null {
  if (!isRecord(payload)) return null;
  if (
    typeof payload.filePath === 'string' &&
    typeof payload.passed === 'boolean' &&
    typeof payload.output === 'string' &&
    typeof payload.at === 'string'
  ) {
    return payload as unknown as VerifyResult;
  }
  return null;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

function compareBy(a: BoundRecord, b: BoundRecord, key: SortKey): number {
  const av = (a[key] ?? '') as string;
  const bv = (b[key] ?? '') as string;
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

function sortRecords(
  rows: BoundRecord[],
  key: SortKey,
  dir: SortDir,
): BoundRecord[] {
  const sorted = rows.slice().sort((a, b) => compareBy(a, b, key));
  return dir === 'asc' ? sorted : sorted.reverse();
}

function matchesQuery(rec: BoundRecord, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    rec.filePath.toLowerCase().includes(needle) ||
    rec.incidentId.toLowerCase().includes(needle) ||
    rec.replayId.toLowerCase().includes(needle)
  );
}

export function BoundTestsRegistry({
  project,
  ws,
}: BoundTestsRegistryProps): React.ReactElement {
  const [records, setRecords] = useState<BoundRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [query, setQuery] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('addedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selected, setSelected] = useState<BoundRecord | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResults, setVerifyResults] = useState<Record<string, VerifyResult>>({});

  const projectRef = useRef(project);
  useEffect(() => { projectRef.current = project; }, [project]);

  // Initial fetch on mount & when project/ws change.
  useEffect(() => {
    if (!ws || !project) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    setLoading(true);
    setRecords([]);
    ws.send(JSON.stringify({ action: 'list-bound-tests', project }));
  }, [ws, project]);

  // WS subscription — functional setState only.
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent): void => {
      let msg: WsEnvelope;
      try { msg = JSON.parse(event.data as string) as WsEnvelope; } catch { return; }
      const t = msg.type;
      if (!t) return;
      if (t === 'bound-tests-list') {
        const list = parseBoundRecords(msg.payload);
        if (list) {
          setRecords(() => list);
          setLoading(() => false);
        }
        return;
      }
      if (t === 'bound-tests-updated') {
        const list = parseBoundRecords(msg.payload);
        if (list) setRecords(() => list);
        return;
      }
      if (t === 'bound-test-removed') {
        const payload = msg.payload;
        if (isRecord(payload) && typeof payload.filePath === 'string') {
          const fp = payload.filePath;
          setRecords((prev) => prev.filter((r) => r.filePath !== fp));
          setSelected((prev) => (prev && prev.filePath === fp ? null : prev));
        }
        return;
      }
      if (t === 'bound-test-verify-result') {
        const result = parseVerifyResult(msg.payload);
        if (result) {
          setVerifyResults((prev) => ({ ...prev, [result.filePath]: result }));
          setVerifying((prev) => (prev === result.filePath ? null : prev));
          setRecords((prev) =>
            prev.map((r) =>
              r.filePath === result.filePath
                ? { ...r, lastVerifiedAt: result.at }
                : r,
            ),
          );
        }
        return;
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  const toggleSort = useCallback((key: SortKey): void => {
    setSortKey((prevKey) => {
      if (prevKey === key) {
        setSortDir((prevDir) => (prevDir === 'asc' ? 'desc' : 'asc'));
        return prevKey;
      }
      setSortDir(() => 'asc');
      return key;
    });
  }, []);

  const filteredSorted = useMemo(
    () => sortRecords(records.filter((r) => matchesQuery(r, query)), sortKey, sortDir),
    [records, query, sortKey, sortDir],
  );

  const handleVerifyAll = useCallback((): void => {
    if (!ws || !project) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'verify-bound-tests', project }));
  }, [ws, project]);

  const handleExport = useCallback((): void => {
    const blob = new Blob([JSON.stringify(records, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bound-tests-${project ?? 'project'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [records, project]);

  const handleOverride = useCallback(
    (reason: string): void => {
      if (!ws || !selected || !project) return;
      ws.send(
        JSON.stringify({
          action: 'override-bound-test',
          project,
          filePath: selected.filePath,
          reason,
        }),
      );
    },
    [ws, selected, project],
  );

  const handleVerifyOne = useCallback((): void => {
    if (!ws || !selected || !project) return;
    const fp = selected.filePath;
    setVerifying(() => fp);
    ws.send(
      JSON.stringify({
        action: 'verify-bound-test',
        project,
        filePath: fp,
      }),
    );
  }, [ws, selected, project]);

  return (
    <div style={containerStyle}>
      <header style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Shield size={18} color="var(--text-primary)" />
          <h2 style={titleStyle}>Regression Guard</h2>
          <span style={countPillStyle}>{records.length}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={handleVerifyAll}
            style={secondaryButtonStyle}
            disabled={!project || records.length === 0}
          >
            <RefreshCw size={14} style={{ marginRight: 6 }} />
            Verify all
          </button>
          <button
            type="button"
            onClick={handleExport}
            style={secondaryButtonStyle}
            disabled={records.length === 0}
          >
            <Download size={14} style={{ marginRight: 6 }} />
            Export
          </button>
        </div>
      </header>

      <div style={toolbarStyle}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by file, incident, or replay id"
          style={searchStyle}
        />
      </div>

      {loading ? (
        <div style={emptyStyle}>Loading bound tests…</div>
      ) : filteredSorted.length === 0 ? (
        <div style={emptyStyle}>
          <Shield size={24} color="var(--text-tertiary)" />
          <div style={{ marginTop: 8 }}>
            {records.length === 0
              ? 'No bound tests yet. Successful replays will appear here.'
              : 'No tests match your search.'}
          </div>
        </div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <SortHeader
                label="File"
                active={sortKey === 'filePath'}
                dir={sortDir}
                onClick={() => toggleSort('filePath')}
              />
              <SortHeader
                label="Incident"
                active={sortKey === 'incidentId'}
                dir={sortDir}
                onClick={() => toggleSort('incidentId')}
              />
              <SortHeader
                label="Bound at"
                active={sortKey === 'addedAt'}
                dir={sortDir}
                onClick={() => toggleSort('addedAt')}
              />
              <SortHeader
                label="Last verified"
                active={sortKey === 'lastVerifiedAt'}
                dir={sortDir}
                onClick={() => toggleSort('lastVerifiedAt')}
              />
              <SortHeader
                label="Severity"
                active={sortKey === 'severity'}
                dir={sortDir}
                onClick={() => toggleSort('severity')}
              />
            </tr>
          </thead>
          <tbody>
            {filteredSorted.map((rec) => {
              const result = verifyResults[rec.filePath];
              return (
                <tr
                  key={rec.filePath}
                  onClick={() => setSelected(rec)}
                  style={rowStyle}
                >
                  <td style={cellMonoStyle}>{rec.filePath}</td>
                  <td style={cellMonoStyle}>{rec.incidentId}</td>
                  <td style={cellStyle}>{formatDate(rec.addedAt)}</td>
                  <td style={cellStyle}>
                    {result ? (
                      <span
                        style={{
                          color: result.passed
                            ? 'var(--color-success)'
                            : 'var(--color-error)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        {result.passed ? <Check size={12} /> : <X size={12} />}
                        {formatDate(result.at)}
                      </span>
                    ) : (
                      formatDate(rec.lastVerifiedAt)
                    )}
                  </td>
                  <td style={cellStyle}>
                    <SeverityPill severity={rec.severity ?? 'warning'} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {selected ? (
        <OverrideModal
          record={selected}
          verifyResult={verifyResults[selected.filePath] ?? null}
          verifying={verifying === selected.filePath}
          onClose={() => setSelected(null)}
          onOverride={handleOverride}
          onVerify={handleVerifyOne}
        />
      ) : null}
    </div>
  );
}

// ── Subcomponents ───────────────────────────────────────────────────────

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
}): React.ReactElement {
  return (
    <th style={headerCellStyle} onClick={onClick}>
      <span
        style={{
          color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
          fontWeight: 600,
        }}
      >
        {label}
        {active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
      </span>
    </th>
  );
}

function SeverityPill({
  severity,
}: {
  severity: BoundSeverity;
}): React.ReactElement {
  const color =
    severity === 'block'
      ? 'var(--color-error)'
      : severity === 'warning'
        ? 'var(--color-warning)'
        : 'var(--color-success)';
  const Icon = severity === 'info' ? Check : AlertTriangle;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 'var(--radius-full)',
        background: 'var(--bg-elevated-2)',
        color,
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        fontWeight: 600,
      }}
    >
      <Icon size={11} />
      {severity}
    </span>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  fontFamily: 'var(--font-sans)',
  color: 'var(--text-primary)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 600,
};

const countPillStyle: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 'var(--radius-full)',
  background: 'var(--bg-elevated-2)',
  color: 'var(--text-secondary)',
  fontSize: 12,
  fontWeight: 600,
};

const toolbarStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
};

const searchStyle: React.CSSProperties = {
  flex: 1,
  padding: '8px 10px',
  background: 'var(--bg-elevated-1)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
};

const secondaryButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '6px 12px',
  background: 'var(--bg-elevated-1)',
  color: 'var(--text-primary)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--radius-sm)',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  cursor: 'pointer',
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  background: 'var(--bg-elevated-1)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--radius-sm)',
  overflow: 'hidden',
  fontSize: 13,
};

const headerCellStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 12px',
  borderBottom: '1px solid var(--separator)',
  background: 'var(--bg-elevated-2)',
  cursor: 'pointer',
  userSelect: 'none',
};

const rowStyle: React.CSSProperties = {
  cursor: 'pointer',
  borderBottom: '1px solid var(--separator)',
};

const cellStyle: React.CSSProperties = {
  padding: '10px 12px',
  color: 'var(--text-secondary)',
  verticalAlign: 'middle',
};

const cellMonoStyle: React.CSSProperties = {
  padding: '10px 12px',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  wordBreak: 'break-all',
  verticalAlign: 'middle',
};

const emptyStyle: React.CSSProperties = {
  padding: 40,
  textAlign: 'center',
  color: 'var(--text-tertiary)',
  background: 'var(--bg-elevated-1)',
  border: '1px dashed var(--separator)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 13,
};
