/**
 * Graph tools over the SQLite system graph buildKB writes: cross-repo evidence
 * and workspace edges, symmetric dependents, full-id / exact / fuzzy symbol
 * resolution, relation-typed callers, regex search_graph, get_repo_graph
 * edges, multi-hop entity impact, hunk-precise detect_changes (incl. deleted
 * files), and same-file references in find_dead_code.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  createSystemGraphSqliteWriter,
  invalidateRetriever,
  type CrossRepoEdge,
  type GraphifyOutput,
} from '@esankhan3/anvil-knowledge-core';

import { handleGraphTool } from '../tools/graph.js';
import type { ServerContext } from '../server.js';

const PROJECT = 'gts';
let tmp = '';
let ws = '';
let headSha = '';
let stashDataDir: string | undefined;

function ctx(directoryPath: string | null = null): ServerContext {
  return {
    projectName: PROJECT,
    directoryPath,
    indexReady: true,
    startedAt: 0,
    indexing: {
      status: 'idle', phase: null, message: null, percent: 0,
      startedAt: null, error: null, lastSuccess: null, lastDurationMs: 0, history: [],
    },
  };
}

const text = (r: any): string => r?.content?.[0]?.text ?? '';
const call = (name: string, args: Record<string, unknown>, c = ctx()) => handleGraphTool(name, args, c);

const SERVER_TS = [
  "import express from 'express';",
  'const app = express();',
  'export async function getOrderById(req: any, res: any) {',
  '  res.json({ id: req.params.id });',
  '}',
  'export function listOrders(req: any, res: any) {',
  '  res.json([]);',
  '}',
  'export function publishOrderCreated(order: any) {',
  '  return order;',
  '}',
  "app.get('/api/orders/:id', getOrderById);",
  "app.get('/api/orders', listOrders);",
].join('\n') + '\n';
const REFUNDS_TS = 'export function refund(id: string) {\n  return id;\n}\n';

const mod = (file: string) => ({ id: file, label: file.split('/').pop(), type: 'module', file });
const ent = (file: string, name: string, type = 'function') => ({ id: `${file}::${name}`, label: name, type, file });
const contains = (file: string, name: string) => ({ source: file, target: `${file}::${name}`, type: 'contains', confidence: 1 });
const rel = (s: string, t: string, type: string, confidence = 0.9) => ({ source: s, target: t, type, confidence });

const ORDERS: GraphifyOutput = {
  nodes: [
    mod('src/server.ts'), ent('src/server.ts', 'getOrderById'), ent('src/server.ts', 'listOrders'), ent('src/server.ts', 'publishOrderCreated'),
    mod('src/models.ts'), ent('src/models.ts', 'LineItem', 'interface'), ent('src/models.ts', 'Order', 'class'), ent('src/models.ts', 'total', 'method'),
    mod('src/checkout.ts'), ent('src/checkout.ts', 'checkoutHandler'),
    mod('src/cart.ts'), ent('src/cart.ts', 'cartTotal'),
    mod('src/refunds.ts'), ent('src/refunds.ts', 'refund'),
    mod('src/pipeline/chainA.ts'), ent('src/pipeline/chainA.ts', 'startPipeline'),
    mod('src/pipeline/chainB.ts'), ent('src/pipeline/chainB.ts', 'stepTwo'),
    mod('src/pipeline/stepThree.ts'), ent('src/pipeline/stepThree.ts', 'stepThree'),
  ],
  links: [
    contains('src/server.ts', 'getOrderById'), contains('src/server.ts', 'listOrders'), contains('src/server.ts', 'publishOrderCreated'),
    contains('src/models.ts', 'LineItem'), contains('src/models.ts', 'Order'),
    { source: 'src/models.ts::Order', target: 'src/models.ts::total', type: 'contains', confidence: 1 },
    contains('src/checkout.ts', 'checkoutHandler'), contains('src/cart.ts', 'cartTotal'), contains('src/refunds.ts', 'refund'),
    contains('src/pipeline/chainA.ts', 'startPipeline'), contains('src/pipeline/chainB.ts', 'stepTwo'), contains('src/pipeline/stepThree.ts', 'stepThree'),
    rel('src/pipeline/chainA.ts::startPipeline', 'src/pipeline/chainB.ts::stepTwo', 'calls'),
    rel('src/pipeline/chainB.ts::stepTwo', 'src/pipeline/stepThree.ts::stepThree', 'calls'),
    rel('src/pipeline/chainA.ts', 'src/pipeline/chainB.ts', 'imports', 1),
    rel('src/pipeline/chainA.ts', 'src/pipeline/chainB.ts::stepTwo', 'uses', 0.95),
    rel('src/server.ts::getOrderById', 'src/models.ts::LineItem', 'type-ref', 0.85),
    rel('src/cart.ts::cartTotal', 'src/checkout.ts::checkoutHandler', 'calls'),
    rel('src/checkout.ts::checkoutHandler', 'src/server.ts::getOrderById', 'calls'),
    rel('src/checkout.ts::checkoutHandler', 'src/refunds.ts::refund', 'calls'),
    rel('src/checkout.ts', 'src/refunds.ts', 'imports', 1),
  ],
};
const WEB: GraphifyOutput = { nodes: [mod('src/api/orders.ts'), ent('src/api/orders.ts', 'fetchOrder')], links: [contains('src/api/orders.ts', 'fetchOrder')] };
const ANALYTICS: GraphifyOutput = { nodes: [mod('consumer.py'), ent('consumer.py', 'consume')], links: [contains('consumer.py', 'consume')] };
const MONO: GraphifyOutput = {
  nodes: [{ id: 'pkg::@m/a', label: '@m/a', type: 'package', file: 'packages/a' }, { id: 'pkg::@m/b', label: '@m/b', type: 'package', file: 'packages/b' }],
  links: [],
};
const CROSS: CrossRepoEdge[] = [
  {
    sourceRepo: 'web-app', sourceNode: 'src/api/orders.ts::/api/orders/:param', targetRepo: 'orders-svc', targetNode: 'src/server.ts::/api/orders/:param',
    edgeType: 'http', evidence: 'API endpoint: /api/orders/:param', confidence: 0.8,
  },
  {
    sourceRepo: 'analytics-py', sourceNode: 'consumer.py::order-created', targetRepo: 'orders-svc', targetNode: 'src/server.ts::order-created',
    edgeType: 'event-schema', evidence: 'Shared event/topic: order-created', confidence: 0.85,
  },
  {
    sourceRepo: 'mono', sourceNode: 'pkg::@m/a', targetRepo: 'mono', targetNode: 'pkg::@m/b',
    edgeType: 'workspace-dep', evidence: '@m/a depends on @m/b (packages/a/package.json)', confidence: 1,
  },
];

function chunk(filePath: string, startLine: number, endLine: number, entityName: string | undefined, content: string) {
  return { id: `${filePath}:${startLine}`, repoName: 'orders-svc', filePath, startLine, endLine, entityName, content, language: 'typescript' };
}
const serverLines = SERVER_TS.split('\n');
const lines = (a: number, b: number) => serverLines.slice(a - 1, b).join('\n');
const CHUNKS = [
  chunk('src/server.ts', 1, 2, undefined, lines(1, 2)),
  chunk('src/server.ts', 3, 5, 'getOrderById', lines(3, 5)),
  chunk('src/server.ts', 6, 8, 'listOrders', lines(6, 8)),
  chunk('src/server.ts', 9, 13, 'publishOrderCreated', lines(9, 13)),
  chunk('src/refunds.ts', 1, 3, 'refund', REFUNDS_TS.trimEnd()),
];

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

before(async () => {
  stashDataDir = process.env.CODE_SEARCH_DATA_DIR;
  tmp = mkdtempSync(join(tmpdir(), 'cs-gts-'));
  process.env.CODE_SEARCH_DATA_DIR = tmp;
  const kb = join(tmp, PROJECT);
  mkdirSync(join(kb, 'orders-svc'), { recursive: true });
  const w = await createSystemGraphSqliteWriter(kb);
  assert.ok(w, 'no sqlite driver');
  for (const [name, g] of [['orders-svc', ORDERS], ['web-app', WEB], ['analytics-py', ANALYTICS], ['mono', MONO]] as const) w.addRepoGraph(name, g);
  w.addCrossRepoEdges(CROSS);
  w.finalize();
  writeFileSync(join(kb, 'orders-svc', 'graph.json'), JSON.stringify(ORDERS));
  writeFileSync(join(kb, 'chunks.json'), CHUNKS.map((c) => JSON.stringify(c)).join('\n') + '\n');

  ws = mkdtempSync(join(tmpdir(), 'cs-gts-ws-'));
  const repo = join(ws, 'orders-svc');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'server.ts'), SERVER_TS);
  writeFileSync(join(repo, 'src', 'refunds.ts'), REFUNDS_TS);
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  headSha = git(repo, 'rev-parse', 'HEAD');
});

after(async () => {
  await invalidateRetriever();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
  if (stashDataDir === undefined) delete process.env.CODE_SEARCH_DATA_DIR;
  else process.env.CODE_SEARCH_DATA_DIR = stashDataDir;
});

describe('get_cross_repo_edges', () => {
  it('names the evidence behind each edge', async () => {
    const t = text(await call('get_cross_repo_edges', { repo: 'web-app' }));
    assert.match(t, /web-app → orders-svc \(http\).*API endpoint: \/api\/orders\/:param/);
  });

  it('lists same-repo workspace-dep edges in their own section', async () => {
    const t = text(await call('get_cross_repo_edges', {}));
    assert.match(t, /## Within a repo/);
    assert.match(t, /mono: @m\/a → @m\/b \(workspace-dep\).*@m\/a depends on @m\/b/);
  });
});

describe('impact_analysis', () => {
  it('counts the other side of a symmetric edge as a dependent', async () => {
    const t = text(await call('impact_analysis', { repo: 'analytics-py', file: 'consumer.py' }));
    assert.match(t, /Affected repos: orders-svc/);
  });

  it('entity scope: file-level cross-repo dependents + multi-hop callers', async () => {
    const t = text(await call('impact_analysis', { repo: 'orders-svc', file: 'src/server.ts', entity: 'getOrderById' }));
    assert.match(t, /checkoutHandler/);              // hop 1
    assert.match(t, /cartTotal/);                    // hop 2 (default depth 2)
    assert.match(t, /web-app.*file-level/);          // http endpoint in the same file
    assert.match(t, /Affected repos: .*web-app/);
    const shallow = text(await call('impact_analysis', { repo: 'orders-svc', file: 'src/server.ts', entity: 'getOrderById', depth: 1 }));
    assert.doesNotMatch(shallow, /cartTotal/);
  });

  it('accepts the full id as entity', async () => {
    const t = text(await call('impact_analysis', { repo: 'orders-svc', file: 'src/server.ts', entity: 'orders-svc::src/server.ts::getOrderById' }));
    assert.match(t, /checkoutHandler/);
  });

  it('a file with no graph nodes is an error, not an empty report', async () => {
    const r: any = await call('impact_analysis', { repo: 'orders-svc', file: 'src/nope.ts' });
    assert.equal(r.isError, true);
    assert.match(text(r), /No graph nodes/);
  });
});

describe('symbol resolution', () => {
  it('trace_path accepts a full repo::file::entity id', async () => {
    const t = text(await call('trace_path', { from: 'orders-svc::src/pipeline/chainA.ts::startPipeline', to: 'stepThree' }));
    assert.match(t, /2 hops/);
  });

  it('exact names are literal: "%" matches nothing', async () => {
    assert.match(text(await call('find_callers', { function: '%' })), /No entity found/);
  });

  it('fuzzy trace_path matches symbol names, never a 0-hop file match', async () => {
    const t = text(await call('trace_path', { from: 'Pipeline', to: 'Three', fuzzy: true }));
    assert.match(t, /2 hops/);
    assert.doesNotMatch(t, /0 hops/);
  });
});

describe('relation-typed traversal', () => {
  it('find_callers returns call edges only by default', async () => {
    const t = text(await call('find_callers', { function: 'stepTwo' }));
    assert.match(t, /startPipeline/);
    assert.doesNotMatch(t, /chainA\.ts`/); // the module's `uses` edge is not a call
  });

  it('other relations are named, and listed on request', async () => {
    const t = text(await call('find_callers', { function: 'LineItem' }));
    assert.match(t, /no callers/i);
    assert.match(t, /type-ref/);
    const typed = text(await call('find_callers', { function: 'LineItem', relations: ['type-ref'] }));
    assert.match(typed, /## type-ref \(1\)[\s\S]*getOrderById/);
  });

  it('find_dependencies defaults to calls', async () => {
    const t = text(await call('find_dependencies', { function: 'checkoutHandler' }));
    assert.match(t, /getOrderById/);
    assert.match(t, /refund/);
  });
});

describe('search_graph', () => {
  it('name is a regex over symbol names', async () => {
    const t = text(await call('search_graph', { name: '^step.*$' }));
    assert.match(t, /stepTwo/);
    assert.match(t, /stepThree/);
    assert.doesNotMatch(t, /\(module/);
  });

  it('type filter matches any node type the graph has', async () => {
    assert.match(text(await call('search_graph', { type: 'method' })), /`total`/);
  });

  it('rejects an invalid regex', async () => {
    const r: any = await call('search_graph', { name: '(' });
    assert.equal(r.isError, true);
    assert.match(text(r), /Invalid regex/);
  });
});

describe('get_repo_graph', () => {
  it('lists edges, bounded by limit', async () => {
    const t = text(await call('get_repo_graph', { repo: 'orders-svc', limit: 2 }));
    assert.match(t, /## Edges/);
    assert.match(t, /startPipeline` → `src\/pipeline\/chainB\.ts::stepTwo` \(calls\)/);
    assert.equal((t.split('## Edges')[1].match(/^- /gm) ?? []).length, 2);
  });

  it('validates repo', async () => {
    const missing: any = await call('get_repo_graph', {});
    assert.equal(missing.isError, true);
    const unknown: any = await call('get_repo_graph', { repo: 'nope' });
    assert.equal(unknown.isError, true);
  });
});

describe('find_dead_code', () => {
  it('does not flag a function referenced elsewhere in its file', async () => {
    const t = text(await call('find_dead_code', { repo: 'orders-svc' }));
    assert.match(t, /publishOrderCreated/);
    assert.doesNotMatch(t, /listOrders/); // passed to app.get(...)
  });
});

describe('detect_changes', () => {
  it('reports only the entities whose lines changed', async () => {
    const repo = join(ws, 'orders-svc');
    writeFileSync(join(repo, 'src', 'server.ts'), SERVER_TS.replace('res.json({ id: req.params.id });', 'res.json({ id: Number(req.params.id) });'));
    try {
      const t = text(await call('detect_changes', { repo: 'orders-svc', baseSha: headSha }, ctx(ws)));
      const affected = t.split('## Affected entities')[1].split('##')[0];
      assert.match(affected, /getOrderById/);
      assert.doesNotMatch(affected, /listOrders|publishOrderCreated/);
      assert.match(t, /checkoutHandler/);
    } finally {
      git(repo, 'checkout', '--', '.');
    }
  });

  it('reports deleted files, their entities and dependents', async () => {
    const repo = join(ws, 'orders-svc');
    git(repo, 'rm', '-q', 'src/refunds.ts');
    try {
      const t = text(await call('detect_changes', { repo: 'orders-svc', baseSha: headSha }, ctx(ws)));
      assert.match(t, /Deleted files: 1[\s\S]*src\/refunds\.ts/);
      assert.match(t.split('## Affected entities')[1], /refund/);
      assert.match(t, /checkoutHandler` → `orders-svc::src\/refunds\.ts::refund/);
    } finally {
      git(repo, 'reset', '-q', '--hard');
    }
  });
});
