/**
 * Graph traversals over the SQLite system graph: trace_path's shortest path
 * agrees with a plain BFS on small random graphs (direction, relations, the
 * confidence filter, maxDepth), and every traversal stays inside its budget on
 * a high-fan-out graph — node cap and wall clock — and says so instead of
 * answering "No path" or reporting a partial count as exact. A fuzzy name
 * resolves to at most FUZZY_CAP start nodes (saying so), and a term under 3
 * characters is matched exactly.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSystemGraphSqliteWriter, getGraphStore, invalidateRetriever } from '@esankhan3/anvil-knowledge-core';

import { handleGraphTool } from '../tools/graph.js';
import type { ServerContext } from '../server.js';

// Mirrors TRAVERSAL_MAX_NODES / FUZZY_MATCH_CAP in tools/graph.ts.
const MAX_NODES = 50_000;
const FUZZY_CAP = 200;

let tmp = '';
let stashDataDir: string | undefined;

function ctx(projectName: string): ServerContext {
  return {
    projectName,
    directoryPath: null,
    indexReady: true,
    startedAt: 0,
    indexing: {
      status: 'idle', phase: null, message: null, percent: 0,
      startedAt: null, error: null, lastSuccess: null, lastDurationMs: 0, history: [],
    },
  };
}

const text = (r: any): string => r?.content?.[0]?.text ?? '';
const call = async (project: string, name: string, args: Record<string, unknown>) => text(await handleGraphTool(name, args, ctx(project)));

interface Edge { s: string; t: string; type: string; confidence: number }
const key = (name: string, file = 'f.ts') => `r::${file}::${name}`;

async function writeGraph(project: string, nodes: Array<{ name: string; file?: string }>, edges: Edge[], fileOf = (_n: string) => 'f.ts'): Promise<void> {
  const kb = join(tmp, project);
  mkdirSync(kb, { recursive: true });
  const w = await createSystemGraphSqliteWriter(kb);
  assert.ok(w, 'no sqlite driver');
  w.addRepoGraph('r', {
    nodes: nodes.map((n) => ({ id: `${n.file ?? 'f.ts'}::${n.name}`, label: n.name, type: 'function', file: n.file ?? 'f.ts' })),
    links: edges.map((e) => ({ source: `${fileOf(e.s)}::${e.s}`, target: `${fileOf(e.t)}::${e.t}`, type: e.type, confidence: e.confidence })),
  });
  w.finalize();
}

/** Count the distinct nodes the store hands back to neighbour queries, and
 *  run `onRead` after each query. Wraps the cached instance the tools use. */
async function instrument(project: string, methods: string[], onRead: () => void = () => {}) {
  const store: any = await getGraphStore(project);
  const nodes = new Set<string>();
  for (const m of methods) {
    const orig = store[m];
    if (typeof orig !== 'function') continue;
    store[m] = (...a: any[]) => {
      const r = orig.apply(store, a);
      if (Array.isArray(r)) for (const x of r) for (const k of Array.isArray(x) ? x : [x]) nodes.add(k);
      onRead();
      return r;
    };
  }
  return { nodes, restore: () => { for (const m of methods) delete store[m]; } };
}

/** Advance Date.now by a minute from the next call on — the wall-clock budget runs out. */
function expireClock(): () => void {
  const real = Date.now;
  Date.now = () => real() + 60_000;
  return () => { Date.now = real; };
}

before(() => {
  stashDataDir = process.env.CODE_SEARCH_DATA_DIR;
  tmp = mkdtempSync(join(tmpdir(), 'cs-trav-'));
  process.env.CODE_SEARCH_DATA_DIR = tmp;
});

after(async () => {
  await invalidateRetriever();
  rmSync(tmp, { recursive: true, force: true });
  if (stashDataDir === undefined) delete process.env.CODE_SEARCH_DATA_DIR;
  else process.env.CODE_SEARCH_DATA_DIR = stashDataDir;
});

// ---------------------------------------------------------------------------
// Correctness — small graphs
// ---------------------------------------------------------------------------

/** mulberry32 — seeded so a failure reproduces. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Edges trace_path may follow: confidence ≥ 0.7, of `types` (null = all). */
function steps(edges: Edge[], direction: string, types: string[] | null): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a)!.add(b); };
  for (const e of edges) {
    if (e.confidence < 0.7 || (types && !types.includes(e.type))) continue;
    if (direction !== 'callers') add(e.s, e.t);
    if (direction !== 'callees') add(e.t, e.s);
  }
  return adj;
}

/** Reference: hops of the shortest path from → to (≥ 1 hop, to ≠ from) by a plain one-sided BFS, or null. */
function bfsHops(adj: Map<string, Set<string>>, from: string, to: string): number | null {
  if (from === to) return null;
  const dist = new Map([[from, 0]]);
  let frontier = [from];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const k of frontier) {
      for (const n of adj.get(k) ?? []) {
        if (dist.has(n)) continue;
        dist.set(n, dist.get(k)! + 1);
        if (n === to) return dist.get(n)!;
        next.push(n);
      }
    }
    frontier = next;
  }
  return null;
}

