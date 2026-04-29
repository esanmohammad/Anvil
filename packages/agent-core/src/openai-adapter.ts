/**
 * OpenAI HTTP API adapter.
 *
 * Uses native fetch() (Node 18+) — no npm dependencies required.
 * Streams SSE responses and emits Anvil Stream Format NDJSON.
 */

import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  ProviderCapabilities,
  ProviderName,
} from './types.js';
import { emitContent, emitResult } from './stream-format.js';

// ---------------------------------------------------------------------------
// Pricing table: [inputPer1MTokens, outputPer1MTokens]
// ---------------------------------------------------------------------------

const PRICING: Record<string, [number, number]> = {
  'gpt-4o':        [2.5, 10.0],
  'gpt-4o-mini':   [0.15, 0.6],
  'gpt-4-turbo':   [10.0, 30.0],
  'o1':            [15.0, 60.0],
  'o3':            [10.0, 40.0],
  'o3-mini':       [1.1, 4.4],
  'o4-mini':       [1.1, 4.4],
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAIAdapter implements ModelAdapter {
  readonly provider: ProviderName = 'openai';

  readonly capabilities: ProviderCapabilities = {
    tier: 'function-calling',
    streaming: true,
    toolUse: true,
    fileSystem: false,
    shellExecution: false,
    sessionResume: false,
  };

  /** Active AbortController — allows kill() to cancel an in-flight request. */
  protected abortController: AbortController | null = null;

  // -- Configuration helpers (overridden by subclasses) ---------------------

  protected getApiKey(): string | undefined {
    return process.env.OPENAI_API_KEY;
  }

  protected getBaseUrl(): string {
    return process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  }

  protected getExtraHeaders(): Record<string, string> {
    return {};
  }

  // -- Interface implementation ---------------------------------------------

  supportsModel(modelId: string): boolean {
    return /^(gpt-|o1|o3|o4|chatgpt-)/.test(modelId);
  }

  getModelPricing(modelId: string): [number, number] | null {
    return PRICING[modelId] ?? null;
  }

  async checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
    const key = this.getApiKey();
    if (!key) {
      return { available: false, error: `${this.provider.toUpperCase()}_API_KEY is not set` };
    }
    return { available: true };
  }

  async run(config: ModelAdapterConfig, output: NodeJS.WritableStream): Promise<ModelAdapterResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error(`${this.provider.toUpperCase()}_API_KEY is not set`);
    }

    const startMs = Date.now();
    this.abortController = new AbortController();

    // Apply timeout if configured
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (config.timeout && config.timeout > 0) {
      timeoutId = setTimeout(() => this.abortController?.abort(), config.timeout);
    }

    try {
      const body = this.buildRequestBody(config);
      const url = `${this.getBaseUrl()}/chat/completions`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...this.getExtraHeaders(),
        },
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
      }

      // Parse the SSE stream
      const { fullText, inputTokens, outputTokens } = await this.consumeSSE(response, output);

      const durationMs = Date.now() - startMs;
      const pricing = this.getModelPricing(config.model);
      const costUsd = pricing
        ? (inputTokens / 1_000_000) * pricing[0] + (outputTokens / 1_000_000) * pricing[1]
        : 0;

      emitResult(output, {
        text: fullText,
        costUsd,
        inputTokens,
        outputTokens,
        durationMs,
      });

      return {
        output: fullText,
        inputTokens,
        outputTokens,
        costUsd,
        durationMs,
        provider: this.provider,
        model: config.model,
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this.abortController = null;
    }
  }

  kill(): void {
    this.abortController?.abort();
  }

  // -- Internal helpers -----------------------------------------------------

  protected buildRequestBody(config: ModelAdapterConfig): Record<string, unknown> {
    const messages: Array<{ role: string; content: string }> = [];

    if (config.projectPrompt) {
      messages.push({ role: 'project', content: config.projectPrompt });
    }
    messages.push({ role: 'user', content: config.userPrompt });

    return {
      model: config.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
  }

  protected async consumeSSE(
    response: Response,
    output: NodeJS.WritableStream,
  ): Promise<{ fullText: string; inputTokens: number; outputTokens: number }> {
    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response body is not readable');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue; // empty or SSE comment

        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6); // strip "data: "

        if (payload === '[DONE]') continue;

        try {
          const chunk = JSON.parse(payload);

          // Extract content delta
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            fullText += delta.content;
            emitContent(output, delta.content);
          }

          // Extract usage from the final chunk
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? 0;
            outputTokens = chunk.usage.completion_tokens ?? 0;
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    return { fullText, inputTokens, outputTokens };
  }
}
