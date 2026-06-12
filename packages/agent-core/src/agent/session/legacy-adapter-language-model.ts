/**
 * `legacyAdapterToLanguageModel(adapter)` — the migration shim named in
 * `types.ts`: presents a legacy `ModelAdapter` (which implements the push
 * surface `run(config, output)`) as a `LanguageModel` (the pull surface
 * `invoke` / `invokeStream`) so the `LlmRouter` can drive every provider
 * through one interface.
 *
 * Scope (Phase 1): the THIN single-shot surface only — prompt → result, no
 * tool execution, no durable recorder. Tool-use blocks the model emits are
 * surfaced in `InvokeResult.toolCalls` / `StreamEvent` but NOT executed; the
 * agentic loop (tool execution, turn recording, prefill resume) lives on the
 * router's `runAgent` / `session` surfaces, which build a rich
 * `ModelAdapterConfig` and drive `adapter.run()` directly.
 *
 * Bridging push→pull: `run()` writes Anvil Stream Format NDJSON to a Writable
 * sink; we parse each line into a `StreamEvent` and hand it to a pull-based
 * async generator backed by a small notify-queue. The parsing mirrors
 * `LanguageModelBridge.handleStreamLine` (the result frame is taken from the
 * resolved `ModelAdapterResult`, not the stream).
 */

import { Writable } from 'node:stream';
import type {
  LanguageModel,
  LanguageModelInvokeOptions,
  InvokeResult,
  StreamEvent,
  ToolCall,
  ModelAdapter,
  ModelAdapterConfig,
} from '../../types.js';

/** Map a legacy provider stop reason → the `StreamEvent` finish reason. */
function mapFinishReason(stop: string | undefined): 'end' | 'tool-use' | 'length' | 'error' {
  switch (stop) {
    case 'tool_use':
      return 'tool-use';
    case 'max_tokens':
    case 'length':
      return 'length';
    default:
      return 'end';
  }
}

/**
 * Flatten a thin `LanguageModelInvokeOptions.messages[]` into the legacy
 * `ModelAdapterConfig`'s `projectPrompt` (system) + `userPrompt` (the rest).
 */
function buildAdapterConfig(adapter: ModelAdapter, opts: LanguageModelInvokeOptions): ModelAdapterConfig {
  const system: string[] = [];
  const turns: string[] = [];
  for (const m of opts.messages) {
    if (m.role === 'system') system.push(m.content);
    else turns.push(m.role === 'assistant' ? `Assistant: ${m.content}` : m.content);
  }
  return {
    userPrompt: turns.join('\n\n'),
    projectPrompt: system.length > 0 ? system.join('\n\n') : undefined,
    model: opts.model,
    workingDir: process.cwd(),
    stage: 'router',
    persona: 'router',
    maxOutputTokens: opts.maxTokens,
  };
}

class LegacyAdapterLanguageModel implements LanguageModel {
  constructor(private readonly adapter: ModelAdapter) {}

  get provider() {
    return this.adapter.provider;
  }

  get capabilities() {
    return this.adapter.capabilities;
  }

  supportsModel(modelId: string): boolean {
    return this.adapter.supportsModel(modelId);
  }

  getModelPricing(modelId: string): [number, number] | null {
    return this.adapter.getModelPricing(modelId);
  }

  checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
    return this.adapter.checkAvailability();
  }

  /**
   * Stream provider output as `StreamEvent`s. The generator's RETURN value is
   * the fully-assembled `InvokeResult` (cost/usage/model come from the
   * resolved `ModelAdapterResult`, which the stream itself doesn't carry), so
   * `invoke()` can drive this generator and read the return value rather than
   * running the adapter twice.
   */
  invokeStream(opts: LanguageModelInvokeOptions): AsyncGenerator<StreamEvent, InvokeResult> {
    return this.#stream(opts);
  }

  async invoke(opts: LanguageModelInvokeOptions): Promise<InvokeResult> {
    const it = this.#stream(opts);
    while (true) {
      const step = await it.next();
      if (step.done) return step.value;
    }
  }

  async *#stream(opts: LanguageModelInvokeOptions): AsyncGenerator<StreamEvent, InvokeResult> {
    const config = buildAdapterConfig(this.adapter, opts);
    const queue: StreamEvent[] = [];
    const toolCalls: ToolCall[] = [];
    let textAcc = '';
    let notify: (() => void) | null = null;
    let finished = false;
    let toolCounter = 0;

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: { type?: string; message?: { content?: Array<Record<string, unknown>> } };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (parsed?.type !== 'assistant' || !Array.isArray(parsed.message?.content)) return;
      for (const block of parsed.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textAcc += block.text;
          queue.push({ type: 'text-delta', text: block.text });
        } else if (block.type === 'thinking' && typeof block.text === 'string') {
          queue.push({ type: 'reasoning-delta', text: block.text });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          const call: ToolCall = {
            id: typeof block.id === 'string' ? block.id : `call-${++toolCounter}`,
            name: block.name,
            arguments: (block.input as Record<string, unknown>) ?? {},
          };
          toolCalls.push(call);
          queue.push({ type: 'tool-call', call });
        }
      }
      notify?.();
      notify = null;
    };

    let buffer = '';
    const sink = new Writable({
      write: (chunk, _enc, cb) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const l of lines) handleLine(l);
        cb();
      },
      final: (cb) => {
        if (buffer) {
          handleLine(buffer);
          buffer = '';
        }
        cb();
      },
    });

    // Cancellation: legacy adapters expose kill(), not a passed AbortSignal.
    const onAbort = (): void => this.adapter.kill?.();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let result: import('../../types.js').ModelAdapterResult | undefined;
    let runErr: Error | undefined;
    const runPromise = this.adapter
      .run(config, sink)
      .then((r) => {
        result = r;
      })
      .catch((e) => {
        runErr = e instanceof Error ? e : new Error(String(e));
      })
      .finally(() => {
        finished = true;
        notify?.();
        notify = null;
      });

    // Drain the queue as the sink fills it; wake on notify.
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (finished) break;
      await new Promise<void>((r) => {
        notify = r;
      });
    }
    await runPromise;
    opts.signal?.removeEventListener('abort', onAbort);

    if (runErr) {
      yield { type: 'finish', reason: 'error', error: runErr.message };
      throw runErr;
    }

    const usage = {
      inputTokens: result?.inputTokens ?? 0,
      outputTokens: result?.outputTokens ?? 0,
      cacheReadTokens: result?.cacheReadTokens ?? 0,
      cacheWriteTokens: result?.cacheWriteTokens ?? 0,
    };
    yield { type: 'usage', ...usage };

    const finishReason = toolCalls.length > 0 && !result?.output
      ? 'tool-use'
      : mapFinishReason(result?.stopReason);
    yield { type: 'finish', reason: finishReason };

    return {
      text: result?.output ?? textAcc,
      toolCalls,
      usage,
      costUsd: result?.costUsd ?? 0,
      durationMs: result?.durationMs ?? 0,
      provider: this.adapter.provider,
      model: opts.model,
      finishReason,
    };
  }
}

/**
 * Wrap a legacy `ModelAdapter` so it satisfies the `LanguageModel` interface.
 * The result is the unit the router's `AdapterResolver` hands back.
 */
export function legacyAdapterToLanguageModel(adapter: ModelAdapter): LanguageModel {
  return new LegacyAdapterLanguageModel(adapter);
}
