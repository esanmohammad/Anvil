/**
 * Knowledge-base WS route (Recipe 7 / Phase 1).
 *
 * Migrated:
 *   - refresh-knowledge-base — echo `kb-refresh-started`; legacy `error`
 *     wire-type when a refresh is already in progress.
 *
 * NOT migrated (read-only — stay handler-side until a read-route shape
 * lands):
 *   - get-kb-data, query-kb, get-kb-index, get-kb-status.
 */

import { route, type Handler } from './route.js';
import * as Z from './schemas.js';

export function kbRoutes(): Record<string, Handler> {
  return {
    // ── Reads ───────────────────────────────────────────────────────────
    'get-kb-data': route({
      input: Z.GetKbData,
      handle: async (input, deps) => {
        const kb = deps.extras.kbManager;
        if (!kb) return;
        const repo = input.repo ?? '';
        const report = repo === '__system__'
          ? kb.getProjectReport(input.project)
          : repo
            ? kb.getGraphReport(input.project, repo)
            : kb.getAllGraphReports(input.project);
        const hasHtml = (repo && repo !== '__system__') ? !!kb.getGraphHtmlPath(input.project, repo) : false;
        let status: unknown = null;
        try { status = await kb.getStatus(input.project); } catch { /* tolerate */ }
        return { project: input.project, repo: repo || null, report, hasHtml, status };
      },
      wireType: 'kb-data',
    }),

    'query-kb': route({
      input: Z.QueryKb,
      handle: (input, deps) => {
        const kb = deps.extras.kbManager;
        if (!kb) return;
        return kb.queryKnowledgeBase(input.project, input.query, input.maxChars);
      },
      wireType: 'kb-query-result',
    }),

    'get-kb-index': route({
      input: Z.GetKbIndex,
      handle: (input, deps) => {
        const kb = deps.extras.kbManager;
        if (!kb) return;
        return kb.getProjectIndex(input.project);
      },
      wireType: 'kb-index',
    }),

    'get-kb-status': route({
      input: Z.GetKbStatus,
      handle: async (input, deps) => {
        const kb = deps.extras.kbManager;
        if (!kb) return;
        return kb.getStatus(input.project);
      },
      wireType: 'kb-status',
    }),

    // ── Mutations ───────────────────────────────────────────────────────
    'refresh-knowledge-base': route({
      input: Z.RefreshKnowledgeBase,
      handle: (input, deps) => {
        const outcome = deps.services.kb.refresh(input);
        if ('inProgress' in outcome) return { error: 'in-progress' };
        return { project: input.project };
      },
      wireType: 'kb-refresh-started',
      errorMessage: () => 'Knowledge base refresh already in progress',
    }),
  };
}
