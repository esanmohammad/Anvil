/**
 * Chunk boundaries follow the code's real definitions: class members are
 * their own chunks (with their class as parent), every method shape counts
 * (Java non-void, PHP), JS/TS top-level variables and ambient declarations
 * are definitions, nested functions stay inside a parent that fits (an
 * oversized one is split at them), and a definition's leading doc comment /
 * decorators belong to it — not to the chunk before.
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
    '  const twice = (x: number) => x * 2;',
    '  return inner(a) + twice(b);',
    '}',
    '',
  ].join('\n'));
  write('constants.ts', [
    "import { a } from './a';",
    "import b from 'b';",
    '',
    'export const TEMPLATE_TYPE = {',
    "  SERVICE: 'wonderpush',",
    "  TYPE: 'template',",
    '};',
    '',
    "export enum PAGE_REFS { TEMPLATE = 'template' }",
    '',
    'const local = [a, b];',
    'let counter = 0;',
    "var legacy = 'x';",
    'export const double = (n: number) => n * 2;',
    '',
  ].join('\n'));
  write('cjs.js', [
    "const fs = require('fs');",
    "const path = require('path');",
    '',
    'const DEFAULTS = { dir: path.join(fs.cwd, "x") };',
    'module.exports = { DEFAULTS };',
    '',
  ].join('\n'));
  write('types.d.ts', [
    "declare module '@dtsl/components' {",
    '  export const VARIANTS: { primary: string };',
    '  export function isEmpty(value: unknown): boolean;',
    '  export interface ButtonProps { kind: string }',
    '}',
    'declare const VERSION: string;',
    'declare function boot(): void;',
    '',
  ].join('\n'));
  write('nav.test.js', [
    "import { render } from '@testing-library/react';",
    "jest.mock('../Nav', () => {",
    '  const MockNav = () => null;',
    '  return MockNav;',
    '});',
    "describe('Nav', () => {",
    '  const renderNav = () => render(null);',
    "  it('renders', () => { renderNav(); });",
    '});',
    '',
  ].join('\n'));
  const filler = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `    ${prefix}${i} = props.option${i} ?? ${i};`);
  write('hook.js', [
    "import { useState } from 'react';",
    '',
    'export function useCampaignWhenAppear(props) {',
    '  const [value, setValue] = useState(0);',
    ...filler('let head', 40),
    '  // Select a dropdown option.',
    '  function handleDropdownSelect(_, option) {',
    ...filler('let sel', 30),
    '    setValue(option);',
    '  }',
    '  const handleSave = () => {',
    ...filler('let save', 30),
    '    setValue(0);',
    '  };',
    '  return { value, handleDropdownSelect, handleSave };',
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
    assert.equal(named('svc.ts', 'twice'), undefined);
    assert.match(named('svc.ts', 'total')?.content ?? '', /function inner[\s\S]*const twice/);
  });

  it('keeps a function defined inside an anonymous callback inside it', () => {
    assert.deepEqual(inFile('nav.test.js').map((c) => [c.entityType, c.entityName]), [['module', 'nav.test']]);
  });

  it('makes every top-level const / let / var a named chunk', () => {
    assert.equal(named('constants.ts', 'TEMPLATE_TYPE')?.entityType, 'const');
    assert.match(named('constants.ts', 'TEMPLATE_TYPE')?.content ?? '', /^export const TEMPLATE_TYPE = \{[\s\S]*\};\s*$/);
    for (const n of ['local', 'counter', 'legacy']) assert.equal(named('constants.ts', n)?.entityType, 'const', n);
    assert.equal(named('constants.ts', 'double')?.entityType, 'function');
    assert.equal(named('constants.ts', 'PAGE_REFS')?.entityType, 'type');
    assert.equal(named('cjs.js', 'DEFAULTS')?.entityType, 'const');
  });

  it('ends the leading import block where the first declaration starts', () => {
    const imports = inFile('constants.ts').filter((c) => c.entityType === 'import');
    assert.deepEqual(imports.map((c) => [c.startLine, c.endLine]), [[1, 3]]);
    // require() bindings are the CommonJS import block, not declarations.
    assert.equal(named('cjs.js', 'fs'), undefined);
    assert.deepEqual(inFile('cjs.js').filter((c) => c.entityType === 'import').map((c) => [c.startLine, c.endLine]), [[1, 3]]);
  });

  it('names .d.ts ambient declarations', () => {
    for (const n of ['VARIANTS', 'isEmpty', 'ButtonProps', 'VERSION', 'boot']) assert.ok(named('types.d.ts', n), `${n} missing`);
  });

  it('splits an oversized entity at its nested definitions, parented to it', () => {
    const parts = inFile('hook.js').filter((c) => c.entityType !== 'import');
    assert.ok(parts.length > 1, 'hook was not split');
    const select = named('hook.js', 'handleDropdownSelect');
    assert.equal(select?.parentEntity, 'useCampaignWhenAppear');
    assert.match(select?.content ?? '', /^ {2}\/\/ Select a dropdown option\.\n {2}function handleDropdownSelect/);
    const save = named('hook.js', 'handleSave');
    assert.equal(save?.parentEntity, 'useCampaignWhenAppear');
    assert.match(save?.content ?? '', /^ {2}const handleSave = \(\) => \{/);
    assert.match(parts[0].entityName ?? '', /^useCampaignWhenAppear/);
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