const pathKeys = (t: string): string[] => [...t.matchAll(/^- `([^`]+)`$/gm)].map((m) => m[1]);

describe('trace_path — shortest path', () => {
  it('matches a plain BFS on random graphs: hop count, a real path, maxDepth', async () => {
    const rand = rng(7);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
    let paths = 0;
    let none = 0;
    for (let g = 0; g < 25; g++) {
      const n = 8 + Math.floor(rand() * 20);
      const names = Array.from({ length: n }, (_, i) => `n${i}`);
      const edges: Edge[] = Array.from({ length: Math.floor(n * (1 + rand() * 1.5)) }, () => ({
        s: pick(names), t: pick(names), type: rand() < 0.75 ? 'calls' : 'imports', confidence: rand() < 0.85 ? 0.9 : 0.5,
      }));
      const project = `rnd${g}`;
      await writeGraph(project, names.map((name) => ({ name })), edges);
      for (let q = 0; q < 16; q++) {
        const from = pick(names);
        const to = pick(names);
        const direction = pick(['callees', 'callers', 'both']);
        const relations = pick<string[] | undefined>([undefined, ['imports'], ['all']]);
        const maxDepth = 1 + Math.floor(rand() * 6);
        const adj = steps(edges, direction, relations === undefined ? ['calls'] : relations[0] === 'all' ? null : relations);
        const want = bfsHops(adj, from, to);
        const t = await call(project, 'trace_path', { from: key(from), to: key(to), direction, maxDepth, ...(relations ? { relations } : {}) });
        const label = `${project}: ${from} → ${to} (${direction}, ${relations ?? 'calls'}, maxDepth ${maxDepth})\n${t}`;
        if (want === null || want > maxDepth) {
          assert.match(t, new RegExp(`^No path from .* within ${maxDepth} hops`), label);
          none++;
          continue;
        }
        assert.equal(Number(/^# Path \((\d+) hops\)/.exec(t)?.[1]), want, label);
        const keys = pathKeys(t);
        assert.equal(keys.length, want + 1, label);
        assert.equal(keys[0], key(from), label);
        assert.equal(keys[keys.length - 1], key(to), label);
        for (let i = 1; i < keys.length; i++) {
          assert.ok(adj.get(keys[i - 1].split('::')[2])?.has(keys[i].split('::')[2]), `no step ${keys[i - 1]} → ${keys[i]} in ${label}`);
        }
        paths++;
      }
    }
    assert.ok(paths >= 60 && none >= 60, `sample covers both outcomes (${paths} paths, ${none} none)`);
  });

  it('picks the shorter of two routes and honours maxDepth exactly', async () => {
    const e = (s: string, t: string): Edge => ({ s, t, type: 'calls', confidence: 0.9 });
    await writeGraph('routes', ['a', 'b', 'c', 'd', 'e', 'x', 'y'].map((name) => ({ name })), [
      e('a', 'b'), e('b', 'c'), e('c', 'd'), e('d', 'e'), // 4 hops
      e('a', 'x'), e('x', 'y'), e('y', 'e'),              // 3 hops
    ]);
    const t = await call('routes', 'trace_path', { from: 'a', to: 'e' });
    assert.match(t, /# Path \(3 hops\)\n\na → x → y → e/);
    assert.match(await call('routes', 'trace_path', { from: 'a', to: 'e', maxDepth: 3 }), /3 hops/);
    assert.match(await call('routes', 'trace_path', { from: 'a', to: 'e', maxDepth: 2 }), /^No path from "a" to "e" within 2 hops/);
    assert.match(await call('routes', 'trace_path', { from: 'e', to: 'a', direction: 'callers' }), /# Path \(3 hops\)\n\ne ← y ← x ← a/);
    assert.match(await call('routes', 'trace_path', { from: 'e', to: 'a' }), /^No path from "e" to "a"/);
  });
});

// ---------------------------------------------------------------------------
// Budget — a high-fan-out graph
// ---------------------------------------------------------------------------

describe('traversal budget on a high-fan-out graph', () => {
  // src → 250 children → 250 grandchildren each (62,500), every grandchild →
  // sink (in sink.ts); dst ← 250 callers. src and dst are not connected.
  const FAN = 250;
  before(async () => {
    const nodes: Array<{ name: string; file?: string }> = [{ name: 'src' }, { name: 'dst' }, { name: 'sink', file: 'sink.ts' }];
    const edges: Edge[] = [];
    const calls = (s: string, t: string) => edges.push({ s, t, type: 'calls', confidence: 0.9 });
    for (let i = 0; i < FAN; i++) {
      nodes.push({ name: `c${i}` }, { name: `k${i}` });
      calls('src', `c${i}`);
      calls(`k${i}`, 'dst');
      for (let j = 0; j < FAN; j++) {
        nodes.push({ name: `g${i}_${j}` });
        calls(`c${i}`, `g${i}_${j}`);
        calls(`g${i}_${j}`, 'sink');
      }
    }
    await writeGraph('fan', nodes, edges, (n) => (n === 'sink' ? 'sink.ts' : 'f.ts'));
  });

  it('trace_path stops at the node cap and says so instead of "No path"', async () => {
    const reads = await instrument('fan', ['neighborsOf', 'neighborEdges']);
    try {
      const t = await call('fan', 'trace_path', { from: 'src', to: 'dst', maxDepth: 10 });
      assert.match(t, /^No path from "src" to "dst" found within the traversal budget \(explored \d+ nodes, depth \d+ of 10/);
      assert.match(t, /narrow the search .* or lower maxDepth/);
      assert.ok(Number(/explored (\d+) nodes/.exec(t)?.[1]) <= MAX_NODES, t);
      assert.ok(reads.nodes.size <= MAX_NODES, `read ${reads.nodes.size} distinct nodes`);
    } finally { reads.restore(); }
  });

  it('trace_path stops when the wall-clock budget runs out', async () => {
    let restoreClock = () => {};
    let queries = 0;
    const reads = await instrument('fan', ['neighborsOf', 'neighborEdges'], () => { if (++queries === 1) restoreClock = expireClock(); });
    try {
      const t = await call('fan', 'trace_path', { from: 'src', to: 'dst', maxDepth: 10 });
      assert.match(t, /found within the traversal budget \(explored \d+ nodes, depth 1 of 10/);
      assert.equal(queries, 1);
    } finally { restoreClock(); reads.restore(); }
  });

  it('trace_path still finds a path into a hub within the budget', async () => {
    const t = await call('fan', 'trace_path', { from: 'c0', to: 'sink', maxDepth: 10 });
    assert.match(t, /# Path \(2 hops\)\n\nc0 → g0_\d+ → sink/);
  });

  it('impact_analysis caps the dependents scanned per hop and marks the count as a lower bound', async () => {
    const t = await call('fan', 'impact_analysis', { repo: 'r', file: 'sink.ts', depth: 1 });
    assert.match(t, new RegExp(`## Dependents: ${MAX_NODES}\\+ edges`));
    assert.match(t, new RegExp(`### Hop 1 \\(${MAX_NODES}\\+\\)`));
  });

  it('impact_analysis stops between hops when the wall-clock budget runs out', async () => {
    let restoreClock = () => {};
    let expired = false;
    const reads = await instrument('fan', ['dependents'], () => { if (!expired) { expired = true; restoreClock = expireClock(); } });
    try {
      const t = await call('fan', 'impact_analysis', { repo: 'r', file: 'sink.ts', depth: 3 });
      assert.match(t, /### Hop 1/);
      assert.doesNotMatch(t, /### Hop 2/);
      assert.match(t, /traversal budget/);
    } finally { restoreClock(); reads.restore(); }
  });
});

