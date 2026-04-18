/**
 * Remote proxy — thin stdio MCP server that forwards all tool/resource
 * calls to a remote code-search-mcp HTTP server.
 *
 * This is the DEFAULT mode for end users. No repos, no index, no embeddings
 * needed locally. All infra lives on the remote server.
 *
 * Usage:
 *   code-search-mcp --remote https://your-server:3100 --api-key sk-xxx
 *
 * Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "code-search": {
 *         "command": "code-search-mcp",
 *         "args": ["--remote", "https://your-server:3100"],
 *         "env": { "CODE_SEARCH_API_KEY": "sk-xxx" }
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

interface RemoteProxyConfig {
  serverUrl: string;
  apiKey?: string;
}

/**
 * Make an authenticated MCP request to the remote server.
 * Handles session management transparently.
 */
class RemoteConnection {
  private serverUrl: string;
  private apiKey: string | undefined;
  private sessionId: string | null = null;

  constructor(config: RemoteProxyConfig) {
    this.serverUrl = config.serverUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  /** Send a JSON-RPC request to the remote MCP server */
  async request(method: string, params: Record<string, unknown> = {}, id: number = 1): Promise<any> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    const response = await fetch(`${this.serverUrl}/mcp`, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Remote server error (${response.status}): ${errBody.slice(0, 300)}`);
    }

    // Capture session ID from response headers
    const newSessionId = response.headers.get('mcp-session-id');
    if (newSessionId) {
      this.sessionId = newSessionId;
    }

    // Parse SSE response (remote MCP uses text/event-stream)
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      const text = await response.text();
      // Extract JSON from SSE data lines
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            return JSON.parse(line.slice(6));
          } catch { /* try next line */ }
        }
      }
      throw new Error('No valid JSON in SSE response');
    }

    return response.json();
  }

  /** Initialize the remote session */
  async initialize(): Promise<any> {
    return this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'code-search-mcp-proxy', version: '0.1.0' },
    });
  }

  /** Check remote server health */
  async health(): Promise<{ status: string; project?: string; indexReady?: boolean }> {
    const res = await fetch(`${this.serverUrl}/health`);
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    return res.json() as any;
  }
}

/**
 * Start a remote proxy — stdio MCP server that forwards to remote HTTP server.
 */
export async function startRemoteProxy(config: RemoteProxyConfig): Promise<void> {
  const remote = new RemoteConnection(config);

  // Verify remote server is reachable
  try {
    const health = await remote.health();
    console.error(`[code-search-mcp] Connected to remote server at ${config.serverUrl}`);
    console.error(`[code-search-mcp] Remote status: ${health.status}, project: ${health.project ?? 'unknown'}, index: ${health.indexReady ? 'ready' : 'not ready'}`);
  } catch (err: any) {
    console.error(`[code-search-mcp] WARNING: Could not reach remote server at ${config.serverUrl}: ${err.message}`);
    console.error(`[code-search-mcp] Proxy will start anyway — requests will fail until server is available.`);
  }

  // Initialize remote session
  try {
    await remote.initialize();
    console.error(`[code-search-mcp] Remote session established`);
  } catch (err: any) {
    console.error(`[code-search-mcp] WARNING: Session init failed: ${err.message}. Will retry on first request.`);
  }

  // Create local stdio MCP server
  const server = new Server(
    { name: 'code-search-mcp', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  // Forward tools/list — fetch from remote
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const response = await remote.request('tools/list');
      return response.result ?? { tools: [] };
    } catch (err: any) {
      console.error(`[proxy] Failed to list tools: ${err.message}`);
      return { tools: [] };
    }
  });

  // Forward tools/call — proxy to remote
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const response = await remote.request('tools/call', {
        name: request.params.name,
        arguments: request.params.arguments ?? {},
      });
      return response.result ?? {
        content: [{ type: 'text', text: 'No response from remote server' }],
        isError: true,
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Remote server error: ${err.message}` }],
        isError: true,
      };
    }
  });

  // Forward resources/list
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      const response = await remote.request('resources/list');
      return response.result ?? { resources: [] };
    } catch {
      return { resources: [] };
    }
  });

  // Forward resources/read
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      const response = await remote.request('resources/read', {
        uri: request.params.uri,
      });
      return response.result ?? {
        contents: [{ uri: request.params.uri, text: 'Not available' }],
      };
    } catch (err: any) {
      return {
        contents: [{ uri: request.params.uri, text: `Error: ${err.message}` }],
      };
    }
  });

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[code-search-mcp] Proxy running (stdio → ${config.serverUrl})`);
}
