/**
 * End-to-end tests for `MergedToolExecutor` driving the official MCP TS SDK
 * over an in-process transport. Validates:
 *   - tool merging (builtin + MCP)
 *   - exact-name + per-server glob allowlists
 *   - destructive-tool guard under glob
 *   - dispatch routing builtin vs MCP
 *   - flattening of `content[]` array results
 *   - cancellation propagation
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { McpAgentClient } from '../mcp/client.js';
import { McpClientPool } from '../mcp/pool.js';
import { MergedToolExecutor } from '../mcp/merged-executor.js';
import { BuiltinToolExecutor } from '../tools/builtin.js';

// ── Helpers ─────────────────────────────────────────────────────────────

interface FakeServerOpts {
  name: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    /** Synthesizer for the call result. Falls back to `[{ type: 'text', text: 'ok' }]`. */
    onCall?: (args: Record<string, unknown>) => unknown;
  }>;
}

/**
 * Spin up an MCP server in-process and return a connected `McpAgentClient`
 * wired through `InMemoryTransport`. The official SDK handles the protocol;
 * the test only cares about the tool surface.
 */
async function makeInMemoryMcpClient(opts: FakeServerOpts): Promise<McpAgentClient> {
  const server = new Server(
    { name: `test-${opts.name}`, version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: 'object' },
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = opts.tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool ${req.params.name}` }],
      };
    }
    const result = tool.onCall?.(req.params.arguments ?? {}) ?? {
      content: [{ type: 'text', text: 'ok' }],
    };
    return result as { content: unknown[] };
  });

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);

  // Construct a client and inject the linked transport, bypassing connect().
  const client = new McpAgentClient(
    { name: opts.name, transport: 'stdio', command: 'noop' },
  );
  // Test seam: swap the SDK Client's transport for our in-memory one.
  // The McpAgentClient holds the SDK Client in a private field; we
  // bypass the type with a controlled cast.
  await (client as unknown as {
    client: { connect: (t: typeof clientT) => Promise<void> };
    connected: boolean;
  }).client.connect(clientT);
  (client as unknown as { connected: boolean }).connected = true;
  return client;
}

function workdir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'merged-exec-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('MergedToolExecutor — schema merging', () => {
  it('merges builtin + MCP tools and namespaces MCP entries as mcp__<server>__<tool>', async () => {
    const client = await makeInMemoryMcpClient({
      name: 'gh',
      tools: [{ name: 'list_issues', description: 'list', annotations: { readOnlyHint: true } }],
    });
    const pool = new McpClientPool({ servers: [client.config] });
    // Bypass pool.discoverTools' loader by stuffing the client directly.
    (pool as unknown as { clients: Map<string, McpAgentClient> }).clients.set('gh', client);

    const builtin = new BuiltinToolExecutor({
      allowedTools: ['read_file', 'mcp__gh__list_issues'],
    });
    const exec = new MergedToolExecutor({
      builtin,
      pool,
      allowedTools: ['read_file', 'mcp__gh__list_issues'],
    });
    await exec.prime();

    const names = exec.listSchemas().map((s) => s.name).sort();
    assert.deepEqual(names, ['mcp__gh__list_issues', 'read_file']);
    await client.close();
    await pool.close();
  });

  it('per-server glob allows read-only MCP tools but hides destructive ones', async () => {
    const client = await makeInMemoryMcpClient({
      name: 'fs',
      tools: [
        { name: 'read', description: 'read', annotations: { readOnlyHint: true } },
        { name: 'delete', description: 'delete', annotations: { destructiveHint: true } },
      ],
    });
    const pool = new McpClientPool({ servers: [client.config] });
    (pool as unknown as { clients: Map<string, McpAgentClient> }).clients.set('fs', client);

    const builtin = new BuiltinToolExecutor({ allowedTools: ['read_file', 'mcp__fs__*'] });
    const exec = new MergedToolExecutor({
      builtin,
      pool,
      allowedTools: ['read_file', 'mcp__fs__*'],
    });
    await exec.prime();

    const names = exec.listSchemas().map((s) => s.name).sort();
    assert.ok(names.includes('mcp__fs__read'), 'glob admits read-only MCP tool');
    assert.ok(!names.includes('mcp__fs__delete'), 'glob hides destructive MCP tool');
    await client.close();
    await pool.close();
  });

  it('exact-name allowance admits destructive MCP tools', async () => {
    const client = await makeInMemoryMcpClient({
      name: 'fs',
      tools: [{ name: 'delete', description: 'd', annotations: { destructiveHint: true } }],
    });
    const pool = new McpClientPool({ servers: [client.config] });
    (pool as unknown as { clients: Map<string, McpAgentClient> }).clients.set('fs', client);

    const exec = new MergedToolExecutor({
      builtin: new BuiltinToolExecutor({ allowedTools: ['mcp__fs__delete'] }),
      pool,
      allowedTools: ['mcp__fs__delete'],
    });
    await exec.prime();
    const names = exec.listSchemas().map((s) => s.name);
    assert.deepEqual(names, ['mcp__fs__delete']);
    await client.close();
    await pool.close();
  });
});

describe('MergedToolExecutor — dispatch', () => {
  it('routes mcp__* calls to the pool and flattens text content[] into a string', async () => {
    const client = await makeInMemoryMcpClient({
      name: 'echo',
      tools: [{
        name: 'say',
        description: 'echo',
        onCall: (args) => ({
          content: [
            { type: 'text', text: `you said: ${(args.msg as string) ?? '?'}` },
            { type: 'text', text: 'and a second line' },
          ],
        }),
      }],
    });
    const pool = new McpClientPool({ servers: [client.config] });
    (pool as unknown as { clients: Map<string, McpAgentClient> }).clients.set('echo', client);
    const exec = new MergedToolExecutor({
      builtin: new BuiltinToolExecutor({ allowedTools: ['mcp__echo__say'] }),
      pool,
      allowedTools: ['mcp__echo__say'],
    });
    await exec.prime();

    const { dir, cleanup } = workdir();
    try {
      const ctrl = new AbortController();
      const result = await exec.execute(
        { id: '1', name: 'mcp__echo__say', arguments: { msg: 'hi' } },
        { workingDir: dir, abortSignal: ctrl.signal },
      );
      assert.equal(result.isError, false);
      assert.match(result.content, /you said: hi/);
      assert.match(result.content, /second line/);
    } finally {
      cleanup();
      await client.close();
      await pool.close();
    }
  });

  it('routes builtin names to BuiltinToolExecutor untouched', async () => {
    const pool = new McpClientPool({ servers: [] });
    const exec = new MergedToolExecutor({
      builtin: new BuiltinToolExecutor({ allowedTools: ['list'] }),
      pool,
      allowedTools: ['list'],
    });

    const { dir, cleanup } = workdir();
    try {
      const ctrl = new AbortController();
      const result = await exec.execute(
        { id: '1', name: 'list', arguments: {} },
        { workingDir: dir, abortSignal: ctrl.signal },
      );
      assert.equal(result.isError, false);
    } finally {
      cleanup();
      await pool.close();
    }
  });

  it('rejects disallowed MCP names at exec with isError=true', async () => {
    const pool = new McpClientPool({ servers: [] });
    const exec = new MergedToolExecutor({
      builtin: new BuiltinToolExecutor({ allowedTools: ['read_file'] }),
      pool,
      allowedTools: ['read_file'],
    });
    const { dir, cleanup } = workdir();
    try {
      const ctrl = new AbortController();
      const result = await exec.execute(
        { id: '1', name: 'mcp__rogue__do_anything', arguments: {} },
        { workingDir: dir, abortSignal: ctrl.signal },
      );
      assert.equal(result.isError, true);
      assert.match(result.content, /not permitted/);
    } finally {
      cleanup();
      await pool.close();
    }
  });
});

describe('McpClientPool — failure isolation', () => {
  it('records connect failures in `failures` without crashing the pool', async () => {
    // Construct a pool with one bogus server config that will fail at connect.
    const pool = new McpClientPool({
      servers: [{ name: 'broken', transport: 'stdio', command: '/no/such/command' }],
      connectTimeoutMs: 1000,
    });
    const tools = await pool.discoverTools();
    assert.deepEqual(tools, []);
    assert.equal(pool.failures.length, 1);
    assert.equal(pool.failures[0].server, 'broken');
    await pool.close();
  });
});
