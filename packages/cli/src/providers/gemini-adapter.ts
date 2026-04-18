/**
 * Google Gemini adapter — HTTP API via native fetch(), no npm dependencies.
 *
 * Auth: GOOGLE_API_KEY or GEMINI_API_KEY env var.
 * Streaming: SSE (alt=sse) with GenerateContentResponse JSON payloads.
 */

import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  ProviderCapabilities,
} from './types.js';
import { emitContent, emitThinking, emitResult } from './stream-format.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const PRICING: Record<string, [number, number]> = {
  'gemini-2.5-pro':        [1.25, 10.0],
  'gemini-2.5-flash':      [0.30, 2.50],
  'gemini-2.5-flash-lite': [0.10, 0.40],
  'gemini-2.0-flash':      [0.10, 0.40],
};

function getApiKey(): string | undefined {
  return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
}

function computeCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = PRICING[modelId];
  if (!pricing) return 0;
  const [inputPer1M, outputPer1M] = pricing;
  return (inputTokens / 1_000_000) * inputPer1M + (outputTokens / 1_000_000) * outputPer1M;
}

export class GeminiAdapter implements ModelAdapter {
  readonly provider = 'gemini' as const;

  readonly capabilities: ProviderCapabilities = {
    tier: 'function-calling',
    streaming: true,
    toolUse: true,
    fileSystem: false,
    shellExecution: false,
    sessionResume: false,
  };

  private abortController: AbortController | null = null;

  supportsModel(modelId: string): boolean {
    return modelId.startsWith('gemini-');
  }

  getModelPricing(modelId: string): [number, number] | null {
    return PRICING[modelId] ?? null;
  }

  async checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
    const key = getApiKey();
    if (!key) {
      return { available: false, error: 'GOOGLE_API_KEY or GEMINI_API_KEY not set' };
    }
    return { available: true };
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
    const key = getApiKey();
    if (!key) {
      throw new Error('Gemini API key not found. Set GOOGLE_API_KEY or GEMINI_API_KEY.');
    }

    const { model, userPrompt, projectPrompt } = config;
    const url = `${API_BASE}/${model}:streamGenerateContent?alt=sse&key=${key}`;

    const body: Record<string, unknown> = {
      contents: [
        {
          parts: [{ text: userPrompt }],
          role: 'user',
        },
      ],
    };

    if (projectPrompt) {
      body.systemInstruction = { parts: [{ text: projectPrompt }] };
    }

    this.abortController = new AbortController();
    const startMs = Date.now();
    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let thinkingTokens = 0;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Gemini API ${response.status}: ${errBody}`);
    }

    if (!response.body) {
      throw new Error('Gemini API returned no response body');
    }

    // Read the SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const jsonStr = trimmed.slice(6); // strip "data: "
        if (!jsonStr) continue;

        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(jsonStr);
        } catch {
          continue; // skip malformed lines
        }

        // Extract text content
        const candidates = chunk.candidates as Array<Record<string, unknown>> | undefined;
        if (candidates && candidates.length > 0) {
          const content = candidates[0].content as Record<string, unknown> | undefined;
          if (content) {
            const parts = content.parts as Array<Record<string, unknown>> | undefined;
            if (parts && parts.length > 0 && typeof parts[0].text === 'string') {
              const text = parts[0].text as string;
              fullText += text;
              emitContent(output, text);
            }
          }
        }

        // Track usage (cumulative — last chunk has final counts)
        const usage = chunk.usageMetadata as Record<string, number> | undefined;
        if (usage) {
          if (typeof usage.promptTokenCount === 'number') {
            inputTokens = usage.promptTokenCount;
          }
          if (typeof usage.candidatesTokenCount === 'number') {
            outputTokens = usage.candidatesTokenCount;
          }
          if (typeof usage.thoughtsTokenCount === 'number' && usage.thoughtsTokenCount > 0) {
            if (usage.thoughtsTokenCount > thinkingTokens) {
              emitThinking(output, `[thinking: ${usage.thoughtsTokenCount} tokens]`);
              thinkingTokens = usage.thoughtsTokenCount;
            }
          }
        }
      }
    }

    const durationMs = Date.now() - startMs;
    const costUsd = computeCost(model, inputTokens, outputTokens);

    emitResult(output, {
      text: fullText,
      costUsd,
      inputTokens,
      outputTokens,
      durationMs,
    });

    this.abortController = null;

    return {
      output: fullText,
      inputTokens,
      outputTokens,
      costUsd,
      durationMs,
      provider: 'gemini',
      model,
    };
  }
}