// ---------------------------------------------------------------------------
// Fuzzy resolution — bounded before the traversal starts
// ---------------------------------------------------------------------------

describe('fuzzy resolution', () => {
  // handleThing0..249 and ab, each calling sink.
  before(async () => {
    const names = [...Array.from({ length: 250 }, (_, i) => `handleThing${i}`), 'ab'];
    await writeGraph('fuzzy', [...names, 'sink'].map((name) => ({ name })), names.map((s) => ({ s, t: 'sink', type: 'calls', confidence: 0.9 })));
  });

  it('a name matching more than FUZZY_CAP symbols starts from the first FUZZY_CAP and says so', async () => {
    const store: any = await getGraphStore('fuzzy');
    const firstBatch: number[] = [];
    const orig = store.neighborEdges;
    store.neighborEdges = (keys: string[], ...rest: unknown[]) => { firstBatch.push(keys.length); return orig.call(store, keys, ...rest); };
    try {
      const t = await call('fuzzy', 'trace_path', { from: 'thing', fuzzy: true });
      assert.match(t, /^# Reachable from "thing"/);
      assert.match(t, new RegExp(`"thing" matched more than ${FUZZY_CAP} symbols — be more specific`));
      assert.equal(firstBatch[0], FUZZY_CAP);
    } finally { delete store.neighborEdges; }
    const deps = await call('fuzzy', 'find_dependencies', { function: 'Thing', fuzzy: true });
    assert.match(deps, /sink/);
    assert.match(deps, new RegExp(`matched more than ${FUZZY_CAP} symbols`));
  });

  it('no note under the cap', async () => {
    const t = await call('fuzzy', 'trace_path', { from: 'Thing1', to: 'sink', fuzzy: true }); // 111 matches
    assert.match(t, /^# Path \(1 hops\)/);
    assert.doesNotMatch(t, /matched more than/);
  });

  it('a term under 3 characters is matched exactly, and the answer says so', async () => {
    const t = await call('fuzzy', 'trace_path', { from: 'ab', to: 'sink', fuzzy: true });
    assert.match(t, /^# Path \(1 hops\)\n\nab → sink/);
    assert.match(t, /needs at least 3 characters — "ab" was matched exactly/);
    const none = await call('fuzzy', 'find_callers', { function: 'AB', fuzzy: true });
    assert.match(none, /^No entity found matching "AB"/);
    assert.match(none, /needs at least 3 characters/);
    assert.doesNotMatch(none, /Try fuzzy:true/);
  });
});
