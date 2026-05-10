/**
 * H5 — `browser.extract` extractor: schema validation, dedup via
 * alreadyCollected, parsing of model output.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extract } from '../browser/extractor.js';

describe('extract', () => {
  it('parses a JSON-wrapped extractor response', async () => {
    const result = await extract(
      { query: 'list of products' },
      {
        pageText: 'Product A — $9.99\nProduct B — $19.99',
        invoke: async () => JSON.stringify({
          data: [
            { name: 'Product A', price: 9.99 },
            { name: 'Product B', price: 19.99 },
          ],
          truncated: false,
        }),
        modelOverride: 'test-model',
      },
    );
    assert.equal(result.truncated, false);
    assert.deepEqual(result.data, [
      { name: 'Product A', price: 9.99 },
      { name: 'Product B', price: 19.99 },
    ]);
  });

  it('handles markdown code fences', async () => {
    const result = await extract(
      { query: 'metadata' },
      {
        pageText: '<title>Hello</title>',
        invoke: async () => '```json\n{"data": {"title": "Hello"}}\n```',
        modelOverride: 'test-model',
      },
    );
    assert.deepEqual(result.data, { title: 'Hello' });
  });

  it('falls back to rawText when the model emits non-JSON', async () => {
    const result = await extract(
      { query: 'q' },
      {
        pageText: 'whatever',
        invoke: async () => 'not json at all',
        modelOverride: 'test-model',
      },
    );
    assert.deepEqual(result.data, { rawText: 'not json at all' });
  });

  it('forwards alreadyCollected to the user prompt', async () => {
    let lastUserPrompt = '';
    await extract(
      { query: 'list', alreadyCollected: ['id-1', 'id-2'] },
      {
        pageText: 'page',
        invoke: async (req) => { lastUserPrompt = req.userPrompt; return '{"data": []}'; },
        modelOverride: 'test-model',
      },
    );
    assert.match(lastUserPrompt, /skip these ids.*id-1, id-2/);
  });

  it('passes outputSchema as JSON Schema string', async () => {
    let lastUserPrompt = '';
    await extract(
      { query: 'q', outputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
      {
        pageText: 'page',
        invoke: async (req) => { lastUserPrompt = req.userPrompt; return '{"data": {}}'; },
        modelOverride: 'test-model',
      },
    );
    assert.match(lastUserPrompt, /OUTPUT_SCHEMA.*name/);
  });

  it('respects startFromChar window', async () => {
    let pageSent = '';
    const text = 'A'.repeat(500) + 'TARGET' + 'B'.repeat(500);
    await extract(
      { query: 'q', startFromChar: 500 },
      {
        pageText: text,
        invoke: async (req) => { pageSent = req.userPrompt; return '{"data": {}}'; },
        modelOverride: 'test-model',
      },
    );
    assert.match(pageSent, /TARGET/);
    assert.equal((pageSent.match(/A/g) ?? []).length < 100, true, 'should have skipped early A run');
  });
});
