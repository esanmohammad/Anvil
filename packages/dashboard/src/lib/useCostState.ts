// React hook subscribing to unified cost-state snapshots over the shared dashboard WebSocket.

import { useEffect, useRef, useState } from 'react';

export interface CostSnapshot {
  project: string;
  runId?: string;
  run?: {
    usd: number;
    limitUsd?: number;
    perStageUsd: Record<string, number>;
  };
  today: {
    usd: number;
    limitUsd?: number;
    alertAt?: number;
  };
  pendingBreach?: {
    runId: string;
    project: string;
    currentUsd: number;
    limitUsd: number;
    projectedUsd: number;
    graceEndsAt: string;
    topSpenders: Array<{ stage: string; usd: number }>;
    extensionsUsed: number;
  };
  recentBreaches?: {
    count30d: number;
    decisions: { raise: number; reject: number; extend: number; autoResolved: number };
  };
  computedAt: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseSnapshot(payload: unknown): CostSnapshot | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.project !== 'string') return null;
  if (!isRecord(payload.today)) return null;
  if (typeof payload.today.usd !== 'number') return null;
  if (typeof payload.computedAt !== 'string') return null;
  return payload as unknown as CostSnapshot;
}

export function useCostState(
  ws: WebSocket | null,
  project: string | null,
  runId?: string | null,
): {
  snapshot: CostSnapshot | null;
  loading: boolean;
} {
  const [snapshot, setSnapshot] = useState<CostSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  // Refs so the message handler always reads the latest values (no stale-closure).
  const projectRef = useRef<string | null>(project);
  const runIdRef = useRef<string | null | undefined>(runId);
  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { runIdRef.current = runId; }, [runId]);

  // When project becomes null, clear snapshot and stop loading.
  useEffect(() => {
    if (!project) {
      setSnapshot(() => null);
      setLoading(() => false);
    } else {
      setLoading(() => true);
    }
  }, [project]);

  // Subscribe + listen.
  useEffect(() => {
    if (!ws || !project) return;

    const sendSubscribe = (): void => {
      try {
        ws.send(JSON.stringify({
          action: 'subscribe-cost',
          project,
          runId: runId ?? undefined,
        }));
      } catch {
        // socket may have closed between readyState check and send — ignore
      }
    };

    const messageHandler = (event: MessageEvent): void => {
      let msg: { type?: unknown; payload?: unknown };
      try {
        msg = JSON.parse(event.data as string) as { type?: unknown; payload?: unknown };
      } catch {
        return;
      }
      if (msg.type !== 'cost-snapshot') return;
      const snap = parseSnapshot(msg.payload);
      if (!snap) return;
      if (snap.project !== projectRef.current) return;
      const wantedRunId = runIdRef.current;
      if (wantedRunId && snap.runId !== wantedRunId) return;
      setSnapshot(() => snap);
      setLoading(() => false);
    };

    const openHandler = (): void => {
      sendSubscribe();
    };

    ws.addEventListener('message', messageHandler);

    if (ws.readyState === WebSocket.OPEN) {
      sendSubscribe();
    } else {
      ws.addEventListener('open', openHandler);
    }

    return () => {
      ws.removeEventListener('message', messageHandler);
      ws.removeEventListener('open', openHandler);
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            action: 'unsubscribe-cost',
            project,
            runId: runId ?? undefined,
          }));
        } catch {
          // ignore — socket might be closing
        }
      }
    };
  }, [ws, project, runId]);

  return { snapshot, loading };
}
