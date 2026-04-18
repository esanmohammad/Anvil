/**
 * Tests for structural-hasher.ts — structural code hashing and deduplication.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStructuralHash,
  computeStructuralHashes,
  deduplicateByStructure,
} from '../structural-hasher.js';

// ---------------------------------------------------------------------------
// computeStructuralHash
// ---------------------------------------------------------------------------

describe('computeStructuralHash', () => {
  it('produces consistent hash for identical input', () => {
    const code = 'function add(a: number, b: number) { return a + b; }';
    const h1 = computeStructuralHash(code, 'typescript');
    const h2 = computeStructuralHash(code, 'typescript');
    assert.equal(h1.hash, h2.hash);
  });

  it('returns a hex string hash', () => {
    const { hash } = computeStructuralHash('const x = 1;', 'typescript');
    assert.match(hash, /^[a-f0-9]{64}$/, 'Should be a 64-char hex SHA256');
  });

  it('returns canonicalSize > 0 for non-empty input', () => {
    const { canonicalSize } = computeStructuralHash('const x = 1;', 'typescript');
    assert.ok(canonicalSize > 0);
  });

  it('different code produces different hashes', () => {
    const h1 = computeStructuralHash('function add(a, b) { return a + b; }', 'javascript');
    const h2 = computeStructuralHash('function sub(a, b) { return a - b; }', 'javascript');
    assert.notEqual(h1.hash, h2.hash);
  });

  // --- Whitespace normalization ---

  it('same code with different indentation produces same hash', () => {
    const code1 = 'function foo() {\n  return 1;\n}';
    const code2 = 'function foo() {\n    return 1;\n}';
    const h1 = computeStructuralHash(code1, 'typescript');
    const h2 = computeStructuralHash(code2, 'typescript');
    assert.equal(h1.hash, h2.hash);
  });

  it('same code with different blank lines produces same hash', () => {
    const code1 = 'const a = 1;\n\n\nconst b = 2;';
    const code2 = 'const a = 1;\nconst b = 2;';
    const h1 = computeStructuralHash(code1, 'typescript');
    const h2 = computeStructuralHash(code2, 'typescript');
    assert.equal(h1.hash, h2.hash);
  });

  it('tabs vs spaces produce same hash', () => {
    const code1 = 'function foo() {\n\treturn 1;\n}';
    const code2 = 'function foo() {\n  return 1;\n}';
    const h1 = computeStructuralHash(code1, 'typescript');
    const h2 = computeStructuralHash(code2, 'typescript');
    assert.equal(h1.hash, h2.hash);
  });

  // --- Comment stripping ---

  it('code with and without line comments produces same hash (TS)', () => {
    const code1 = 'const x = 1; // this is a comment\nconst y = 2;';
    const code2 = 'const x = 1;\nconst y = 2;';
    const h1 = computeStructuralHash(code1, 'typescript');
    const h2 = computeStructuralHash(code2, 'typescript');
    assert.equal(h1.hash, h2.hash);
  });

  it('code with and without block comments produces same hash', () => {
    const code1 = '/* block comment */\nconst x = 1;';
    const code2 = 'const x = 1;';
    const h1 = computeStructuralHash(code1, 'typescript');
    const h2 = computeStructuralHash(code2, 'typescript');
    assert.equal(h1.hash, h2.hash);
  });

  it('code with and without hash comments produces same hash (Python)', () => {
    const code1 = '# comment\nx = 1';
    const code2 = 'x = 1';
    const h1 = computeStructuralHash(code1, 'python');
    const h2 = computeStructuralHash(code2, 'python');
    assert.equal(h1.hash, h2.hash);
  });

  it('code with and without Python hash comments produces same hash (multiline)', () => {
    // Python hash comments should be stripped across multiple lines
    const code1 = '# module comment\nx = 1\n# another comment\ny = 2';
    const code2 = 'x = 1\ny = 2';
    const h1 = computeStructuralHash(code1, 'python');
    const h2 = computeStructuralHash(code2, 'python');
    assert.equal(h1.hash, h2.hash);
  });

  it('does not strip content inside string literals', () => {
    // The "// not a comment" inside a string should NOT be stripped
    const code1 = 'const msg = "// not a comment";';
    const code2 = 'const msg = "";';
    const h1 = computeStructuralHash(code1, 'typescript');
    const h2 = computeStructuralHash(code2, 'typescript');
    assert.notEqual(h1.hash, h2.hash, 'String content should be preserved');
  });

  // --- Variable normalization ---

  it('same logic with different local variable names produces same hash', () => {
    const code1 = 'const result = 1 + 2;\nconst output = result * 3;';
    const code2 = 'const value = 1 + 2;\nconst total = value * 3;';
    const h1 = computeStructuralHash(code1, 'typescript');
    const h2 = computeStructuralHash(code2, 'typescript');
    assert.equal(h1.hash, h2.hash);
  });

  it('different logic still produces different hashes after normalization', () => {
    const code1 = 'const x = 1 + 2;';
    const code2 = 'const x = 1 - 2;';
    const h1 = computeStructuralHash(code1, 'typescript');
    const h2 = computeStructuralHash(code2, 'typescript');
    assert.notEqual(h1.hash, h2.hash);
  });
});

