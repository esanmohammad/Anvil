/**
 * Shared fixture for indexing integration tests: a temp workspace of git
 * repos, a data dir (CODE_SEARCH_DATA_DIR), and a local OpenAI-compatible
 * embedding stub (deterministic vector per text) that counts embedded texts.
 * Drives the real buildKB + embedChunks and a real LanceDB table.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildKBFromPath, embedFromPath, getRetriever, invalidateRetriever, resolveStorage,
} from '@esankhan3/anvil-knowledge-core';
import type { CodeChunk, KnowledgeConfig, StorageBundle } from '@esankhan3/anvil-knowledge-core';

const DIM = 8;

export interface KbFixture {
  ws: string;
  project: string;
  config: KnowledgeConfig;
  storage: () => StorageBundle;
  /** Texts sent to the embedder so far. */
  embedded: () => number;
  /** Create + commit a repo under the workspace. */
  repo: (name: string, files: Record<string, string>) => void;
  write: (repo: string, rel: string, content: string) => void;
  git: (repo: string, ...args: string[]) => void;
  commit: (repo: string, msg?: string) => void;
  /** buildKB + embed the whole workspace. */
  index: () => Promise<void>;
  /** Every row in the vector table. */
  rows: () => Promise<CodeChunk[]>;
  /** BM25 search, optionally repo-scoped. */
  search: (query: string, repos?: string[]) => Promise<CodeChunk[]>;
}

export async function withKbFixture(
  t: { skip: (msg: string) => void },
  body: (f: KbFixture) => Promise<void>,
): Promise<void> {
  try { await import('@lancedb/lancedb'); } catch { t.skip('lancedb native binding unavailable'); return; }

  process.env.ANVIL_LLM_MODE = 'none';
  const root = join(tmpdir(), `kc-fx-${randomBytes(6).toString('hex')}`);
  const ws = join(root, 'ws');
  mkdirSync(ws, { recursive: true });
  const prevDataDir = process.env.CODE_SEARCH_DATA_DIR;
  process.env.CODE_SEARCH_DATA_DIR = join(root, 'data');

  let texts = 0;
  const stub: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const { input } = JSON.parse(raw) as { input: string[] };
      texts += input.length;
      const data = input.map((text) => {
        const h = createHash('sha256').update(text).digest();
        return { embedding: Array.from({ length: DIM }, (_, i) => h[i] / 255) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));

  const project = `fx-${randomBytes(4).toString('hex')}`;
  const config: KnowledgeConfig = {
    embedding: {
      provider: 'openai-compatible',
      model: 'stub',
      dimensions: DIM,
      baseUrl: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
      apiKey: 'stub',
    },
    chunking: { maxTokens: 500, contextEnrichment: 'structural' },
    retrieval: { maxChunks: 20, maxTokens: 100000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 }, reranker: 'none' },
    autoIndex: true,
  };
  const git = (repo: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: join(ws, repo), stdio: 'ignore' });
  };
  const write = (repo: string, rel: string, content: string): void => {
    const full = join(ws, repo, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  };
  const commit = (repo: string, msg = 'change'): void => {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', msg);
  };
  const storage = () => resolveStorage(project, config);

  try {
    await body({
      ws,
      project,
      config,
      storage,
      embedded: () => texts,
      repo: (name, files) => {
        mkdirSync(join(ws, name), { recursive: true });
        for (const [rel, content] of Object.entries(files)) write(name, rel, content);
        git(name, 'init', '-q', '-b', 'main');
        commit(name, 'init');
      },
      write,
      git,
      commit,
      index: async () => {
        await buildKBFromPath(project, ws, { config });
        await embedFromPath(project, { config });
        await invalidateRetriever(project);
      },
      rows: async () => {
        const v = storage().vectors;
        await v.init();
        return v.getByIds(await v.getChunkIds(project));
      },
      search: async (query, repos) => {
        const r = await getRetriever(project, config);
        return (await r.retrieve(query, { mode: 'bm25', repos })).chunks.map((c) => c.chunk);
      },
    });
  } finally {
    await invalidateRetriever(project);
    stub.close();
    if (prevDataDir === undefined) delete process.env.CODE_SEARCH_DATA_DIR;
    else process.env.CODE_SEARCH_DATA_DIR = prevDataDir;
    rmSync(root, { recursive: true, force: true });
  }
}

/** A function whose body differs per name (no two are structurally identical). */
export const fn = (name: string, salt = ''): string =>
  `export function ${name}(a: number, b: number): number {\n  const ${name}Sum = a + b + ${name.length}${salt};\n  return ${name}Sum * ${name.charCodeAt(0)};\n}\n\n`;
