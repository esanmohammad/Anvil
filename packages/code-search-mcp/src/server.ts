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
export interface ServerContext {
  projectName: string;
  directoryPath: string | null;
  indexReady: boolean;
  startedAt: number;
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
        console.error(`[code-search-mcp] Health: ${url}/health`);
        console.error(`[code-search-mcp] Auth: ${config.authMode}`);
      },
      getHealth: () => ({
        project: ctx.projectName,
        indexReady: ctx.indexReady,
        uptime: Math.floor((Date.now() - ctx.startedAt) / 1000),
        transport: config.transport,
        authMode: config.authMode,
      }),
    });
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
    await indexFromPath(ctx.projectName, ctx.directoryPath, {
      onProgress: (m) => console.error(`[code-search-mcp] ${m}`),
    });
    ctx.indexReady = true;
    console.error(`[code-search-mcp] Index ready.`);
  } catch (err) {
    console.error(`[code-search-mcp] Auto-index failed:`, err);
  }
}
