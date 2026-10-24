/**
 * MCP Server — registers tools and resources, handles lifecycle.
 * Supports stdio (default) and HTTP transports with auth.
 *
 * The server process is itself the index writer for the project it serves
 * (startup index, POST /index, scheduled reindex) and searches in-process; it
 * never routes to a running code-search-daemon — only the `code-search` CLI
 * picks a daemon backend. Don't point a daemon and a server at the same
 * project + data dir: both would write the same KB.
 */

import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cluster from 'node:cluster';

import { registerSearchTools, handleSearchTool } from './tools/search.js';
import { registerGraphTools, handleGraphTool } from './tools/graph.js';
import { registerProfileTools, handleProfileTool } from './tools/profile.js';
import { registerIndexTools, handleIndexTool } from './tools/index-tools';
import { registerResources, registerResourceTemplates, handleResource } from './resources/resources';
import {
  getBlobStore,
  readVectorIndexHealth,
  indexFromPath,
  invalidateRetriever,
  KnowledgeIndexer,
  type KnowledgeConfig,
} from '@esankhan3/anvil-knowledge-core';
import { loadServerConfig, resolvedKnowledgeConfig } from './core/env-config.js';
import { PACKAGE_VERSION } from './core/version.js';
import { startHttpTransport, HttpError, type AuthzDecision, type IndexRequestBody } from './transports/http-transport.js';
import type { AuthIdentity } from './middleware/auth.js';
import { localRateHit, localRateLimiter, type RateDecision, type RateLimiter } from './middleware/rate-limit.js';
import { ProjectRegistry, projectAccessAllowed, projectQuotaKey } from './projects/registry.js';
import { metrics } from './observability/metrics.js';
import { getComponentLogger } from './observability/logger.js';

const log = getComponentLogger('code-search-mcp');

// State shared across tools
export interface IndexingState {
  status: 'idle' | 'indexing' | 'error';
  phase: string | null;       // current phase: profiling, chunking, embedding, etc.
  message: string | null;     // latest progress message
  percent: number;            // 0-100
  startedAt: number | null;   // epoch ms when current indexing started
  error: string | null;       // last error message
  lastSuccess: string | null; // ISO timestamp of last successful index
  lastDurationMs: number;     // duration of last successful index
  history: Array<{            // recent indexing events (last 50)
    timestamp: string;
    type: 'start' | 'progress' | 'complete' | 'error';
    message: string;
  }>;
}

export interface ServerContext {
  projectName: string;
  directoryPath: string | null;
  indexReady: boolean;
  startedAt: number;
  indexing: IndexingState;
}

