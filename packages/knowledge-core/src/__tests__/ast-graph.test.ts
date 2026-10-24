/**
 * buildAstGraph over a polyglot repo: names only resolve within a language
 * family (a Java class can't inherit a Python class, a TS method can't call a
 * Python function), class methods are graph nodes, require() is an import,
 * and .tsx is parsed with the TSX grammar.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { buildAstGraph } from '@esankhan3/anvil-knowledge-core';
import type { GraphifyOutput } from '@esankhan3/anvil-knowledge-core';

let root: string;
let graph: GraphifyOutput;
const write = (rel: string, content: string): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
};
const family = (id: string): string => {
  const ext = extname(id.split('::')[0]);
  return ['.ts', '.tsx', '.js', '.jsx'].includes(ext) ? 'js' : ext;
};

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'ast-graph-'));
  write('java/App.java', 'class App extends Base {\n  void run() { stop(); }\n}\n');
  write('py/svc.py', 'class Base:\n    def stop(self):\n        pass\n');
  write('ts/service.ts', 'export class Service {\n  run() { return stop(); }\n}\n');
  write('js/a.js', "const b = require('./b');\nfunction go() { return b.x; }\n");
  write('js/b.js', 'function x() { return 1; }\nmodule.exports = { x };\n');
  write('ui/Card.tsx', 'export class Board {\n  render() { return <div className="b">{rows.map((r) => <Row key={r} />)}</div>; }\n  click() { return track(); }\n}\nexport function track() { return 1; }\n');
  graph = await buildAstGraph(root, {});
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('buildAstGraph', () => {
  it('never links names across language families', () => {
    const cross = graph.links.filter((e) => e.type !== 'contains' && family(e.source) !== family(e.target));
    assert.deepEqual(cross.map((e) => `${e.source} -${e.type}-> ${e.target}`), []);
  });

  it('makes class methods graph nodes', () => {
    const run = graph.nodes.find((n) => n.id === 'ts/service.ts::run');
    assert.equal(run?.type, 'method');
  });

  it('treats require() as an import', () => {
    assert.ok(graph.links.some((e) => e.source === 'js/a.js' && e.target === 'js/b.js' && e.type === 'imports'), 'no require import edge');
  });

  it('parses .tsx with the TSX grammar', () => {
    assert.ok(graph.links.some((e) => e.source === 'ui/Card.tsx::click' && e.target === 'ui/Card.tsx::track' && e.type === 'calls'));
    assert.ok(graph.nodes.some((n) => n.id === 'ui/Card.tsx::render'));
  });
});
