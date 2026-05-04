import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContractSummary, ImpactReport } from './contract-ui-types.js';

export interface UseContractsResult {
  contracts: ContractSummary[];
  selected: ContractSummary | null;
  select: (summary: ContractSummary | null) => void;
  impact: ImpactReport | null;
  loading: boolean;
  rescan: () => void;
  generateTests: (contract: ContractSummary) => void;
}

/**
 * Contract Guard state hook. Owns:
 *   - the contracts list (`contracts-list` payloads)
 *   - the currently selected contract (sent back to server as `select-contract`)
 *   - the impact report for that selection (`contract-impact` payloads)
 *   - loading state across rescan + impact fetches
 *
 * Invariants this hook preserves:
 *   - WS listener is scoped to `[ws]`. `project` lives in a ref so switching
 *     projects does not resubscribe. All setState calls are functional.
 *   - Incoming payloads for a project the user has switched away from are
 *     dropped (mirrors `usePlanApprovalStats.ts`).
 *   - `selected` is matched by `sourceFile + repoName` — name alone is not
 *     unique when a repo ships multiple OpenAPI specs.
 */
export function useContracts(
  ws: WebSocket | null,
  project: string | null,
): UseContractsResult {
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [selected, setSelected] = useState<ContractSummary | null>(null);
  const [impact, setImpact] = useState<ImpactReport | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  const wsOpen = (socket: WebSocket | null): socket is WebSocket =>
    !!socket && socket.readyState === WebSocket.OPEN;

  const send = useCallback(
    (payload: Record<string, unknown>) => {
      if (!wsOpen(ws)) return;
      ws.send(JSON.stringify(payload));
    },
    [ws],
  );

  const rescan = useCallback(() => {
    const proj = projectRef.current;
    if (!proj || !wsOpen(ws)) return;
    setLoading(true);
    ws.send(JSON.stringify({ action: 'rescan-contracts', project: proj }));
  }, [ws]);

  const select = useCallback(
    (summary: ContractSummary | null) => {
      setSelected(() => summary);
      setImpact(() => null);
      if (!summary) return;
      const proj = projectRef.current;
      if (!proj) return;
      setLoading(true);
      send({
        action: 'select-contract',
        project: proj,
        sourceFile: summary.sourceFile,
        repoName: summary.repoName,
      });
    },
    [send],
  );

  const generateTests = useCallback(
    (contract: ContractSummary) => {
      const proj = projectRef.current;
      if (!proj) return;
      send({
        action: 'generate-contract-tests',
        project: proj,
        sourceFile: contract.sourceFile,
        repoName: contract.repoName,
      });
    },
    [send],
  );

  // Initial list fetch / project change.
  useEffect(() => {
    if (!ws || !project) {
      setContracts(() => []);
      setSelected(() => null);
      setImpact(() => null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setContracts(() => []);
    setSelected(() => null);
    setImpact(() => null);
    if (wsOpen(ws)) {
      ws.send(JSON.stringify({ action: 'list-contracts', project }));
    }
  }, [ws, project]);

  // Single scoped listener. Functional setState lets us avoid depending on
  // `selected` / `contracts` here and sidesteps stale closures entirely.
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
      const type = typeof m.type === 'string' ? m.type : '';
      const payload = m.payload as Record<string, unknown> | undefined;
      if (!payload) return;

      const payloadProject = typeof payload.project === 'string' ? payload.project : undefined;
      const currentProject = projectRef.current;
      if (currentProject && payloadProject && payloadProject !== currentProject) return;

      if (type === 'contracts-list') {
        const list = Array.isArray(payload.contracts)
          ? (payload.contracts as ContractSummary[])
          : [];
        setContracts(() => list);
        setLoading(false);
        return;
      }

      if (type === 'contract-selected') {
        const report = (payload.impact as ImpactReport | undefined) ?? null;
        setImpact(() => report);
        setLoading(false);
        return;
      }

      if (type === 'contract-impact') {
        const report = (payload.impact as ImpactReport | undefined) ?? null;
        setImpact(() => report);
        setLoading(false);
        return;
      }

      if (type === 'contract-tests-generated') {
        setLoading(false);
        return;
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  return { contracts, selected, select, impact, loading, rescan, generateTests };
}

export default useContracts;
