import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanApprovalStats } from '../../../server/pipeline-learnings-types.js';

export interface UsePlanApprovalStatsResult {
  stats: PlanApprovalStats | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Hook that fetches {@link PlanApprovalStats} for a single project via the
 * dashboard WebSocket. The server must implement the `get-plan-approval-stats`
 * WS action and emit a `plan-approval-stats` event — see
 * `pipeline-learnings-INTEGRATION.md` for the wiring details.
 *
 * The message handler uses functional setState so we can scope the effect
 * to `[ws, project]` without resubscribing on every incoming payload — this
 * avoids the stale-closure class of bug that bit ReviewPage.
 */
export function usePlanApprovalStats(
  ws: WebSocket | null,
  project: string | null,
): UsePlanApprovalStatsResult {
  const [stats, setStats] = useState<PlanApprovalStats | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  // Stable refs for values the WS handler needs but should not cause
  // re-subscribes.
  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  const send = useCallback(
    (proj: string) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      setLoading(true);
      ws.send(JSON.stringify({ action: 'get-plan-approval-stats', project: proj }));
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
      setStats(null);
      setLoading(false);
      return;
    }
    // Clear stale stats when project changes so the UI doesn't flash a
    // mismatched project's rollup during the round-trip.
    setStats((prev) => (prev && prev.projectSlug === project ? prev : null));
    send(project);
  }, [ws, project, send]);

  // WS message listener. Scoped to [ws] — functional setState lets us read
  // fresh `project` without a dep on it.
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
      if (m.type !== 'plan-approval-stats') return;

      const payload = m.payload as
        | { project?: string; stats?: PlanApprovalStats }
        | undefined;
      if (!payload || !payload.stats) return;

      const incoming = payload.stats;
      const currentProject = projectRef.current;
      // Drop payloads for a project the user has since switched away from.
      if (currentProject && payload.project && payload.project !== currentProject) return;

      setStats(() => incoming);
      setLoading(false);
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  return { stats, loading, refresh };
}

export default usePlanApprovalStats;
