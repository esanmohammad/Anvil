/**
 * React hook — subscribes to CI triage WS events and exposes imperative
 * actions (`analyzeLog`, `saveReport`). All setState calls use the functional
 * form so stale closures cannot clobber in-flight updates.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ── Types (narrow mirrors of dashboard-side types; kept local so the
// component tree doesn't pull in server imports). ──────────────────────

export type CiFailurePattern =
  | 'oom'
  | 'port-conflict'
  | 'db-lock'
  | 'network-timeout'
  | 'known-flake'
  | 'dependency-mismatch'
  | 'permission-denied'
  | 'missing-file'
  | 'compile-error'
  | 'assertion-failure'
  | 'unknown';

export type CiFailureSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface CiFailureCluster {
  pattern: CiFailurePattern;
  severity: CiFailureSeverity;
  count: number;
  firstLine: number;
  lastLine: number;
  examples: string[];
  suggestedFix: string;
  confidence: number;
}

export interface CiTriageReport {
  logSource: string;
  totalLines: number;
  errorLines: number;
  clusters: CiFailureCluster[];
  unknownExcerpt: string[];
  computedAt: string;
}

export interface CiTriageHistoryEntry {
  id: string;
  createdAt: string;
  topPattern?: CiFailurePattern;
  topSeverity?: CiFailureSeverity;
  ciRunId?: string;
}

export interface UseCiTriageResult {
  report: CiTriageReport | null;
  loading: boolean;
  error: string | null;
  history: CiTriageHistoryEntry[];
  analyzeLog: (input: { logText?: string; logUrl?: string }) => void;
  saveReport: (ciRunId?: string) => void;
  clear: () => void;
}

interface WsEnvelope {
  type?: string;
  payload?: unknown;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function parseReport(payload: unknown): CiTriageReport | null {
  if (!isRecord(payload)) return null;
  const report = payload.report;
  if (!isRecord(report)) return null;
  if (!Array.isArray(report.clusters)) return null;
  return report as unknown as CiTriageReport;
}

function parseHistory(payload: unknown): CiTriageHistoryEntry[] | null {
  if (!isRecord(payload)) return null;
  const list = payload.history;
  if (!Array.isArray(list)) return null;
  return list.filter((entry): entry is CiTriageHistoryEntry =>
    isRecord(entry) && typeof entry.id === 'string' && typeof entry.createdAt === 'string',
  );
}

export function useCiTriage(
  ws: WebSocket | null,
  project: string | null,
): UseCiTriageResult {
  const [report, setReport] = useState<CiTriageReport | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<CiTriageHistoryEntry[]>([]);

  const projectRef = useRef(project);
  useEffect(() => { projectRef.current = project; }, [project]);

  useEffect(() => {
    if (!ws || !project) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'list-ci-triage', project }));
  }, [ws, project]);

  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent): void => {
      let msg: WsEnvelope;
      try { msg = JSON.parse(event.data as string) as WsEnvelope; } catch { return; }
      const t = msg.type;
      if (!t) return;

      if (t === 'ci-triage-report' || t === 'ci-triage-saved') {
        const next = parseReport(msg.payload);
        if (next) {
          setReport(() => next);
          setLoading(() => false);
          setError(() => null);
        }
        return;
      }
      if (t === 'ci-triage-history') {
        const list = parseHistory(msg.payload);
        if (list) setHistory(() => list);
        return;
      }
      if (t === 'ci-triage-error' || t === 'ci-log-fetch-error') {
        const payload = msg.payload;
        const message = isRecord(payload) && typeof payload.message === 'string'
          ? payload.message : 'CI triage failed.';
        setError(() => message);
        setLoading(() => false);
        return;
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  const analyzeLog = useCallback((input: { logText?: string; logUrl?: string }): void => {
    if (!ws || !project) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    setLoading(() => true);
    setError(() => null);
    if (input.logUrl) {
      ws.send(JSON.stringify({ action: 'fetch-ci-log', project, logUrl: input.logUrl }));
      return;
    }
    ws.send(JSON.stringify({ action: 'analyze-ci-log', project, logText: input.logText || '' }));
  }, [ws, project]);

  const saveReport = useCallback((ciRunId?: string): void => {
    if (!ws || !project) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'save-ci-triage', project, ciRunId }));
  }, [ws, project]);

  const clear = useCallback((): void => {
    setReport(() => null);
    setError(() => null);
  }, []);

  return { report, loading, error, history, analyzeLog, saveReport, clear };
}
