import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadKnowledgeConfig,
  applyEnvOverrides,
  DEFAULT_CONFIG,
  normalizeRerankerConfig,
  type KnowledgeConfig,
} from '@esankhan3/anvil-knowledge-core';

/**
 * P1 — env-override layer in loadKnowledgeConfig should make
 * CODE_SEARCH_* env vars actually reach the indexer (issue #6).
 */

const ENV_KEYS = [
  'ANVIL_HOME',
  'CODE_SEARCH_EMBEDDING_PROVIDER',
  'CODE_SEARCH_EMBEDDING_MODEL',
  'CODE_SEARCH_EMBEDDING_DIMENSIONS',
  'CODE_SEARCH_EMBEDDING_API_KEY',
  'CODE_SEARCH_EMBEDDING_BASE_URL',
  'CODE_SEARCH_RERANKER_PROVIDER',
  'CODE_SEARCH_RERANKER_MODEL',
  'CODE_SEARCH_RERANKER_API_KEY',
  'CODE_SEARCH_RERANKER_BASE_URL',
  'CODE_SEARCH_RETRIEVAL_MAX_CHUNKS',
  'CODE_SEARCH_RETRIEVAL_MAX_TOKENS',
  'CODE_SEARCH_AUTO_INDEX',
];

let tmp = '';
const STASH: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    STASH[k] = process.env[k];
    delete process.env[k];
  }
  tmp = mkdtempSync(join(tmpdir(), 'kb-config-'));
  process.env.ANVIL_HOME = tmp;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (STASH[k] === undefined) delete process.env[k];
    else process.env[k] = STASH[k];
  }
});

function writeFactoryYaml(project: string, body: string): void {
  const dir = join(tmp, 'projects', project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'factory.yaml'), body, 'utf-8');
}

describe('loadKnowledgeConfig + applyEnvOverrides (P1)', () => {
  it('with no YAML and no env, returns DEFAULT_CONFIG clone', () => {
    const cfg = loadKnowledgeConfig('unknown-project');
    assert.equal(cfg.embedding.provider, DEFAULT_CONFIG.embedding.provider);
    assert.equal(cfg.embedding.dimensions, DEFAULT_CONFIG.embedding.dimensions);
    assert.equal(cfg.autoIndex, DEFAULT_CONFIG.autoIndex);
  });

  it('env vars alone override DEFAULT_CONFIG', () => {
    process.env.CODE_SEARCH_EMBEDDING_PROVIDER = 'codestral';
    process.env.CODE_SEARCH_EMBEDDING_MODEL = 'codestral-embed-2505';
    process.env.CODE_SEARCH_EMBEDDING_DIMENSIONS = '768';
    process.env.CODE_SEARCH_EMBEDDING_API_KEY = 'sk-test';

    const cfg = loadKnowledgeConfig('no-yaml');
    assert.equal(cfg.embedding.provider, 'codestral');
    assert.equal(cfg.embedding.model, 'codestral-embed-2505');
    assert.equal(cfg.embedding.dimensions, 768);
    assert.equal(cfg.embedding.apiKey, 'sk-test');
  });

  it('env vars override YAML (last-write semantics)', () => {
    writeFactoryYaml(
      'with-yaml',
      `\nknowledge:\n  embedding:\n    provider: voyage\n    model: voyage-code-3\n  auto_index: true\n`,
    );

    // YAML alone
    let cfg = loadKnowledgeConfig('with-yaml');
    assert.equal(cfg.embedding.provider, 'voyage');

    // YAML + env override
    process.env.CODE_SEARCH_EMBEDDING_PROVIDER = 'openai';
    cfg = loadKnowledgeConfig('with-yaml');
    assert.equal(cfg.embedding.provider, 'openai');
  });

  it('reranker env vars normalize into struct shape', () => {
    process.env.CODE_SEARCH_RERANKER_PROVIDER = 'custom';
    process.env.CODE_SEARCH_RERANKER_MODEL = 'rerank-test';
    process.env.CODE_SEARCH_RERANKER_BASE_URL = 'http://rerank.local';
    process.env.CODE_SEARCH_RERANKER_API_KEY = 'rr-key';

    const cfg = loadKnowledgeConfig('no-yaml');
    const reranker = normalizeRerankerConfig(cfg.retrieval.reranker);
    assert.equal(reranker.provider, 'custom');
    assert.equal(reranker.model, 'rerank-test');
    assert.equal(reranker.baseUrl, 'http://rerank.local');
    assert.equal(reranker.apiKey, 'rr-key');
  });

  it('retrieval tuning env vars override defaults', () => {
    process.env.CODE_SEARCH_RETRIEVAL_MAX_CHUNKS = '20';
    process.env.CODE_SEARCH_RETRIEVAL_MAX_TOKENS = '24000';

    const cfg = loadKnowledgeConfig('no-yaml');
    assert.equal(cfg.retrieval.maxChunks, 20);
    assert.equal(cfg.retrieval.maxTokens, 24000);
  });

  it('CODE_SEARCH_AUTO_INDEX=false disables autoIndex', () => {
    process.env.CODE_SEARCH_AUTO_INDEX = 'false';
    const cfg = loadKnowledgeConfig('no-yaml');
    assert.equal(cfg.autoIndex, false);
  });

  it('applyEnvOverrides is pure — never mutates input', () => {
    const input: KnowledgeConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    process.env.CODE_SEARCH_EMBEDDING_PROVIDER = 'openai';
    const output = applyEnvOverrides(input);
    assert.notEqual(input, output, 'should return new object');
    assert.equal(input.embedding.provider, DEFAULT_CONFIG.embedding.provider);
    assert.equal(output.embedding.provider, 'openai');
  });
});
