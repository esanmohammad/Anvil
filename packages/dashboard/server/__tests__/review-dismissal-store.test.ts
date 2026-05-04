/**
 * Tests for ReviewDismissalStore — R8 dismissal tracker.
 *
 * Covers: record increments, shouldFilter threshold, reasons ring buffer
 * capped at 5, list() returns all records, atomic-write behaviour when
 * an existing index file is corrupt.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ReviewDismissalStore,
  derivePatternFromFile,
} from '../review-dismissal-store.js';

function tmpHome() {
  return mkdtempSync(join(tmpdir(), 'anvil-dismiss-'));
}

function sampleKey(over = {}) {
  return {
    personaId: 'security',
    claimType: 'null-deref',
    filePattern: derivePatternFromFile('packages/dashboard/src/foo/bar.tsx'),
    ...over,
  };
}

describe('ReviewDismissalStore', () => {
  let home = '';
  let store: ReviewDismissalStore;

  beforeEach(() => {
    home = tmpHome();
    store = new ReviewDismissalStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('record() increments count and stamps lastDismissedAt', () => {
    const key = sampleKey();

    const first = store.record('demo', key, 'looks like a false positive');
    assert.equal(first.count, 1);
    assert.equal(first.key.personaId, 'security');
    assert.equal(first.key.filePattern, 'packages/dashboard/**/*.tsx');
    assert.ok(first.lastDismissedAt);

    const second = store.record('demo', key, 'still noisy');
    assert.equal(second.count, 2);
    assert.deepEqual(second.reasons, ['looks like a false positive', 'still noisy']);

    const fetched = store.get('demo', key);
    assert.ok(fetched);
    assert.equal(fetched.count, 2);
  });

  it('shouldFilter() respects default threshold of 3 and custom threshold', () => {
    const key = sampleKey();

    store.record('demo', key);
    store.record('demo', key);
    assert.equal(store.shouldFilter('demo', key), false, 'count=2 < default 3');

    store.record('demo', key);
    assert.equal(store.shouldFilter('demo', key), true, 'count=3 meets default');

    assert.equal(store.shouldFilter('demo', key, 10), false, 'count=3 < threshold 10');
    assert.equal(store.shouldFilter('demo', key, 1), true, 'count=3 >= threshold 1');

    const unseen = sampleKey({ claimType: 'unusual-pattern' });
    assert.equal(store.shouldFilter('demo', unseen), false, 'unseen key never filters');
  });

  it('reasons ring buffer is capped at 5 (keeps most recent)', () => {
    const key = sampleKey();
    const inputs = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
    for (const r of inputs) store.record('demo', key, r);

    const fetched = store.get('demo', key);
    assert.ok(fetched);
    assert.equal(fetched.count, 7);
    assert.equal(fetched.reasons.length, 5);
    assert.deepEqual(fetched.reasons, ['r3', 'r4', 'r5', 'r6', 'r7']);
  });

  it('list() returns every record and orders by lastDismissedAt desc', async () => {
    const k1 = sampleKey({ claimType: 'null-deref' });
    const k2 = sampleKey({ claimType: 'unusual-pattern' });
    const k3 = sampleKey({ claimType: 'api-misuse' });

    store.record('demo', k1);
    await new Promise((r) => setTimeout(r, 10));
    store.record('demo', k2);
    await new Promise((r) => setTimeout(r, 10));
    store.record('demo', k3);

    const all = store.list('demo');
    assert.equal(all.length, 3);
    assert.equal(all[0].key.claimType, 'api-misuse');
    assert.equal(all[2].key.claimType, 'null-deref');

    // Different project isolates its own records.
    assert.equal(store.list('other').length, 0);
  });

  it('atomic write survives a corrupt index file', () => {
    const path = join(home, 'review-dismissals', 'demo', 'dismissals.json');
    mkdirSync(join(home, 'review-dismissals', 'demo'), { recursive: true });
    writeFileSync(path, '{ not json ::: ', 'utf-8');

    const key = sampleKey();
    const rec = store.record('demo', key, 'recovered');
    assert.equal(rec.count, 1);
    assert.deepEqual(rec.reasons, ['recovered']);

    const round = store.get('demo', key);
    assert.ok(round);
    assert.equal(round.count, 1);

    assert.ok(existsSync(path));
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(parsed.version, 1);
    assert.equal(Object.keys(parsed.records).length, 1);
  });
});
