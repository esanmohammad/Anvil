/**
 * MCP Server — registers tools and resources, handles lifecycle.
 * Supports stdio (default) and HTTP transports with auth.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import cluster from 'node:cluster';

import { registerSearchTools, handleSearchTool } from './tools/search.js';
import { registerGraphTools, handleGraphTool } from './tools/graph.js';
import { registerProfileTools, handleProfileTool } from './tools/profile.js';
import { registerIndexTools, handleIndexTool } from './tools/index-tools';
import { registerResources, handleResource } from './resources/resources';
import { getKnowledgeBasePath } from '@esankhan3/anvil-knowledge-core';
import { indexFromPath, invalidateRetriever } from '@esankhan3/anvil-knowledge-core';
import { loadServerConfig, type ServerConfig } from './core/env-config.js';
import { toKnowledgeConfig } from './core/config.js';
import { startHttpTransport } from './transports/http-transport.js';

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
    { name: 'code-search-mcp', version: '0.4.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  const allTools = [
    ...registerSearchTools(),
    ...registerGraphTools(),
    ...registerProfileTools(),
    ...registerIndexTools(),
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
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

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: allResources,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return handleResource(request.params.uri, ctx);
  });

  return server;
}

export async function startServer(
  projectName: string,
  directoryPath: string | null,
): Promise<void> {
  const config = loadServerConfig();

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
  console.error(`[code-search-mcp] LLM: ${llmInfo}`);

  // --- Auto-index if needed ---
  // Cluster workers are read-only: they must never race the primary (the sole
  // writer) into a concurrent initial index — they only check the disk flag.
  await autoIndex(ctx, { readOnly: cluster.isWorker });

  // --- Start transport ---
  if (config.transport === 'stdio') {
    const server = createMcpServerInstance(ctx);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[code-search-mcp] Server running for "${projectName}" (stdio)`);
  } else {
    // ── Cluster mode (CODE_SEARCH_WORKERS > 1) ──────────────────────
    // The primary never serves HTTP: it forks N read-only workers that share
    // the listen port (kernel round-robin) and it stays the SOLE WRITER —
    // workers forward POST /index here over IPC, and a successful index fans a
    // retriever-cache invalidate back out to every worker.
    const workerCount = parseWorkerCount();
    if (workerCount > 1 && cluster.isPrimary) {
      // A scheduled reindex also refreshes disk — workers must drop caches too.
      armScheduledReindex(ctx, () => broadcastInvalidate(ctx));
      runClusterPrimary(ctx, workerCount);
      return;
    }

    // Security: warn if auth=none with non-localhost binding
    if (config.authMode === 'none' && config.host !== '127.0.0.1' && config.host !== 'localhost') {
      console.error(`[code-search-mcp] WARNING: Auth is disabled but server binds to ${config.host}. Any machine on the network can access your code search API.`);
      console.error(`[code-search-mcp] Set CODE_SEARCH_AUTH_MODE=api-key or CODE_SEARCH_HOST=127.0.0.1 for security.`);
    }

    const isReadOnlyWorker = cluster.isWorker;
    if (isReadOnlyWorker) registerWorkerIpc(ctx);

    await startHttpTransport({
      config,
      // Workers must be stateless: the fronting proxy opens a new upstream
      // connection per request, so in-memory MCP sessions cannot stick to one
      // worker. Also opt-in for single-process deploys via env.
      stateless: isReadOnlyWorker || process.env.CODE_SEARCH_STATELESS === '1',
      createMcpServer: async () => ({
        server: createMcpServerInstance(ctx),
      }),
      onReady: (url) => {
        console.error(`[code-search-mcp] Server running for "${projectName}" at ${url}/mcp`);
        console.error(`[code-search-mcp] Health:  GET  ${url}/health`);
        console.error(`[code-search-mcp] Status:  GET  ${url}/status`);
        console.error(`[code-search-mcp] Index:   POST ${url}/index`);
        console.error(`[code-search-mcp] Auth: ${config.authMode}`);
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
      onIndex: (body) =>
        isReadOnlyWorker ? forwardIndexToPrimary(body) : runAdminIndex(ctx, body),
    });
  }

  // Scheduled reindex — never on a read-only worker (the primary is the sole
  // writer and arms its own schedule before forking).
  if (!cluster.isWorker) armScheduledReindex(ctx);
}

/** Arm the CODE_SEARCH_REINDEX_INTERVAL schedule (no-op when 0/unset). */
function armScheduledReindex(ctx: ServerContext, onSuccess?: () => void): void {
  const reindexIntervalMs = parseReindexInterval();
  if (reindexIntervalMs > 0 && ctx.directoryPath) {
    console.error(`[code-search-mcp] Auto-reindex every ${Math.round(reindexIntervalMs / 60_000)}m`);
    setInterval(async () => {
      if (!ctx.directoryPath || ctx.indexing.status === 'indexing') return;
      try {
        await trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'auto-reindex' });
        onSuccess?.();
      } catch (err) {
        console.error(`[auto-reindex] Failed:`, err);
      }
    }, reindexIntervalMs).unref();
  }
}

