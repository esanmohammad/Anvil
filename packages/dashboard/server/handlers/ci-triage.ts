/**
 * CI-triage read route (Recipe 7 / Phase 1).
 *
 * Migrated:
 *   - list-ci-triage — history records for a project (paged by `limit`)
 *
 * NOT migrated (mutating — closure-dependent on the agent manager +
 * analyzer pipeline):
 *   - analyze-ci-log
 */

import { route, type Handler } from './route.js';
import * as Z from './schemas.js';

/**
 * Per-connection cache for the latest CI report so `save-ci-triage` can
 * persist what `analyze-ci-log` / `fetch-ci-log` just produced without
 * the client having to round-trip it. Mirrors the legacy
 * `(ws as { __lastCiReport }).__lastCiReport = report` patch.
 */
function stashLastCiReport(ws: { send(data: string): void }, report: unknown): void {
  (ws as unknown as { __lastCiReport?: unknown }).__lastCiReport = report;
}
function recallLastCiReport(ws: { send(data: string): void }): unknown {
  return (ws as unknown as { __lastCiReport?: unknown }).__lastCiReport;
}

export function ciTriageRoutes(): Record<string, Handler> {
  return {
    'analyze-ci-log': route({
      input: Z.AnalyzeCiLog,
      errorWireType: 'ci-triage-error',
      handle: async (input, deps) => {
        const { clusterCiLog } = await import('../ci-log-clusterer.js');
        const report = clusterCiLog({ logText: input.logText, logSource: input.logSource });
        stashLastCiReport(deps.ws, report);
        return { project: input.project, report };
      },
      wireType: 'ci-triage-report',
    }),

    'fetch-ci-log': route({
      input: Z.FetchCiLog,
      errorWireType: 'ci-log-fetch-error',
      handle: async (input, deps) => {
        const { execSync } = await import('node:child_process');
        const { clusterCiLog } = await import('../ci-log-clusterer.js');
        // Accept either a full URL (https://github.com/o/r/actions/runs/<id>)
        // or a bare run id; pass `--repo o/r` when extractable.
        const idMatch = input.logUrl.match(/\/runs\/(\d+)/) ?? input.logUrl.match(/^(\d+)$/);
        const runId = idMatch ? idMatch[1] : input.logUrl;
        const repoMatch = input.logUrl.match(/github\.com\/([^/]+\/[^/]+)/);
        const repoFlag = repoMatch ? ['--repo', repoMatch[1]] : [];
        try {
          const out = execSync(`gh run view ${runId} --log ${repoFlag.map((a) => `"${a}"`).join(' ')}`, {
            timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
          }).toString();
          const report = clusterCiLog({ logText: out, logSource: input.logUrl });
          stashLastCiReport(deps.ws, report);
          return { project: input.project, report };
        } catch (err) {
          const msgText = err instanceof Error ? err.message : String(err);
          throw new Error(`gh fetch failed: ${msgText.slice(0, 400)}`);
        }
      },
      wireType: 'ci-triage-report',
    }),

    'save-ci-triage': route({
      input: Z.SaveCiTriage,
      errorWireType: 'ci-triage-error',
      handle: (input, deps) => {
        const store = deps.extras.ciTriageStore;
        if (!store) return;
        const report = input.report ?? recallLastCiReport(deps.ws);
        if (!report) {
          // Legacy parity message — covers both "no analyze first" + "no payload".
          return { error: 'no-report' };
        }
        const record = store.record(input.project, report, input.ciRunId);
        return { record, report };
      },
      wireType: 'ci-triage-saved',
      errorMessage: () => 'project required (and analyze first or pass report)',
    }),

    'list-ci-triage': route({
      input: Z.ListCiTriage,
      errorWireType: 'ci-triage-error',
      handle: (input, deps) => {
        const store = deps.extras.ciTriageStore;
        if (!store) return;
        return {
          project: input.project,
          history: store.list(input.project, { limit: input.limit }),
        };
      },
      wireType: 'ci-triage-history',
    }),
  };
}