/** Create a wired MCP Server instance (shared logic for stdio and HTTP sessions) */
function createMcpServerInstance(ctx: ServerContext) {
  const server = new Server(
    { name: 'code-search-mcp', version: PACKAGE_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  const allTools = [
    ...registerSearchTools(),
    ...registerGraphTools(),
    ...registerProfileTools(),
    ...registerIndexTools(),
  ];

  server.setRequestHandler('tools/list', async () => ({
    tools: allTools,
  }));

  server.setRequestHandler('tools/call', async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    const searchResult = await handleSearchTool(name, args, ctx);
    if (searchResult) return searchResult;

    const graphResult = await handleGraphTool(name, args, ctx);
    if (graphResult) return graphResult;

    const profileResult = await handleProfileTool(name, args, ctx);
    if (profileResult) return profileResult;

    const indexResult = await handleIndexTool(name, args, ctx);
    if (indexResult) return indexResult;

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  });

  const allResources = registerResources(ctx);

  server.setRequestHandler('resources/list', async () => ({
    resources: allResources,
  }));

  server.setRequestHandler('resources/templates/list', async () => ({
    resourceTemplates: registerResourceTemplates(),
  }));

  server.setRequestHandler('resources/read', async (request) => {
    return handleResource(request.params.uri, ctx);
  });

  return server;
}

export async function startServer(
  projectName: string,
  directoryPath: string | null,
  opts: { force?: boolean } = {},
): Promise<void> {
  const config = loadServerConfig();
  const reindexIntervalMs = config.__unified.indexing.reindexIntervalMs;

  const ctx: ServerContext = {
    projectName,
    directoryPath,
    indexReady: false,
    startedAt: Date.now(),
    indexing: {
      status: 'idle',
      phase: null,
      message: null,
      percent: 0,
      startedAt: null,
      error: null,
      lastSuccess: null,
      lastDurationMs: 0,
      history: [],
    },
  };

  // Log resolved LLM configuration
  const llmInfo = config.llmMode === 'none'
    ? 'disabled (profiling + service mesh skipped)'
    : config.llmMode === 'api'
      ? `api → ${config.llmProvider}/${config.llmModel}${config.llmApiKey ? '' : ' (WARNING: no API key!)'}`
      : `cli → ${config.claudeBin}`;
  log.info(`LLM: ${llmInfo}`);

  // --- stdio: index first, then serve ---
  if (config.transport === 'stdio') {
    await autoIndex(ctx, { force: opts.force });
    const server = createMcpServerInstance(ctx);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info(`Server running for "${projectName}" (stdio)`);
    armScheduledReindex(ctx, reindexIntervalMs);
    return;
  }

  // --- HTTP: bind the port first, so /health and /ready answer while the
  // startup index runs (/ready is 503 until the index is servable) ---

  // ── Cluster mode (CODE_SEARCH_WORKERS > 1) ──────────────────────
  // The primary never serves HTTP: it forks N read-only workers that share
  // the listen port (kernel round-robin) and it stays the SOLE WRITER —
  // workers forward POST /index here over IPC, mirror its indexing state,
  // and ask it for rate-limit decisions (one window for the whole server).
  // A successful index fans a retriever-cache invalidate out to every worker.
  const workerCount = parseWorkerCount();
  if (workerCount > 1 && cluster.isPrimary) {
    runClusterPrimary(ctx, workerCount);
    // A scheduled reindex also refreshes disk — workers must drop caches too.
    armScheduledReindex(ctx, reindexIntervalMs, () => broadcastInvalidate(ctx.projectName));
    if (await autoIndex(ctx, { force: opts.force })) broadcastInvalidate(ctx.projectName);
    return;
  }

  // Security: warn if auth=none with non-localhost binding
  if (config.authMode === 'none' && config.host !== '127.0.0.1' && config.host !== 'localhost') {
    log.warn(`WARNING: Auth is disabled but server binds to ${config.host}. Any machine on the network can access your code search API.`);
    log.warn(`Set CODE_SEARCH_AUTH_MODE=api-key or CODE_SEARCH_HOST=127.0.0.1 for security.`);
  }

  const isReadOnlyWorker = cluster.isWorker;
  if (isReadOnlyWorker) registerWorkerIpc(ctx);
  const rateLimiter = isReadOnlyWorker ? primaryRateLimiter : localRateLimiter;

  await startHttpTransport({
    config,
    createMcpServer: async () => ({
      server: createMcpServerInstance(ctx),
    }),
    onReady: (url) => {
      log.info(`Server running for "${projectName}" at ${url}/mcp`);
      log.info(`Health:  GET  ${url}/health`);
      log.info(`Status:  GET  ${url}/status`);
      log.info(`Index:   POST ${url}/index`);
      log.info(`Auth: ${config.authMode}`);
    },
    getHealth: () => ({
      project: ctx.projectName,
      indexReady: ctx.indexReady,
      indexing: ctx.indexing.status,
      uptime: Math.floor((Date.now() - ctx.startedAt) / 1000),
      transport: config.transport,
      authMode: config.authMode,
    }),
    getStatus: () => ({
      project: ctx.projectName,
      directoryPath: ctx.directoryPath,
      indexReady: ctx.indexReady,
      uptime: Math.floor((Date.now() - ctx.startedAt) / 1000),
      indexing: {
        ...ctx.indexing,
        elapsedMs: ctx.indexing.startedAt ? Date.now() - ctx.indexing.startedAt : null,
      },
    }),
    collectMetrics: () => collectIndexMetrics(ctx.projectName, resolvedKnowledgeConfig(), ctx.indexing.lastSuccess),
    onIndex: (body) =>
      isReadOnlyWorker ? forwardIndexToPrimary(body) : runAdminIndex(ctx, body),
    authorize: createProjectAuthorizer(ctx, config.dataDir, rateLimiter),
    rateLimiter,
  });

  // Scheduled reindex — never on a read-only worker (the cluster primary is
  // the sole writer and arms its own schedule).
  if (!isReadOnlyWorker) armScheduledReindex(ctx, reindexIntervalMs);
  await autoIndex(ctx, { readOnly: isReadOnlyWorker, force: opts.force });
}

/**
 * Refresh the index gauges at scrape time from the writer's blobs (in
 * cluster mode the HTTP workers are not the writer). The collector owns these
 * gauges: each scrape starts them empty, so a vanished blob or a repo that
 * left the index drops its series instead of reporting a stale value.
 */
export async function collectIndexMetrics(
  project: string,
  knowledgeConfig: KnowledgeConfig,
  lastSuccess: string | null = null,
): Promise<void> {
  const owned = [metrics.indexAge, metrics.indexChunks, metrics.vectorIndexUnindexedRows, metrics.vectorIndexGrowthRatio];
  let stats: { repos?: Array<{ name: string; chunkCount: number }>; lastIndexed?: string } | null;
  let health: Awaited<ReturnType<typeof readVectorIndexHealth>>;
  try {
    const blobs = getBlobStore(project, knowledgeConfig);
    [stats, health] = await Promise.all([
      blobs.getJson<{ repos?: Array<{ name: string; chunkCount: number }>; lastIndexed?: string }>('index_stats.json'),
      readVectorIndexHealth(blobs),
    ]);
  } catch (err) {
    for (const g of owned) g.clear();
    throw err;
  }
  for (const g of owned) g.clear();
  const labels = { project };

  // The stats rollup only moves when an index changed something; this
  // process's own last success also counts a reindex that found nothing new.
  const lastMs = [stats?.lastIndexed, lastSuccess]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((t) => Number.isFinite(t));
  if (lastMs.length) metrics.indexAge.set(Math.max(0, Math.round((Date.now() - Math.max(...lastMs)) / 1000)), labels);
  for (const r of stats?.repos ?? []) metrics.indexChunks.set(r.chunkCount, { project, repo: r.name });

  if (health) {
    metrics.vectorIndexUnindexedRows.set(health.numUnindexedRows ?? 0, labels);
    if (health.trainedRows) metrics.vectorIndexGrowthRatio.set(health.rowsAddedSinceTrain / health.trainedRows, labels);
  }
}

/** Arm the reindex schedule (`indexing.reindexIntervalMs`; 0 = off). */
function armScheduledReindex(ctx: ServerContext, intervalMs: number, onSuccess?: () => void): void {
  if (intervalMs > 0 && ctx.directoryPath) {
    log.info(`Auto-reindex every ${Math.round(intervalMs / 60_000)}m`);
    setInterval(async () => {
      if (!ctx.directoryPath || ctx.indexing.status === 'indexing') return;
      try {
        await trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'auto-reindex' });
        onSuccess?.();
      } catch (err) {
        getComponentLogger('auto-reindex').error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, intervalMs).unref();
  }
}

/** Per-request /mcp authorization from the P8 registry entry of the served
 *  project (loaded once at boot): scopes + per-(identity, project) quota.
 *  No entry → nothing beyond authentication is enforced. */
function createProjectAuthorizer(
  ctx: ServerContext,
  dataDir: string,
  rateLimiter: RateLimiter,
): (identity: AuthIdentity) => Promise<AuthzDecision> {
  const projects = new ProjectRegistry(dataDir);
  projects.reload();
  return async (identity) => {
    const entry = projects.get(ctx.projectName);
    if (!entry) return { ok: true };
    if (!projectAccessAllowed(entry, identity.scopes)) {
      return { ok: false, status: 403, error: `Forbidden: project "${entry.name}" requires one of the scopes: ${entry.scopes.join(', ')}` };
    }
    const d = await rateLimiter(projectQuotaKey(entry, identity.subject), entry.quotas.maxQueriesPerMinute);
    if (!d.ok) {
      return {
        ok: false,
        status: 429,
        error: `Quota exceeded for project "${entry.name}": ${entry.quotas.maxQueriesPerMinute} requests/min`,
        retryAfterSec: d.retryAfterSec,
      };
    }
    return { ok: true };
  };
}

/** POST /index writer path — shared by the single-process server and the
 *  cluster primary (where it runs for requests forwarded from workers).
 *
 *  It (re)indexes the served project only, optionally from a new source path
 *  (which then becomes the project's directory for scheduled reindexes). A
 *  request naming another project is refused: the server serves exactly one
 *  project and must not silently switch to another. */
async function runAdminIndex(
  ctx: ServerContext,
  body: IndexRequestBody,
): Promise<Record<string, unknown>> {
  const project = body.project ?? ctx.projectName;
  if (project !== ctx.projectName) {
    throw new HttpError(400, `This server serves project "${ctx.projectName}"; POST /index only (re)indexes it. Index "${project}" with the code-search CLI or another server.`);
  }

  const dirPath = resolve(body.path);
  if (!existsSync(dirPath)) {
    throw new HttpError(400, `Path does not exist: ${dirPath}`);
  }

  if (ctx.indexing.status === 'indexing') {
    throw new HttpError(409, `Indexing already in progress (phase: ${ctx.indexing.phase}). Wait for it to complete or check GET /status.`);
  }

  const stats = await trackedIndex(ctx, project, dirPath, {
    force: body.force,
    label: 'admin-index',
  });
  ctx.directoryPath = dirPath;

  // indexFromPath returns the embed stage's stats; the cross-repo edge count
  // comes from the graph stage, recorded in the stats rollup.
  const rollup = await new KnowledgeIndexer().getStats(project, resolvedKnowledgeConfig());

  return {
    status: 'ok',
    project,
    path: dirPath,
    chunks: stats.totalChunks,
    repos: stats.repos.length,
    crossRepoEdges: rollup.crossRepoEdges,
    durationMs: stats.indexDurationMs,
  };
}

// ---------------------------------------------------------------------------
// Cluster mode — N read-only HTTP workers sharing the port, one writer primary
// ---------------------------------------------------------------------------

interface IndexRequestMsg {
  type: 'csm:index';
  id: number;
  body: IndexRequestBody;
}
interface IndexResultMsg {
  type: 'csm:index-result';
  id: number;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  status?: number;
}
interface InvalidateMsg {
  type: 'csm:invalidate';
  project: string;
}
interface StateMsg {
  type: 'csm:state';
  indexReady: boolean;
  directoryPath: string | null;
  indexing: IndexingState;
}
interface RateRequestMsg {
  type: 'csm:rate';
  id: number;
  key: string;
  limit: number;
}
interface RateResultMsg extends RateDecision {
  type: 'csm:rate-result';
  id: number;
}
type PrimaryToWorker = IndexResultMsg | InvalidateMsg | StateMsg | RateResultMsg;

function sendToWorker(w: import('node:cluster').Worker | undefined, msg: PrimaryToWorker): void {
  try { w?.send(msg); } catch { /* worker died — respawn handles it */ }
}

/** Primary → all workers: drop cached retrievers after a successful index. */
function broadcastInvalidate(project: string): void {
  const msg: InvalidateMsg = { type: 'csm:invalidate', project };
  for (const w of Object.values(cluster.workers ?? {})) sendToWorker(w, msg);
}

/** CODE_SEARCH_WORKERS — >1 enables cluster mode (capped at 16). */
function parseWorkerCount(): number {
  const n = parseInt(process.env.CODE_SEARCH_WORKERS ?? '', 10);
  return Number.isFinite(n) && n > 1 ? Math.min(n, 16) : 1;
}

/** Primary: fork workers, execute forwarded index requests as the sole
 *  writer, answer rate-limit checks from the one process-wide window, push
 *  its indexing state to the workers, respawn workers. */
function runClusterPrimary(ctx: ServerContext, workerCount: number): void {
  log.info(`Cluster primary ${process.pid}: forking ${workerCount} read-only workers (stateless MCP)`);
  let shuttingDown = false;

  const stateMsg = (): StateMsg => ({
    type: 'csm:state',
    indexReady: ctx.indexReady,
    directoryPath: ctx.directoryPath,
    indexing: ctx.indexing,
  });
  // Mirror the writer's indexing state to the workers that answer /status,
  // /ready and /admin/api/status (polled — progress updates are frequent).
  let lastState = '';
  setInterval(() => {
    const msg = stateMsg();
    const json = JSON.stringify(msg);
    if (json === lastState) return;
    lastState = json;
    for (const w of Object.values(cluster.workers ?? {})) sendToWorker(w, msg);
  }, 250).unref();
  cluster.on('online', (worker) => sendToWorker(worker, stateMsg()));

  cluster.on('message', (worker, msg: IndexRequestMsg | RateRequestMsg) => {
    if (msg?.type === 'csm:rate') {
      sendToWorker(worker, { type: 'csm:rate-result', id: msg.id, ...localRateHit(msg.key, msg.limit) });
      return;
    }
    if (msg?.type !== 'csm:index') return;
    void (async () => {
      try {
        const result = await runAdminIndex(ctx, msg.body);
        // Fresh index on disk → every worker drops its cached retriever
        broadcastInvalidate(ctx.projectName);
        sendToWorker(worker, { type: 'csm:index-result', id: msg.id, ok: true, result });
      } catch (err) {
        sendToWorker(worker, {
          type: 'csm:index-result',
          id: msg.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          status: err instanceof HttpError ? err.status : undefined,
        });
      }
    })();
  });

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) return;
    log.warn(`Worker ${worker.process.pid} exited (${signal ?? code}) — respawning`);
    cluster.fork();
  });

  const shutdown = (sig: NodeJS.Signals) => {
    shuttingDown = true;
    for (const w of Object.values(cluster.workers ?? {})) {
      try { w?.kill(sig); } catch { /* already gone */ }
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  for (let i = 0; i < workerCount; i++) cluster.fork();
}

// Worker-side IPC: pending forwarded requests keyed by sequence id.
let ipcSeq = 0;
const pendingIndexRequests = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
const pendingRateRequests = new Map<number, (d: RateDecision) => void>();

/** Worker: forward a POST /index body to the primary and await its result. */
function forwardIndexToPrimary(body: IndexRequestBody): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!process.send) {
      rejectPromise(new Error('IPC channel unavailable — not a cluster worker'));
      return;
    }
    const id = ++ipcSeq;
    pendingIndexRequests.set(id, { resolve: resolvePromise, reject: rejectPromise });
    const msg: IndexRequestMsg = { type: 'csm:index', id, body };
    process.send(msg);
  });
}

