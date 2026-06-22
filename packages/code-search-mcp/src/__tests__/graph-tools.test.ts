import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { handleGraphTool } from '../tools/graph.js';
import { handleSearchTool } from '../tools/search.js';
import type { ServerContext } from '../server.js';

const PROJECT = 'demo';
let tmp = '';
let stashDataDir: string | undefined;

function ctx(): ServerContext {
  return {
    projectName: PROJECT,
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

// system_graph_v2.json — graphology export shape.
const SYSTEM_GRAPH = {
  nodes: [
    { key: 'app::a.ts::handleRequest', attributes: { label: 'handleRequest', type: 'function', repo: 'app', file: 'a.ts' } },
    { key: 'app::a.ts::validateToken', attributes: { label: 'validateToken', type: 'function', repo: 'app', file: 'a.ts' } },
    { key: 'app::b.ts::dbQuery', attributes: { label: 'dbQuery', type: 'function', repo: 'app', file: 'b.ts' } },
    { key: 'app::a.ts::get', attributes: { label: 'get', type: 'function', repo: 'app', file: 'a.ts' } },
    { key: 'app::a.ts::getUser', attributes: { label: 'getUser', type: 'function', repo: 'app', file: 'a.ts' } },
    { key: 'app::a.ts::caller1', attributes: { label: 'caller1', type: 'function', repo: 'app', file: 'a.ts' } },
    { key: 'app::a.ts::caller2', attributes: { label: 'caller2', type: 'function', repo: 'app', file: 'a.ts' } },
  ],
  edges: [
    { source: 'app::a.ts::handleRequest', target: 'app::a.ts::validateToken', attributes: { type: 'calls', confidence: 0.9 } },
    { source: 'app::a.ts::validateToken', target: 'app::b.ts::dbQuery', attributes: { type: 'calls', confidence: 0.9 } },
    { source: 'app::a.ts::caller1', target: 'app::a.ts::get', attributes: { type: 'calls', confidence: 0.9 } },
    { source: 'app::a.ts::caller2', target: 'app::a.ts::getUser', attributes: { type: 'calls', confidence: 0.9 } },
  ],
};

// per-repo graph.json — GraphifyOutput shape.
const REPO_GRAPH = {
  nodes: [
    { id: 'app::a.ts::usedFn', label: 'usedFn', type: 'function', file: 'a.ts' },
    { id: 'app::a.ts::deadFn', label: 'deadFn', type: 'function', file: 'a.ts' },
  ],
  links: [
    { source: 'app::a.ts::caller', target: 'app::a.ts::usedFn', type: 'calls', confidence: 0.9 },
    { source: 'app::a.ts::Container', target: 'app::a.ts::deadFn', type: 'contains', confidence: 1 },
  ],
};

const CHUNKS = [
  { id: 'c1', repoName: 'app', filePath: 'a.ts', entityName: 'handleRequest', startLine: 1, endLine: 3, content: 'function handleRequest() { return 1; }', language: 'typescript' },
];

const PROJECT_GRAPH = {
  architectureSummary: 'Two services talk over HTTP.',
  repoRoles: { app: { role: 'service', criticality: 'high', responsibilities: ['serves the API'] } },
  relationships: [{ from: 'app', to: 'db', type: 'sync-http', description: 'queries the database' }],
  keyFlows: [{ name: 'login', trigger: 'POST /login', steps: [{ repo: 'app', component: 'handler', action: 'validate', protocol: 'http' }] }],
};

beforeEach(() => {
  stashDataDir = process.env.CODE_SEARCH_DATA_DIR;
  tmp = mkdtempSync(join(tmpdir(), 'cs-graph-'));
  process.env.CODE_SEARCH_DATA_DIR = tmp;
  const kb = join(tmp, PROJECT);
  mkdirSync(join(kb, 'app'), { recursive: true });
  writeFileSync(join(kb, 'system_graph_v2.json'), JSON.stringify(SYSTEM_GRAPH));
  writeFileSync(join(kb, 'app', 'graph.json'), JSON.stringify(REPO_GRAPH));
  writeFileSync(join(kb, 'chunks.json'), JSON.stringify(CHUNKS));
  writeFileSync(join(kb, 'PROJECT_GRAPH.json'), JSON.stringify(PROJECT_GRAPH));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (stashDataDir === undefined) delete process.env.CODE_SEARCH_DATA_DIR;
  else process.env.CODE_SEARCH_DATA_DIR = stashDataDir;
});

describe('trace_path', () => {
  it('finds a 2-hop call chain', async () => {
    const r = await handleGraphTool('trace_path', { from: 'handleRequest', to: 'dbQuery' }, ctx());
    const t = text(r);
    assert.match(t, /2 hops/);
    assert.match(t, /handleRequest.*validateToken.*dbQuery/s);
  });

  it('respects maxDepth', async () => {
    const r = await handleGraphTool('trace_path', { from: 'handleRequest', to: 'dbQuery', maxDepth: 1 }, ctx());
    assert.match(text(r), /No path/);
  });

  it('lists reachable callees without a target', async () => {
    const r = await handleGraphTool('trace_path', { from: 'handleRequest' }, ctx());
    const t = text(r);
    assert.match(t, /validateToken/);
    assert.match(t, /dbQuery/);
  });
});

describe('find_callers precision', () => {
  it('exact match does not treat "get" as a substring of "getUser"', async () => {
    const r = await handleGraphTool('find_callers', { function: 'get' }, ctx());
    const t = text(r);
    assert.match(t, /caller1/);          // caller of get
    assert.doesNotMatch(t, /caller2/);   // caller of getUser — must NOT appear
    assert.doesNotMatch(t, /getUser/);
  });

  it('fuzzy:true re-enables substring matching', async () => {
    const r = await handleGraphTool('find_callers', { function: 'get', fuzzy: true }, ctx());
    const t = text(r);
    assert.match(t, /caller1/);
    assert.match(t, /caller2/);          // now getUser's caller is included
  });
});

describe('find_dead_code', () => {
  it('flags zero-caller entities and ignores contains-only edges', async () => {
    const r = await handleGraphTool('find_dead_code', { repo: 'app' }, ctx());
    const t = text(r);
    assert.match(t, /deadFn/);            // only a `contains` edge → still dead
    assert.doesNotMatch(t, /\busedFn\b/); // has a real caller
  });
});

describe('get_architecture', () => {
  it('renders the project graph when present', async () => {
    const r = await handleGraphTool('get_architecture', {}, ctx());
    const t = text(r);
    assert.match(t, /Two services talk over HTTP/);
    assert.match(t, /login/);
  });

  it('degrades cleanly when no architecture data exists', async () => {
    const c = ctx();
    c.projectName = 'empty-project';
    const r = await handleGraphTool('get_architecture', {}, c);
    assert.match(text(r), /No architecture data/);
  });
});

describe('get_code_snippet', () => {
  it('returns source for a qualified id', async () => {
    const r = await handleSearchTool('get_code_snippet', { id: 'app::a.ts::handleRequest' }, ctx());
    assert.match(text(r), /function handleRequest/);
  });

  it('reports when nothing matches', async () => {
    const r = await handleSearchTool('get_code_snippet', { id: 'app::a.ts::nope' }, ctx());
    assert.match(text(r), /No snippet found/);
  });
});

describe('search_graph', () => {
  it('filters by type and minDegree, ranked by connectivity', async () => {
    const r = await handleGraphTool('search_graph', { type: 'function', minDegree: 2 }, ctx());
    const t = text(r);
    assert.match(t, /validateToken/);     // degree 2 (1 in + 1 out)
    assert.doesNotMatch(t, /handleRequest/); // degree 1 < 2
  });

  it('matches names by regex/substring', async () => {
    const r = await handleGraphTool('search_graph', { name: 'caller' }, ctx());
    const t = text(r);
    assert.match(t, /caller1/);
    assert.match(t, /caller2/);
  });

  it('reports when no entity matches', async () => {
    const r = await handleGraphTool('search_graph', { type: 'class' }, ctx());
    assert.match(text(r), /No entities match/);
  });
});

describe('detect_changes', () => {
  it('requires a local repo path', async () => {
    const r = await handleGraphTool('detect_changes', { repo: 'app' }, ctx()); // directoryPath null
    assert.match(text(r), /needs a local repo path/);
  });

  it('maps a git working-tree change to affected entities + dependents', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'cs-ws-'));
    const repoDir = join(ws, 'app');
    mkdirSync(repoDir, { recursive: true });
    let baseSha = '';
    try {
      const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repoDir, stdio: ['pipe', 'pipe', 'pipe'] });
      git('init -q');
      git('config user.email t@t.dev');
      git('config user.name test');
      git('config commit.gpgsign false');
      writeFileSync(join(repoDir, 'a.ts'), 'export function handleRequest() {}\n');
      writeFileSync(join(repoDir, 'b.ts'), 'export function dbQuery() {}\n');
      git('add -A');
      git('commit -q -m init');
      baseSha = execSync('git rev-parse HEAD', { cwd: repoDir }).toString().trim();
      // uncommitted change to b.ts (where dbQuery lives in the fixture graph)
      appendFileSync(join(repoDir, 'b.ts'), '// touched\n');
    } catch {
      rmSync(ws, { recursive: true, force: true });
      return; // git unavailable — skip
    }

    const c = ctx();
    c.directoryPath = ws;
    const r = await handleGraphTool('detect_changes', { repo: 'app', baseSha }, c);
    const t = text(r);
    rmSync(ws, { recursive: true, force: true });

    assert.match(t, /b\.ts/);                    // changed file
    assert.match(t, /dbQuery/);                  // affected entity in b.ts
    assert.match(t, /validateToken.*dbQuery/s);  // dependent edge into the change
  });
});
