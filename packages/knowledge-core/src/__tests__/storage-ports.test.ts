/**
 * P0a — storage ports foundation.
 *
 * Verifies the FsBlobStore adapter's contract (the only genuinely new code in
 * P0a) and that resolveStorage with no config reproduces today's local wiring.
 * No consumer is rewired in P0a, so these are isolated adapter/factory tests.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { FsBlobStore, resolveStorage, getKnowledgeBasePath, createChunkWriter, lanceStorageOptions, lanceCacheBudget } from '@esankhan3/anvil-knowledge-core';
import type { CodeChunk } from '@esankhan3/anvil-knowledge-core';

let base: string;

beforeEach(() => {
  base = join(tmpdir(), `kc-storage-${randomBytes(6).toString('hex')}`);
  mkdirSync(base, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('FsBlobStore — JSON / text', () => {
  it('round-trips JSON and creates nested parent dirs', async () => {
    const s = new FsBlobStore(base);
    await s.putJson('repoA/index_meta.json', { lastIndexedSha: 'abc', n: 3 });
    const got = await s.getJson<{ lastIndexedSha: string; n: number }>('repoA/index_meta.json');
    assert.deepEqual(got, { lastIndexedSha: 'abc', n: 3 });
    // pretty-printed on disk (matches today's writeRepoIndexMeta)
    assert.match(readFileSync(join(base, 'repoA', 'index_meta.json'), 'utf-8'), /\n {2}"lastIndexedSha"/);
  });

  it('getJson / getText return null for a missing key', async () => {
    const s = new FsBlobStore(base);
    assert.equal(await s.getJson('missing.json'), null);
    assert.equal(await s.getText('missing.md'), null);
  });

  it('round-trips text and reports exists()', async () => {
    const s = new FsBlobStore(base);
    assert.equal(await s.exists('PROJECT_SUMMARY.md'), false);
    await s.putText('PROJECT_SUMMARY.md', '# hi\n');
    assert.equal(await s.exists('PROJECT_SUMMARY.md'), true);
    assert.equal(await s.getText('PROJECT_SUMMARY.md'), '# hi\n');
  });
});

describe('FsBlobStore — binary (system_graph.sqlite shape)', () => {
  it('round-trips a Buffer', async () => {
    const s = new FsBlobStore(base);
    const payload = randomBytes(2048);
    await s.putBytes('system_graph.sqlite', payload);
    const got = await s.getBytes('system_graph.sqlite');
    assert.ok(Buffer.isBuffer(got));
    assert.ok((got as Buffer).equals(payload));
  });

  it('getBytes({toFile}) materializes to a local path with identical bytes', async () => {
    const s = new FsBlobStore(base);
    const payload = randomBytes(1024);
    await s.putBytes('system_graph.sqlite', payload);
    const dest = join(base, 'cache', 'pulled.sqlite');
    const ret = await s.getBytes('system_graph.sqlite', { toFile: dest });
    assert.equal(ret, dest);
    assert.ok(readFileSync(dest).equals(payload));
  });

  it('putBytes(string) copies a local source file in', async () => {
    const s = new FsBlobStore(base);
    const src = join(base, 'src.sqlite');
    const payload = randomBytes(512);
    writeFileSync(src, payload);
    await s.putBytes('graph/system_graph.sqlite', src);
    const got = await s.getBytes('graph/system_graph.sqlite');
    assert.ok((got as Buffer).equals(payload));
  });

  it('getBytes returns null for a missing key', async () => {
    const s = new FsBlobStore(base);
    assert.equal(await s.getBytes('nope.sqlite'), null);
  });
});

describe('FsBlobStore — NDJSON streaming', () => {
  it('round-trips records one line at a time', async () => {
    const s = new FsBlobStore(base);
    const records = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    await s.putNdjson('chunks.json', records);
    const out: Array<{ id: string }> = [];
    for await (const r of s.iterateNdjson<{ id: string }>('chunks.json')) out.push(r);
    assert.deepEqual(out, records);
    // on disk it's newline-delimited, not one JSON array
    const raw = readFileSync(join(base, 'chunks.json'), 'utf-8');
    assert.equal(raw.trim().split('\n').length, 3);
  });

  it('reads a legacy single-array file element-by-element', async () => {
    const s = new FsBlobStore(base);
    writeFileSync(join(base, 'legacy.json'), JSON.stringify([{ id: 1 }, { id: 2 }]));
    const out: Array<{ id: number }> = [];
    for await (const r of s.iterateNdjson<{ id: number }>('legacy.json')) out.push(r);
    assert.deepEqual(out, [{ id: 1 }, { id: 2 }]);
  });

  it('iterateNdjson on a missing key yields nothing', async () => {
    const s = new FsBlobStore(base);
    const out: unknown[] = [];
    for await (const r of s.iterateNdjson('missing.json')) out.push(r);
    assert.equal(out.length, 0);
  });
});

describe('FsBlobStore — list / delete', () => {
  it('list(prefix) enumerates nested keys as POSIX paths', async () => {
    const s = new FsBlobStore(base);
    await s.putJson('repoA/profile.json', { name: 'A' });
    await s.putJson('repoB/profile.json', { name: 'B' });
    await s.putJson('top.json', { x: 1 });
    const all = (await s.list('')).sort();
    assert.deepEqual(all, ['repoA/profile.json', 'repoB/profile.json', 'top.json']);
    const scoped = (await s.list('repoA')).sort();
    assert.deepEqual(scoped, ['repoA/profile.json']);
  });

  it('delete removes a key; deletePrefix removes a subtree', async () => {
    const s = new FsBlobStore(base);
    await s.putJson('repoA/profile.json', { name: 'A' });
    await s.putJson('repoA/graph.json', { nodes: [] });
    await s.delete('repoA/profile.json');
    assert.equal(await s.exists('repoA/profile.json'), false);
    assert.equal(await s.exists('repoA/graph.json'), true);
    await s.deletePrefix('repoA');
    assert.equal(existsSync(join(base, 'repoA')), false);
  });
});

describe('FsBlobStore — byte-parity with legacy fs primitives (P0c)', () => {
  // P0c routed the indexer's chunks/index_meta/deleted_files writes through the
  // blob port. These pin the new path byte-for-byte against the exact primitives
  // it replaced, so the on-disk layout is provably unchanged.
  const chunk = (id: string): CodeChunk => ({
    id, filePath: 'r/f.ts', repoName: 'r', project: 'p', startLine: 1, endLine: 2,
    content: `body ${id}`, contextPrefix: '', contextualizedContent: `body ${id}`,
    language: 'ts', entityType: 'function', entityName: id, tokens: 3, imports: [], exports: [],
  });

  it('putNdjson === createChunkWriter, byte-for-byte', async () => {
    const chunks = [chunk('a'), chunk('b'), chunk('c')];
    const legacy = join(base, 'legacy.json');
    const w = createChunkWriter(legacy);
    for (const c of chunks) w.write(c);
    w.close();

    await new FsBlobStore(base).putNdjson('chunks.json', chunks);
    assert.equal(readFileSync(join(base, 'chunks.json'), 'utf-8'), readFileSync(legacy, 'utf-8'));
  });

  it('putJson === JSON.stringify(x, null, 2) (index_meta path)', async () => {
    const meta = { lastIndexedSha: 'deadbeef', lastIndexedAt: '2026-01-01T00:00:00Z', chunkCount: 7 };
    await new FsBlobStore(base).putJson('repoA/index_meta.json', meta);
    assert.equal(readFileSync(join(base, 'repoA', 'index_meta.json'), 'utf-8'), JSON.stringify(meta, null, 2));
  });

  it('putText(JSON.stringify(x)) === compact writeFileSync (deleted_files path)', async () => {
    const stale = [{ repoName: 'r', filePath: 'a.ts' }, { repoName: 'r', filePath: 'b.ts' }];
    await new FsBlobStore(base).putText('deleted_files.json', JSON.stringify(stale));
    assert.equal(readFileSync(join(base, 'deleted_files.json'), 'utf-8'), JSON.stringify(stale));
  });
});

describe('resolveStorage — defaults reproduce today’s wiring', () => {
  it('with no config: fs blobs at getKnowledgeBasePath, lance vectors, sqlite graph thunk', async () => {
    const project = `kc-resolve-${randomBytes(4).toString('hex')}`;
    const bundle = resolveStorage(project);
    assert.equal(bundle.basePath, getKnowledgeBasePath(project));
    assert.equal(typeof bundle.vectors.vectorSearch, 'function');
    assert.equal(typeof bundle.blobs.getJson, 'function');
    // graph is a thunk; returns null when no graph has been built yet
    assert.equal(await bundle.graph(), null);
  });

  it('storage.blob.basePath overrides the base directory', () => {
    const bundle = resolveStorage('p', {
      embedding: { provider: 'openai' },
      chunking: { maxTokens: 500, contextEnrichment: 'structural' },
      retrieval: { maxChunks: 8, maxTokens: 12000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 }, reranker: 'none' },
      autoIndex: true,
      storage: { blob: { backend: 'fs', basePath: base } },
    });
    assert.equal(bundle.basePath, base);
  });

  it('rejects a not-yet-implemented backend with a clear error', () => {
    const cfg = {
      embedding: { provider: 'openai' as const },
      chunking: { maxTokens: 500, contextEnrichment: 'structural' as const },
      retrieval: { maxChunks: 8, maxTokens: 12000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 }, reranker: 'none' as const },
      autoIndex: true,
      storage: { blob: { backend: 's3' as const } },
    };
    assert.throws(() => resolveStorage('p', cfg), /not implemented yet/);
  });
});

describe('P1 — S3/MinIO vector resolution', () => {
  const cfg = (storage: unknown) => ({
    embedding: { provider: 'openai' as const },
    chunking: { maxTokens: 500, contextEnrichment: 'structural' as const },
    retrieval: { maxChunks: 8, maxTokens: 12000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 }, reranker: 'none' as const },
    autoIndex: true,
    storage,
  });

  it('lanceStorageOptions maps config knobs to object_store keys (creds stay in env)', () => {
    assert.equal(lanceStorageOptions(undefined), undefined);
    assert.deepEqual(
      lanceStorageOptions({ endpoint: 'http://minio:9000', region: 'us-east-1', virtualHostedStyle: false, allowHttp: true }),
      { aws_endpoint: 'http://minio:9000', aws_region: 'us-east-1', aws_virtual_hosted_style_request: 'false', allow_http: 'true' },
    );
    assert.deepEqual(lanceStorageOptions({ region: 'r' }), { aws_region: 'r' });
  });

  it('resolveStorage builds an s3-pointed vector store; blob base stays fs', () => {
    const bundle = resolveStorage('p', cfg({
      vector: { backend: 'lancedb', lancedb: { uri: 's3://bucket/p/lancedb', s3: { endpoint: 'http://minio:9000', region: 'r', virtualHostedStyle: false, allowHttp: true } } },
    }) as never);
    assert.equal(typeof bundle.vectors.vectorSearch, 'function'); // constructed, no fs touch
    assert.equal(bundle.basePath, getKnowledgeBasePath('p')); // blob base independent of vector uri
  });

  it('rejects mongo vectors with a clear error', () => {
    assert.throws(() => resolveStorage('p', cfg({ vector: { backend: 'mongo' } }) as never), /not implemented yet/);
  });
});

describe('P1b — LanceDB in-RAM cache budget (storage.cache)', () => {
  const GiB = 1024 ** 3;
  const cfg = (storage: unknown) => ({
    embedding: { provider: 'openai' as const },
    chunking: { maxTokens: 500, contextEnrichment: 'structural' as const },
    retrieval: { maxChunks: 8, maxTokens: 12000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 }, reranker: 'none' as const },
    autoIndex: true,
    storage,
  });

  it('no cache / mode:none / missing maxBytes ⇒ undefined (LanceDB defaults, today)', () => {
    assert.equal(lanceCacheBudget(undefined), undefined);
    assert.equal(lanceCacheBudget({ mode: 'none', maxBytes: GiB }), undefined);
    assert.equal(lanceCacheBudget({ mode: 'ram' }), undefined); // no maxBytes to size from
    assert.equal(lanceCacheBudget({ maxBytes: 0 }), undefined);
    assert.equal(lanceCacheBudget({ maxBytes: -5 }), undefined);
  });

  it('mode:ram splits maxBytes across index + metadata, total ≤ maxBytes', () => {
    const b = lanceCacheBudget({ mode: 'ram', maxBytes: GiB })!;
    assert.ok(b);
    assert.equal(b.indexCacheBytes + b.metadataCacheBytes, GiB);
    assert.ok(b.indexCacheBytes > b.metadataCacheBytes, 'index cache is the dominant slice');
    assert.equal(b.metadataCacheBytes, GiB * 0.25); // 25% under the 1 GiB cap
  });

  it('metadata slice is capped at 1 GiB for large budgets', () => {
    const b = lanceCacheBudget({ maxBytes: 8 * GiB })!; // default mode (read-through→ram)
    assert.equal(b.metadataCacheBytes, GiB); // capped, not 2 GiB
    assert.equal(b.indexCacheBytes, 7 * GiB);
  });

  it("mode:'read-through' is treated as 'ram' (no disk fragment cache in the binding)", () => {
    assert.deepEqual(
      lanceCacheBudget({ mode: 'read-through', maxBytes: GiB }),
      lanceCacheBudget({ mode: 'ram', maxBytes: GiB }),
    );
  });

  it('resolveStorage builds a vector store when storage.cache is set (no throw, blob base unaffected)', () => {
    const bundle = resolveStorage('p', cfg({
      vector: { backend: 'lancedb', lancedb: { uri: 's3://bucket/p/lancedb' } },
      cache: { dir: '/var/cache/code-search', maxBytes: 2 * GiB, mode: 'ram' },
    }) as never);
    assert.equal(typeof bundle.vectors.vectorSearch, 'function');
    assert.equal(bundle.basePath, getKnowledgeBasePath('p'));
  });
});

describe('P1c — IVF_PQ index config resolution', () => {
  const cfg = (storage: unknown) => ({
    embedding: { provider: 'openai' as const },
    chunking: { maxTokens: 500, contextEnrichment: 'structural' as const },
    retrieval: { maxChunks: 8, maxTokens: 12000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 }, reranker: 'none' as const },
    autoIndex: true,
    storage,
  });

  it('threads storage.vector.lancedb.index into a constructed vector store (no throw)', () => {
    const bundle = resolveStorage('p', cfg({
      vector: { backend: 'lancedb', lancedb: {
        uri: 's3://bucket/p/lancedb',
        index: { type: 'ivf_pq', numPartitions: 64, numSubVectors: 96, minRows: 5000, nprobes: 20, refineFactor: 10 },
      } },
    }) as never);
    assert.equal(typeof bundle.vectors.ensureVectorIndex, 'function');
    assert.equal(typeof bundle.vectors.vectorSearch, 'function');
  });

  it('omitting index leaves the vector store at flat/exact (still constructs)', () => {
    const bundle = resolveStorage('p', cfg({ vector: { backend: 'lancedb' } }) as never);
    assert.equal(typeof bundle.vectors.ensureVectorIndex, 'function');
  });
});