/** Worker: rate-limit decisions come from the primary's window, so a limit
 *  is per server, not per worker. Falls back to this worker's own window if
 *  the primary doesn't answer within 2s. */
const primaryRateLimiter: RateLimiter = (key, limit) => new Promise((resolveP) => {
  if (!process.send || limit <= 0) {
    resolveP(localRateHit(key, limit));
    return;
  }
  const id = ++ipcSeq;
  const timer = setTimeout(() => {
    pendingRateRequests.delete(id);
    resolveP(localRateHit(key, limit));
  }, 2_000);
  pendingRateRequests.set(id, (d) => { clearTimeout(timer); resolveP(d); });
  const msg: RateRequestMsg = { type: 'csm:rate', id, key, limit };
  process.send(msg);
});

/** Worker: handle results, invalidate broadcasts and state from the primary. */
function registerWorkerIpc(ctx: ServerContext): void {
  process.on('message', (msg: PrimaryToWorker) => {
    if (msg?.type === 'csm:index-result') {
      const pending = pendingIndexRequests.get(msg.id);
      if (!pending) return;
      pendingIndexRequests.delete(msg.id);
      if (msg.ok) pending.resolve(msg.result ?? {});
      else pending.reject(new HttpError(msg.status ?? 500, msg.error ?? 'Index failed'));
    } else if (msg?.type === 'csm:rate-result') {
      const pending = pendingRateRequests.get(msg.id);
      pendingRateRequests.delete(msg.id);
      pending?.({ ok: msg.ok, retryAfterSec: msg.retryAfterSec });
    } else if (msg?.type === 'csm:invalidate') {
      void invalidateRetriever(msg.project).catch(() => { /* next query rebuilds */ });
      if (msg.project === ctx.projectName) ctx.indexReady = true;
    } else if (msg?.type === 'csm:state') {
      ctx.indexing = msg.indexing;
      ctx.directoryPath = msg.directoryPath;
      // Readiness never regresses; the worker may have found the index on disk.
      ctx.indexReady = ctx.indexReady || msg.indexReady;
    }
  });
  // Orphaned worker (primary died) — exit; the container supervisor restarts.
  process.on('disconnect', () => process.exit(0));
}

