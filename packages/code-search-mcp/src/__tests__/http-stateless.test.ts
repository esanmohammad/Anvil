/**
 * Stateless HTTP transport — the only mode since the SDK v2 migration.
 *
 * Each POST /mcp is served with no session affinity: requests arrive as
 * independent exchanges, exactly as they do when a proxy round-robins
 * requests across cluster workers. Pins that createMcpHandler's serving
 * works end-to-end with a real MCP client, and that legacy session verbs
 * (GET SSE / DELETE) are refused.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttpTransport } from '../transports/http-transport.js';
import type { ServerConfig } from '../core/env-config.js';

function makeMcpServer() {
  const server = new Server(
    { name: 'stateless-test', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler('tools/list', async () => ({
    tools: [{ name: 'ping', description: 'test tool', inputSchema: { type: 'object' } }],
  }));
  return server;
}

// port 0 → ephemeral; the actual port comes from the returned server handle.
const config = {
  port: 0,
  host: '127.0.0.1',
  transport: 'streamable-http',
  authEnabled: false,
  authMode: 'none',
  authApiKeys: [],
} as unknown as ServerConfig;

describe('http transport — stateless mode (cluster workers)', () => {
  it('serves initialize + tools/list as independent sessionless requests', async () => {
    const httpServer = await startHttpTransport({
      config,
      createMcpServer: async () => ({ server: makeMcpServer() }),
    });
    const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    try {
      // Legacy era (client default): initialize handshake, no session.
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
      await client.connect(transport); // initialize → request #1, fresh server
      const tools = await client.listTools(); // request #2 → another fresh server
      assert.equal(tools.tools[0]?.name, 'ping');
      assert.equal(transport.sessionId, undefined, 'stateless server must not assign a session');
      assert.equal(client.getProtocolEra(), 'legacy');
      await client.close();

      // Modern era (2026-07-28): server/discover probe negotiates statelessly.
      const modern = new Client(
        { name: 'modern-client', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      await modern.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      assert.equal(modern.getProtocolEra(), 'modern');
      assert.equal(modern.getNegotiatedProtocolVersion(), '2026-07-28');
      assert.equal((await modern.listTools()).tools[0]?.name, 'ping');
      await modern.close();

      // No SSE stream / session teardown to offer in stateless mode.
      const get = await fetch(`${base}/mcp`, { method: 'GET' });
      assert.equal(get.status, 405);
      const del = await fetch(`${base}/mcp`, { method: 'DELETE' });
      assert.equal(del.status, 405);
    } finally {
      httpServer.close();
    }
  });
});
