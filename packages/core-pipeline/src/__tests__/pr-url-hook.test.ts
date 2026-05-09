/**
 * Phase A5 — attachPrUrlHook.
 *
 * Coverage:
 *   - artifact:emitted with string payload.data → onPrFound called per URL
 *   - artifact:emitted with { text }/{ content } payload → also scanned
 *   - dedupe across emissions
 *   - scanText() exposed for transports that don't go through the bus
 *   - non-global regex throws
 *   - onPrFound throwing doesn't crash the bus listener
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryEventBus,
  attachPrUrlHook,
  PR_URL_REGEX,
} from '../index.js';

describe('attachPrUrlHook', () => {
  it('extracts a PR URL from artifact:emitted string payloads', async () => {
    const found: string[] = [];
    const bus = new InMemoryEventBus();
    attachPrUrlHook(bus, { onPrFound: (u) => found.push(u) });
    await bus.emit({
      hook: 'artifact:emitted',
      runId: 'r1',
      stepId: 'ship',
      ts: new Date().toISOString(),
      payload: { data: 'opened https://github.com/acme/repo/pull/123 and ready' },
    });
    assert.deepEqual(found, ['https://github.com/acme/repo/pull/123']);
  });

  it('extracts from { text } and { content } shaped payloads', async () => {
    const found: string[] = [];
    const bus = new InMemoryEventBus();
    attachPrUrlHook(bus, { onPrFound: (u) => found.push(u) });
    await bus.emit({
      hook: 'artifact:emitted',
      runId: 'r1', ts: new Date().toISOString(),
      payload: { data: { text: 'see https://github.com/o/r/pull/1' } },
    });
    await bus.emit({
      hook: 'artifact:emitted',
      runId: 'r1', ts: new Date().toISOString(),
      payload: { data: { content: 'and https://github.com/o/r/pull/2' } },
    });
    assert.deepEqual(found, ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2']);
  });

  it('deduplicates across multiple emissions', async () => {
    const found: string[] = [];
    const bus = new InMemoryEventBus();
    attachPrUrlHook(bus, { onPrFound: (u) => found.push(u) });
    const url = 'https://github.com/o/r/pull/5';
    await bus.emit({ hook: 'artifact:emitted', runId: 'r', ts: 't', payload: { data: url } });
    await bus.emit({ hook: 'artifact:emitted', runId: 'r', ts: 't', payload: { data: url } });
    await bus.emit({ hook: 'artifact:emitted', runId: 'r', ts: 't', payload: { data: `mention ${url} again` } });
    assert.deepEqual(found, [url]);
  });

  it('extracts multiple URLs from a single payload', async () => {
    const found: string[] = [];
    const bus = new InMemoryEventBus();
    attachPrUrlHook(bus, { onPrFound: (u) => found.push(u) });
    await bus.emit({
      hook: 'artifact:emitted',
      runId: 'r1', ts: 't',
      payload: {
        data: 'https://github.com/a/b/pull/1 and https://github.com/c/d/pull/2 done',
      },
    });
    assert.deepEqual(found, [
      'https://github.com/a/b/pull/1',
      'https://github.com/c/d/pull/2',
    ]);
  });

  it('scanText() feeds text from transports outside the bus', async () => {
    const found: string[] = [];
    const bus = new InMemoryEventBus();
    const handle = attachPrUrlHook(bus, { onPrFound: (u) => found.push(u) });
    handle.scanText('tool_result chunk: https://github.com/o/r/pull/9');
    assert.deepEqual(found, ['https://github.com/o/r/pull/9']);
    // dedupe across bus + scanText
    handle.scanText('https://github.com/o/r/pull/9');
    assert.deepEqual(found, ['https://github.com/o/r/pull/9']);
    assert.equal(handle.urls.size, 1);
  });

  it('throws when regex is not global', () => {
    const bus = new InMemoryEventBus();
    assert.throws(
      () => attachPrUrlHook(bus, {
        onPrFound: () => {},
        regex: /pull\/\d+/,  // not global
      }),
      /regex must be global/,
    );
  });

  it('onPrFound throwing does not break the listener (other URLs still flow)', async () => {
    const found: string[] = [];
    let calls = 0;
    const bus = new InMemoryEventBus();
    attachPrUrlHook(bus, {
      onPrFound: (u) => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        found.push(u);
      },
    });
    await bus.emit({
      hook: 'artifact:emitted',
      runId: 'r', ts: 't',
      payload: { data: 'https://github.com/a/b/pull/1 https://github.com/a/b/pull/2' },
    });
    // First throws, second succeeds → recorded.
    assert.deepEqual(found, ['https://github.com/a/b/pull/2']);
  });

  it('PR_URL_REGEX is exported and matches the documented shape', () => {
    PR_URL_REGEX.lastIndex = 0;
    const text = 'https://github.com/some-org/some.repo/pull/1234';
    const match = text.match(PR_URL_REGEX);
    assert.deepEqual(match, [text]);
  });
});
