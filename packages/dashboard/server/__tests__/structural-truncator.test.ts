/**
 * Phase 4 — structural code truncation.
 *
 * The unit goal: when a long code file is truncated to fit a budget, the
 * result should preserve imports + top-level signatures + at least one
 * full body, instead of the middle-cut hatchet job `smartTruncate` does.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { structurallyTruncate, looksLikeCode } from '../structural-truncator.js';

// ── Fixture builder ─────────────────────────────────────────────────────

function buildLargeTsFile(symbolCount: number): string {
  const imports = [
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import type { CodeChunk } from './types.js';",
  ];
  const symbols: string[] = [];
  for (let i = 0; i < symbolCount; i++) {
    const isExport = i % 2 === 0;
    const name = isExport ? `publicHelper${i}` : `internalHelper${i}`;
    const prefix = isExport ? 'export function' : 'function';
    // Pad each body so it dominates token cost.
    const body = Array.from({ length: 12 }, (_, j) => `  const v${j} = ${i} * ${j} + ${j}; // line ${j} of ${name}`).join('\n');
    symbols.push(`${prefix} ${name}(arg: number): number {\n${body}\n  return ${i};\n}`);
  }
  return imports.join('\n') + '\n\n' + symbols.join('\n\n') + '\n';
}

function tokenCount(s: string): number {
  return Math.ceil(s.length / 4);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('looksLikeCode', () => {
  it('detects TS by extension hint', () => {
    assert.equal(looksLikeCode('whatever\nblob', 'src/foo.ts'), true);
  });

  it('detects code by content sniffing without hint', () => {
    const code = `import x from 'y';\nexport function foo() {\n  return 1;\n}\nclass Bar {}\n`;
    assert.equal(looksLikeCode(code), true);
  });

  it('treats prose as not-code', () => {
    const prose = 'This is a long paragraph about software engineering.\nIt has multiple lines.\nNone of which are code.\n';
    assert.equal(looksLikeCode(prose), false);
  });
});

describe('structurallyTruncate — TS', () => {
  it('passes through when input fits the budget', () => {
    const text = `import x from 'y';\nexport function f() { return 1; }\n`;
    const out = structurallyTruncate(text, { budgetTokens: 1000, languageHint: '.ts' });
    assert.equal(out, text);
  });

  it('keeps imports and at least one full body when shrinking by ~50%', () => {
    const file = buildLargeTsFile(20); // ~200 lines
    const fullTokens = tokenCount(file);
    const target = Math.floor(fullTokens * 0.5);

    const out = structurallyTruncate(file, { budgetTokens: target, languageHint: '.ts' });

    // Imports survived.
    assert.match(out, /import\s+\{\s*readFileSync\s*\}\s+from\s+'node:fs'/);
    assert.match(out, /import\s+\{\s*join\s*\}\s+from\s+'node:path'/);

    // At least one full body survived (publicHelper0 should come through whole).
    assert.match(out, /export function publicHelper0\(arg: number\): number \{/);
    assert.match(out, /return 0;/, 'expected publicHelper0 body to land in output');

    // Stayed within budget (chars/4 heuristic).
    assert.ok(
      tokenCount(out) <= target + 5,
      `output ${tokenCount(out)} tokens exceeded target ${target}`,
    );

    // A truncation marker is present so the consumer can tell something was dropped.
    assert.match(out, /\[N? ?\d+ more symbols truncated\]|\[N more symbols truncated\]/);
  });

  it('prefers exported symbols over private ones', () => {
    // Build a file where only internalHelper3 has a giant body so the
    // greedy packer is forced to pick between exports and a private helper.
    const lines: string[] = [
      "import { x } from 'y';",
      '',
      'export function exportedA(): number { return 1; }',
      '',
      'export function exportedB(): number { return 2; }',
      '',
      'function internalHelper(): number {',
      ...Array.from({ length: 80 }, (_, j) => `  const k${j} = ${j};`),
      '  return 0;',
      '}',
      '',
    ];
    const text = lines.join('\n');
    const target = Math.floor(tokenCount(text) * 0.4);
    const out = structurallyTruncate(text, { budgetTokens: target, languageHint: '.ts' });

    // Both exported symbols should survive in some form.
    assert.match(out, /exportedA/);
    assert.match(out, /exportedB/);
    // The private helper's giant body should NOT be present in full.
    assert.equal(out.includes('const k79 = 79'), false);
  });

  it('returns input unchanged when language is unknown (caller falls back)', () => {
    const text = 'random!!! prose with no code shape\n'.repeat(40);
    const target = Math.floor(tokenCount(text) * 0.5);
    const out = structurallyTruncate(text, { budgetTokens: target /* no hint */ });
    // Either it was passed through (fallback signal) or it was within budget.
    // We accept both, but if it returned modified text, it must respect the budget.
    if (out !== text) {
      assert.ok(tokenCount(out) <= target + 5);
    }
  });
});

describe('structurallyTruncate — Python', () => {
  it('keeps imports and exported (non-underscore) defs', () => {
    const lines: string[] = [
      'from typing import Any',
      'import os',
      '',
      'def public_one(x: int) -> int:',
      ...Array.from({ length: 30 }, (_, j) => `    a${j} = ${j} * x`),
      '    return x',
      '',
      'def _private_helper(x: int) -> int:',
      ...Array.from({ length: 30 }, (_, j) => `    b${j} = ${j} * x`),
      '    return x',
      '',
      'def public_two(x: int) -> int:',
      '    return x',
      '',
    ];
    const text = lines.join('\n');
    const target = Math.floor(tokenCount(text) * 0.4);
    const out = structurallyTruncate(text, { budgetTokens: target, languageHint: '.py' });

    assert.match(out, /from typing import Any/);
    assert.match(out, /def public_one/);
    assert.match(out, /def public_two/);
    // The private body's giant content should not all survive.
    assert.equal(out.includes('b29 = 29 * x'), false);
  });
});
