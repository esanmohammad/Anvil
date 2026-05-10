/**
 * H5 — RingBuffer + ConsoleRecorder + NetworkRecorder. Verifies bounded
 * size, cursor pagination, and filter semantics.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RingBuffer, ConsoleRecorder, NetworkRecorder } from '../browser/network-recorder.js';

describe('RingBuffer', () => {
  it('respects the size cap', () => {
    const buf = new RingBuffer<number>(3);
    for (let i = 0; i < 10; i++) buf.push(i);
    assert.equal(buf.size(), 3);
  });

  it('paginates via cursor', () => {
    const buf = new RingBuffer<string>(10);
    for (let i = 0; i < 5; i++) buf.push(`m${i}`);
    const a = buf.read(0, 2);
    assert.deepEqual(a.items, ['m0', 'm1']);
    const b = buf.read(a.nextCursor, 2);
    assert.deepEqual(b.items, ['m2', 'm3']);
    const c = buf.read(b.nextCursor, 10);
    assert.deepEqual(c.items, ['m4']);
  });

  it('returns empty when cursor is past the end', () => {
    const buf = new RingBuffer<string>(5);
    buf.push('a');
    const out = buf.read(99, 10);
    assert.deepEqual(out.items, []);
  });

  it('skips dropped items', () => {
    const buf = new RingBuffer<number>(3);
    for (let i = 0; i < 10; i++) buf.push(i);
    // Items 0..6 dropped; oldest visible is 7.
    const out = buf.read(0, 10);
    assert.deepEqual(out.items, [7, 8, 9]);
  });
});

describe('ConsoleRecorder', () => {
  it('filters by level', () => {
    const rec = new ConsoleRecorder();
    rec.record({ ts: '2026-01-01T00:00:00Z', level: 'log', text: 'hello' });
    rec.record({ ts: '2026-01-01T00:00:01Z', level: 'error', text: 'oops' });
    rec.record({ ts: '2026-01-01T00:00:02Z', level: 'warn', text: 'careful' });
    const r = rec.query({ level: 'error' });
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].text, 'oops');
  });

  it('paginates with cursor', () => {
    const rec = new ConsoleRecorder();
    for (let i = 0; i < 10; i++) {
      rec.record({ ts: '2026-01-01T00:00:00Z', level: 'log', text: `m${i}` });
    }
    const a = rec.query({ limit: 4 });
    assert.equal(a.messages.length, 4);
    const b = rec.query({ cursor: a.nextCursor, limit: 100 });
    assert.equal(b.messages.length, 6);
  });
});

describe('NetworkRecorder', () => {
  function rec(): NetworkRecorder {
    const r = new NetworkRecorder();
    r.record({ url: 'https://x.com/a', status: 200, method: 'GET', durationMs: 10, ts: '', failed: false });
    r.record({ url: 'https://x.com/b', status: 404, method: 'POST', durationMs: 20, ts: '', failed: false });
    r.record({ url: 'https://y.com/c', status: 500, method: 'GET', durationMs: 30, ts: '', failed: true });
    return r;
  }

  it('filters by status', () => {
    const r = rec().query({ status: 404 });
    assert.equal(r.requests.length, 1);
    assert.equal(r.requests[0].url, 'https://x.com/b');
  });

  it('filters by method', () => {
    const r = rec().query({ method: 'GET' });
    assert.equal(r.requests.length, 2);
  });

  it('filters by failed flag', () => {
    const r = rec().query({ failed: true });
    assert.equal(r.requests.length, 1);
    assert.equal(r.requests[0].url, 'https://y.com/c');
  });

  it('matches urlPattern globs', () => {
    const r = rec().query({ urlPattern: '*x.com*' });
    assert.equal(r.requests.length, 2);
  });
});
