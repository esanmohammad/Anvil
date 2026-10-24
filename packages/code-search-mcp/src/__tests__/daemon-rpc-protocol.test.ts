/**
 * RpcServer protocol edges: only the handlers' own method names dispatch,
 * notifications are not answered, batches get one clear error, and stop()
 * removes only the socket file this server created.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { RpcServer, type RpcHandlers } from '../daemon/rpc-server.js';
import { tmp } from './_harness.js';

let dir: string;
let server: RpcServer;
let socketPath: string;
let healthCalls = 0;

const handlers: RpcHandlers = {
  'search.code': async (p) => ({ query: p.query, totalTokens: 0, chunks: [] }),
  'index.status': async () => ({}),
  'index.force': async () => ({}),
  'index.invalidate': async () => ({ ok: true } as const),
  'health': () => { healthCalls++; return { ok: true as const, uptime: 1 }; },
};

before(async () => {
  dir = tmp('cs-rpcp-');
  socketPath = join(dir, 's.sock');
  server = new RpcServer({ socketPath, handlers });
  await server.start();
});
after(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Write raw lines, collect reply lines until `expect` arrived (or 500ms idle). */
function exchange(lines: string[], expect: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buf = '';
    const replies: any[] = [];
    const done = () => { sock.destroy(); resolve(replies); };
    let idle = setTimeout(done, 500);
    sock.on('connect', () => sock.write(lines.map((l) => l + '\n').join('')));
    sock.on('data', (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        replies.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
      clearTimeout(idle);
      if (replies.length >= expect) setTimeout(done, 100);
      else idle = setTimeout(done, 500);
    });
    sock.on('error', reject);
  });
}

describe('daemon RPC protocol', { skip: process.platform === 'win32' }, () => {
  it('does not dispatch prototype method names', async () => {
    for (const method of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const [r] = await exchange([JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} })], 1);
      assert.equal(r?.error?.code, -32601, `${method}: ${JSON.stringify(r)}`);
    }
  });

  it('runs notifications without answering them', async () => {
    const before = healthCalls;
    const replies = await exchange([
      JSON.stringify({ jsonrpc: '2.0', method: 'health', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', method: 'nope', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'health', params: {} }),
    ], 2);
    assert.deepEqual(replies.map((r) => r.id), [7]);
    assert.equal(healthCalls - before, 2);
  });

  it('answers a batch with a single invalid-request error', async () => {
    const replies = await exchange([JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'health', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'health', params: {} },
    ])], 2);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].id, null);
    assert.equal(replies[0].error.code, -32600);
  });

  it('stop() leaves a socket file another server created', async () => {
    const path = join(dir, 'own.sock');
    const a = new RpcServer({ socketPath: path, handlers });
    await a.start();
    unlinkSync(path); // the path is taken over by a second server…
    const b = new RpcServer({ socketPath: path, handlers });
    await b.start();
    await a.stop(); // …so the first one must not remove it on shutdown
    assert.equal(existsSync(path), true);
    await b.stop();
    assert.equal(existsSync(path), false);
  });
});
