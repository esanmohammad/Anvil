/**
 * Lifecycle of the real `code-search-mcp` server process: the HTTP port is
 * bound before the startup index (probes answer during it), the reported
 * version is the package's, dynamic resources are discoverable, index gauges
 * are real, structured logging + config-file reindex intervals apply, and
 * SIGTERM terminates both the HTTP and the stdio server.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  BIN, tmp, makeWorkspace, baseEnv, spawnProc, getJson, waitFor, exitWithin, startFakeEmbedder, type FakeEmbedder,
} from './_harness.js';

const PKG_VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version: string }).version;

let root: string;
let ws: string;
let slow: FakeEmbedder;
let fast: FakeEmbedder;

before(async () => {
  root = tmp('cs-life-');
  ws = makeWorkspace(root);
  slow = await startFakeEmbedder(47391, { delayMs: 2500 });
  fast = await startFakeEmbedder(47392);
});
after(async () => {
  await slow.close();
  await fast.close();
  rmSync(root, { recursive: true, force: true });
});

describe('HTTP server lifecycle', () => {
  it('answers /health and /ready during the startup index, then serves', async () => {
    const env = baseEnv({ home: join(root, 'home'), dataDir: join(root, 'data1'), embedderUrl: slow.url });
    const p = spawnProc(BIN.mcp, ['--local', ws, '--serve', '--port', '47383'], env);
    const base = 'http://127.0.0.1:47383';
    try {
      await waitFor(async () => (await getJson(`${base}/health`)).status === 200, 20_000, `health\n${p.stderr()}`);
      const early = await getJson(`${base}/ready`);
      assert.equal(early.status, 503, 'not ready while the first index is still embedding');
      assert.equal(early.body.ready, false);

      await waitFor(async () => (await getJson(`${base}/ready`)).status === 200, 60_000, `ready\n${p.stderr()}`);

      const version = await getJson(`${base}/version`);
      assert.equal(version.body.version, PKG_VERSION);
      const admin = await getJson(`${base}/admin/api/status`);
      assert.equal(admin.body.version, PKG_VERSION);

      const client = new Client({ name: 'lifecycle-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      assert.equal(client.getServerVersion()?.version, PKG_VERSION);
      const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate).sort();
      assert.deepEqual(templates, ['code-search://repo/{name}/graph', 'code-search://repo/{name}/profile']);
      await client.close();

      const metrics = await (await fetch(`${base}/metrics`)).text();
      const age = metrics.match(/^code_search_index_age_seconds\{project="default"\} (\d+)$/m);
      assert.ok(age, `index_age missing:\n${metrics}`);
      assert.ok(Number(age[1]) < 120, `index_age=${age[1]}`);
      assert.doesNotMatch(metrics, /phase=/);
      assert.match(metrics, /^code_search_index_chunks_total\{project="default",repo="orders"\} [1-9]\d*$/m);

      p.child.kill('SIGTERM');
      const exit = await exitWithin(p, 5_000);
      assert.notEqual(exit, 'timeout', 'SIGTERM must terminate the HTTP server');
    } finally {
      p.kill();
      await p.exited;
    }
  });

  it('structured logs + reindex interval from the config file', async () => {
    const env = baseEnv({
      home: join(root, 'home'),
      dataDir: join(root, 'data2'),
      embedderUrl: fast.url,
      extra: { CODE_SEARCH_STRUCTURED_LOGS: '1' },
    });
    const p = spawnProc(BIN.mcp, ['--serve', ws, '--port', '47384', '--indexing.reindex-interval-ms', '1h'], env);
    try {
      await waitFor(async () => (await getJson('http://127.0.0.1:47384/ready')).status === 200, 60_000, `ready\n${p.stderr()}`);
      const lines = p.stderr().split('\n').filter(Boolean);
      assert.ok(!lines.some((l) => l.startsWith('[code-search-mcp]')), `plain-text server lines:\n${p.stderr()}`);
      const json = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      assert.ok(json.some((e) => e.component === 'code-search-mcp' && e.msg === 'Auto-reindex every 60m'), p.stderr());
      assert.ok(json.some((e) => e.component === 'auto-index' && e.level === 'info'), 'index progress goes through the logger');
    } finally {
      p.kill();
      await p.exited;
    }
  });
});

describe('stdio server lifecycle', () => {
  it('SIGTERM terminates --local stdio mode', async () => {
    const env = baseEnv({ home: join(root, 'home'), dataDir: join(root, 'data3'), embedderUrl: fast.url });
    const p = spawnProc(BIN.mcp, ['--local', ws], env);
    try {
      await p.waitForStderr(/Server running for "ws" \(stdio\)/, 60_000);
      p.child.kill('SIGTERM');
      const exit = await exitWithin(p, 5_000);
      assert.notEqual(exit, 'timeout', 'SIGTERM must terminate the stdio server');
    } finally {
      p.kill();
      await p.exited;
    }
  });
});
