/**
 * Tests for review-scope-matcher — persona topic-scope gating.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  matches,
  filterFilesForPersona,
  routeFilesToPersonas,
} from '../review-scope-matcher.js';

describe('matches — sql-injection-reviewer', () => {
  it('matches a .py file containing SELECT *', () => {
    const contents = 'def q():\n    return db.query("SELECT * FROM users")\n';
    assert.equal(matches('sql-injection-reviewer', 'app/queries.py', contents), true);
  });

  it('skips .tsx files even when they mention SELECT', () => {
    const contents = 'export const label = "Please SELECT an option";\n';
    assert.equal(matches('sql-injection-reviewer', 'src/ui/Picker.tsx', contents), false);
  });

  it('skips .py files with no SQL sniffs', () => {
    const contents = 'def add(a, b):\n    return a + b\n';
    assert.equal(matches('sql-injection-reviewer', 'app/math.py', contents), false);
  });
});

describe('matches — xss-reviewer', () => {
  it('matches .tsx with dangerouslySetInnerHTML', () => {
    const contents = 'const X = () => <div dangerouslySetInnerHTML={{__html: h}} />;';
    assert.equal(matches('xss-reviewer', 'src/Unsafe.tsx', contents), true);
  });

  it('skips pure .go files', () => {
    const contents = 'package main\nfunc main() { fmt.Println("hi") }\n';
    assert.equal(matches('xss-reviewer', 'cmd/app/main.go', contents), false);
  });

  it('skips .tsx files without any XSS sinks', () => {
    const contents = 'export const Plain = () => <div>hello</div>;';
    assert.equal(matches('xss-reviewer', 'src/Plain.tsx', contents), false);
  });
});

describe('matches — race-condition-reviewer', () => {
  it('matches async/await code', () => {
    const src = 'async function load() { return await fetch(url); }';
    assert.equal(matches('race-condition-reviewer', 'src/load.ts', src), true);
  });

  it('matches Go goroutines', () => {
    const src = 'package x\nfunc run() { go func() { work() }() }\n';
    assert.equal(matches('race-condition-reviewer', 'pkg/run.go', src), true);
  });

  it('skips synchronous code with no concurrency primitives', () => {
    const src = 'function add(a, b) { return a + b; }';
    assert.equal(matches('race-condition-reviewer', 'src/add.js', src), false);
  });
});

describe('matches — crypto-reviewer', () => {
  it('matches MD5 mentions in any language', () => {
    assert.equal(matches('crypto-reviewer', 'legacy/hash.py', 'digest = MD5(x)'), true);
    assert.equal(matches('crypto-reviewer', 'pkg/hash.go', 'h := md5Sum(b) // MD5 fallback'), true);
  });

  it('matches AES in Java', () => {
    const src = 'Cipher c = Cipher.getInstance("AES/GCM/NoPadding");';
    assert.equal(matches('crypto-reviewer', 'src/Crypto.java', src), true);
  });

  it('skips files without crypto references', () => {
    assert.equal(matches('crypto-reviewer', 'src/Plain.java', 'int x = 1;'), false);
  });
});

describe('matches — generic persona (empty scope)', () => {
  it('matches any file type', () => {
    assert.equal(matches('convention-reviewer', 'README.md', '# hi'), true);
    assert.equal(matches('convention-reviewer', 'src/x.tsx', 'const x = 1;'), true);
    assert.equal(matches('convention-reviewer', 'pkg/main.go', 'package main'), true);
  });

  it('matches even when contents are empty', () => {
    assert.equal(matches('edge-case-hunter', 'anything.txt', ''), true);
  });
});

describe('matches — unknown persona', () => {
  it('returns false for personas not in the scope table', () => {
    assert.equal(matches('no-such-reviewer', 'a.ts', 'x'), false);
  });
});

describe('filterFilesForPersona', () => {
  it('returns only files matching a persona scope', () => {
    const files = [
      { path: 'app/users.py', contents: 'db.query("SELECT * FROM users")' },
      { path: 'src/Ui.tsx', contents: '<div dangerouslySetInnerHTML={{__html: x}} />' },
      { path: 'README.md', contents: '# hi' },
    ];
    const sql = filterFilesForPersona('sql-injection-reviewer', files);
    assert.equal(sql.length, 1);
    assert.equal(sql[0].path, 'app/users.py');
  });
});

describe('routeFilesToPersonas', () => {
  it('returns a map from persona id to the files they should review', () => {
    const files = [
      { path: 'app/users.py', contents: 'db.query("SELECT * FROM users")' },
      { path: 'src/Ui.tsx', contents: '<div dangerouslySetInnerHTML={{__html: x}} />' },
      { path: 'pkg/run.go', contents: 'package x\nfunc run() { go func() { work() }() }' },
    ];
    const routed = routeFilesToPersonas(files, [
      'sql-injection-reviewer',
      'xss-reviewer',
      'race-condition-reviewer',
      'convention-reviewer',
    ]);

    assert.equal(routed['sql-injection-reviewer'].length, 1);
    assert.equal(routed['sql-injection-reviewer'][0].path, 'app/users.py');

    assert.equal(routed['xss-reviewer'].length, 1);
    assert.equal(routed['xss-reviewer'][0].path, 'src/Ui.tsx');

    assert.equal(routed['race-condition-reviewer'].length, 1);
    assert.equal(routed['race-condition-reviewer'][0].path, 'pkg/run.go');

    // Generic persona picks up every file.
    assert.equal(routed['convention-reviewer'].length, 3);
  });

  it('defaults to all personas when none are passed', () => {
    const routed = routeFilesToPersonas([{ path: 'x.ts', contents: 'const x = 1;' }]);
    assert.ok('convention-reviewer' in routed);
    assert.ok('sql-injection-reviewer' in routed);
  });
});

describe('glob matcher edge cases', () => {
  it('handles brace alternation for crypto persona (no path filter) vs xss (braces in path)', () => {
    // xss only fires on .tsx (brace pattern), not on .py
    const pyContents = '# dangerouslySetInnerHTML mention in comment';
    assert.equal(matches('xss-reviewer', 'x.py', pyContents), false);
  });

  it('handles ** across multiple directories', () => {
    const contents = 'Object.assign({}, a, b)';
    assert.equal(matches('prototype-pollution-reviewer', 'a/b/c/d/file.ts', contents), true);
  });
});
