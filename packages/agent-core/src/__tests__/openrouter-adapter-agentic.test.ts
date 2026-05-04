/**
 * Phase 4-mirror — agentic loop tests for the OpenRouter adapter.
 *
 * OpenRouter is OpenAI-compatible, so the wire format is SSE with
 * `data: ...` lines and tool_calls streamed as DELTAS (arguments
 * arrive in pieces, indexed by tool-call index). These tests verify
 * the reassembly + multi-turn loop work the same shape as the Ollama
 * agentic suite.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { OpenRouterAdapter } from '../openrouter-adapter.js';
import type { ModelAdapterConfig, ToolExecutorLike, ToolCall, ToolSchema } from '../types.js';

// ────────────────────────────────────────────────────────────────────────
// SSE fixtures
// ────────────────────────────────────────────────────────────────────────

function sseLine(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function sseTextOnly(text: string, opts: { cost?: number } = {}): Response {
  const body =
    sseLine({ choices: [{ index: 0, delta: { content: text } }] }) +
    sseLine({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        ...(opts.cost !== undefined ? { cost: opts.cost } : {}),
      },
    }) +
    'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/**
 * One assistant turn that emits a tool_call. Crucially, OpenAI streams
 * arguments as multiple chunks — we simulate that to exercise the
 * reassembly code path.
 */
function sseToolCall(
  name: string,
  argsJson: string,
  opts: { id?: string; trailingText?: string } = {},
): Response {
  const id = opts.id ?? 'call_test123';
  const half = Math.floor(argsJson.length / 2);
  const argsPart1 = argsJson.slice(0, half);
  const argsPart2 = argsJson.slice(half);

  const lines: string[] = [];
  if (opts.trailingText) {
    lines.push(sseLine({ choices: [{ index: 0, delta: { content: opts.trailingText } }] }));
  }
  // First chunk: name + id + first half of arguments
  lines.push(sseLine({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: argsPart1 } }],
      },
    }],
  }));
  // Second chunk: rest of arguments only (id + name omitted, accumulator extends)
  lines.push(sseLine({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index: 0, function: { arguments: argsPart2 } }],
      },
    }],
  }));
  // Final chunk: finish_reason + usage
  lines.push(sseLine({
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  }));
  lines.push('data: [DONE]\n\n');

  return new Response(lines.join(''), { status: 200 });
}

class StubWritable {
  chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  }
  end(): void { /* noop */ }
  on(): void { /* noop */ }
  parsedLines(): unknown[] {
    return this.chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
}

class FakeExecutor implements ToolExecutorLike {
  calls: ToolCall[] = [];
  constructor(private readonly handlers: Record<string, (args: Record<string, unknown>) => { content: string; isError: boolean }>) {}

  listSchemas(): ToolSchema[] {
    return Object.keys(this.handlers).map((name) => ({
      name,
      description: `${name} tool`,
      inputSchema: { type: 'object', properties: {} },
    }));
  }

  async execute(call: ToolCall): Promise<{ content: string; isError: boolean }> {
    this.calls.push(call);
    const h = this.handlers[call.name];
    if (!h) return { content: `unknown ${call.name}`, isError: true };
    return h(call.arguments);
  }
}

const baseConfig: ModelAdapterConfig = {
  userPrompt: 'do the thing',
  model: 'anthropic/claude-sonnet-4-6',
  workingDir: '/tmp',
  stage: 'build',
  persona: 'engineer',
};

