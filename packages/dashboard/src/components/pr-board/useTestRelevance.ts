import { useCallback, useEffect, useRef, useState } from 'react';
import type { RelevanceResult, RankedTest } from '../../../server/test-relevance-ranker.js';

export interface UseTestRelevanceResult {
  result: RelevanceResult | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  runRelevant: () => void;
}

interface WsEnvelope {
  type?: string;
  payload?: unknown;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Validate that an incoming payload conforms to RelevanceResult. The server
 * owns the contract, but we're defensive here because WS payloads are
 * untrusted JSON — a malformed push should not crash the panel.
 */
function parseResult(payload: unknown): RelevanceResult | null {
  if (!isRecord(payload)) return null;
  const totalTests = typeof payload.totalTests === 'number' ? payload.totalTests : null;
  const rankedRelevant = Array.isArray(payload.rankedRelevant) ? payload.rankedRelevant : null;
  const estimatedRuntimeMs = typeof payload.estimatedRuntimeMs === 'number'
    ? payload.estimatedRuntimeMs : null;
  const estimatedSavings = typeof payload.estimatedSavings === 'string'
    ? payload.estimatedSavings : null;
  if (totalTests === null || rankedRelevant === null ||
      estimatedRuntimeMs === null || estimatedSavings === null) return null;

  const ranked: RankedTest[] = [];
  for (const r of rankedRelevant) {
    if (!isRecord(r)) continue;
    if (typeof r.testFile !== 'string') continue;
    if (typeof r.distance !== 'number') continue;
    if (typeof r.repoName !== 'string') continue;
    const matched = Array.isArray(r.matchedSymbols)
      ? r.matchedSymbols.filter((s): s is string => typeof s === 'string')
      : [];
    ranked.push({
      testFile: r.testFile,
      testName: typeof r.testName === 'string' ? r.testName : undefined,
      distance: r.distance,
      matchedSymbols: matched,
      repoName: r.repoName,
    });
  }
  return {
    totalTests,
    rankedRelevant: ranked,
    estimatedRuntimeMs,
    estimatedSavings,
  };
}

/**
 * Stream test-relevance results for a PR over the dashboard WS. The server
 * must implement the `rank-tests-for-pr` action and emit either
 * `test-relevance` (success) or `test-relevance-error` (failure).
 *
 * All setState calls inside the WS handler are functional to avoid
 * stale-closure bugs when the parent flips `project` / `prUrl`.
 */
export function useTestRelevance(
  ws: WebSocket | null,
  project: string | null,
  prUrl: string | null,
): UseTestRelevanceResult {
  const [result, setResult] = useState<RelevanceResult | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const projectRef = useRef(project);
  const prUrlRef = useRef(prUrl);
  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { prUrlRef.current = prUrl; }, [prUrl]);

  const send = useCallback((proj: string, url: string) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setLoading(() => true);
    setError(() => null);
    ws.send(JSON.stringify({ action: 'rank-tests-for-pr', project: proj, prUrl: url }));
  }, [ws]);

  const refresh = useCallback(() => {
    const p = projectRef.current;
    const u = prUrlRef.current;
    if (!p || !u) return;
    send(p, u);
  }, [send]);

  const runRelevant = useCallback(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const p = projectRef.current;
    const u = prUrlRef.current;
    if (!p || !u) return;
    // Echo the current ranked list back so the server doesn't have to re-rank.
    const ranked = result?.rankedRelevant ?? [];
    ws.send(JSON.stringify({
      action: 'run-relevant-tests',
      project: p,
      prUrl: u,
      tests: ranked,
    }));
  }, [ws, result]);

  // Initial fetch on mount + refresh when the pr or project changes.
  useEffect(() => {
    if (!ws || !project || !prUrl) {
      setResult(() => null);
      setLoading(() => false);
      return;
    }
    send(project, prUrl);
  }, [ws, project, prUrl, send]);

  // Subscribe once per `ws`; use functional setState so we stay stable when
  // project/prUrl change.
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent): void => {
      let msg: WsEnvelope;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '') as WsEnvelope;
      } catch {
        return;
      }
      if (!msg || !msg.type) return;
      if (msg.type === 'test-relevance') {
        const parsed = parseResult(msg.payload);
        if (!parsed) return;
        setResult(() => parsed);
        setLoading(() => false);
        setError(() => null);
        return;
      }
      if (msg.type === 'test-relevance-error') {
        const payload = msg.payload;
        const text = isRecord(payload) && typeof payload.message === 'string'
          ? payload.message
          : 'Failed to rank tests.';
        setError(() => text);
        setLoading(() => false);
        return;
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  return { result, loading, error, refresh, runRelevant };
}

export default useTestRelevance;
