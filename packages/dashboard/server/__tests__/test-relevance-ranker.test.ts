/**
 * Tests for test-relevance-ranker: inverse-graph BFS, distance bookkeeping,
 * test-file pattern matching, and maxDistance capping.
 *
 * node:test + node:assert/strict — no third-party deps, matching the style
 * of the other tests in this directory. Run via:
 *   npx tsc -p server/tsconfig.json
 *   node --test server/out/__tests__/test-relevance-ranker.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rankRelevantTests } from '../test-relevance-ranker.js';

// ── Fixture helpers ────────────────────────────────────────────────────────
// Build a tiny graph shape that matches GraphifyOutput. Each node carries an
// `id`, `file`, and `label`; each edge is { source, target } pointing from
// the importer to the imported (matching ast-graph-builder's convention).
//
// The helper signatures are at module scope (not inside a test function) so
// the "no type annotations inside test bodies" rule still holds.

interface FixtureNode {
  id: string;
  file: string;
  label: string;
  type: string;
}
interface FixtureEdge {
  source: string;
  target: string;
}

function node(id: string, file: string, label: string, type: string): FixtureNode {
  return { id, file, label, type };
}
function edge(source: string, target: string): FixtureEdge {
  return { source, target };
}

// Shared graph: three sources and four tests, so we can assert distance
// hops and denominator counts clearly.
//
//   lib/a.ts (fn a)  ←─  consumer/b.ts (fn b)  ←─  consumer/c.ts (fn c)
//        ↑                      ↑                         ↑
//   tests/a.test.ts    tests/b.test.ts            tests/c.test.ts
//
//   tests/unrelated.test.ts has no edges.

const sharedGraph = {
  nodes: [
    node('lib/a.ts::a', 'lib/a.ts', 'a', 'function'),
    node('consumer/b.ts::b', 'consumer/b.ts', 'b', 'function'),
    node('consumer/c.ts::c', 'consumer/c.ts', 'c', 'function'),
    node('tests/a.test.ts::t_a', 'tests/a.test.ts', 't_a', 'function'),
    node('tests/b.test.ts::t_b', 'tests/b.test.ts', 't_b', 'function'),
    node('tests/c.test.ts::t_c', 'tests/c.test.ts', 't_c', 'function'),
    node('tests/unrelated.test.ts::t_u', 'tests/unrelated.test.ts', 't_u', 'function'),
  ],
  links: [
    // source IMPORTS target. Tests import the symbol they exercise.
    edge('tests/a.test.ts::t_a', 'lib/a.ts::a'),
    edge('tests/b.test.ts::t_b', 'consumer/b.ts::b'),
    edge('tests/c.test.ts::t_c', 'consumer/c.ts::c'),
    edge('consumer/b.ts::b', 'lib/a.ts::a'),     // b calls a
    edge('consumer/c.ts::c', 'consumer/b.ts::b'), // c calls b
  ],
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('rankRelevantTests', () => {
  it('empty diff → zero relevant tests but totalTests still reported', () => {
    const result = rankRelevantTests({
      changedSymbols: [],
      repoGraphs: { repo: sharedGraph },
    });
    assert.equal(result.rankedRelevant.length, 0);
    // 4 tests exist on the graph (tests/{a,b,c,unrelated}.test.ts).
    assert.equal(result.totalTests, 4);
    assert.equal(result.estimatedRuntimeMs, 0);
    assert.match(result.estimatedSavings, /0 of 4/);
  });

  it('direct caller is reported at distance 1', () => {
    // Changing fn `a` in lib/a.ts. tests/a.test.ts imports it directly
    // (distance 1). Other tests reach it at further distances (b→a = 1 hop,
    // b.test→b = another hop, so t_b ends up at distance 2).
    const result = rankRelevantTests({
      changedSymbols: [{
        repoName: 'repo',
        filePath: 'lib/a.ts',
        symbol: 'a',
        changeKind: 'modified',
      }],
      repoGraphs: { repo: sharedGraph },
    });
    const ta = result.rankedRelevant.find((t) => t.testFile === 'tests/a.test.ts');
    assert.ok(ta, 'tests/a.test.ts should be reachable');
    assert.equal(ta.distance, 1);
    assert.equal(ta.repoName, 'repo');
    assert.ok(ta.matchedSymbols.length >= 1);
  });

  it('transitive dependency is reported at distance 2', () => {
    // Changing fn `a`. The chain t_c → c → b → a is 3 hops; t_b → b → a is
    // 2 hops; t_a → a is 1 hop. So tests/b.test.ts sits at distance 2.
    const result = rankRelevantTests({
      changedSymbols: [{
        repoName: 'repo',
        filePath: 'lib/a.ts',
        symbol: 'a',
        changeKind: 'modified',
      }],
      repoGraphs: { repo: sharedGraph },
    });
    const tb = result.rankedRelevant.find((t) => t.testFile === 'tests/b.test.ts');
    assert.ok(tb, 'tests/b.test.ts should be reachable transitively');
    assert.equal(tb.distance, 2);
    // Results sort distance asc — the direct test must precede the transitive.
    const iA = result.rankedRelevant.findIndex((t) => t.testFile === 'tests/a.test.ts');
    const iB = result.rankedRelevant.findIndex((t) => t.testFile === 'tests/b.test.ts');
    assert.ok(iA >= 0 && iB >= 0);
    assert.ok(iA < iB, 'distance-1 test should sort before distance-2');
  });

  it('honours the test-file pattern filter', () => {
    // Restrict the test pattern to files under tests/ named *.spec.*. That
    // matches nothing in the fixture (we only have .test.ts), so even with
    // a matching changed symbol no tests should be returned.
    const result = rankRelevantTests({
      changedSymbols: [{
        repoName: 'repo',
        filePath: 'lib/a.ts',
        symbol: 'a',
        changeKind: 'modified',
      }],
      repoGraphs: { repo: sharedGraph },
      testFilePatterns: ['**/*.spec.*'],
    });
    assert.equal(result.rankedRelevant.length, 0);
    // totalTests reflects the same (restrictive) pattern — should also be 0.
    assert.equal(result.totalTests, 0);
  });

  it('maxDistance caps BFS depth', () => {
    // With maxDistance=1, only tests/a.test.ts should surface; the transitive
    // tests/b.test.ts (d=2) and tests/c.test.ts (d=3) are beyond the horizon.
    const result = rankRelevantTests({
      changedSymbols: [{
        repoName: 'repo',
        filePath: 'lib/a.ts',
        symbol: 'a',
        changeKind: 'modified',
      }],
      repoGraphs: { repo: sharedGraph },
      maxDistance: 1,
    });
    const files = result.rankedRelevant.map((t) => t.testFile);
    assert.deepEqual(files, ['tests/a.test.ts']);
  });

  it('file-level change (no symbol) expands to every node in that file', () => {
    // consumer/b.ts contains only fn b. A whole-file change should still
    // reach tests/b.test.ts directly.
    const result = rankRelevantTests({
      changedSymbols: [{
        repoName: 'repo',
        filePath: 'consumer/b.ts',
        changeKind: 'modified',
      }],
      repoGraphs: { repo: sharedGraph },
    });
    const tb = result.rankedRelevant.find((t) => t.testFile === 'tests/b.test.ts');
    assert.ok(tb);
    assert.equal(tb.distance, 1);
  });
});
