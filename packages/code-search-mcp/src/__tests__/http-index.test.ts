/**
 * POST /index on the real server (validation, 409 on overlap, 413 on a huge
 * body, real cross-repo edge count, no silent retarget to another project)
 * and cluster mode (workers mirror the primary's indexing state; the rate
 * limit is global to the server, not per worker).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  BIN, tmp, makeWorkspace, baseEnv, spawnProc, getJson, waitFor, exitWithin, startFakeEmbedder, type FakeEmbedder,
} from './_harness.js';

let root: string;
let ws: string;
let slow: FakeEmbedder;

before(async () => {
  root = tmp('cs-idx-');
  ws = makeWorkspace(root);
  slow = await startFakeEmbedder(47393, { delayMs: 2000 });
});
after(async () => {
  await slow.close();
  rmSync(root, { recursive: true, force: true });
});

const post = (base: string, body: string, headers: Record<string, string> = {}) =>
  getJson(`${base}/index`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

describe('POST /index', () => {
  it('validates, refuses overlap and other projects, reports real edges', async () => {
    const env = baseEnv({ home: join(root, 'home'), dataDir: join(root, 'data1'), embedderUrl: slow.url });
    const p = spawnProc(BIN.mcp, ['--serve', '--port', '47387'], env);
    const base = 'http://127.0.0.1:47387';
    try {
      await waitFor(async () => (await getJson(`${base}/health`)).status === 200, 20_000, `health\n${p.stderr()}`);

      assert.equal((await post(base, '')).status, 400, 'empty body');
      assert.equal((await post(base, 'not json')).status, 400, 'invalid JSON');
      assert.equal((await post(base, '[]')).status, 400, 'no path');
      assert.equal((await post(base, JSON.stringify({ path: join(root, 'missing') }))).status, 400, 'missing dir');
      assert.equal((await post(base, JSON.stringify({ path: ws, pad: 'x'.repeat(200_000) }))).status, 413, 'huge body');

      const other = await post(base, JSON.stringify({ path: ws, project: 'other' }));
      assert.equal(other.status, 400);
      assert.match(other.body.error, /serves project "default"/);
      assert.equal((await getJson(`${base}/status`)).body.project, 'default');

      const first = post(base, JSON.stringify({ path: ws }));
      await waitFor(async () => (await getJson(`${base}/status`)).body.indexing.status === 'indexing', 10_000, 'indexing to start');
      const overlap = await post(base, JSON.stringify({ path: ws }));
      assert.equal(overlap.status, 409);

      const done = await first;
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal(done.body.project, 'default');
      assert.equal(done.body.repos, 2);
      assert.ok(done.body.crossRepoEdges >= 1, `crossRepoEdges=${done.body.crossRepoEdges}`);

      const status = (await getJson(`${base}/status`)).body;
      assert.equal(status.project, 'default');
      assert.equal(status.directoryPath, ws);
      assert.equal(status.indexReady, true);
    } finally {
      p.kill();
      await p.exited;
    }
  });
});

describe('cluster mode', () => {
  it('workers report the primary\'s indexing state', async () => {
    const env = baseEnv({
      home: join(root, 'home'),
      dataDir: join(root, 'data2'),
      embedderUrl: slow.url,
      extra: { CODE_SEARCH_WORKERS: '2' },
    });
    const p = spawnProc(BIN.mcp, ['--serve', '--port', '47397'], env);
    const base = 'http://127.0.0.1:47397';
    try {
      await waitFor(async () => (await getJson(`${base}/health`)).status === 200, 20_000, `health\n${p.stderr()}`);
      const indexed = post(base, JSON.stringify({ path: ws }));
      await waitFor(async () => (await getJson(`${base}/status`)).body.indexing.status === 'indexing', 10_000, `worker sees indexing\n${p.stderr()}`);
      const done = await indexed;
      assert.equal(done.status, 200, JSON.stringify(done.body));
      await waitFor(async () => {
        for (let i = 0; i < 6; i++) {
          const s = (await getJson(`${base}/status`)).body;
          if (s.indexing.status !== 'idle' || !s.indexReady || !s.indexing.lastSuccess) return false;
        }
        return true;
      }, 5_000, 'every worker to report the finished index');
      assert.equal((await getJson(`${base}/admin/api/status`)).body.indexing.status, 'idle');
    } finally {
      p.child.kill('SIGTERM');
      await exitWithin(p, 5_000);
    }
  });

  it('enforces one rate limit for the whole server', async () => {
    const env = baseEnv({
      home: join(root, 'home'),
      dataDir: join(root, 'data3'),
      extra: {
        CODE_SEARCH_WORKERS: '2',
        CODE_SEARCH_AUTH_MODE: 'api-key',
        CODE_SEARCH_AUTH_API_KEYS: 'cluster-key-0001',
        CODE_SEARCH_RATE_LIMIT_PER_MINUTE: '4',
        CODE_SEARCH_HOST: '127.0.0.1',
      },
    });
    const p = spawnProc(BIN.mcp, ['--serve', '--port', '47398'], env);
    const base = 'http://127.0.0.1:47398';
    try {
      await waitFor(async () => (await getJson(`${base}/health`)).status === 200, 20_000, `health\n${p.stderr()}`);
      // Let both workers come up before counting.
      await waitFor(() => (p.stderr().match(/Server running for/g) ?? []).length >= 2, 20_000, 'two workers');
      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) {
        statuses.push((await getJson(`${base}/admin/api/status`, { headers: { Authorization: 'Bearer cluster-key-0001' } })).status);
      }
      assert.equal(statuses.filter((s) => s === 200).length, 4, statuses.join(','));
      assert.equal(statuses.filter((s) => s === 429).length, 6, statuses.join(','));
    } finally {
      p.child.kill('SIGTERM');
      await exitWithin(p, 5_000);
    }
  });
});
