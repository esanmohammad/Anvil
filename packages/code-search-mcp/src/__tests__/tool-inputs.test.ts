/**
 * Tool input contract: bad arguments are rejected with a clear message and
 * `isError: true`; descriptors advertise what the handlers accept; search_exact
 * (BM25) works without the embedder; search tools record the query metrics;
 * hints name things that exist.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore, invalidateRetriever, resetLlmConfig, type CodeChunk } from '@esankhan3/anvil-knowledge-core';

import { handleGraphTool, registerGraphTools } from '../tools/graph.js';
import { handleSearchTool, registerSearchTools } from '../tools/search.js';
import { handleProfileTool } from '../tools/profile.js';
import { resetServerConfig } from '../core/env-config.js';
import { registry } from '../observability/metrics.js';
import type { ServerContext } from '../server.js';

const PROJECT = 'inputs';
let tmp = '';
const ENV_KEYS = [
  'CODE_SEARCH_DATA_DIR', 'CODE_SEARCH_EMBEDDING_PROVIDER', 'CODE_SEARCH_OLLAMA_HOST', 'CODE_SEARCH_EMBEDDING_DIMENSIONS',
  'CODE_SEARCH_RERANKER_PROVIDER', 'ANVIL_LLM_MODE', 'CODE_SEARCH_LLM_MODE',
];
const stash: Record<string, string | undefined> = {};

function ctx(indexReady = true): ServerContext {
  return {
    projectName: PROJECT,
    directoryPath: null,
    indexReady,
    startedAt: 0,
    indexing: {
      status: 'idle', phase: null, message: null, percent: 0,
      startedAt: null, error: null, lastSuccess: null, lastDurationMs: 0, history: [],
    },
  };
}
const text = (r: any): string => r?.content?.[0]?.text ?? '';

function chunk(id: string, entityName: string, content: string): CodeChunk & { embedding: number[] } {
  return {
    id, filePath: `src/${id}.ts`, repoName: 'app', project: PROJECT, startLine: 1, endLine: 3,
    content, contextPrefix: '', contextualizedContent: content, language: 'typescript',
    entityType: 'function', entityName, tokens: 10, imports: [], exports: [],
    embedding: [1, 0, 0, 0],
  };
}

before(async () => {
  for (const k of ENV_KEYS) stash[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), 'cs-inputs-'));
  process.env.CODE_SEARCH_DATA_DIR = tmp;
  // An embedder nobody listens on: BM25 must not need it.
  process.env.CODE_SEARCH_EMBEDDING_PROVIDER = 'ollama';
  process.env.CODE_SEARCH_OLLAMA_HOST = 'http://127.0.0.1:47361';
  process.env.CODE_SEARCH_EMBEDDING_DIMENSIONS = '4';
  process.env.CODE_SEARCH_RERANKER_PROVIDER = 'none';
  process.env.ANVIL_LLM_MODE = 'none';
  process.env.CODE_SEARCH_LLM_MODE = 'none';
  resetServerConfig();
  resetLlmConfig();
  mkdirSync(join(tmp, PROJECT), { recursive: true });
  const store = new VectorStore(join(tmp, PROJECT, 'lancedb'));
  await store.init();
  await store.upsertChunks([
    chunk('a', 'chargeCustomer', 'export function chargeCustomer(amount: number) { return gateway.charge(amount); }'),
    chunk('b', 'refundCustomer', 'export function refundCustomer(id: string) { return gateway.refund(id); }'),
  ]);
  await store.ensureFtsIndex();
});

after(async () => {
  await invalidateRetriever();
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (stash[k] === undefined) delete process.env[k];
    else process.env[k] = stash[k];
  }
  resetServerConfig();
  resetLlmConfig();
});

describe('input validation', () => {
  const cases: Array<[string, string, Record<string, unknown>, RegExp]> = [
    ['search', 'search_code', {}, /query/],
    ['search', 'search_code', { query: '   ' }, /query/],
    ['search', 'search_code', { query: 5 }, /query.*string/],
    ['search', 'search_code', { query: 'x', maxResults: 0 }, /maxResults/],
    ['search', 'search_exact', { query: 'x', repos: 5 }, /"repos" must be a non-empty array of strings or a non-empty string/],
    ['search', 'search_exact', { query: 'x', repos: { app: true } }, /repos/],
    ['search', 'search_exact', { query: 'x', repos: [] }, /repos/],
    ['search', 'search_exact', { query: 'x', repos: '' }, /repos/],
    ['search', 'search_exact', { query: 'x', repos: ' , ' }, /repos.*at least one/],
    ['search', 'get_code_snippet', {}, /id|repo/],
    ['graph', 'detect_changes', {}, /repo/],
    ['graph', 'trace_path', { from: 'a', direction: 'sideways' }, /direction.*callees, callers, both/],
    ['graph', 'trace_path', { from: 'a', maxDepth: 0 }, /maxDepth/],
    ['graph', 'trace_path', { from: 'a', maxDepth: 11 }, /maxDepth/],
    ['graph', 'find_callers', { function: 'a', relations: ['friends'] }, /relations/],
    ['graph', 'impact_analysis', { repo: 'app' }, /file/],
    ['graph', 'search_graph', { limit: 'ten' }, /limit/],
    ['graph', 'find_dead_code', { repo: 'app', limit: -1 }, /limit/],
  ];
  for (const [kind, name, args, re] of cases) {
    it(`${name} ${JSON.stringify(args)} → isError`, async () => {
      const r: any = kind === 'search' ? await handleSearchTool(name, args, ctx()) : await handleGraphTool(name, args, ctx());
      assert.equal(r?.isError, true, text(r));
      assert.match(text(r), re);
    });
  }

  it('get_repo_profile without repo → isError', async () => {
    const r: any = await handleProfileTool('get_repo_profile', {}, ctx());
    assert.equal(r?.isError, true);
  });
});

describe('search_exact without an embedder', () => {
  it('serves BM25 even while the index is not ready', async () => {
    const r: any = await handleSearchTool('search_exact', { query: 'refundCustomer' }, ctx(false));
    assert.notEqual(r.isError, true, text(r));
    assert.match(text(r), /refundCustomer/);
  });

  it('accepts repos as an array, one name, or a comma-separated list — and applies it', async () => {
    for (const repos of [['app'], 'app', 'other, app']) {
      const r: any = await handleSearchTool('search_exact', { query: 'refundCustomer', repos }, ctx());
      assert.notEqual(r.isError, true, `${JSON.stringify(repos)}: ${text(r)}`);
      assert.match(text(r), /refundCustomer/, JSON.stringify(repos));
    }
    assert.match(text(await handleSearchTool('search_exact', { query: 'refundCustomer', repos: 'other' }, ctx())), /No results/);
  });

  it('records the query metrics', async () => {
    await handleSearchTool('search_exact', { query: 'chargeCustomer' }, ctx());
    const body = registry.render();
    assert.match(body, /code_search_queries_total\{[^}]*mode="bm25"[^}]*\} \d+/);
    assert.match(body, /code_search_query_duration_seconds_count\{mode="bm25"\} \d+/);
  });

  it('hybrid search reports an embedder failure as an error and counts it', async () => {
    const r: any = await handleSearchTool('search_code', { query: 'charge customer' }, ctx());
    assert.equal(r.isError, true);
    assert.match(registry.render(), /code_search_errors_total\{kind="search"\} \d+/);
  });
});

describe('hints', () => {
  it('index-not-ready does not point at a reindex tool', async () => {
    const t = text(await handleSearchTool('search_semantic', { query: 'x' }, ctx(false)));
    assert.match(t, /not ready/i);
    assert.doesNotMatch(t, /reindex tool/);
  });

  it('missing profile with LLM off says profiles need an LLM', async () => {
    const t = text(await handleProfileTool('get_repo_profile', { repo: 'app' }, ctx()));
    assert.match(t, /LLM/);
    assert.doesNotMatch(t, /Run reindex/);
  });
});

describe('descriptors match behaviour', () => {
  const search = Object.fromEntries(registerSearchTools().map((t) => [t.name, t]));
  const graph = Object.fromEntries(registerGraphTools().map((t) => [t.name, t]));

  it('search_semantic / search_exact advertise repos', () => {
    assert.ok((search.search_semantic.inputSchema.properties as any).repos);
    assert.ok((search.search_exact.inputSchema.properties as any).repos);
  });

  it('trace_path is not described as confidence-weighted; search_graph name is a regex', () => {
    assert.doesNotMatch(graph.trace_path.description, /confidence-weighted/);
    assert.match((graph.search_graph.inputSchema.properties as any).name.description, /regex/i);
    assert.ok((graph.find_callers.inputSchema.properties as any).relations);
  });
});
