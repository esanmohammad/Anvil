/**
 * Tests for review-incident-bind-check (Review Phase R7).
 * node:test + node:assert/strict, no third-party deps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BoundTestsStore } from '../bound-tests.js';
import { checkIncidentBindings } from '../review-incident-bind-check.js';

function makeStore(project: string) {
  const home = mkdtempSync(join(tmpdir(), 'anvil-bind-check-'));
  const store = new BoundTestsStore(home);
  store.appendBound(project, {
    filePath: 'tests/incidents/payments.spec.ts',
    incidentId: 'INC-123',
    replayId: 'REPLAY-1',
    addedAt: '2026-04-01T10:00:00.000Z',
  });
  return {
    store,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe('checkIncidentBindings', () => {
  it('emits a blocker for a modified bound file with the modification message', () => {
    const { store, cleanup } = makeStore('p');
    try {
      const out = checkIncidentBindings(
        'p',
        [{ path: 'tests/incidents/payments.spec.ts', added: 5, removed: 3 }],
        { boundStore: store },
      );
      assert.equal(out.length, 1);
      assert.equal(out[0].severity, 'blocker');
      assert.equal(out[0].incidentId, 'INC-123');
      assert.match(out[0].message, /Modification of a file guarding incident INC-123/);
      assert.match(out[0].message, /verify the regression test still reproduces/);
      assert.ok(
        out[0].evidenceChecks.some((c) => c.name === 'bound-registry' && c.passed === true),
      );
    } finally {
      cleanup();
    }
  });

  it('emits a stronger blocker message for a deleted bound file', () => {
    const { store, cleanup } = makeStore('p');
    try {
      const out = checkIncidentBindings(
        'p',
        [{ path: 'tests/incidents/payments.spec.ts', added: 0, removed: 42 }],
        { boundStore: store },
      );
      assert.equal(out.length, 1);
      assert.equal(out[0].severity, 'blocker');
      assert.match(out[0].message, /Deletion of a regression guard/);
      assert.match(out[0].message, /override required/);
      assert.match(out[0].message, /INC-123/);
    } finally {
      cleanup();
    }
  });

  it('emits no finding when the changed file is not registered as a bound test', () => {
    const { store, cleanup } = makeStore('p');
    try {
      const out = checkIncidentBindings(
        'p',
        [{ path: 'src/unrelated/module.ts', added: 10, removed: 2 }],
        { boundStore: store },
      );
      assert.deepEqual(out, []);
    } finally {
      cleanup();
    }
  });

  it('always sets immutable: true and severity: blocker on every finding', () => {
    const { store, cleanup } = makeStore('p');
    try {
      const out = checkIncidentBindings(
        'p',
        [
          { path: 'tests/incidents/payments.spec.ts', added: 1, removed: 1 },
          { path: 'tests/incidents/payments.spec.ts', added: 0, removed: 99 },
        ],
        { boundStore: store },
      );
      assert.ok(out.length >= 1);
      for (const f of out) {
        assert.equal(f.immutable, true);
        assert.equal(f.severity, 'blocker');
        assert.equal(f.claimType, 'security');
        assert.equal(f.category, 'regression-guard');
        assert.ok(typeof f.id === 'string' && f.id.length > 0);
      }
    } finally {
      cleanup();
    }
  });
});
