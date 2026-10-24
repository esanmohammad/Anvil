/**
 * Remote proxy — thin stdio MCP server that forwards all tool/resource
 * calls to a remote code-search-mcp HTTP server.
 *
 * This is the DEFAULT mode for end users. No repos, no index, no embeddings
 * needed locally. All infra lives on the remote server.
 *
 * The remote serves /mcp statelessly, so every forwarded call is one
 * independent POST — there is no session to keep. Remote failures (HTTP
 * errors, JSON-RPC errors) surface to the local client as JSON-RPC errors.
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

import { Server, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { PACKAGE_VERSION } from '../core/version.js';
import { getComponentLogger } from '../observability/logger.js';

const log = getComponentLogger('code-search-mcp');

interface RemoteProxyConfig {
  serverUrl: string;
  apiKey?: string;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Every JSON message carried by a text/event-stream body (an event's
 *  `data:` lines joined with "\n", per the SSE spec). */
export function parseSseMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try { messages.push(JSON.parse(data)); } catch { /* not a JSON event */ }
  }
  return messages;
}

/** Authenticated JSON-RPC over the remote server's stateless /mcp endpoint. */
class RemoteConnection {
  private serverUrl: string;
  private apiKey: string | undefined;
  private nextId = 1;

  constructor(config: RemoteProxyConfig) {
    this.serverUrl = config.serverUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  /** Send one request; resolve with its `result`, or throw a ProtocolError
   *  carrying the remote's JSON-RPC error / the HTTP failure. */
  async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
    } catch (err) {
      throw new ProtocolError(ProtocolErrorCode.InternalError, `Remote server unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new ProtocolError(ProtocolErrorCode.InternalError, `Remote server error (${response.status}): ${errBody.slice(0, 300)}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const messages = contentType.includes('text/event-stream')
      ? parseSseMessages(await response.text())
      : [await response.json()];
    // The stream can carry notifications / server requests before the answer.
    const reply = messages.find((m): m is JsonRpcMessage =>
      typeof m === 'object' && m !== null && (m as JsonRpcMessage).id === id
      && ('result' in (m as object) || 'error' in (m as object)));
    if (!reply) {
      throw new ProtocolError(ProtocolErrorCode.InternalError, `Remote server sent no response for ${method} (id ${id})`);
    }
    if (reply.error) throw new ProtocolError(reply.error.code, reply.error.message, reply.error.data);
    return reply.result;
  }

  /** MCP handshake — used at startup as a reachability / credentials check. */
  async initialize(): Promise<any> {
    return this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'code-search-mcp-proxy', version: PACKAGE_VERSION },
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
    log.info(`Connected to remote server at ${config.serverUrl}`);
    log.info(`Remote status: ${health.status}, project: ${health.project ?? 'unknown'}, index: ${health.indexReady ? 'ready' : 'not ready'}`);
  } catch (err: any) {
    log.warn(`WARNING: Could not reach remote server at ${config.serverUrl}: ${err.message}`);
    log.warn(`Proxy will start anyway — requests will fail until server is available.`);
  }

  try {
    await remote.initialize();
    log.info(`Remote MCP handshake ok`);
  } catch (err: any) {
    log.warn(`WARNING: Remote MCP handshake failed: ${err.message}. Requests will fail until this is fixed (check --api-key / CODE_SEARCH_API_KEY).`);
  }

  // Create local stdio MCP server
  const server = new Server(
    { name: 'code-search-mcp', version: PACKAGE_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler('tools/list', async () => remote.request('tools/list'));

  server.setRequestHandler('tools/call', async (request) => remote.request('tools/call', {
    name: request.params.name,
    arguments: request.params.arguments ?? {},
  }));

  server.setRequestHandler('resources/list', async () => remote.request('resources/list'));

  server.setRequestHandler('resources/templates/list', async () => remote.request('resources/templates/list'));

  server.setRequestHandler('resources/read', async (request) => remote.request('resources/read', {
    uri: request.params.uri,
  }));

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`Proxy running (stdio → ${config.serverUrl})`);
}
