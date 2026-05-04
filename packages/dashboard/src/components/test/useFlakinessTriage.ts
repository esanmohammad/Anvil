/**
 * useFlakinessTriage — React hook that fetches flakiness clusters and fix
 * suggestions for a given spec over the dashboard WebSocket.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ── Mirror of server types (keep in sync with server/flakiness-*.ts) ─────

export type FlakyRootCause =
  | 'timing-sensitive'
  | 'order-dependent'
  | 'data-dependent'
  | 'env-dependent'
  | 'unknown';

export interface FlakyCluster {
  testId: string;
  samples: number;
  failureRate: number;
  rootCause: FlakyRootCause;
  confidence: number;
  evidence: string[];
}

export interface FlakyFixSuggestion {
  testId: string;
  rootCause: FlakyRootCause;
  suggestion: string;
  codePatch?: string;
  confidence: number;
}

// Payload we expect back on the WebSocket under `type: 'flakiness-clusters'`.
interface FlakinessPayload {
  type: 'flakiness-clusters';
  project: string;
  specSlug: string;
  clusters: FlakyCluster[];
  suggestions: FlakyFixSuggestion[];
}

export interface UseFlakinessTriageResult {
  clusters: FlakyCluster[];
  suggestions: FlakyFixSuggestion[];
  loading: boolean;
  refresh: () => void;
}

export function useFlakinessTriage(
  project: string,
  specSlug: string,
  ws: WebSocket | null,
): UseFlakinessTriageResult {
  const [clusters, setClusters] = useState<FlakyCluster[]>([]);
  const [suggestions, setSuggestions] = useState<FlakyFixSuggestion[]>([]);
  const [loading, setLoading] = useState(false);

  // We hold the WebSocket in a ref so the message handler's identity stays
  // stable across renders (avoids duplicate listener registration).
  const wsRef = useRef<WebSocket | null>(ws);
  useEffect(() => {
    wsRef.current = ws;
  }, [ws]);

  // Stable fetcher — send a `get-flakiness-clusters` action.
  const refresh = useCallback(() => {
    const sock = wsRef.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    if (!project || !specSlug) return;
    setLoading(true);
    sock.send(
      JSON.stringify({
        action: 'get-flakiness-clusters',
        project,
        specSlug,
      }),
    );
  }, [project, specSlug]);

  // Listen for the response; use functional setState so repeated messages
  // don't capture a stale reference to prior clusters.
  useEffect(() => {
    if (!ws) return;

    const handler = (ev: MessageEvent) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (!isFlakinessPayload(msg)) return;
      if (msg.project !== project || msg.specSlug !== specSlug) return;

      const nextClusters = msg.clusters;
      const nextSuggestions = msg.suggestions;
      // Functional form — we don't actually need prior state here, but this
      // keeps the call-site honest if anyone adds merging/diffing later.
      setClusters(() => nextClusters);
      setSuggestions(() => nextSuggestions);
      setLoading(() => false);
    };

    ws.addEventListener('message', handler);
    return () => {
      ws.removeEventListener('message', handler);
    };
  }, [ws, project, specSlug]);

  // Auto-fetch once the socket is usable and the keys are known.
  useEffect(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    refresh();
  }, [ws, refresh]);

  return { clusters, suggestions, loading, refresh };
}

// ── Type guard ───────────────────────────────────────────────────────────

function isFlakinessPayload(x: unknown): x is FlakinessPayload {
  if (!x || typeof x !== 'object') return false;
  const m = x as Record<string, unknown>;
  return (
    m.type === 'flakiness-clusters' &&
    typeof m.project === 'string' &&
    typeof m.specSlug === 'string' &&
    Array.isArray(m.clusters) &&
    Array.isArray(m.suggestions)
  );
}
