import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RpcServer } from '../daemon/rpc-server.js';
import { DaemonBackend } from '../backends/daemon-client.js';

/**
 * P4 — UDS JSON-RPC wire contract. Doesn't index real repos; just pins
 * that the client encodes requests the server can parse, and vice versa.
 * Skipped on Windows where UDS semantics differ from named pipes.
 */

const tmp = mkdtempSync(join(tmpdir(), 'cs-rpc-'));
const socketPath = join(tmp, 'test.sock');
let server: RpcServer;

before(async () => {
  server = new RpcServer({
    socketPath,
    handlers: {
      'search.code': async (p) => ({ query: p.query, totalTokens: 0, chunks: [] }),
      'index.status': async () => ({
        totalChunks: 0,
        repos: [],
        embeddingProvider: 'stub',
        lastIndexedAt: null,
        watching: true,
        queueDepth: 0,
        uptimeSec: 1,
      }),
      'index.force': async () => ({
        totalChunks: 0,
        repos: [],
        embeddingProvider: 'stub',
        lastIndexedAt: null,
        watching: true,
        queueDepth: 0,
        uptimeSec: 1,
      }),
      'index.invalidate': async () => ({ ok: true } as const),
      'health': () => ({ ok: true as const, uptime: 1 }),
    },
  });
  await server.start();
});

after(async () => {
  await server.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('daemon RPC roundtrip', { skip: process.platform === 'win32' }, () => {
  it('ping returns true for a live daemon', async () => {
    const client = new DaemonBackend({
      project: 'test',
      workspaceDir: null,
      knowledge: {} as never,
      preferDaemon: true,
      socketPath,
    });
    assert.equal(await client.ping(), true);
    await client.close();
  });

  it('search returns the typed payload', async () => {
    const client = new DaemonBackend({
      project: 'test',
      workspaceDir: null,
      knowledge: {} as never,
      preferDaemon: true,
      socketPath,
    });
    const r = await client.search('hello', { mode: 'hybrid', maxResults: 5 });
    assert.equal(r.query, 'hello');
    assert.equal(Array.isArray(r.chunks), true);
    await client.close();
  });

  it('status / invalidate / forceIndex roundtrip', async () => {
    const client = new DaemonBackend({
      project: 'test',
      workspaceDir: null,
      knowledge: {} as never,
      preferDaemon: true,
      socketPath,
    });
    const s = await client.status();
    assert.equal(s.embeddingProvider, 'stub');
    assert.equal(s.watching, true);
    await client.invalidate(['/some/path.ts']);
    const after = await client.forceIndex({ force: true });
    assert.equal(after.embeddingProvider, 'stub');
    await client.close();
  });

  it('unknown method returns RPC error', async () => {
    const client = new DaemonBackend({
      project: 'test',
      workspaceDir: null,
      knowledge: {} as never,
      preferDaemon: true,
      socketPath,
    });
    // Cast through any to exercise the error path on the server.
    await assert.rejects(
      // @ts-expect-error — calling a private method on purpose
      () => (client as any).rpc('notARealMethod', {}, 500),
      /Method not found/,
    );
    await client.close();
  });
});
