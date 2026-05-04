/**
 * Tests for bound-tests-annotator.buildBoundAnnotations.
 * node:test + node:assert/strict, no third-party deps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BoundTestsStore } from '../bound-tests.js';
import { buildBoundAnnotations } from '../bound-tests-annotator.js';

function makeStore(project: string): { store: BoundTestsStore; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'anvil-bound-annot-'));
  const store = new BoundTestsStore(home);
  store.appendBound(project, {
    filePath: 'tests/incidents/payments.spec.ts',
    incidentId: 'INC-123',
    replayId: 'REPLAY-1',
    addedAt: new Date().toISOString(),
  });
  store.appendBound(project, {
    filePath: 'tests/incidents/auth.spec.ts',
    incidentId: 'INC-456',
    replayId: 'REPLAY-2',
    addedAt: new Date().toISOString(),
  });
  return {
    store,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe('buildBoundAnnotations', () => {
  it('returns empty array for empty hunks', () => {
    const { store, cleanup } = makeStore('p');
    try {
      assert.deepEqual(buildBoundAnnotations(store, 'p', []), []);
    } finally {
      cleanup();
    }
  });

  it('marks deletion as block severity', () => {
    const { store, cleanup } = makeStore('p');
    try {
      const hunks = [
        { filePath: 'tests/incidents/payments.spec.ts', addedLines: 0, removedLines: 42 },
      ];
      const out = buildBoundAnnotations(store, 'p', hunks);
      assert.equal(out.length, 1);
      assert.equal(out[0].severity, 'block');
      assert.equal(out[0].incidentId, 'INC-123');
      assert.match(out[0].message, /guards incident INC-123/);
      assert.match(out[0].message, /override/);
    } finally {
      cleanup();
    }
  });

  it('marks modification as warning severity', () => {
    const { store, cleanup } = makeStore('p');
    try {
      const hunks = [
        { filePath: 'tests/incidents/payments.spec.ts', addedLines: 8, removedLines: 3 },
      ];
      const out = buildBoundAnnotations(store, 'p', hunks);
      assert.equal(out.length, 1);
      assert.equal(out[0].severity, 'warning');
      assert.equal(out[0].filePath, 'tests/incidents/payments.spec.ts');
    } finally {
      cleanup();
    }
  });

  it('returns empty when no hunks match any bound file', () => {
    const { store, cleanup } = makeStore('p');
    try {
      const hunks = [
        { filePath: 'src/unrelated.ts', addedLines: 5, removedLines: 1 },
        { filePath: 'README.md', addedLines: 10, removedLines: 0 },
      ];
      assert.deepEqual(buildBoundAnnotations(store, 'p', hunks), []);
    } finally {
      cleanup();
    }
  });

  it('dedupes hunks for the same file and orders results by filePath', () => {
    const { store, cleanup } = makeStore('p');
    try {
      const hunks = [
        { filePath: 'tests/incidents/payments.spec.ts', addedLines: 2, removedLines: 0 },
        { filePath: 'tests/incidents/payments.spec.ts', addedLines: 3, removedLines: 1 },
        { filePath: 'tests/incidents/auth.spec.ts', addedLines: 0, removedLines: 10 },
      ];
      const out = buildBoundAnnotations(store, 'p', hunks);
      assert.equal(out.length, 2);
      // Alphabetical ordering: auth.spec.ts before payments.spec.ts.
      assert.equal(out[0].filePath, 'tests/incidents/auth.spec.ts');
      assert.equal(out[0].severity, 'block');
      assert.equal(out[1].filePath, 'tests/incidents/payments.spec.ts');
      assert.equal(out[1].severity, 'warning');
    } finally {
      cleanup();
    }
  });
});
