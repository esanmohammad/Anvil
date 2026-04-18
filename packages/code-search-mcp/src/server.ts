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
import { join } from 'node:path';

import { registerSearchTools, handleSearchTool } from './tools/search.js';
import { registerGraphTools, handleGraphTool } from './tools/graph.js';
import { registerProfileTools, handleProfileTool } from './tools/profile.js';
import { registerIndexTools, handleIndexTool } from './tools/index-tools';
import { registerResources, handleResource } from './resources/resources';
import { getKnowledgeBasePath } from './core/config.js';
import { indexFromPath } from './core/indexer.js';
import { loadServerConfig, type ServerConfig } from './core/env-config.js';
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
    { name: 'code-search-mcp', version: '0.1.0' },
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

  // --- Auto-index if needed ---
  await autoIndex(ctx);

  // --- Start transport ---
  if (config.transport === 'stdio') {
    const server = createMcpServerInstance(ctx);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[code-search-mcp] Server running for "${projectName}" (stdio)`);
  } else {
    // Security: warn if auth=none with non-localhost binding
    if (config.authMode === 'none' && config.host !== '127.0.0.1' && config.host !== 'localhost') {
      console.error(`[code-search-mcp] WARNING: Auth is disabled but server binds to ${config.host}. Any machine on the network can access your code search API.`);
      console.error(`[code-search-mcp] Set CODE_SEARCH_AUTH_MODE=api-key or CODE_SEARCH_HOST=127.0.0.1 for security.`);
    }

    await startHttpTransport({
      config,
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
      onIndex: async (body) => {
        const { resolve } = await import('node:path');
        const { existsSync } = await import('node:fs');

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
      },
    });
  }

  // --- Scheduled reindex interval (server-side only) ---
  const reindexIntervalMs = parseReindexInterval();
  if (reindexIntervalMs > 0 && ctx.directoryPath) {
    console.error(`[code-search-mcp] Auto-reindex every ${Math.round(reindexIntervalMs / 60_000)}m`);
    setInterval(async () => {
      if (!ctx.directoryPath || ctx.indexing.status === 'indexing') return;
      try {
        await trackedIndex(ctx, ctx.projectName, ctx.directoryPath, { label: 'auto-reindex' });
      } catch (err) {
        console.error(`[auto-reindex] Failed:`, err);
      }
    }, reindexIntervalMs).unref();
  }
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

  try {
    const stats = await indexFromPath(project, dirPath, {
      force: opts?.force,
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

async function autoIndex(ctx: ServerContext): Promise<void> {
  try {
    const kbPath = getKnowledgeBasePath(ctx.projectName);
    const hasLanceDB = existsSync(join(kbPath, 'lancedb'));
    const hasGraph = existsSync(join(kbPath, 'system_graph_v2.json'));

    if (hasLanceDB && hasGraph) {
      ctx.indexReady = true;
      console.error(`[code-search-mcp] Index loaded for "${ctx.projectName}"`);
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
