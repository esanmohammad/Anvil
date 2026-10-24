/**
 * buildAstGraph over a polyglot repo: names only resolve within a language
 * family (a Java class can't inherit a Python class, a TS method can't call a
 * Python function), class methods and top-level consts are graph nodes,
 * type references start at the entity that makes them, require() is an
 * import, and .tsx is parsed with the TSX grammar.
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
  write('py/two.py', 'class A:\n    def render(self):\n        return 1\n\nclass B:\n    def render(self):\n        return helper()\n\ndef helper():\n    return 2\n');
  write('ts/consts.ts', "export enum Kind { A = 'a' }\nexport const TEMPLATE_TYPE = { SERVICE: 'wonderpush' };\nconst limits = [1, 2];\n");
  write('ts/order.ts', 'export interface Order { id: string }\nexport class Receipt {}\nexport function save(o: Order): Receipt {\n  return new Receipt();\n}\n');
  write('go/h.go', 'package h\n\ntype Req struct{}\n\ntype Res struct{}\n\ntype Handler struct{ last Req; repo *store.Repo }\n\nfunc (h *Handler) Run(r Req, w *http.Request) (*Res, error) {\n  return &Res{}, nil\n}\n');
  write('go/store/repo.go', 'package store\n\ntype Repo struct{}\n');
  write('go/web/request.go', 'package web\n\ntype Request struct{}\n');
  write('ui/App.jsx', "function Row() { return null; }\nexport function App() { return <div><Row /></div>; }\n");
  write('ui/App.test.jsx', "const mockProps = { a: 1 };\ndescribe('App', () => {\n  it('renders', () => { render(<App {...mockProps} />); track(); });\n});\n");
  graph = await buildAstGraph(root, {});
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('buildAstGraph', () => {
  it('never links names across language families', () => {
    const cross = graph.links.filter((e) => e.type !== 'contains' && family(e.source) !== family(e.target));
    assert.deepEqual(cross.map((e) => `${e.source} -${e.type}-> ${e.target}`), []);
  });

  it('makes class methods graph nodes', () => {
    const run = graph.nodes.find((n) => n.id === 'ts/service.ts::Service.run');
    assert.equal(run?.type, 'method');
  });

  it('gives same-name methods of different classes their own nodes', () => {
    const ids = graph.nodes.map((n) => n.id);
    assert.ok(ids.includes('py/two.py::A.render') && ids.includes('py/two.py::B.render'), ids.filter((i) => i.startsWith('py/two')).join(', '));
    assert.ok(graph.links.some((e) => e.source === 'py/two.py::B.render' && e.target === 'py/two.py::helper' && e.type === 'calls'));
    assert.ok(!graph.links.some((e) => e.source === 'py/two.py::A.render' && e.type === 'calls'));
    assert.ok(graph.links.some((e) => e.source === 'py/two.py::A' && e.target === 'py/two.py::A.render' && e.type === 'contains'));
  });

  it('treats require() as an import', () => {
    assert.ok(graph.links.some((e) => e.source === 'js/a.js' && e.target === 'js/b.js' && e.type === 'imports'), 'no require import edge');
  });

  it('makes top-level consts graph nodes', () => {
    const type = (id: string) => graph.nodes.find((n) => n.id === id)?.type;
    assert.equal(type('ts/consts.ts::TEMPLATE_TYPE'), 'const');
    assert.equal(type('ts/consts.ts::limits'), 'const');
  });

  it('draws type-ref edges from the entity that references the type', () => {
    const refs = graph.links.filter((e) => e.type === 'type-ref').map((e) => `${e.source} -> ${e.target}`);
    for (const ref of [
      'ts/order.ts::save -> ts/order.ts::Order',
      'ts/order.ts::save -> ts/order.ts::Receipt',
      'go/h.go::Handler -> go/h.go::Req',
      'go/h.go::Run -> go/h.go::Handler',
      'go/h.go::Run -> go/h.go::Req',
      'go/h.go::Run -> go/h.go::Res',
      'go/h.go::Handler -> go/store/repo.go::Repo',
      'ui/App.jsx::App -> ui/App.jsx::Row',
    ]) assert.ok(refs.includes(ref), `${ref} missing from ${refs.join(', ')}`);
    // `http.Request` is net/http's type, not the one declared in package `web`.
    assert.ok(!refs.some((r) => r.endsWith('::Request')), refs.join(', '));
  });

  it('attributes module-level references to the file, not the declaration above them', () => {
    const from = (target: string) => graph.links.filter((e) => e.target === target && e.source.startsWith('ui/App.test.jsx')).map((e) => `${e.source} -${e.type}->`);
    assert.deepEqual(from('ui/App.jsx::App'), ['ui/App.test.jsx -type-ref->']);
    assert.deepEqual(from('ui/Card.tsx::track'), ['ui/App.test.jsx -calls->']);
  });

  it('parses .tsx with the TSX grammar', () => {
    assert.ok(graph.links.some((e) => e.source === 'ui/Card.tsx::Board.click' && e.target === 'ui/Card.tsx::track' && e.type === 'calls'));
    assert.ok(graph.nodes.some((n) => n.id === 'ui/Card.tsx::Board.render'));
  });
});
