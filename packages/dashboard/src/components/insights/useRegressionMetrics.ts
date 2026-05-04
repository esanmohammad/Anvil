import { useCallback, useEffect, useRef, useState } from 'react';
import type { RegressionGuardMetrics } from '../../../server/regression-metrics-types.js';

export interface UseRegressionMetricsResult {
  metrics: RegressionGuardMetrics | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Hook that streams {@link RegressionGuardMetrics} for a single project over
 * the dashboard WebSocket. The server must implement the
 * `get-regression-metrics` WS action and emit a `regression-metrics` event —
 * see `regression-metrics-INTEGRATION.md` for wiring.
 *
 * The WS message handler uses functional setState so the effect can stay
 * scoped to `[ws]` without resubscribing when `project` changes — this
 * avoids the stale-closure class of bug we hit in earlier panels.
 */
export function useRegressionMetrics(
  ws: WebSocket | null,
  project: string | null,
): UseRegressionMetricsResult {
  const [metrics, setMetrics] = useState<RegressionGuardMetrics | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  // Stable ref so the WS message handler can filter payloads by the current
  // project without re-subscribing on every project change.
  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  const send = useCallback(
    (proj: string) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      setLoading(true);
      ws.send(JSON.stringify({ action: 'get-regression-metrics', project: proj }));
    },
    [ws],
  );

  const refresh = useCallback(() => {
    const p = projectRef.current;
    if (!p) return;
    send(p);
  }, [send]);

  // Initial + on project change.
  useEffect(() => {
    if (!ws || !project) {
      setMetrics(null);
      setLoading(false);
      return;
    }
    // Clear metrics belonging to a different project so the UI doesn't flash
    // mismatched data during the round-trip.
    setMetrics((prev) => (prev && prev.project === project ? prev : null));
    send(project);
  }, [ws, project, send]);

  // WS message listener — scoped to `[ws]`. Functional setState lets us read
  // the freshest `project` via the ref without adding a dep on it.
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: unknown; payload?: unknown };
      if (m.type !== 'regression-metrics') return;

      const payload = m.payload as
        | { project?: string; metrics?: RegressionGuardMetrics }
        | undefined;
      if (!payload || !payload.metrics) return;

      const incoming = payload.metrics;
      const currentProject = projectRef.current;
      // Drop payloads for a project the user has since switched away from.
      if (currentProject && payload.project && payload.project !== currentProject) return;

      setMetrics(() => incoming);
      setLoading(false);
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  return { metrics, loading, refresh };
}

export default useRegressionMetrics;
