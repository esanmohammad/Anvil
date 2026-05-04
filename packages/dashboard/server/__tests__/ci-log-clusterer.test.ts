/**
 * Tests for the CI log clusterer — node:test + node:assert/strict.
 *
 * Covers: OOM, port conflict, DB lock, network timeout, unknown lines,
 * severity-first sorting, and confidence math.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { clusterCiLog } from '../ci-log-clusterer.js';

// ── OOM detection ───────────────────────────────────────────────────────

describe('clusterCiLog — OOM detection', () => {
  it('buckets "JavaScript heap out of memory" into the oom cluster', () => {
    const log = [
      'info: starting build',
      'FATAL ERROR: JavaScript heap out of memory',
      'worker crashed',
    ].join('\n');

    const report = clusterCiLog({ logText: log, logSource: 'unit' });
    const oom = report.clusters.find((c) => c.pattern === 'oom');
    assert.ok(oom, 'expected an oom cluster');
    assert.equal(oom.severity, 'critical');
    assert.equal(oom.count, 1);
    assert.ok(oom.suggestedFix.length > 0);
  });
});

// ── Port conflict ───────────────────────────────────────────────────────

describe('clusterCiLog — port conflict', () => {
  it('detects EADDRINUSE as port-conflict / high severity', () => {
    const log = [
      'Error: listen EADDRINUSE: address already in use :::3000',
      'at Server.setupListenHandle',
    ].join('\n');

    const report = clusterCiLog({ logText: log });
    const cluster = report.clusters.find((c) => c.pattern === 'port-conflict');
    assert.ok(cluster);
    assert.equal(cluster.severity, 'high');
    assert.ok(cluster.count >= 1);
  });
});

// ── DB lock ─────────────────────────────────────────────────────────────

describe('clusterCiLog — DB lock', () => {
  it('detects deadlock / database-is-locked as db-lock', () => {
    const log = [
      'error: deadlock detected',
      'error: database is locked',
      'fatal: Lock wait timeout exceeded; try restarting transaction',
    ].join('\n');

    const report = clusterCiLog({ logText: log });
    const cluster = report.clusters.find((c) => c.pattern === 'db-lock');
    assert.ok(cluster);
    assert.equal(cluster.count, 3);
    assert.equal(cluster.severity, 'high');
  });
});

// ── Network timeout ─────────────────────────────────────────────────────

describe('clusterCiLog — network timeout', () => {
  it('detects ETIMEDOUT / ECONNREFUSED / fetch failed', () => {
    const log = [
      'Error: connect ETIMEDOUT 10.0.0.1:443',
      'FetchError: request timeout',
      'TypeError: fetch failed',
    ].join('\n');

    const report = clusterCiLog({ logText: log });
    const cluster = report.clusters.find((c) => c.pattern === 'network-timeout');
    assert.ok(cluster);
    assert.equal(cluster.count, 3);
  });
});

// ── Unknown lines ───────────────────────────────────────────────────────

describe('clusterCiLog — unknown error lines', () => {
  it('collects up-to-N unknown error lines and creates no cluster for them', () => {
    const log = [
      'error: something weird happened no one has seen',
      'fatal: a mysterious goose appeared',
    ].join('\n');

    const report = clusterCiLog({ logText: log });
    assert.equal(report.errorLines, 2);
    assert.equal(report.clusters.length, 0);
    assert.equal(report.unknownExcerpt.length, 2);
  });
});

// ── Sorting ─────────────────────────────────────────────────────────────

describe('clusterCiLog — severity-first sort', () => {
  it('sorts clusters by severity desc, then count desc', () => {
    const log = [
      // one low flake
      'retrying after failure: intermittent failure',
      // three network timeouts (medium)
      'error: ETIMEDOUT',
      'error: ECONNREFUSED',
      'error: fetch failed',
      // one OOM (critical, count=1) — should still be first
      'FATAL ERROR: JavaScript heap out of memory',
    ].join('\n');

    const report = clusterCiLog({ logText: log });
    assert.ok(report.clusters.length >= 3);
    assert.equal(report.clusters[0].severity, 'critical');
    assert.equal(report.clusters[0].pattern, 'oom');

    // The second cluster should be the high/medium tier, not the low one.
    const lowIdx = report.clusters.findIndex((c) => c.severity === 'low');
    const medIdx = report.clusters.findIndex((c) => c.severity === 'medium');
    if (lowIdx !== -1 && medIdx !== -1) {
      assert.ok(medIdx < lowIdx, 'medium clusters must sort before low ones');
    }
  });
});

// ── Confidence math ─────────────────────────────────────────────────────

describe('clusterCiLog — confidence math', () => {
  it('count=1 non-critical → ~0.33; count=3 → 1.0; critical gets +0.2 bonus', () => {
    // 1x network timeout (medium) → base = 1/3 ≈ 0.333, no bonus.
    const single = clusterCiLog({ logText: 'error: ECONNREFUSED' });
    const timeoutCluster = single.clusters.find((c) => c.pattern === 'network-timeout');
    assert.ok(timeoutCluster);
    assert.ok(timeoutCluster.confidence >= 0.3 && timeoutCluster.confidence <= 0.4,
      `expected ~0.33, got ${timeoutCluster.confidence}`);

    // 3x timeouts → base = 1.0, no bonus → clamped at 1.
    const triple = clusterCiLog({
      logText: [
        'error: ECONNREFUSED',
        'error: ETIMEDOUT',
        'error: fetch failed',
      ].join('\n'),
    });
    const triCluster = triple.clusters.find((c) => c.pattern === 'network-timeout');
    assert.ok(triCluster);
    assert.equal(triCluster.confidence, 1);

    // 1x OOM (critical) → base = 0.333 + 0.2 = 0.533.
    const oom = clusterCiLog({ logText: 'FATAL ERROR: JavaScript heap out of memory' });
    const oomCluster = oom.clusters.find((c) => c.pattern === 'oom');
    assert.ok(oomCluster);
    assert.ok(oomCluster.confidence > 0.5 && oomCluster.confidence <= 0.6,
      `expected ~0.533, got ${oomCluster.confidence}`);
  });
});