// ---------------------------------------------------------------------------
// computeStructuralHashes (batch)
// ---------------------------------------------------------------------------

describe('computeStructuralHashes', () => {
  it('returns hashes map with correct size', () => {
    const chunks = [
      { id: 'a', content: 'const x = 1;', language: 'typescript' },
      { id: 'b', content: 'const y = 2;', language: 'typescript' },
    ];
    const result = computeStructuralHashes(chunks);
    assert.equal(result.hashes.size, 2);
  });

  it('detects duplicates with same structural content', () => {
    const chunks = [
      { id: 'a', content: 'const x = 1; // comment', language: 'typescript' },
      { id: 'b', content: 'const x = 1;', language: 'typescript' },
    ];
    const result = computeStructuralHashes(chunks);
    assert.equal(result.duplicateCount, 1);
    assert.equal(result.uniqueCount, 1);
  });

  it('counts no duplicates for distinct content', () => {
    const chunks = [
      { id: 'a', content: 'const x = 1;', language: 'typescript' },
      { id: 'b', content: 'const y = "hello";', language: 'typescript' },
    ];
    const result = computeStructuralHashes(chunks);
    assert.equal(result.duplicateCount, 0);
    assert.equal(result.uniqueCount, 2);
  });
});

// ---------------------------------------------------------------------------
// deduplicateByStructure
// ---------------------------------------------------------------------------

describe('deduplicateByStructure', () => {
  it('keeps unique chunks and separates duplicates', () => {
    const chunks = [
      { id: 'a', content: 'const x = 1;', language: 'typescript' },
      { id: 'b', content: 'const x = 1; // dup', language: 'typescript' },
      { id: 'c', content: 'const y = "different";', language: 'typescript' },
    ];
    const result = deduplicateByStructure(chunks);
    assert.equal(result.unique.length, 2);
    assert.equal(result.duplicates.length, 1);
    assert.ok(result.savings.chunks === 1);
    assert.ok(result.savings.estimatedTokens > 0);
  });

  it('returns all chunks as unique when no duplicates', () => {
    const chunks = [
      { id: 'a', content: 'function add() {}', language: 'typescript' },
      { id: 'b', content: 'function sub() {}', language: 'typescript' },
    ];
    const result = deduplicateByStructure(chunks);
    assert.equal(result.unique.length, 2);
    assert.equal(result.duplicates.length, 0);
    assert.equal(result.savings.chunks, 0);
  });

  it('selects canonical chunk deterministically by ID sort', () => {
    const chunks = [
      { id: 'z-chunk', content: 'const x = 1;', language: 'typescript' },
      { id: 'a-chunk', content: 'const x = 1; // dup', language: 'typescript' },
    ];
    const result = deduplicateByStructure(chunks);
    // 'a-chunk' sorts before 'z-chunk', so 'a-chunk' should be the canonical one
    assert.equal(result.unique[0].id, 'a-chunk');
    assert.equal(result.duplicates[0].id, 'z-chunk');
  });

  it('uses pre-computed structuralHash when provided', () => {
    const fakeHash = 'a'.repeat(64);
    const chunks = [
      { id: 'a', content: 'different content 1', language: 'typescript', structuralHash: fakeHash },
      { id: 'b', content: 'different content 2', language: 'typescript', structuralHash: fakeHash },
    ];
    const result = deduplicateByStructure(chunks);
    // Both share the same pre-computed hash, so one is a duplicate
    assert.equal(result.unique.length, 1);
    assert.equal(result.duplicates.length, 1);
  });
});