/** POST /index writer path — shared by the single-process server and the
 *  cluster primary (where it runs for requests forwarded from workers). */
async function runAdminIndex(
  ctx: ServerContext,
  body: { path: string; project?: string; force?: boolean },
): Promise<Record<string, unknown>> {
  const dirPath = resolve(body.path);
  if (!existsSync(dirPath)) {
    throw new Error(`Path does not exist: ${dirPath}`);
  }

  if (ctx.indexing.status === 'indexing') {
    throw new Error(`Indexing already in progress (phase: ${ctx.indexing.phase}). Wait for it to complete or check GET /status.`);
  }

  const project = body.project || dirPath.split('/').filter(Boolean).pop() || 'project';

  const stats = await trackedIndex(ctx, project, dirPath, {
    force: body.force,
    label: 'admin-index',
  });

  ctx.projectName = project;
  ctx.directoryPath = dirPath;

  return {
    status: 'ok',
    project,
    path: dirPath,
    chunks: stats.totalChunks,
    repos: stats.repos.length,
    crossRepoEdges: stats.crossRepoEdges,
    durationMs: stats.indexDurationMs,
  };
}

// ---------------------------------------------------------------------------
// Cluster mode — N read-only HTTP workers sharing the port, one writer primary
// ---------------------------------------------------------------------------

interface IndexRequestMsg {
  type: 'csm:index';
  id: number;
  body: { path: string; project?: string; force?: boolean };
}
interface IndexResultMsg {
  type: 'csm:index-result';
  id: number;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}
interface InvalidateMsg {
  type: 'csm:invalidate';
  project: string;
  directoryPath: string | null;
}

/** Primary → all workers: drop cached retrievers after a successful index. */
function broadcastInvalidate(ctx: ServerContext): void {
  const msg: InvalidateMsg = { type: 'csm:invalidate', project: ctx.projectName, directoryPath: ctx.directoryPath };
  for (const w of Object.values(cluster.workers ?? {})) {
    try { w?.send(msg); } catch { /* worker died — respawn handles it */ }
  }
}

/** CODE_SEARCH_WORKERS — >1 enables cluster mode (capped at 16). */
function parseWorkerCount(): number {
  const n = parseInt(process.env.CODE_SEARCH_WORKERS ?? '', 10);
  return Number.isFinite(n) && n > 1 ? Math.min(n, 16) : 1;
}

/** Primary: fork workers, execute forwarded index requests as the sole
 *  writer, fan invalidates out after each successful index, respawn workers. */
