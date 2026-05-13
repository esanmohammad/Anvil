/**
 * Phase 3 — MCP config loader + tool merger unit tests.
 *
 * Covers ADR-locked semantics:
 *   - Search order ranks 1–5 (config-loader)
 *   - ${env:VAR} substitution in env + headers
 *   - Transport inference (command → stdio, url → streamable-http)
 *   - Malformed entries dropped with stderr warning
 *   - Tool merging with namespaced names + collision detection
 *   - listTools failure isolation (one bad server doesn't kill the others)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadMcpServers,
  findMcpConfigPath,
} from '../mcp/config-loader.js';
import { buildAgentToolset } from '../mcp/tool-merger.js';
import { McpAgentClient } from '../mcp/client.js';
import type { ToolSchema } from '../types.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-mcp-test-'));
}

function captureStderr<T>(fn: () => T): { result: T; captured: string } {
  const orig = process.stderr.write.bind(process.stderr);
  const buf: string[] = [];
  (process.stderr as { write: typeof orig }).write = (chunk: string | Uint8Array) => {
    buf.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  };
  try {
    const result = fn();
    return { result, captured: buf.join('') };
  } finally {
    (process.stderr as { write: typeof orig }).write = orig;
  }
}

// ── findMcpConfigPath ────────────────────────────────────────────────────

describe('findMcpConfigPath search order', () => {
  it('returns undefined when no candidates exist', () => {
    const result = findMcpConfigPath({
      workspaceRoot: '/nonexistent/workspace',
      env: {},
      homeDir: '/nonexistent/home',
    });
    assert.equal(result, undefined);
  });

  it('rank 1: ANVIL_MCP_CONFIG env override wins over everything', () => {
    const root = tempDir();
    try {
      const override = join(root, 'override.json');
      writeFileSync(override, '{"mcpServers":{}}');
      const ws = join(root, 'workspace');
      mkdirSync(ws, { recursive: true });
      writeFileSync(join(ws, 'mcp.json'), '{"mcpServers":{}}');

      const result = findMcpConfigPath({
        workspaceRoot: ws,
        env: { ANVIL_MCP_CONFIG: override },
        homeDir: root,
      });
      assert.equal(result, override);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rank 2: <workspace>/mcp.json wins when env unset', () => {
    const root = tempDir();
    try {
      const ws = join(root, 'workspace');
      mkdirSync(join(ws, '.mcp'), { recursive: true });
      mkdirSync(join(ws, '.claude'), { recursive: true });
      writeFileSync(join(ws, 'mcp.json'), '{"mcpServers":{}}');
      writeFileSync(join(ws, '.mcp', 'servers.json'), '{"mcpServers":{}}');
      writeFileSync(join(ws, '.claude', 'mcp.json'), '{"mcpServers":{}}');

      const result = findMcpConfigPath({ workspaceRoot: ws, env: {}, homeDir: root });
      assert.equal(result, join(ws, 'mcp.json'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rank 3: <workspace>/.mcp/servers.json when no rank-2', () => {
    const root = tempDir();
    try {
      const ws = join(root, 'workspace');
      mkdirSync(join(ws, '.mcp'), { recursive: true });
      mkdirSync(join(ws, '.claude'), { recursive: true });
      writeFileSync(join(ws, '.mcp', 'servers.json'), '{"mcpServers":{}}');
      writeFileSync(join(ws, '.claude', 'mcp.json'), '{"mcpServers":{}}');

      const result = findMcpConfigPath({ workspaceRoot: ws, env: {}, homeDir: root });
      assert.equal(result, join(ws, '.mcp', 'servers.json'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rank 4: <workspace>/.claude/mcp.json fallback', () => {
    const root = tempDir();
    try {
      const ws = join(root, 'workspace');
      mkdirSync(join(ws, '.claude'), { recursive: true });
      writeFileSync(join(ws, '.claude', 'mcp.json'), '{"mcpServers":{}}');

      const result = findMcpConfigPath({ workspaceRoot: ws, env: {}, homeDir: root });
      assert.equal(result, join(ws, '.claude', 'mcp.json'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rank 5: $HOME/.claude/mcp.json user-global', () => {
    const root = tempDir();
    try {
      const home = join(root, 'home');
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'mcp.json'), '{"mcpServers":{}}');

      const result = findMcpConfigPath({
        workspaceRoot: join(root, 'workspace'),
        env: {},
        homeDir: home,
      });
      assert.equal(result, join(home, '.claude', 'mcp.json'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── loadMcpServers — parsing + transport inference ───────────────────────

describe('loadMcpServers — parsing', () => {
  it('returns [] when no config found', () => {
    const result = loadMcpServers({
      workspaceRoot: '/nonexistent',
      env: {},
      homeDir: '/nonexistent',
    });
    assert.deepEqual(result, []);
  });

  it('infers stdio from `command`, streamable-http from `url`', () => {
    const root = tempDir();
    try {
      const cfg = {
        mcpServers: {
          fs: { command: 'npx', args: ['-y', 'server'] },
          'remote-api': { url: 'https://x.example.com/mcp', headers: { Authorization: 'Bearer T' } },
        },
      };
      writeFileSync(join(root, 'mcp.json'), JSON.stringify(cfg));
      const servers = loadMcpServers({ workspaceRoot: root, env: {}, homeDir: '/none' });
      assert.equal(servers.length, 2);
      const fs = servers.find((s) => s.name === 'fs')!;
      assert.equal(fs.transport, 'stdio');
      assert.equal(fs.command, 'npx');
      assert.deepEqual(fs.args, ['-y', 'server']);
      const api = servers.find((s) => s.name === 'remote-api')!;
      assert.equal(api.transport, 'streamable-http');
      assert.equal(api.url, 'https://x.example.com/mcp');
      assert.deepEqual(api.headers, { Authorization: 'Bearer T' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops entries with both command and url; warns', () => {
    const root = tempDir();
    try {
      const cfg = {
        mcpServers: {
          good: { command: 'cmd' },
          bad: { command: 'cmd', url: 'https://x' },
          empty: {},
        },
      };
      writeFileSync(join(root, 'mcp.json'), JSON.stringify(cfg));
      const { result, captured } = captureStderr(() =>
        loadMcpServers({ workspaceRoot: root, env: {}, homeDir: '/none' }),
      );
      assert.equal(result.length, 1);
      assert.equal(result[0].name, 'good');
      assert.ok(captured.includes('"bad" has both command and url'));
      assert.ok(captured.includes('"empty" has neither command nor url'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('expands ${env:VAR} substitutions in env + headers', () => {
    const root = tempDir();
    try {
      const cfg = {
        mcpServers: {
          gh: {
            command: 'npx',
            env: { GITHUB_TOKEN: '${env:MY_TOKEN}', LITERAL: 'plain' },
          },
          api: {
            url: 'https://x.example.com',
            headers: { Authorization: 'Bearer ${env:API_KEY}' },
          },
        },
      };
      writeFileSync(join(root, 'mcp.json'), JSON.stringify(cfg));
      const servers = loadMcpServers({
        workspaceRoot: root,
        env: { MY_TOKEN: 'tok-abc', API_KEY: 'key-xyz' },
        homeDir: '/none',
      });
      const gh = servers.find((s) => s.name === 'gh')!;
      assert.equal(gh.env?.GITHUB_TOKEN, 'tok-abc');
      assert.equal(gh.env?.LITERAL, 'plain');
      const api = servers.find((s) => s.name === 'api')!;
      assert.equal(api.headers?.Authorization, 'Bearer key-xyz');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns on unset ${env:VAR} but does not crash', () => {
    const root = tempDir();
    try {
      const cfg = {
        mcpServers: {
          gh: { command: 'cmd', env: { TOKEN: '${env:UNSET_VAR_XYZ}' } },
        },
      };
      writeFileSync(join(root, 'mcp.json'), JSON.stringify(cfg));
      const { result, captured } = captureStderr(() =>
        loadMcpServers({ workspaceRoot: root, env: {}, homeDir: '/none' }),
      );
      assert.equal(result.length, 1);
      assert.equal(result[0].env?.TOKEN, '');
      assert.ok(captured.includes('UNSET_VAR_XYZ'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('gracefully handles malformed JSON', () => {
    const root = tempDir();
    try {
      writeFileSync(join(root, 'mcp.json'), '{ not json');
      const { result, captured } = captureStderr(() =>
        loadMcpServers({ workspaceRoot: root, env: {}, homeDir: '/none' }),
      );
      assert.deepEqual(result, []);
      assert.ok(captured.includes('not valid JSON'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns when top-level mcpServers is missing', () => {
    const root = tempDir();
    try {
      writeFileSync(join(root, 'mcp.json'), '{"servers": {}}');
      const { result, captured } = captureStderr(() =>
        loadMcpServers({ workspaceRoot: root, env: {}, homeDir: '/none' }),
      );
      assert.deepEqual(result, []);
      assert.ok(captured.includes('missing top-level "mcpServers"'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── buildAgentToolset ────────────────────────────────────────────────────

class FakeMcpClient {
  // Shape-compatible with McpAgentClient for buildAgentToolset usage.
  public readonly config: { name: string };
  constructor(
    name: string,
    private readonly tools: ToolSchema[],
    private readonly throwOnList = false,
  ) {
    this.config = { name };
  }
  async listTools(): Promise<Array<{ name: string; bareName: string; serverName: string; schema: ToolSchema; annotations: Record<string, unknown> }>> {
    if (this.throwOnList) throw new Error('boom');
    return this.tools.map((t) => ({
      name: t.name,
      bareName: t.name.includes('__') ? t.name.split('__').slice(2).join('__') : t.name,
      serverName: this.config.name,
      schema: t,
      annotations: {},
    }));
  }
}

function asClient(c: FakeMcpClient): McpAgentClient {
  return c as unknown as McpAgentClient;
}

describe('buildAgentToolset', () => {
  it('merges built-in + MCP tools and namespaces MCP entries', async () => {
    const builtIn: ToolSchema[] = [
      { name: 'fs.read', description: 'read', inputSchema: {} },
    ];
    const ghClient = new FakeMcpClient('github', [
      { name: 'mcp__github__list_issues', description: 'list', inputSchema: {} },
    ]);
    const ts = await buildAgentToolset(builtIn, [asClient(ghClient)]);
    assert.equal(ts.tools.length, 2);
    assert.deepEqual(
      ts.tools.map((t) => t.name).sort(),
      ['fs.read', 'mcp__github__list_issues'],
    );
    assert.equal(ts.mcpDispatch.size, 1);
    assert.equal(ts.mcpDispatch.get('mcp__github__list_issues'), asClient(ghClient));
    assert.equal(ts.mcpDispatch.has('fs.read'), false);
  });

  it('drops collisions with built-ins (warns)', async () => {
    const builtIn: ToolSchema[] = [
      { name: 'fs.read', description: 'built-in', inputSchema: {} },
    ];
    const dup = new FakeMcpClient('weird', [
      { name: 'fs.read', description: 'mcp dup', inputSchema: {} },
      { name: 'mcp__weird__ok', description: 'fine', inputSchema: {} },
    ]);
    const { result, captured } = await captureStderrAsync(() =>
      buildAgentToolset(builtIn, [asClient(dup)]),
    );
    assert.equal(result.tools.length, 2);
    assert.equal(result.mcpDispatch.has('fs.read'), false);
    assert.equal(result.mcpDispatch.has('mcp__weird__ok'), true);
    assert.ok(captured.includes('collision "fs.read"'));
  });

  it('isolates listTools failures: one bad server does not kill others', async () => {
    const good = new FakeMcpClient('good', [
      { name: 'mcp__good__ping', description: 'p', inputSchema: {} },
    ]);
    const bad = new FakeMcpClient('bad', [], /* throwOnList */ true);
    const { result, captured } = await captureStderrAsync(() =>
      buildAgentToolset([], [asClient(bad), asClient(good)]),
    );
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].name, 'mcp__good__ping');
    assert.ok(captured.includes('"bad" listTools failed'));
  });
});