const MAX_HISTORY = 50;

function pushHistory(ctx: ServerContext, type: 'start' | 'progress' | 'complete' | 'error', message: string): void {
  ctx.indexing.history.push({ timestamp: new Date().toISOString(), type, message });
  if (ctx.indexing.history.length > MAX_HISTORY) {
    ctx.indexing.history = ctx.indexing.history.slice(-MAX_HISTORY);
  }
}

/** Wrap an indexFromPath call with status tracking */
async function trackedIndex(
  ctx: ServerContext,
  project: string,
  dirPath: string,
  opts?: { force?: boolean; label?: string },
): Promise<{ totalChunks: number; repos: Array<{ name: string }>; crossRepoEdges: number; indexDurationMs: number }> {
  const label = opts?.label ?? 'index';
  const progressLog = getComponentLogger(label);

  ctx.indexing.status = 'indexing';
  ctx.indexing.phase = 'starting';
  ctx.indexing.message = `Starting ${label}...`;
  ctx.indexing.percent = 0;
  ctx.indexing.startedAt = Date.now();
  ctx.indexing.error = null;
  pushHistory(ctx, 'start', `${label}: started for "${project}" at ${dirPath}`);

  try {
    // Explicit KnowledgeConfig from the unified resolver, so CODE_SEARCH_* env
    // vars / config file / CLI flags reach the indexer.
    const stats = await indexFromPath(project, dirPath, {
      force: opts?.force,
      config: resolvedKnowledgeConfig(),
      onProgress: (m) => {
        ctx.indexing.message = m;
        progressLog.info(m);
      },
      onDetailedProgress: (p) => {
        ctx.indexing.phase = p.phase;
        ctx.indexing.percent = p.percent;
        ctx.indexing.message = p.message;
      },
    });

    // Fresh data on disk → drop the cached retriever so the next query rebuilds
    // against the new index (otherwise the cache would serve pre-reindex results).
    try { await invalidateRetriever(project); } catch { /* non-fatal */ }

    ctx.indexReady = true;
    ctx.indexing.status = 'idle';
    ctx.indexing.phase = null;
    ctx.indexing.percent = 100;
    ctx.indexing.lastSuccess = new Date().toISOString();
    ctx.indexing.lastDurationMs = stats.indexDurationMs;
    ctx.indexing.message = `Completed: ${stats.totalChunks} chunks, ${stats.repos.length} repos in ${Math.round(stats.indexDurationMs / 1000)}s`;
    pushHistory(ctx, 'complete', ctx.indexing.message);

    return stats;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.indexing.status = 'error';
    ctx.indexing.error = msg;
    ctx.indexing.message = `Failed: ${msg}`;
    pushHistory(ctx, 'error', msg);
    throw err;
  }
}

