/**
 * Remote proxy (`code-search-mcp --remote URL`) against a fake remote:
 * upstream failures reach the local client as JSON-RPC errors (not empty
 * lists), and SSE replies are parsed event by event, picking the response
 * whose id matches the request.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BIN, tmp, baseEnv } from './_harness.js';

const PORT = 47389;
const GOOD_KEY = 'good-key-1234';
let remote: HttpServer;
let root: string;

before(async () => {
  root = tmp('cs-proxy-');
  remote = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', project: 'remote', indexReady: true }));
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid API key' }));
        return;
      }
      const msg = JSON.parse(body) as { id: number; method: string };
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0' } } }));
        return;
      }
      if (msg.method === 'resources/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: resources/list' } }));
        return;
      }
      // tools/list over SSE: a notification first, then a reply for another
      // id, then ours — split across two data lines.
      const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'remote_tool', inputSchema: { type: 'object' } }] } });
      const half = Math.floor(reply.length / 2);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hi' } })}\n\n` +
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 999, result: { tools: [] } })}\n\n` +
        `event: message\ndata: ${reply.slice(0, half)}\ndata: ${reply.slice(half)}\n\n`,
      );
    });
  });
  await new Promise<void>((r) => remote.listen(PORT, '127.0.0.1', () => r()));
});

after(async () => {
  remote.closeAllConnections();
  await new Promise((r) => remote.close(r));
  rmSync(root, { recursive: true, force: true });
});

async function proxyClient(key: string): Promise<Client> {
  const client = new Client({ name: 'proxy-test', version: '1.0.0' });
  const env = baseEnv({ home: join(root, 'home') }) as Record<string, string>;
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [BIN.mcp, '--remote', `http://127.0.0.1:${PORT}`, '--api-key', key],
    env,
    stderr: 'pipe',
  }));
  return client;
}

describe('remote proxy', () => {
  it('surfaces upstream auth failures as JSON-RPC errors', async () => {
    const client = await proxyClient('wrong-key');
    try {
      await assert.rejects(() => client.listTools(), /401/);
      await assert.rejects(() => client.listResources(), /401/);
    } finally {
      await client.close();
    }
  });

  it('relays a remote JSON-RPC error', async () => {
    const client = await proxyClient(GOOD_KEY);
    try {
      await assert.rejects(() => client.listResources(), /Method not found: resources\/list/);
    } finally {
      await client.close();
    }
  });

  it('picks the SSE event answering its request id', async () => {
    const client = await proxyClient(GOOD_KEY);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ['remote_tool']);
    } finally {
      await client.close();
    }
  });
});
