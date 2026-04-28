/**
 * Phase 3 — output-token ceiling.
 *
 * Verifies the per-stage limit table covers every stage; that the api-adapter
 * sends `max_tokens` in the request body when setMaxOutputTokens() is called;
 * that finish_reason='length' is normalized to stop_reason='max_tokens'; and
 * that the claude-adapter captures stop_reason from assistant frames.
 *
 * Truncation telemetry (the warning emit on max_tokens) is exercised by
 * unit-mocking the agent state in pipeline-runner indirectly via these
 * adapter-level checks — the runner simply forwards what the adapter reports.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  STAGE_OUTPUT_LIMITS,
  STAGE_OUTPUT_LIMIT_FALLBACK,
  maxOutputTokensForStage,
  listStageNames,
} from '../pipeline-runner.js';
import { ApiAdapter } from '../adapters/api-adapter.js';
import { ClaudeAdapter } from '../adapters/claude-adapter.js';

describe('STAGE_OUTPUT_LIMITS', () => {
  it('covers every pipeline stage', () => {
    for (const name of listStageNames()) {
      assert.ok(
        STAGE_OUTPUT_LIMITS[name] !== undefined,
        `STAGE_OUTPUT_LIMITS missing entry for ${name}`,
      );
    }
  });

  it('uses positive integer ceilings', () => {
    for (const [name, limit] of Object.entries(STAGE_OUTPUT_LIMITS)) {
      assert.equal(Number.isInteger(limit), true, `${name} limit must be integer`);
      assert.ok(limit > 0, `${name} limit must be positive`);
    }
  });

  it('build has the largest ceiling (codegen needs the headroom)', () => {
    const build = STAGE_OUTPUT_LIMITS.build;
    for (const [name, limit] of Object.entries(STAGE_OUTPUT_LIMITS)) {
      if (name === 'build') continue;
      assert.ok(limit <= build, `${name} (${limit}) should not exceed build (${build})`);
    }
  });

  it('maxOutputTokensForStage returns table values + fallback for unknowns', () => {
    assert.equal(maxOutputTokensForStage('build'), STAGE_OUTPUT_LIMITS.build);
    assert.equal(maxOutputTokensForStage('clarify'), STAGE_OUTPUT_LIMITS.clarify);
    assert.equal(maxOutputTokensForStage('not-a-real-stage'), STAGE_OUTPUT_LIMIT_FALLBACK);
  });
});

describe('ApiAdapter — output ceiling + truncation reporting', () => {
  it('passes max_tokens in the request body when setMaxOutputTokens is called', async () => {
    let capturedBody: Record<string, unknown> | null = null;

    // Stub fetch so we can inspect the outgoing body and feed back a single
    // SSE chunk so the adapter completes cleanly.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      const sse =
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n';
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    try {
      const adapter = new ApiAdapter(
        {
          prompt: 'hello',
          model: 'gpt-4o-mini',
          sessionId: 'sess-test-1',
          cwd: process.cwd(),
        },
        'openai',
      );
      // Force-supply API key so the adapter doesn't bail early.
      process.env.OPENAI_API_KEY = 'test-key';

      adapter.setMaxOutputTokens(1234);

      await new Promise<void>((resolve) => {
        adapter.on('exit', () => resolve());
        adapter.start();
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(capturedBody, 'fetch should have been called');
    assert.equal((capturedBody as { max_tokens?: number }).max_tokens, 1234);
  });

  it("normalizes finish_reason 'length' → stopReason 'max_tokens'", async () => {
    let resultStopReason: string | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const sse =
        'data: {"choices":[{"delta":{"content":"truncated body"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
        'data: [DONE]\n\n';
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    try {
      const adapter = new ApiAdapter(
        {
          prompt: 'hello',
          model: 'gpt-4o-mini',
          sessionId: 'sess-test-2',
          cwd: process.cwd(),
        },
        'openai',
      );
      process.env.OPENAI_API_KEY = 'test-key';

      await new Promise<void>((resolve) => {
        adapter.on('result', (data) => {
          resultStopReason = data.cost.stopReason;
        });
        adapter.on('exit', () => resolve());
        adapter.start();
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(resultStopReason, 'max_tokens');
  });

  it("preserves natural finish_reason 'stop' as-is on the cost object", async () => {
    let resultStopReason: string | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const sse =
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n';
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    try {
      const adapter = new ApiAdapter(
        {
          prompt: 'hi',
          model: 'gpt-4o-mini',
          sessionId: 'sess-test-3',
          cwd: process.cwd(),
        },
        'openai',
      );
      process.env.OPENAI_API_KEY = 'test-key';

      await new Promise<void>((resolve) => {
        adapter.on('result', (data) => {
          resultStopReason = data.cost.stopReason;
        });
        adapter.on('exit', () => resolve());
        adapter.start();
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(resultStopReason, 'stop');
  });
});

describe('ClaudeAdapter — capabilities + stop_reason capture', () => {
  it('reports capabilities.maxOutputTokens=false today (CLI lacks the flag)', () => {
    const adapter = new ClaudeAdapter({
      prompt: 'unused',
      model: 'claude-sonnet-4-6',
      sessionId: 'sess-claude',
      cwd: process.cwd(),
    });
    assert.equal(adapter.capabilities.maxOutputTokens, false);
    // setMaxOutputTokens is therefore a no-op — must not throw.
    assert.doesNotThrow(() => adapter.setMaxOutputTokens(1000));
  });

  it("captures stop_reason='max_tokens' from assistant frames and stamps onto cost", async () => {
    // We simulate the parser by feeding a fake stream-json buffer through a
    // fresh adapter instance. We avoid spawning the CLI by reaching into the
    // private parseStreamJson via Object property access (test-only seam).
    const adapter = new ClaudeAdapter({
      prompt: 'unused',
      model: 'claude-sonnet-4-6',
      sessionId: 'sess-claude-stop',
      cwd: process.cwd(),
    });

    let capturedStopReason: string | undefined;
    adapter.on('result', (data) => {
      capturedStopReason = data.cost.stopReason;
    });

    const assistantFrame = JSON.stringify({
      type: 'assistant',
      message: {
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'truncated' }],
      },
    });
    const resultFrame = JSON.stringify({
      type: 'result',
      result: 'truncated',
      usage: { input_tokens: 10, output_tokens: 16000 },
      total_cost_usd: 0,
      duration_ms: 0,
      session_id: 'sess-claude-stop',
    });

    // Reach into the parser via a typed cast so we don't spawn a real CLI.
    const parser = (adapter as unknown as {
      parseStreamJson: (buf: Buffer) => void;
    }).parseStreamJson.bind(adapter);

    parser(Buffer.from(assistantFrame + '\n' + resultFrame + '\n'));

    assert.equal(capturedStopReason, 'max_tokens');
  });
});
