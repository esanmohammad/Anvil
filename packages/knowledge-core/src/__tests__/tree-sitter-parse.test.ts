/**
 * Tree-sitter parsing must actually run for every supported language — when a
 * grammar fails to load, the AST graph silently degrades to the regex
 * fallback. Each sample has a class with a method, a free function, an
 * import and a call.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFile } from '@esankhan3/anvil-knowledge-core';

const SAMPLES: Record<string, { file: string; src: string; entities: string[]; method: [string, string] | null; importLike: string; callee: string }> = {
  typescript: {
    file: 'svc.ts',
    src: "import { b } from './b';\nexport class Svc {\n  run(x: number) { return helper(x); }\n}\nexport function helper(n: number) { return b(n); }\n",
    entities: ['Svc', 'run', 'helper'], method: ['run', 'Svc'], importLike: './b', callee: 'helper',
  },
  tsx: {
    file: 'card.tsx',
    src: "import React from 'react';\nexport class Board extends React.Component {\n  render() { return <div onClick={() => track()} />; }\n}\nexport function track() { return 1; }\n",
    entities: ['Board', 'render', 'track'], method: ['render', 'Board'], importLike: 'react', callee: 'track',
  },
  javascript: {
    file: 'a.js',
    src: "const fs = require('fs');\nclass A {\n  m() { return go(); }\n}\nfunction go() { return fs; }\n",
    entities: ['A', 'm', 'go'], method: ['m', 'A'], importLike: 'fs', callee: 'go',
  },
  go: {
    file: 'main.go',
    src: 'package main\n\nimport "fmt"\n\ntype Svc struct{}\n\nfunc (s *Svc) Run() { helper() }\n\nfunc helper() { fmt.Println("x") }\n',
    entities: ['Svc', 'Run', 'helper'], method: null, importLike: 'fmt', callee: 'helper',
  },
  python: {
    file: 'svc.py',
    src: 'import os\nfrom a.b import c\n\nclass Svc:\n    def run(self):\n        return helper()\n\ndef helper():\n    return os.getcwd()\n',
    entities: ['Svc', 'run', 'helper'], method: ['run', 'Svc'], importLike: 'a.b', callee: 'helper',
  },
  rust: {
    file: 'lib.rs',
    src: 'use std::collections::HashMap;\n\nstruct Svc;\n\nimpl Svc {\n    fn run(&self) { helper(); }\n}\n\nfn helper() {}\n',
    entities: ['Svc', 'run', 'helper'], method: null, importLike: 'std::collections::HashMap', callee: 'helper',
  },
  java: {
    file: 'Svc.java',
    src: 'import java.util.List;\n\nclass Svc {\n  int helper() { return 1; }\n  void run() { helper(); }\n}\n',
    entities: ['Svc', 'helper', 'run'], method: ['run', 'Svc'], importLike: 'java.util.List', callee: 'helper',
  },
  php: {
    file: 'svc.php',
    src: '<?php\nuse App\\Models\\User;\n\nclass Svc {\n  public function run() { return helper(); }\n}\n\nfunction helper() { return 1; }\n',
    entities: ['Svc', 'run', 'helper'], method: ['run', 'Svc'], importLike: 'App\\Models\\User', callee: 'helper',
  },
};

describe('tree-sitter parseFile', () => {
  for (const [language, s] of Object.entries(SAMPLES)) {
    it(`parses ${language}: entities, methods, imports, calls`, async () => {
      const r = await parseFile(s.file, s.src, language);
      assert.ok(r, `${language} grammar did not load / parse`);
      const names = r.entities.map((e) => e.name);
      for (const n of s.entities) assert.ok(names.includes(n), `${language}: entity ${n} missing from ${names}`);
      if (s.method) {
        const m = r.entities.find((e) => e.name === s.method![0]);
        assert.equal(m?.type, 'method', `${language}: ${s.method[0]} type`);
        assert.equal(m?.parent, s.method[1], `${language}: ${s.method[0]} parent`);
      }
      assert.ok(r.imports.some((i) => i.source.includes(s.importLike)), `${language}: import ${s.importLike} missing from ${r.imports.map((i) => i.source)}`);
      assert.ok(r.callSites.some((c) => c.callee === s.callee), `${language}: call ${s.callee} missing from ${r.callSites.map((c) => c.callee)}`);
    });
  }
});
