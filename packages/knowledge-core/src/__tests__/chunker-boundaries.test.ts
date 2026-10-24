/**
 * Chunk boundaries follow the code's real definitions: class members are
 * their own chunks (with their class as parent), every method shape counts
 * (Java non-void, PHP), nested functions stay inside their parent, and a
 * definition's leading doc comment / decorators belong to it — not to the
 * chunk before.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkRepo } from '@esankhan3/anvil-knowledge-core';
import type { CodeChunk } from '@esankhan3/anvil-knowledge-core';

let root: string;
let chunks: CodeChunk[];
const write = (rel: string, content: string): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
};
const inFile = (file: string) => chunks.filter((c) => c.filePath === file);
const named = (file: string, name: string) => inFile(file).find((c) => c.entityName === name);

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'chunk-bounds-'));
  write('svc.ts', [
    "import { db } from './db';",
    '',
    '/** The order service. */',
    'export class OrderService {',
    '  private cache = new Map<string, number>();',
    '',
    '  /** Load one order. */',
    '  async load(id: string): Promise<number> {',
    '    return db.get(id);',
    '  }',
    '',
    '  // Persist an order.',
    '  save(id: string, n: number): void {',
    '    db.set(id, n);',
    '  }',
    '}',
    '',
    '/** Total of two numbers. */',
    'export function total(a: number, b: number): number {',
    '  function inner(x: number) { return x * 2; }',
    '  return inner(a) + b;',
    '}',
    '',
  ].join('\n'));
  write('Svc.java', [
    'package app;',
    '',
    'class Svc {',
    '  int helper() { return 1; }',
    '',
    '  public String name() { return "svc"; }',
    '',
    '  void run() { helper(); }',
    '}',
    '',
  ].join('\n'));
  write('svc.php', [
    '<?php',
    'class Svc {',
    '  public function run() { return helper(); }',
    '}',
    '',
    'function helper() { return 1; }',
    '',
  ].join('\n'));
  write('app.py', [
    'import flask',
    '',
    "@app.route('/orders')",
    'def list_orders():',
    '    return []',
    '',
  ].join('\n'));
  chunks = (await chunkRepo(root, 'repo', 'p', { maxTokens: 500 })).chunks;
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('chunk boundaries', () => {
  it('splits TS class members into their own chunks, parented to the class', () => {
    const load = named('svc.ts', 'load');
    const save = named('svc.ts', 'save');
    assert.equal(load?.entityType, 'method');
    assert.equal(load?.parentEntity, 'OrderService');
    assert.equal(save?.entityType, 'method');
    assert.ok(named('svc.ts', 'OrderService'), 'class chunk missing');
  });

  it('keeps a nested function inside its parent', () => {
    assert.equal(named('svc.ts', 'inner'), undefined);
    assert.match(named('svc.ts', 'total')?.content ?? '', /function inner/);
  });

  it('gives each definition its own leading comment, not the previous chunk', () => {
    assert.match(named('svc.ts', 'load')?.content ?? '', /^\s*\/\*\* Load one order\. \*\//);
    assert.match(named('svc.ts', 'save')?.content ?? '', /^\s*\/\/ Persist an order\./);
    assert.match(named('svc.ts', 'total')?.content ?? '', /^\/\*\* Total of two numbers\. \*\//);
    assert.doesNotMatch(named('svc.ts', 'load')?.content ?? '', /Persist an order/);
    const before = inFile('svc.ts').filter((c) => c.entityName !== 'total');
    assert.ok(!before.some((c) => c.content.includes('Total of two numbers')), 'JSDoc leaked into the previous chunk');
  });

  it('splits Java methods of any return type', () => {
    for (const m of ['helper', 'name', 'run']) assert.equal(named('Svc.java', m)?.entityType, 'method', m);
  });

  it('splits PHP methods and functions', () => {
    assert.equal(named('svc.php', 'run')?.entityType, 'method');
    assert.equal(named('svc.php', 'helper')?.entityType, 'function');
  });

  it('keeps Python decorators with their function', () => {
    assert.match(named('app.py', 'list_orders')?.content ?? '', /^@app\.route\('\/orders'\)/);
  });
});