let originalFetch: typeof fetch;
let originalKey: string | undefined;
before(() => {
  originalFetch = globalThis.fetch;
  originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-test';
});
after(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe('OpenRouterAdapter — single-shot (no toolExecutor)', () => {
  it('completes one turn, emits a result with tokens + cost', async () => {
    globalThis.fetch = (async () => sseTextOnly('hello world', { cost: 0.0042 })) as typeof fetch;
    const adapter = new OpenRouterAdapter();
    const sink = new StubWritable();

    const r = await adapter.run({ ...baseConfig }, sink as unknown as NodeJS.WritableStream);

    assert.equal(r.output, 'hello world');
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(r.toolCallCount, 0);
    assert.equal(r.inputTokens, 12);
    assert.equal(r.outputTokens, 7);
    assert.equal(r.costUsd, 0.0042, 'should prefer OpenRouter-reported cost');
  });

  it('falls back to pricing table when usage.cost is absent', async () => {
    globalThis.fetch = (async () => sseTextOnly('x')) as typeof fetch;  // no cost field
    const adapter = new OpenRouterAdapter();
    const r = await adapter.run({ ...baseConfig }, new StubWritable() as unknown as NodeJS.WritableStream);

    // anthropic/claude-sonnet-4-6 is in OPENROUTER_PRICING at [3, 15]
    // 12 in_tokens × 3/1M + 7 out × 15/1M = 0.000036 + 0.000105 = 0.000141
    assert.ok(r.costUsd > 0, 'should compute from pricing fallback');
    assert.ok(Math.abs(r.costUsd - 0.000141) < 0.000001);
  });

  it('throws clean error when API key is missing', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const adapter = new OpenRouterAdapter();
    await assert.rejects(
      () => adapter.run({ ...baseConfig }, new StubWritable() as unknown as NodeJS.WritableStream),
      /OPENROUTER_API_KEY is not set/,
    );
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
  });
});

