/**
 * FO1-1b — disk vs durable skip-set reconciliation.
 *
 * Pure unit tests of the divergence computation that `Pipeline.run`
 * uses on resume. The pipeline itself only logs the result (durable
 * still wins); the load-bearing decision is this symmetric diff, so we
 * pin it directly rather than spying on console output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSkipSetDivergence,
  hasSkipSetDivergence,
  formatSkipSetDivergence,
} from '../durable/skip-reconcile.js';

test('no divergence when disk and durable agree exactly', () => {
  const d = computeSkipSetDivergence(['clarify', 'requirements'], ['requirements', 'clarify']);
  assert.deepEqual(d, { onlyDisk: [], onlyDurable: [] });
  assert.equal(hasSkipSetDivergence(d), false);
});

test('onlyDisk: checkpoint says done but durable log has no step:completed', () => {
  // disk claims build finished; durable only saw clarify+requirements.
  const d = computeSkipSetDivergence(
    ['clarify', 'requirements', 'build'],
    ['clarify', 'requirements'],
  );
  assert.deepEqual(d.onlyDisk, ['build']);
  assert.deepEqual(d.onlyDurable, []);
  assert.equal(hasSkipSetDivergence(d), true);
});

test('onlyDurable: durable log ahead of the checkpoint', () => {
  const d = computeSkipSetDivergence(['clarify'], ['clarify', 'requirements', 'specs']);
  assert.deepEqual(d.onlyDisk, []);
  assert.deepEqual(d.onlyDurable, ['requirements', 'specs']);
  assert.equal(hasSkipSetDivergence(d), true);
});

test('both directions diverge simultaneously', () => {
  const d = computeSkipSetDivergence(['clarify', 'build'], ['clarify', 'specs']);
  assert.deepEqual(d.onlyDisk, ['build']);
  assert.deepEqual(d.onlyDurable, ['specs']);
  assert.equal(hasSkipSetDivergence(d), true);
});

test('empty disk set never reports divergence (pure durable replay)', () => {
  // priorCompleted empty → nothing to reconcile against; durable-only is
  // not surfaced because the pipeline guards on a non-empty disk set.
  const d = computeSkipSetDivergence([], ['clarify', 'requirements']);
  assert.deepEqual(d.onlyDisk, []);
  // The helper itself reports durable-only; the pipeline call site only
  // invokes it when priorCompleted is non-empty, so this asymmetry is
  // intentional and documented.
  assert.deepEqual(d.onlyDurable, ['clarify', 'requirements']);
});

test('output sets are sorted + deduped for stable logging', () => {
  const d = computeSkipSetDivergence(
    ['specs', 'build', 'build', 'clarify'],
    ['clarify'],
  );
  assert.deepEqual(d.onlyDisk, ['build', 'specs']); // sorted, deduped
});

test('formatSkipSetDivergence renders a stable one-line summary', () => {
  const d = computeSkipSetDivergence(['build'], ['specs']);
  const line = formatSkipSetDivergence('build-xyz', d);
  assert.match(line, /build-xyz/);
  assert.match(line, /disk-only=\[build\]/);
  assert.match(line, /durable-only=\[specs\]/);
  assert.match(line, /durable log wins/);
});
