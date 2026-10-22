/**
 * Incremental embed must not lose chunks.
 *
 * Chunk ids are hash(filePath, startLine, endLine), so when a file changes,
 * every chunk whose line range didn't move keeps its id. buildKB lists the
 * changed file in deleted_files.json so embedChunks wipes its old rows and
 * re-embeds it — which only works if the wipe happens before the
 * "already embedded" id snapshot. And a later no-change cycle must not replay
 * that list against rows that are already correct.
 *
 * Drives the real buildKB + embedChunks over a temp git repo, with a local
 * OpenAI-compatible embedding stub and a real LanceDB table.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildKBFromPath, embedFromPath, indexFromPath, resolveStorage } from '@esankhan3/anvil-knowledge-core';
import type { KnowledgeConfig } from '@esankhan3/anvil-knowledge-core';

const DIM = 8;

/** OpenAI-compatible /v1/embeddings stub: deterministic vector per input text. */
let embedCalls = 0;
function startEmbedStub(): Promise<Server> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      embedCalls++;
      const { input } = JSON.parse(body) as { input: string[] };
      const data = input.map((text) => {
        const h = createHash('sha256').update(text).digest();
        return { embedding: Array.from({ length: DIM }, (_, i) => h[i] / 255) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const fn = (name: string): string =>
  `export function ${name}(a: number, b: number): number {\n  const sum = a + b;\n  const product = a * b;\n  return sum + product + ${name.length};\n}\n\n`;

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
};

interface Fixture {
  repo: string;
  project: string;
  config: KnowledgeConfig;
  rows: () => Promise<{ total: number; a: number; b: number }>;
  pending: () => Promise<Array<{ filePath: string }> | null>;
}

/** Temp git repo (a.ts: 5 functions, b.ts: 3) + data dir + embedding stub. */
async function withFixture(
  t: { skip: (msg: string) => void },
  body: (f: Fixture) => Promise<void>,
): Promise<void> {
  try { await import('@lancedb/lancedb'); } catch { t.skip('lancedb native binding unavailable'); return; }

  process.env.ANVIL_LLM_MODE = 'none'; // no repo profiling / LLM phases
  const root = join(tmpdir(), `kc-embed-${randomBytes(6).toString('hex')}`);
  const repo = join(root, 'svc');
  const data = join(root, 'data');
  mkdirSync(repo, { recursive: true });
  mkdirSync(data, { recursive: true });
  const prevDataDir = process.env.CODE_SEARCH_DATA_DIR;
  process.env.CODE_SEARCH_DATA_DIR = data;
  const stub = await startEmbedStub();
  try {
    writeFileSync(join(repo, 'a.ts'), ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(fn).join(''));
    writeFileSync(join(repo, 'b.ts'), ['zeta', 'eta', 'theta'].map(fn).join(''));
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');

    const project = `embed-${randomBytes(4).toString('hex')}`;
    const config: KnowledgeConfig = {
      embedding: {
        provider: 'openai-compatible',
        model: 'stub',
        dimensions: DIM,
        baseUrl: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
        apiKey: 'stub',
      },
      chunking: { maxTokens: 500, contextEnrichment: 'structural' },
      retrieval: { maxChunks: 8, maxTokens: 12000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 }, reranker: 'none' },
      autoIndex: true,
    };
    const repoName = basename(repo);
    await body({
      repo,
      project,
      config,
      rows: async () => {
        const v = resolveStorage(project, config).vectors;
        await v.init();
        return {
          total: (await v.getStats())?.rowCount ?? 0,
          a: (await v.getChunksByFile(repoName, 'a.ts')).length,
          b: (await v.getChunksByFile(repoName, 'b.ts')).length,
        };
      },
      pending: () => resolveStorage(project, config).blobs.getJson<Array<{ filePath: string }>>('deleted_files.json'),
    });
  } finally {
    stub.close();
    if (prevDataDir === undefined) delete process.env.CODE_SEARCH_DATA_DIR;
    else process.env.CODE_SEARCH_DATA_DIR = prevDataDir;
    rmSync(root, { recursive: true, force: true });
  }
}

/** Append a line to `file` without moving any existing function's lines. */
const touch = (repo: string, file: string): void => {
  appendFileSync(join(repo, file), '// trailing comment\n');
  git(repo, 'commit', '-qam', `touch ${file}`);
};

describe('embedChunks — incremental runs keep every chunk', () => {
  it('re-embeds a changed file and survives a no-change cycle', async (t) => {
    await withFixture(t, async ({ repo, project, config, rows, pending }) => {
      const first = await indexFromPath(project, repo, { config });
      const afterFirst = await rows();
      assert.ok(afterFirst.a >= 5, `a.ts chunked into its functions (got ${afterFirst.a})`);
      assert.equal(afterFirst.total, first.totalChunks, 'every chunk embedded');

      touch(repo, 'a.ts');
      const second = await indexFromPath(project, repo, { config });
      const afterChange = await rows();
      assert.equal(afterChange.a, afterFirst.a, 'unchanged-range chunks of a changed file survive');
      assert.equal(afterChange.total, second.totalChunks, 'no chunks lost after an incremental change');
      assert.deepEqual(await pending(), [], 'applied stale-file list is cleared');

      // No changes at all: must not replay the previous build's stale-file list.
      const callsBefore = embedCalls;
      await indexFromPath(project, repo, { config });
      assert.equal(embedCalls, callsBefore, 'no-change cycle embeds nothing');
      const afterNoop = await rows();
      assert.equal(afterNoop.total, afterChange.total, 'no-change cycle keeps every row');
      assert.equal(afterNoop.a, afterChange.a);
    });
  });

  it('keeps stale-file entries from a build whose embed never ran', async (t) => {
    await withFixture(t, async ({ repo, project, config, rows, pending }) => {
      await indexFromPath(project, repo, { config });
      const before = await rows();

      // Two builds without an embed in between (e.g. the embed step failed).
      touch(repo, 'a.ts');
      await buildKBFromPath(project, repo, { config });
      touch(repo, 'b.ts');
      await buildKBFromPath(project, repo, { config });
      assert.deepEqual(
        ((await pending()) ?? []).map((f) => f.filePath).sort(),
        ['a.ts', 'b.ts'],
        'second build keeps the first build’s pending entry',
      );

      await embedFromPath(project, { config });
      const after = await rows();
      assert.equal(after.a, before.a);
      assert.equal(after.b, before.b);
      assert.equal(after.total, before.total);
    });
  });

  it('tracks uncommitted edits: indexed once, not re-embedded while unchanged, reverted cleanly', async (t) => {
    await withFixture(t, async ({ repo, project, config, rows }) => {
      await indexFromPath(project, repo, { config });
      const before = await rows();

      // Saved but not committed — what the daemon's file watcher reacts to.
      appendFileSync(join(repo, 'a.ts'), fn('omega'));
      await indexFromPath(project, repo, { config });
      const edited = await rows();
      assert.equal(edited.a, before.a + 1, 'the new uncommitted function is indexed');
      assert.equal(edited.total, before.total + 1);

      // Same dirty state on the next run: nothing to redo.
      const callsBefore = embedCalls;
      await indexFromPath(project, repo, { config });
      assert.equal(embedCalls, callsBefore, 'an unchanged uncommitted edit is not re-embedded');
      assert.deepEqual(await rows(), edited);

      // Reverting the edit restores the committed content in the index.
      git(repo, 'checkout', '--', 'a.ts');
      await indexFromPath(project, repo, { config });
      assert.deepEqual(await rows(), before, 'reverted edit leaves the index as committed');

      // An uncommitted delete drops the file; restoring it brings it back.
      rmSync(join(repo, 'b.ts'));
      await indexFromPath(project, repo, { config });
      assert.equal((await rows()).b, 0, 'uncommitted delete removes the file');
      git(repo, 'checkout', '--', 'b.ts');
      await indexFromPath(project, repo, { config });
      assert.deepEqual(await rows(), before, 'restored file is indexed again');

      // An indexed edit reverted while HEAD moves on (a commit to another file):
      // the reverted file must still go back to its committed content.
      appendFileSync(join(repo, 'a.ts'), fn('omega'));
      await indexFromPath(project, repo, { config });
      assert.equal((await rows()).a, before.a + 1);
      git(repo, 'checkout', '--', 'a.ts');
      touch(repo, 'b.ts');
      await indexFromPath(project, repo, { config });
      assert.deepEqual(await rows(), before, 'reverted edit is restored across a new commit');
    });
  });
});