describe('OpenRouterAdapter — agentic loop', () => {
  it('reassembles tool_call arguments from streamed deltas and executes', async () => {
    let turn = 0;
    globalThis.fetch = (async () => {
      turn++;
      if (turn === 1) return sseToolCall('list', '{"path":"src"}');
      return sseTextOnly('done');
    }) as typeof fetch;

    const fx = new FakeExecutor({ list: () => ({ content: 'a.ts\nb.ts', isError: false }) });
    const adapter = new OpenRouterAdapter();
    const sink = new StubWritable();

    const r = await adapter.run(
      { ...baseConfig, toolExecutor: fx },
      sink as unknown as NodeJS.WritableStream,
    );

    assert.equal(turn, 2);
    assert.equal(fx.calls.length, 1);
    assert.equal(fx.calls[0].name, 'list');
    assert.deepEqual(fx.calls[0].arguments, { path: 'src' }, 'args reassembled from 2 chunks');
    assert.equal(r.toolCallCount, 1);
    assert.equal(r.stopReason, 'end_turn');

    const lines = sink.parsedLines() as Array<{ message?: { content: Array<{ type: string }> } }>;
    const toolUse = lines.find((l) => l.message?.content?.[0]?.type === 'tool_use');
    const toolResult = lines.find((l) => l.message?.content?.[0]?.type === 'tool_result');
    assert.ok(toolUse, 'tool_use line emitted');
    assert.ok(toolResult, 'tool_result line emitted');
  });

  it('handles three sequential tool calls before completing', async () => {
    let turn = 0;
    globalThis.fetch = (async () => {
      turn++;
      if (turn <= 3) return sseToolCall('grep', `{"pattern":"p${turn}"}`, { id: `call_${turn}` });
      return sseTextOnly('finally done');
    }) as typeof fetch;

    const fx = new FakeExecutor({
      grep: (args) => ({ content: `match for ${args.pattern}`, isError: false }),
    });
    const adapter = new OpenRouterAdapter();

    const r = await adapter.run(
      { ...baseConfig, toolExecutor: fx },
      new StubWritable() as unknown as NodeJS.WritableStream,
    );

    assert.equal(turn, 4);
    assert.equal(fx.calls.length, 3);
    assert.equal(r.stopReason, 'end_turn');
  });

  it('hits iteration cap → stopReason: iteration_limit', async () => {
    globalThis.fetch = (async () => sseToolCall('list', '{}')) as typeof fetch;
    const fx = new FakeExecutor({ list: () => ({ content: 'x', isError: false }) });
    const adapter = new OpenRouterAdapter();

    const r = await adapter.run(
      { ...baseConfig, toolExecutor: fx, maxToolIterations: 3 },
      new StubWritable() as unknown as NodeJS.WritableStream,
    );

    assert.equal(r.stopReason, 'iteration_limit');
    assert.equal(fx.calls.length, 3);
  });

  it('surfaces tool errors with is_error:true so the model can recover', async () => {
    let turn = 0;
    globalThis.fetch = (async () => {
      turn++;
      if (turn === 1) return sseToolCall('write_file', '{"path":"/etc/passwd","content":"x"}');
      return sseTextOnly('ok will retry differently');
    }) as typeof fetch;

    const fx = new FakeExecutor({
      write_file: () => ({ content: 'Path escapes workingDir', isError: true }),
    });
    const adapter = new OpenRouterAdapter();
    const sink = new StubWritable();

    const r = await adapter.run(
      { ...baseConfig, toolExecutor: fx },
      sink as unknown as NodeJS.WritableStream,
    );

    assert.equal(r.stopReason, 'end_turn');
    const lines = sink.parsedLines() as Array<{ message?: { content: Array<{ type: string; is_error?: boolean }> } }>;
    const errResult = lines.find((l) =>
      l.message?.content?.[0]?.type === 'tool_result' &&
      l.message.content[0].is_error === true,
    );
    assert.ok(errResult, 'tool_result emitted with is_error:true');
  });

  it('passes tools + tool_choice + max_tokens in the request body', async () => {
    let observedBody: string | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      observedBody = init?.body as string;
      return sseTextOnly('done');
    }) as typeof fetch;

    const fx = new FakeExecutor({ list: () => ({ content: 'x', isError: false }) });
    const adapter = new OpenRouterAdapter();
    await adapter.run(
      { ...baseConfig, toolExecutor: fx, maxOutputTokens: 4096 },
      new StubWritable() as unknown as NodeJS.WritableStream,
    );

    const body = JSON.parse(observedBody as string);
    assert.equal(Array.isArray(body.tools), true);
    assert.equal(body.tools[0].type, 'function');
    assert.equal(body.tools[0].function.name, 'list');
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });

  it('sends OpenRouter attribution headers', async () => {
    let observedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      observedHeaders = init?.headers as Record<string, string>;
      return sseTextOnly('hi');
    }) as typeof fetch;

    const adapter = new OpenRouterAdapter();
    await adapter.run({ ...baseConfig }, new StubWritable() as unknown as NodeJS.WritableStream);

    assert.equal(observedHeaders!['HTTP-Referer'], 'https://anvil.dev');
    assert.equal(observedHeaders!['X-Title'], 'Anvil');
    assert.match(observedHeaders!['Authorization'], /^Bearer sk-or-test/);
  });

  it('survives concurrent run() calls on the same adapter instance', async () => {
    // Repro: per-repo stages (build for backend + frontend) call the
    // same singleton adapter in parallel. Pre-fix the adapter held a
    // single instance-level abortController; one call's `finally`
    // nulled it out while the other was mid-loop, crashing with
    // "Cannot read properties of null (reading 'signal')".
    let inflight = 0;
    let maxInflight = 0;
    globalThis.fetch = (async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      // Hold the connection open briefly so both calls overlap.
      await new Promise((r) => setTimeout(r, 30));
      inflight -= 1;
      return sseTextOnly('ok');
    }) as typeof fetch;

    const adapter = new OpenRouterAdapter();
    const results = await Promise.all([
      adapter.run({ ...baseConfig, userPrompt: 'first' }, new StubWritable() as unknown as NodeJS.WritableStream),
      adapter.run({ ...baseConfig, userPrompt: 'second' }, new StubWritable() as unknown as NodeJS.WritableStream),
    ]);

    assert.equal(maxInflight, 2, 'both calls must run concurrently');
    assert.equal(results[0].stopReason, 'end_turn');
    assert.equal(results[1].stopReason, 'end_turn');
  });

  it('falls back to {_raw} when tool_call arguments are malformed JSON', async () => {
    let turn = 0;
    globalThis.fetch = (async () => {
      turn++;
      if (turn === 1) return sseToolCall('grep', 'not-valid-json{');
      return sseTextOnly('done');
    }) as typeof fetch;

    const fx = new FakeExecutor({ grep: (args) => ({ content: JSON.stringify(args), isError: false }) });
    const adapter = new OpenRouterAdapter();

    await adapter.run(
      { ...baseConfig, toolExecutor: fx },
      new StubWritable() as unknown as NodeJS.WritableStream,
    );

    assert.equal(fx.calls[0].arguments._raw, 'not-valid-json{');
  });
});
