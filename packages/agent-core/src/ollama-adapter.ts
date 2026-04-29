/**
 * Ollama adapter — HTTP API for local Ollama server, no npm dependencies.
 *
 * Base URL: OLLAMA_HOST env var or http://localhost:11434
 * Streaming: NDJSON (not SSE) from POST /api/chat
 */

import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  ProviderCapabilities,
} from './types.js';
import { emitContent, emitResult } from './stream-format.js';

function getBaseUrl(): string {
  return (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
}

export class OllamaAdapter implements ModelAdapter {
  readonly provider = 'ollama' as const;

  readonly capabilities: ProviderCapabilities = {
    tier: 'text-only',
    streaming: true,
    toolUse: false,
    fileSystem: false,
    shellExecution: false,
    sessionResume: false,
  };

  private abortController: AbortController | null = null;

  supportsModel(_modelId: string): boolean {
    // Only used when explicitly configured; auto-detection is via registry rules.
    return false;
  }

  getModelPricing(_modelId: string): [number, number] | null {
    return [0, 0]; // local = free
  }

  async checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
    const baseUrl = getBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { method: 'GET' });
      if (res.ok) {
        return { available: true };
      }
      return { available: false, error: `Ollama returned ${res.status}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, error: `Cannot reach Ollama at ${baseUrl}: ${msg}` };
    }
  }

  kill(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async run(
    config: ModelAdapterConfig,
    output: NodeJS.WritableStream,
  ): Promise<ModelAdapterResult> {
    const baseUrl = getBaseUrl();
    const { model, userPrompt, projectPrompt } = config;

    const messages: Array<{ role: string; content: string }> = [];
    if (projectPrompt) {
      messages.push({ role: 'project', content: projectPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    this.abortController = new AbortController();
    const startMs = Date.now();
    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let durationMs = 0;

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Ollama API ${response.status}: ${errBody}`);
    }

    if (!response.body) {
      throw new Error('Ollama API returned no response body');
    }

    // Read NDJSON stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (chunk.done === true) {
          // Final chunk with stats
          if (typeof chunk.prompt_eval_count === 'number') {
            inputTokens = chunk.prompt_eval_count as number;
          }
          if (typeof chunk.eval_count === 'number') {
            outputTokens = chunk.eval_count as number;
          }
          if (typeof chunk.total_duration === 'number') {
            // Ollama reports duration in nanoseconds
            durationMs = (chunk.total_duration as number) / 1_000_000;
          }
        } else {
          // Streaming content chunk
          const message = chunk.message as Record<string, unknown> | undefined;
          if (message && typeof message.content === 'string') {
            const text = message.content as string;
            fullText += text;
            emitContent(output, text);
          }
        }
      }
    }

    // Fall back to wall-clock time if Ollama didn't report duration
    if (durationMs === 0) {
      durationMs = Date.now() - startMs;
    }

    emitResult(output, {
      text: fullText,
      costUsd: 0,
      inputTokens,
      outputTokens,
      durationMs,
    });

    this.abortController = null;

    return {
      output: fullText,
      inputTokens,
      outputTokens,
      costUsd: 0,
      durationMs,
      provider: 'ollama',
      model,
    };
  }
}
