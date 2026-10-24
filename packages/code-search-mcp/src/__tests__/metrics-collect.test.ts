/**
 * The scrape-time index collector: index age is the time since the last
 * successful index, chunk gauges come from the stats rollup, and every gauge
 * it owns is cleared when its blob disappears (no stale series).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { getBlobStore } from '@esankhan3/anvil-knowledge-core';
import { collectIndexMetrics } from '../server.js';
import { registry } from '../observability/metrics.js';
import { tmp } from './_harness.js';

let dataDir: string;
before(() => {
  dataDir = tmp('cs-metrics-');
  process.env.CODE_SEARCH_DATA_DIR = dataDir;
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

const KC = { embedding: { provider: 'ollama' }, chunking: { maxTokens: 500 }, retrieval: { maxChunks: 8, maxTokens: 12000 } } as never;

describe('collectIndexMetrics', () => {
  it('reports real index age + chunks and clears gauges whose blob vanished', async () => {
    const blobs = getBlobStore('p', KC);
    await blobs.putJson('index_stats.json', {
      repos: [{ name: 'a', chunkCount: 3, language: 'ts' }, { name: 'b', chunkCount: 5, language: 'ts' }],
      lastIndexed: new Date(Date.now() - 42_000).toISOString(),
    });
    await blobs.putJson('vector_index.json', { rowsAddedSinceTrain: 5, trainedRows: 10, numUnindexedRows: 7, checkedAt: new Date().toISOString() });

    await collectIndexMetrics('p', KC);
    let out = registry.render();
    const age = Number(out.match(/^code_search_index_age_seconds\{project="p"\} (\d+)$/m)?.[1]);
    assert.ok(age >= 42 && age < 60, `age=${age}`);
    assert.match(out, /^code_search_index_chunks_total\{project="p",repo="a"\} 3$/m);
    assert.match(out, /^code_search_index_chunks_total\{project="p",repo="b"\} 5$/m);
    assert.match(out, /^code_search_vector_index_unindexed_rows\{project="p"\} 7$/m);
    assert.match(out, /^code_search_vector_index_growth_ratio\{project="p"\} 0\.5$/m);

    // A fresher in-process success wins over the rollup timestamp.
    await collectIndexMetrics('p', KC, new Date(Date.now() - 2_000).toISOString());
    assert.ok(Number(registry.render().match(/^code_search_index_age_seconds\{project="p"\} (\d+)$/m)?.[1]) < 10);

    await blobs.delete('vector_index.json');
    await blobs.putJson('index_stats.json', { repos: [{ name: 'a', chunkCount: 4, language: 'ts' }], lastIndexed: new Date().toISOString() });
    await collectIndexMetrics('p', KC);
    out = registry.render();
    assert.doesNotMatch(out, /code_search_vector_index_unindexed_rows\{/);
    assert.doesNotMatch(out, /code_search_vector_index_growth_ratio\{/);
    assert.doesNotMatch(out, /repo="b"/);
    assert.match(out, /^code_search_index_chunks_total\{project="p",repo="a"\} 4$/m);
  });

  it('declares no metric that nothing records', () => {
    const out = registry.render();
    for (const dead of ['embeddings_calls_total', 'llm_calls_total', 'reranker_cache_hits_total']) {
      assert.doesNotMatch(out, new RegExp(`code_search_${dead}`));
    }
  });
});