/** Make the served project ready: load an existing index, or (writer only)
 *  build it — always rebuilt when `force`. Returns true when it built one. */
async function autoIndex(ctx: ServerContext, opts?: { readOnly?: boolean; force?: boolean }): Promise<boolean> {
  try {
    const rebuild = !!opts?.force && !opts.readOnly && !!ctx.directoryPath;
    const blobs = getBlobStore(ctx.projectName, resolvedKnowledgeConfig());
    // Remote backends: `lancedb` is NOT a blob key (vectors live in object
    // storage), so existence-of-lancedb can never turn a Mongo/S3 reader
    // ready. The writer's stats rollup is the cross-backend readiness signal —
    // its embeddingProvider is patched from 'pending' when embedding finishes,
    // i.e. exactly when search is servable.
    const stats = await blobs.getJson<{ embeddingProvider?: string }>('index_stats.json');
    const statsReady = !!stats && stats.embeddingProvider !== 'pending';
    // Legacy local layout (pre-rollup indexes): lancedb dir + system graph.
    const hasLanceDB = await blobs.exists('lancedb');
    const hasGraph = (await blobs.exists('system_graph.sqlite')) || (await blobs.exists('system_graph_v2.json'));

    if ((statsReady || (hasLanceDB && hasGraph)) && !rebuild) {
      ctx.indexReady = true;
      log.info(`Index loaded for "${ctx.projectName}"`);
      return false;
    }

    if (opts?.readOnly) {
      // Read-only cluster worker: the primary owns the initial index; this
      // worker turns ready on the primary's invalidate broadcast.
      log.info(`No index yet — read-only worker waiting for the writer`);
      return false;
    }

    if (!ctx.directoryPath) {
      log.warn(`No index found and no directory path — tools will return empty results`);
      return false;
    }

    // Build KB + Embed
    log.info(`${rebuild ? 'Forced re-index' : 'No index found'} — building from ${ctx.directoryPath}...`);
    await trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'auto-index', force: rebuild });
    log.info(`Index ready.`);
    return true;
  } catch (err) {
    log.error(`Auto-index failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return false;
  }
}
