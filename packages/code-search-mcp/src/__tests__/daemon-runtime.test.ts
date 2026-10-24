/**
 * The real daemon + CLI against a fixture workspace: project naming from a
 * relative --workspace, single daemon per project, liveness via ping, fresh
 * results right after the daemon's own reindex / invalidate, one index run
 * per watcher batch, --no-daemon, signal forwarding by the `code-search
 * daemon` wrapper (own socket + pid file removed), and `reset` safety.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonBackend } from '../backends/daemon-client.js';
import {
  BIN, tmp, makeWorkspace, baseEnv, spawnProc, run, waitFor, exitWithin, startFakeEmbedder, type FakeEmbedder, type Proc,
} from './_harness.js';

let root: string;
let ws: string;
let dataDir: string;
let embedder: FakeEmbedder;
let env: NodeJS.ProcessEnv;
let wrapper: Proc;

const sock = () => join(dataDir, 'daemon', 'ws.sock');
const pidFile = () => join(dataDir, 'daemon', 'ws.pid');
const client = () => new DaemonBackend({ project: 'ws', workspaceDir: null, knowledge: {} as never, preferDaemon: true, socketPath: sock() });

before(async () => {
  root = tmp('cs-d-');
  ws = makeWorkspace(root);
  dataDir = join(root, 'd');
  embedder = await startFakeEmbedder(47394);
  env = baseEnv({ home: join(root, 'h'), dataDir, embedderUrl: embedder.url });
});
after(async () => {
  wrapper?.kill();
  await embedder.close();
  rmSync(root, { recursive: true, force: true });
});

describe('daemon', { skip: process.platform === 'win32' }, () => {
  it('starts via the wrapper with --workspace . and names the project after the directory', async () => {
    wrapper = spawnProc(BIN.cli, ['daemon', '--workspace', '.'], env, ws);
    await wrapper.waitForStderr(/initial index ready/, 60_000);
    assert.equal(existsSync(sock()), true, 'socket at <dataDir>/daemon/ws.sock');
    const pid = Number(readFileSync(pidFile(), 'utf-8'));
    assert.ok(pid > 0 && pid !== wrapper.child.pid, 'pid file holds the daemon (child) pid');
    const status = JSON.parse((await run(BIN.cli, ['status', '--project', 'ws'], env)).stdout);
    assert.equal(status.daemonAlive, true);
  });

  it('refuses a second daemon for the same project', async () => {
    const r = await run(BIN.daemon, ['--workspace', ws], env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already running/);
    assert.equal(await client().ping(), true, 'the first daemon keeps its socket');
  });

  it('serves fresh results right after its own reindex, one run per watcher batch', async () => {
    const before = await client().search('zebraQuasar', { mode: 'bm25', maxResults: 20 });
    assert.ok(!before.chunks.some((c) => c.content.includes('zebraQuasar')));

    const genFile = join(dataDir, 'ws', 'index_generation');
    const gens = new Set<string>();
    const poll = setInterval(() => { try { gens.add(readFileSync(genFile, 'utf-8')); } catch { /* mid-write */ } }, 5);
    const startGen = readFileSync(genFile, 'utf-8');
    try {
      const mark = wrapper.stderr().length;
      appendFileSync(join(ws, 'orders', 'src', 'orders.ts'), '\nexport function zebraQuasar() {\n  return "zebra quasar";\n}\n');
      await waitFor(() => /reindex finished \(watcher\)/.test(wrapper.stderr().slice(mark)), 60_000, `watcher reindex\n${wrapper.stderr()}`);
      const after = await client().search('zebraQuasar', { mode: 'bm25', maxResults: 20 });
      assert.ok(after.chunks.some((c) => c.content.includes('zebraQuasar')), 'the daemon must not serve its pre-reindex retriever');

      await new Promise((r) => setTimeout(r, 2_000));
      gens.delete(startGen);
      assert.equal(gens.size, 2, `one index run (graph + embed phases) per batch, saw ${gens.size} generation bumps`);
      assert.equal((wrapper.stderr().slice(mark).match(/reindex started \(watcher\)/g) ?? []).length, 1);
    } finally {
      clearInterval(poll);
    }
  });

  it('drops invalidated rows from results immediately', async () => {
    const hasBilling = async () => (await client().search('chargeOrder', { mode: 'vector', maxResults: 50 }))
      .chunks.some((c) => c.filePath === 'src/billing.ts');
    assert.equal(await hasBilling(), true);
    await client().invalidate(['src/billing.ts']);
    assert.equal(await hasBilling(), false);
  });

  it('honours --no-daemon', async () => {
    // An unreachable embedder only breaks the in-process path; the daemon has its own.
    const args = ['query', '--project', 'ws', '--mode', 'vector', '--format', 'json', '--embedding.base-url', 'http://127.0.0.1:9', 'zebra'];
    assert.equal((await run(BIN.cli, args, env)).code, 0, 'routed to the daemon');
    assert.notEqual((await run(BIN.cli, [...args, '--no-daemon'], env)).code, 0, 'searched in-process');
  });

  it('the wrapper forwards SIGTERM; the daemon removes its own socket + pid file', async () => {
    wrapper.child.kill('SIGTERM');
    const exit = await exitWithin(wrapper, 10_000);
    assert.notEqual(exit, 'timeout', 'wrapper must exit on SIGTERM');
    assert.equal(existsSync(sock()), false);
    assert.equal(existsSync(pidFile()), false);
  });

  it('status sees a SIGKILLed daemon as dead and a new daemon replaces its stale socket', async () => {
    const d = spawnProc(BIN.daemon, ['--workspace', ws], env);
    try {
      await d.waitForStderr(/initial index ready/, 60_000);
      d.child.kill('SIGKILL');
      await d.exited;
      assert.equal(existsSync(sock()), true, 'stale socket left behind');
      const status = JSON.parse((await run(BIN.cli, ['status', '--project', 'ws'], env)).stdout);
      assert.equal(status.daemonAlive, false);

      const d2 = spawnProc(BIN.daemon, ['--workspace', ws], env);
      try {
        await d2.waitForStderr(/RPC listening/, 30_000);
        await waitFor(() => client().ping(), 10_000, 'second daemon answering');
      } finally {
        d2.child.kill('SIGTERM');
        await exitWithin(d2, 10_000);
      }
    } finally {
      d.kill();
    }
  });
});

describe('reset', () => {
  it('rejects names that escape or collide inside the data dir', async () => {
    const dd = join(root, 'rp', 'inner', 'dd');
    mkdirSync(join(dd, 'daemon'), { recursive: true });
    mkdirSync(join(dd, 'projects'), { recursive: true });
    writeFileSync(join(root, 'rp', 'keep.txt'), 'x');
    const e = { ...env, CODE_SEARCH_DATA_DIR: dd };
    for (const bad of ['..', '.', 'daemon', 'projects', 'a/b', '../inner']) {
      const r = await run(BIN.cli, ['reset', '--project', bad], e);
      assert.equal(r.code, 2, `${bad}: ${r.stderr}`);
    }
    assert.equal(existsSync(join(root, 'rp', 'keep.txt')), true);
    assert.equal(existsSync(join(dd, 'daemon')), true);
    assert.equal(existsSync(join(dd, 'projects')), true);

    mkdirSync(join(dd, 'p1', 'lancedb'), { recursive: true });
    const ok = await run(BIN.cli, ['reset', '--project', 'p1'], e);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(existsSync(join(dd, 'p1')), false);
    assert.equal(existsSync(dd), true);
  });
});
