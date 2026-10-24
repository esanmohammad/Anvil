/**
 * Retriever graph expansion over the SQLite system graph: a seed's one-hop
 * neighbours become chunk lookups. A hub seed is read up to a per-seed row
 * limit (not its thousands of callers); a seed with normal fan-out expands
 * to exactly its neighbours, in neighbour order.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { HybridRetriever, createSystemGraphSqliteWriter, openSystemGraphStore } from '@esankhan3/anvil-knowledge-core';
import type { CodeChunk, EmbeddingProvider, GraphStore, ScoredChunk } from '@esankhan3/anvil-knowledge-core';

const root = join(tmpdir(), `kc-expand-${randomBytes(6).toString('hex')}`);
const HUB_CALLERS = 1000;

function chunk(filePath: string, entityName: string): CodeChunk {
  return {
    id: `${filePath}::${entityName}`, filePath, repoName: 'r', project: 'p', startLine: 1, endLine: 2,
    content: entityName, contextPrefix: '', contextualizedContent: entityName, language: 'ts',
    entityType: 'function', entityName, tokens: 3, imports: [], exports: [],
  };
}

let store: GraphStore;
before(async () => {
  mkdirSync(root, { recursive: true });
  const fn = (file: string, name: string) => ({ id: `${file}::${name}`, label: name, type: 'function', file });
  const calls = (s: string, t: string) => ({ source: s, target: t, type: 'calls', confidence: 0.9 });
  const nodes = [fn('hub.ts', 'hub'), fn('leaf.ts', 'leaf')];
  const links: Array<ReturnType<typeof calls>> = [];
  for (let i = 0; i < 3; i++) { nodes.push(fn('deps.ts', `d${i}`)); links.push(calls('hub.ts::hub', `deps.ts::d${i}`)); }
  for (let i = 0; i < HUB_CALLERS; i++) { nodes.push(fn('callers.ts', `c${i}`)); links.push(calls(`callers.ts::c${i}`, 'hub.ts::hub')); }
  links.push(calls('leaf.ts::leaf', 'deps.ts::d0'), calls('leaf.ts::leaf', 'deps.ts::d1'), calls('callers.ts::c0', 'leaf.ts::leaf'), calls('callers.ts::c1', 'leaf.ts::leaf'));
  const w = await createSystemGraphSqliteWriter(root);
  assert.ok(w, 'no sqlite driver');
  w.addRepoGraph('r', { nodes, links });
  w.finalize();
  const s = await openSystemGraphStore(root);
  assert.ok(s);
  store = s;
});
after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

/** Chunk lookups the expansion asks the vector store for, seeded by `seed`. */
async function expansionLookups(seed: CodeChunk): Promise<string[]> {
  const lookups: string[] = [];
  const vectorStore = {
    vectorSearch: async (): Promise<ScoredChunk[]> => [{ chunk: seed, score: 1, source: 'vector' }],
    searchByEntitySubstring: async (): Promise<ScoredChunk[]> => [],
    searchByEntityName: async (): Promise<ScoredChunk[]> => [],
    phraseSearch: async (): Promise<ScoredChunk[]> => [],
    getChunksByEntity: async (ls: Array<{ filePath: string; entityName?: string }>): Promise<ScoredChunk[]> => {
      lookups.push(...ls.map((l) => `${l.filePath}::${l.entityName}`));
      return [];
    },
  } as any;
  const embedder = { name: 'expansion-stub', dimensions: 3, embed: async (t: string[]) => t.map(() => [1, 0, 0]), embedSingle: async () => [1, 0, 0] } as unknown as EmbeddingProvider;
  const r = new HybridRetriever(vectorStore, embedder, store, { maxChunks: 8, maxTokens: 12000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 } });
  await r.retrieve(seed.entityName!, { mode: 'vector+graph' });
  return lookups;
}

describe('retriever graph expansion', () => {
  it('reads a hub seed up to the per-seed row limit, not all its callers', async () => {
    const lookups = await expansionLookups(chunk('hub.ts', 'hub'));
    assert.ok(lookups.length > 0 && lookups.length <= 100, `${lookups.length} lookups`);
    for (const d of ['deps.ts::d0', 'deps.ts::d1', 'deps.ts::d2']) assert.ok(lookups.includes(d), `${d} kept`);
  });

  it('expands a normal seed to exactly its neighbours, in order', async () => {
    const lookups = await expansionLookups(chunk('leaf.ts', 'leaf'));
    assert.deepEqual(lookups, store.neighborsOf('r::leaf.ts::leaf', 'both').map((k) => k.split('::').slice(1).join('::')));
    assert.equal(lookups.length, 4);
  });
});
