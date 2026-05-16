import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Counter, Gauge, Histogram, registry, metrics } from '../observability/metrics.js';
import { Logger } from '../observability/logger.js';

describe('Prometheus collectors (P7)', () => {
  it('Counter renders with labels', () => {
    const c = new Counter('test_counter', 'test counter');
    c.inc({ kind: 'a' });
    c.inc({ kind: 'a' });
    c.inc({ kind: 'b' });
    const out = c.render();
    assert.match(out, /# HELP test_counter test counter/);
    assert.match(out, /# TYPE test_counter counter/);
    assert.match(out, /test_counter\{kind="a"\} 2/);
    assert.match(out, /test_counter\{kind="b"\} 1/);
  });

  it('Gauge updates last-write per label set', () => {
    const g = new Gauge('test_gauge', 'test gauge');
    g.set(5, { repo: 'a' });
    g.set(7, { repo: 'a' });
    assert.match(g.render(), /test_gauge\{repo="a"\} 7/);
  });

  it('Histogram tracks buckets, sum, count', () => {
    const h = new Histogram('test_hist', 'test', [0.1, 0.5, 1]);
    h.observe(0.05);
    h.observe(0.3);
    h.observe(0.9);
    const out = h.render();
    assert.match(out, /test_hist_count\{?\}? 3/);
    assert.match(out, /test_hist_sum\{?\}? 1.25/);
    assert.match(out, /test_hist_bucket\{le="0.1"\} 1/);
    assert.match(out, /test_hist_bucket\{le="\+Inf"\} 3/);
  });

  it('registry renders the prelude for all pre-declared metrics', () => {
    metrics.queriesTotal.inc({ mode: 'hybrid' });
    const out = registry.render();
    assert.match(out, /code_search_queries_total/);
    assert.match(out, /code_search_query_duration_seconds/);
  });
});

describe('Logger (P7)', () => {
  it('emits structured JSON when enabled', () => {
    const lines: string[] = [];
    const log = new Logger({ structured: true, write: (l) => lines.push(l) });
    log.info('hello', { query: 'auth' });
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.msg, 'hello');
    assert.equal(parsed.query, 'auth');
    assert.equal(parsed.level, 'info');
    assert.ok(parsed.ts);
  });

  it('respects level threshold', () => {
    const lines: string[] = [];
    const log = new Logger({ structured: true, level: 'warn', write: (l) => lines.push(l) });
    log.info('skipped');
    log.warn('kept');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /"kept"/);
  });

  it('falls back to text mode when structured=false', () => {
    const lines: string[] = [];
    const log = new Logger({ structured: false, write: (l) => lines.push(l) });
    log.error('boom');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /ERROR/);
    assert.match(lines[0], /boom/);
  });
});
