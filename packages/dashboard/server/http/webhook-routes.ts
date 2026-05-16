/**
 * HTTP webhook routes (Phase 2.8 extraction).
 *
 * Lifted verbatim out of `serveStatic` in `dashboard-server.ts`:
 *   - /share/plan/:token         (signed plan share)
 *   - /share/tests/:token        (signed test-spec share)
 *   - /api/incidents/webhook/*   (sentry / incidentio / generic)
 *   - /api/pipeline/approve      (HMAC-signed approval link)
 *   - /api/contracts/list        (GET)
 *   - /api/contracts/drift       (POST)
 *   - /api/contracts/generate    (POST 501)
 *   - /api/contracts/verify      (POST 501)
 *   - /api/tests/rank            (POST)
 *   - /api/triage/analyze        (POST)
 *   - /api/kb/:project/:repo/graph.html
 *
 * `tryWebhookRoutes` returns `true` if a route handled the request (so
 * `serveStatic` should stop) or `false` to fall through to static files.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { IncidentStore } from '../incident-store.js';
import type { ReplayStore } from '../replay-store.js';
import type { TestSpecStore } from '../test-spec-store.js';
import type { TestCaseStore } from '../test-case-store.js';
import type { TestLearningsStore } from '../test-learnings.js';
import type { BoundTestsStore } from '../bound-tests.js';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import type { ProjectLoader } from '../project-loader.js';
import type { DashboardServices } from '../services/index.js';
import type { PipelinePauseStore } from '../pipeline-pause-store.js';
import type { KnowledgeBaseManager } from '../knowledge-base-manager.js';
import type { CiTriageStore } from '../ci-triage-store.js';

import { PlanStore } from '../plan-store.js';
import { verifyShareToken, getOrCreateShareSecret } from '../plan-share.js';
import { verifyApprovalToken } from '../pipeline-approval-tokens.js';

export interface WebhookDeps {
  incidentStore: IncidentStore;
  replayStore: ReplayStore;
  testSpecStore: TestSpecStore;
  testCaseStore: TestCaseStore;
  testLearningsStore: TestLearningsStore;
  boundTestsStore: BoundTestsStore;
  agentManager: AgentManager;
  projectLoader: ProjectLoader;
  services: DashboardServices;
  enqueueReplay: (incidentId: string, project: string) => { queueDepth: number };
  pauseStore?: PipelinePauseStore;
  approvalSecret?: string;
  kbManager?: KnowledgeBaseManager;
  ciTriageStore?: CiTriageStore;
}

export async function tryWebhookRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  anvilHome: string,
  kbManagerRef?: { current: KnowledgeBaseManager | null },
  webhookDepsRef?: { current: WebhookDeps | null },
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  // Serve shared plan: /share/plan/:token
  const shareMatch = url.pathname.match(/^\/share\/plan\/([A-Za-z0-9_\-.]+)$/);
  if (shareMatch) {
    try {
      const secret = getOrCreateShareSecret(anvilHome);
      const payload = verifyShareToken(shareMatch[1], secret);
      if (!payload) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Share link invalid or expired.' }));
        return true;
      }
      const planStoreLocal = new PlanStore(anvilHome);
      const plan = planStoreLocal.readVersion(payload.project, payload.slug, payload.version);
      if (!plan) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Plan version not found.' }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ plan, expiresAt: payload.expiresAt }));
      return true;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
      return true;
    }
  }

  // Serve shared test spec: /share/tests/:token
  const testShareMatch = url.pathname.match(/^\/share\/tests\/([A-Za-z0-9_\-.]+)$/);
  if (testShareMatch) {
    try {
      const { verifyTestShareToken, getOrCreateTestShareSecret } = await import('../test-share.js');
      const secret = getOrCreateTestShareSecret(anvilHome);
      const payload = verifyTestShareToken(testShareMatch[1], secret);
      if (!payload) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Share link invalid or expired.' }));
        return true;
      }
      const { TestSpecStore: TestSpecStoreCtor } = await import('../test-spec-store.js');
      const { TestCaseStore: TestCaseStoreCtor } = await import('../test-case-store.js');
      const specStore = new TestSpecStoreCtor(anvilHome);
      const caseStore = new TestCaseStoreCtor(anvilHome);
      const spec = specStore.readVersion(payload.project, payload.slug, payload.version);
      if (!spec) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Test spec version not found.' }));
        return true;
      }
      const cases = caseStore.readCases(payload.project, payload.slug, payload.version);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ spec, cases, expiresAt: payload.expiresAt }));
      return true;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
      return true;
    }
  }

  // Incident webhooks
  if (url.pathname.startsWith('/api/incidents/webhook/') && webhookDepsRef?.current) {
    const deps = webhookDepsRef.current;
    try {
      const { dispatchIncidentWebhook } = await import('../incident-webhooks.js');
      const handled = await dispatchIncidentWebhook(req, res, {
        anvilHome,
        resolveProject: (u: URL) => {
          const q = u.searchParams.get('project');
          if (q) return q.trim() || null;
          const h = req.headers['x-anvil-project'];
          if (typeof h === 'string') return h.trim() || null;
          if (Array.isArray(h) && h[0]) return h[0].trim() || null;
          return null;
        },
        onIncident: async (parsed, autoReplay) => {
          try {
            const project = (req.headers['x-anvil-project'] as string | undefined)
              ?? new URL(req.url ?? '/', `http://${req.headers.host}`).searchParams.get('project')
              ?? '';
            if (!project) return;
            const incident = deps.incidentStore.ingest(project, parsed.source, parsed.externalId, parsed);
            deps.services.incidents.emit('incident.ingested', { incident });
            if (autoReplay) {
              const { queueDepth } = deps.enqueueReplay(incident.id, project);
              deps.services.incidents.emit('replay.queued', { incidentId: incident.id, project, queueDepth });
            }
          } catch (err) {
            console.warn('[incidents] webhook onIncident failed:', err);
          }
        },
      });
      if (handled) return true;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Webhook error' }));
      return true;
    }
  }

  // Pipeline approval link
  if (url.pathname === '/api/pipeline/approve' && webhookDepsRef?.current) {
    const deps = webhookDepsRef.current;
    const token = url.searchParams.get('token') ?? '';
    const secret = deps.approvalSecret ?? '';
    const pauseStore = deps.pauseStore;
    if (!token || !secret || !pauseStore) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>400 — missing token, secret, or pause store</h1>');
      return true;
    }
    const payload = verifyApprovalToken(token, secret);
    if (!payload) {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('<h1>403 — token invalid or expired</h1>');
      return true;
    }
    try {
      if (payload.action === 'approve') {
        const existing = pauseStore.get(payload.runId);
        if (!existing) {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('<h1>404 — pause not found</h1>');
          return true;
        }
        if (existing.status === 'paused-awaiting-user') {
          pauseStore.resume(payload.runId, { action: 'approve' }, 'approval-link');
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>✅ Approved</h1><p>The paused stage has been resumed. You can close this tab.</p>');
        deps.services.pipeline.emit('pipeline.resumed', { pause: pauseStore.get(payload.runId) } as never);
      } else if (payload.action === 'reject') {
        const existing = pauseStore.get(payload.runId);
        if (existing && existing.status === 'paused-awaiting-user') {
          pauseStore.cancel(payload.runId, 'approval-link');
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>🛑 Rejected</h1><p>The paused stage has been cancelled. You can close this tab.</p>');
        deps.services.pipeline.emit('pipeline.cancelled', { pause: pauseStore.get(payload.runId) } as never);
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>500 — ${err instanceof Error ? err.message : 'approve handler error'}</h1>`);
    }
    return true;
  }

  // Contract Guard endpoints
  if (url.pathname === '/api/contracts/list' && webhookDepsRef?.current) {
    const deps = webhookDepsRef.current;
    const project = url.searchParams.get('project') ?? '';
    const repoFilter = url.searchParams.get('repo') ?? '';
    if (!project) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project query param required' }));
      return true;
    }
    try {
      const { discoverContracts: discover } = await import('../contract-discovery.js');
      const repoPaths = deps.projectLoader.getRepoLocalPaths(project);
      const contracts: unknown[] = [];
      for (const [repoName, repoPath] of Object.entries(repoPaths)) {
        if (repoFilter && repoName !== repoFilter) continue;
        if (!repoPath || !existsSync(repoPath)) continue;
        contracts.push(...discover(repoPath, repoName));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ project, contracts }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  if (url.pathname === '/api/contracts/drift' && req.method === 'POST' && webhookDepsRef?.current) {
    const deps = webhookDepsRef.current;
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { project } = JSON.parse(body || '{}') as { project?: string };
      if (!project) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project required' }));
        return true;
      }
      const { discoverContracts: discover } = await import('../contract-discovery.js');
      const { detectConsumerCalls: detect } = await import('../contract-consumer-detector.js');
      const { buildContractGraph: build } = await import('../contract-graph-builder.js');
      const repoPaths = deps.projectLoader.getRepoLocalPaths(project);
      const contracts: unknown[] = [];
      const calls: unknown[] = [];
      for (const [repoName, repoPath] of Object.entries(repoPaths)) {
        if (!repoPath || !existsSync(repoPath)) continue;
        contracts.push(...discover(repoPath, repoName));
        calls.push(...detect(repoPath, repoName));
      }
      const graph = build(contracts as never, calls as never);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ project, graph }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  if (url.pathname === '/api/contracts/generate' && req.method === 'POST') {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'contracts generate not yet wired to a request-diff input; use dashboard UI' }));
    return true;
  }
  if (url.pathname === '/api/contracts/verify' && req.method === 'POST') {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'contracts verify not yet wired; use CLI test runner directly' }));
    return true;
  }

  // Test relevance ranking
  if (url.pathname === '/api/tests/rank' && req.method === 'POST' && webhookDepsRef?.current) {
    const deps = webhookDepsRef.current;
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { project, changedSymbols } = JSON.parse(body || '{}') as { project?: string; changedSymbols?: unknown[] };
      if (!project || !Array.isArray(changedSymbols)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project + changedSymbols required' }));
        return true;
      }
      const { rankRelevantTests: rank } = await import('../test-relevance-ranker.js');
      const repoPaths = deps.projectLoader.getRepoLocalPaths(project);
      const repoGraphs: Record<string, unknown> = {};
      if (deps.kbManager) {
        for (const repoName of Object.keys(repoPaths)) {
          try {
            const graphHtml = deps.kbManager.getGraphHtmlPath(project, repoName);
            if (graphHtml) {
              const graphJson = graphHtml.replace(/graph\.html$/, 'graph.json');
              if (existsSync(graphJson)) {
                repoGraphs[repoName] = JSON.parse(readFileSync(graphJson, 'utf-8'));
              }
            }
          } catch { /* ignore */ }
        }
      }
      const result = rank({ changedSymbols: changedSymbols as never, repoGraphs });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ project, result }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // CI triage HTTP
  if (url.pathname === '/api/triage/analyze' && req.method === 'POST' && webhookDepsRef?.current) {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { logText, logSource, project } = JSON.parse(body || '{}') as { logText?: string; logSource?: string; project?: string };
      if (!logText) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'logText required' }));
        return true;
      }
      const { clusterCiLog: cluster } = await import('../ci-log-clusterer.js');
      const report = cluster({ logText, logSource });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ project, report }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // KB graph HTML
  const kbMatch = url.pathname.match(/^\/api\/kb\/([^/]+)\/([^/]+)\/graph\.html$/);
  if (kbMatch && kbManagerRef?.current) {
    const htmlPath = kbManagerRef.current.getGraphHtmlPath(kbMatch[1], kbMatch[2]);
    if (htmlPath) {
      try {
        const data = await readFile(htmlPath);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
        return true;
      } catch { /* fall through */ }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Knowledge graph not found');
    return true;
  }

  return false;
}