function runClusterPrimary(ctx: ServerContext, workerCount: number): void {
  console.error(`[code-search-mcp] Cluster primary ${process.pid}: forking ${workerCount} read-only workers (stateless MCP)`);
  let shuttingDown = false;

  const send = (w: import('node:cluster').Worker | undefined, msg: IndexResultMsg | InvalidateMsg) => {
    try { w?.send(msg); } catch { /* worker died — respawn handles it */ }
  };

  cluster.on('message', (worker, msg: IndexRequestMsg) => {
    if (msg?.type !== 'csm:index') return;
    void (async () => {
      try {
        const result = await runAdminIndex(ctx, msg.body);
        // Fresh index on disk → every worker drops its cached retriever
        broadcastInvalidate(ctx);
        send(worker, { type: 'csm:index-result', id: msg.id, ok: true, result });
      } catch (err) {
        send(worker, {
          type: 'csm:index-result',
          id: msg.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) return;
    console.error(`[code-search-mcp] Worker ${worker.process.pid} exited (${signal ?? code}) — respawning`);
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

// Worker-side IPC: pending forwarded /index requests keyed by sequence id.
let ipcSeq = 0;
const pendingIndexRequests = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();

/** Worker: forward a POST /index body to the primary and await its result. */
function forwardIndexToPrimary(body: { path: string; project?: string; force?: boolean }): Promise<Record<string, unknown>> {
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

/** Worker: handle index results + invalidate broadcasts from the primary. */
function registerWorkerIpc(ctx: ServerContext): void {
  process.on('message', (msg: IndexResultMsg | InvalidateMsg) => {
    if (msg?.type === 'csm:index-result') {
      const pending = pendingIndexRequests.get(msg.id);
      if (!pending) return;
      pendingIndexRequests.delete(msg.id);
      if (msg.ok) pending.resolve(msg.result ?? {});
      else pending.reject(new Error(msg.error ?? 'Index failed'));
    } else if (msg?.type === 'csm:invalidate') {
      void invalidateRetriever(msg.project).catch(() => { /* next query rebuilds */ });
      ctx.projectName = msg.project;
      if (msg.directoryPath) ctx.directoryPath = msg.directoryPath;
      ctx.indexReady = true;
    }
  });
  // Orphaned worker (primary died) — exit; the container supervisor restarts.
  process.on('disconnect', () => process.exit(0));
}

/**
 * Parse CODE_SEARCH_REINDEX_INTERVAL env var.
 * Accepts: "30m", "1h", "6h", "0" (disabled). Default: 0 (disabled).
 */
function parseReindexInterval(): number {
  const raw = process.env.CODE_SEARCH_REINDEX_INTERVAL?.trim();
  if (!raw || raw === '0' || raw === 'none') return 0;

  const match = raw.match(/^(\d+)(m|h)$/);
  if (!match) {
    console.error(`[code-search-mcp] Invalid REINDEX_INTERVAL "${raw}" — use "30m", "1h", etc. Disabling.`);
    return 0;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];
  return unit === 'h' ? value * 60 * 60_000 : value * 60_000;
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

  ctx.indexing.status = 'indexing';
  ctx.indexing.phase = 'starting';
  ctx.indexing.message = `Starting ${label}...`;
  ctx.indexing.percent = 0;
  ctx.indexing.startedAt = Date.now();
  ctx.indexing.error = null;
  pushHistory(ctx, 'start', `${label}: started for "${project}" at ${dirPath}`);

  // P3 — explicit KnowledgeConfig threaded from the unified resolver, so
  // CODE_SEARCH_* env vars / config file / CLI flags actually reach the
  // indexer (issue #6). Previously knowledge-core read DEFAULT_CONFIG.
  const unified = loadServerConfig().__unified;
  const knowledgeConfig = toKnowledgeConfig(unified);

  try {
    const stats = await indexFromPath(project, dirPath, {
      force: opts?.force,
      config: knowledgeConfig,
      onProgress: (m) => {
        ctx.indexing.message = m;
        console.error(`[${label}] ${m}`);
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

async function autoIndex(ctx: ServerContext, opts?: { readOnly?: boolean }): Promise<void> {
  try {
    const kbPath = getKnowledgeBasePath(ctx.projectName);
    const hasLanceDB = existsSync(join(kbPath, 'lancedb'));
    // System graph is now SQLite (system_graph.sqlite); accept the legacy JSON
    // too so pre-migration indexes still read as ready.
    const hasGraph = existsSync(join(kbPath, 'system_graph.sqlite')) || existsSync(join(kbPath, 'system_graph_v2.json'));

    if (hasLanceDB && hasGraph) {
      ctx.indexReady = true;
      console.error(`[code-search-mcp] Index loaded for "${ctx.projectName}"`);
      return;
    }

    if (opts?.readOnly) {
      // Read-only cluster worker: the primary owns the initial index; this
      // worker turns ready on the primary's invalidate broadcast.
      console.error(`[code-search-mcp] No index yet — read-only worker waiting for the writer`);
      return;
    }

    if (!ctx.directoryPath) {
      console.error(`[code-search-mcp] No index found and no directory path — tools will return empty results`);
      return;
    }

    // Build KB + Embed
    console.error(`[code-search-mcp] No index found — building from ${ctx.directoryPath}...`);
    await trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'auto-index' });
    console.error(`[code-search-mcp] Index ready.`);
  } catch (err) {
    console.error(`[code-search-mcp] Auto-index failed:`, err);
  }
}
