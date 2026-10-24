/**
 * argv handling of the real binaries: `code-search-mcp` mode flags + dotted
 * config flags, and the `code-search` subcommand parser.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  BIN, tmp, makeWorkspace, baseEnv, spawnProc, run, getJson, waitFor, startFakeEmbedder, type FakeEmbedder,
} from './_harness.js';

let root: string;
let ws: string;
let embedder: FakeEmbedder;
let env: NodeJS.ProcessEnv;

before(async () => {
  root = tmp('cs-args-');
  ws = makeWorkspace(root);
  embedder = await startFakeEmbedder(47390);
  env = baseEnv({ home: join(root, 'home'), dataDir: join(root, 'data'), embedderUrl: embedder.url });
});
after(async () => {
  await embedder.close();
  rmSync(root, { recursive: true, force: true });
});

async function printConfig(args: string[], cwd?: string, extra: Record<string, string> = {}) {
  const r = await run(BIN.mcp, ['--print-config', ...args], { ...env, ...extra }, cwd);
  assert.equal(r.code, 0, r.stderr);
  return { cfg: JSON.parse(r.stdout), stderr: r.stderr };
}

describe('code-search-mcp argv', () => {
  it('--print-config reports dotted flags and --port under server.port', async () => {
    const { cfg } = await printConfig(['--serve', '--port', '47381', '--retrieval.max-chunks', '12']);
    assert.equal(cfg.server.port, 47381);
    assert.equal(cfg.retrieval.maxChunks, 12);
    assert.equal(cfg.port, undefined);
  });

  it('--print-config flags an invalid reindex interval as disabled', async () => {
    const { cfg, stderr } = await printConfig([], undefined, { CODE_SEARCH_REINDEX_INTERVAL: '90s' });
    assert.equal(cfg.indexing.reindexIntervalMs, 0);
    assert.match(stderr, /invalid reindex interval "90s"/i);
  });

  it('--print-config applies the cwd .code-search.yaml layer', async () => {
    const dir = tmp('cs-wsy-');
    writeFileSync(join(dir, '.code-search.yaml'), 'retrieval:\n  max_chunks: 17\n');
    const { cfg } = await printConfig([], dir);
    assert.equal(cfg.retrieval.maxChunks, 17);
    const cli = await run(BIN.cli, ['--print-config'], env, dir);
    assert.equal(JSON.parse(cli.stdout).retrieval.maxChunks, 17);
  });

  it('serve mode accepts dotted flags, --serve <path>, and any mode-flag order', async () => {
    const variants = [
      ['--serve', ws, '--port', '47381', '--retrieval.max-chunks', '12'],
      ['--serve', '--local', ws, '--port', '47381'],
      ['--local', ws, '--serve', '--port', '47381'],
    ];
    for (const args of variants) {
      const p = spawnProc(BIN.mcp, args, env);
      try {
        await waitFor(async () => (await getJson('http://127.0.0.1:47381/health')).status === 200, 20_000, `health for ${args.join(' ')}\n${p.stderr()}`);
        const status = await getJson('http://127.0.0.1:47381/status');
        assert.equal(status.body.directoryPath, ws, args.join(' '));
        assert.match(p.stderr(), /LLM: disabled/);
      } finally {
        p.kill();
        await p.exited;
      }
    }
  });

  it('--transport sse fails clearly instead of starting another transport', async () => {
    const r = await run(BIN.mcp, ['--serve', '--port', '47382', '--transport', 'sse'], env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /SSE transport is not supported/);
  });

  it('unknown flags exit 2', async () => {
    const r = await run(BIN.mcp, ['--serve', '--retrieval.max-chunkz', '3'], env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown flag.*--retrieval\.max-chunkz/i);
  });
});

describe('code-search subcommands', () => {
  it('index --project p <dir> indexes <dir> as p and reports cross-repo edges', async () => {
    const r = await run(BIN.cli, ['index', '--project', 'wsx', ws], env);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.project, 'wsx');
    assert.equal(out.repos, 2);
    assert.ok(out.crossRepoEdges >= 1, `crossRepoEdges=${out.crossRepoEdges}`);
  });

  it('query takes the positional text even after flags', async () => {
    const r = await run(BIN.cli, ['query', '--project', 'wsx', '--mode', 'bm25', '--format', 'json', '--no-daemon', 'welcome email'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).query, 'welcome email');
  });

  it('rejects unknown flags and invalid --format / --top-k with exit 2', async () => {
    for (const args of [
      ['query', '--retrieval.max-chunkz', '3', 'x'],
      ['query', '--format', 'xml', 'x'],
      ['query', '--top-k', 'abc', 'x'],
      ['query', '--top-k', '0', 'x'],
      ['index', '--top-k', '3', ws],
      ['status', '--bogus'],
    ]) {
      const r = await run(BIN.cli, args, env);
      assert.equal(r.code, 2, `${args.join(' ')} → ${r.code}\n${r.stderr}`);
    }
  });

  it('status reports where the KB lives and never creates dirs for unknown projects', async () => {
    const r = await run(BIN.cli, ['status', '--project', 'nope'], env);
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.indexed, false);
    assert.equal(s.daemonAlive, false);
    assert.equal(existsSync(join(root, 'data', 'nope')), false);

    const ok = JSON.parse((await run(BIN.cli, ['status', '--project', 'wsx'], env)).stdout);
    assert.equal(ok.indexed, true);
    assert.equal(ok.kbPath, join(root, 'data', 'wsx'));
  });

  it('storage.dataDir from the CLI moves the KB', async () => {
    const { CODE_SEARCH_DATA_DIR: _drop, ...noDataDir } = env;
    const dd = join(root, 'dd2');
    const r = await run(BIN.cli, ['index', ws, '--project', 'moved', '--storage.data-dir', dd], noDataDir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(dd, 'moved', 'index_stats.json')), 'KB written under --storage.data-dir');
    assert.equal(existsSync(join(root, 'home', '.anvil', 'knowledge-base', 'moved')), false);
    const s = JSON.parse((await run(BIN.cli, ['status', '--project', 'moved', '--storage.data-dir', dd], noDataDir)).stdout);
    assert.equal(s.dataDir, dd);
    assert.equal(s.indexed, true);
  });

  it('bare `code-search mcp` serves the cwd over stdio (as its help says)', async () => {
    const p = spawnProc(BIN.cli, ['mcp', '--project', 'wsx'], env, ws);
    try {
      await p.waitForStderr(/Server running for "wsx" \(stdio\)/);
      assert.doesNotMatch(p.stderr(), /No remote server configured/);
    } finally {
      p.kill();
      await p.exited;
    }
  });
});