// ── McpAgentClient list+call routing (mocked SDK Client) ────────────────

describe('McpAgentClient routing', () => {
  function makeFakeSdkClient() {
    const calls: Array<{ method: string; params: unknown }> = [];
    return {
      calls,
      listToolsResult: {
        tools: [
          { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
          { name: 'write_file', description: 'write', inputSchema: { type: 'object' } },
        ],
      },
      callToolResult: { content: [{ type: 'text', text: 'ok' }] } as unknown,
      async listTools() {
        calls.push({ method: 'listTools', params: undefined });
        return this.listToolsResult;
      },
      async callTool(params: { name: string; arguments: Record<string, unknown> }) {
        calls.push({ method: 'callTool', params });
        return this.callToolResult;
      },
      async close() {
        calls.push({ method: 'close', params: undefined });
      },
    };
  }

  function injectFakeClient(c: McpAgentClient, fake: ReturnType<typeof makeFakeSdkClient>): void {
    // Bypass `private` for the test seam — the constructor instantiated a
    // real SDK Client which we want to replace with the fake.
    (c as unknown as { client: unknown; connected: boolean }).client = fake;
    (c as unknown as { connected: boolean }).connected = true;
  }

  it('namespaces tools as `mcp__<server>__<tool>` in listTools()', async () => {
    const client = new McpAgentClient({ name: 'fs', transport: 'stdio', command: 'noop' });
    const fake = makeFakeSdkClient();
    injectFakeClient(client, fake);

    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ['mcp__fs__read_file', 'mcp__fs__write_file'],
    );
    // descriptions decorated with server tag + read-only heuristic; schema preserved
    assert.match(tools[0].schema.description, /\(via fs MCP/);
    assert.deepEqual(tools[0].schema.inputSchema, { type: 'object' });
  });

  it('callTool strips the namespacing prefix before forwarding to SDK', async () => {
    const client = new McpAgentClient({ name: 'gh', transport: 'stdio', command: 'noop' });
    const fake = makeFakeSdkClient();
    injectFakeClient(client, fake);

    await client.callTool('mcp__gh__list_issues', { repo: 'owner/repo' });
    assert.equal(fake.calls.length, 1);
    assert.equal((fake.calls[0].params as { name: string }).name, 'list_issues');
    assert.deepEqual(
      (fake.calls[0].params as { arguments: Record<string, unknown> }).arguments,
      { repo: 'owner/repo' },
    );
  });

  it('callTool accepts bare tool names too (no prefix to strip)', async () => {
    const client = new McpAgentClient({ name: 'svc', transport: 'stdio', command: 'noop' });
    const fake = makeFakeSdkClient();
    injectFakeClient(client, fake);

    await client.callTool('ping', {});
    assert.equal((fake.calls[0].params as { name: string }).name, 'ping');
  });

  it('close() forwards to SDK and flips connected back to false', async () => {
    const client = new McpAgentClient({ name: 'x', transport: 'stdio', command: 'noop' });
    const fake = makeFakeSdkClient();
    injectFakeClient(client, fake);

    assert.equal(client.isConnected(), true);
    await client.close();
    assert.equal(client.isConnected(), false);
    assert.deepEqual(
      fake.calls.map((c) => c.method),
      ['close'],
    );
    // Subsequent close is a no-op (does not call SDK again)
    await client.close();
    assert.equal(fake.calls.length, 1);
  });

  it('connect() throws clearly when stdio config has no command', async () => {
    const client = new McpAgentClient({ name: 'bad', transport: 'stdio' });
    await assert.rejects(() => client.connect(), /no command/);
  });

  it('connect() throws clearly when http config has no url', async () => {
    const client = new McpAgentClient({ name: 'bad', transport: 'streamable-http' });
    await assert.rejects(() => client.connect(), /no url/);
  });
});

async function captureStderrAsync<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; captured: string }> {
  const orig = process.stderr.write.bind(process.stderr);
  const buf: string[] = [];
  (process.stderr as { write: typeof orig }).write = (chunk: string | Uint8Array) => {
    buf.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  };
  try {
    const result = await fn();
    return { result, captured: buf.join('') };
  } finally {
    (process.stderr as { write: typeof orig }).write = orig;
  }
}
