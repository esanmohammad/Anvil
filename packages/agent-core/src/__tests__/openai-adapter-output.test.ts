/**
 * OpenAI adapter — output-token ceiling + finish_reason normalization.
 *
 * Verifies:
 *   - `ModelAdapterConfig.maxOutputTokens` is forwarded as `max_tokens` in
 *     the request body.
 *   - SSE `finish_reason: 'length'` is normalized to `stopReason: 'max_tokens'`
 *     on the returned `ModelAdapterResult`.
 *   - Natural finishes (`'stop'`) are passed through unchanged.
 *
 * Ported from packages/dashboard/server/__tests__/output-token-ceiling.test.ts
 * during the Phase 1 dashboard adapter consolidation — the behavior moved
 * from dashboard's local `ApiAdapter` into the agent-core adapter that the
 * dashboard now bridges to.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { OpenAIAdapter } from '../openai-adapter.js';

function nullSink(): NodeJS.WritableStream {
  return new Writable({ write: (_chunk, _enc, cb) => cb() });
}

function ssePayload(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('OpenAIAdapter — output-token ceiling', () => {
  it('forwards config.maxOutputTokens as max_tokens in the request body', async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return ssePayload(
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
      );
    }) as typeof fetch;

    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';

    try {
      const adapter = new OpenAIAdapter();
      await adapter.run(
        {
          userPrompt: 'hello',
          model: 'gpt-4o-mini',
          workingDir: process.cwd(),
          stage: '',
          persona: '',
          maxOutputTokens: 1234,
        },
        nullSink(),
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }

    assert.ok(capturedBody, 'fetch should have been called');
    assert.equal((capturedBody as { max_tokens?: number }).max_tokens, 1234);
  });

  it("normalizes finish_reason 'length' → stopReason 'max_tokens'", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ssePayload(
        'data: {"choices":[{"delta":{"content":"truncated"},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
          'data: [DONE]\n\n',
      )) as typeof fetch;

    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';

    let result;
    try {
      const adapter = new OpenAIAdapter();
      result = await adapter.run(
        {
          userPrompt: 'hi',
          model: 'gpt-4o-mini',
          workingDir: process.cwd(),
          stage: '',
          persona: '',
        },
        nullSink(),
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }

    assert.equal(result.stopReason, 'max_tokens');
  });

  it("normalizes natural finish_reason 'stop' → stopReason 'end_turn'", async () => {
    // Cross-provider normalization inherited from OpenRouterAdapter:
    // a tool-loop that ends with no further tool_calls reports
    // `stopReason: 'end_turn'` (Anthropic-style) regardless of which
    // upstream provider sent the raw `finish_reason: 'stop'`. This
    // gives downstream telemetry a single stop-reason vocabulary.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ssePayload(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
      )) as typeof fetch;

    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';

    let result;
    try {
      const adapter = new OpenAIAdapter();
      result = await adapter.run(
        {
          userPrompt: 'hi',
          model: 'gpt-4o-mini',
          workingDir: process.cwd(),
          stage: '',
          persona: '',
        },
        nullSink(),
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }

    assert.equal(result.stopReason, 'end_turn');
  });

  it('declares capabilities.maxOutputTokens=true and capabilities.cache=auto', () => {
    const adapter = new OpenAIAdapter();
    assert.equal(adapter.capabilities.maxOutputTokens, true);
    assert.equal(adapter.capabilities.cache, 'auto');
  });
});
