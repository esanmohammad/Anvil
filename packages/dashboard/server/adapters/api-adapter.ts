/**
 * API adapter — HTTP chat completions for OpenAI, Gemini API, OpenRouter, Ollama.
 *
 * All these providers support the OpenAI-compatible `/v1/chat/completions` endpoint
 * with `stream: true` for SSE-based streaming.
 *
 * Limitations vs CLI adapters:
 *   - Chat only — no multi-turn agentic loops, no tool use
 *   - No resume — each call is stateless (we maintain message history in memory)
 *   - Cost is estimated from token counts, not exact
 */

import { BaseAdapter, type AdapterConfig, type AdapterCostInfo } from './base-adapter.js';

type ApiProvider = 'openai' | 'gemini-api' | 'openrouter' | 'ollama';

interface ProviderEndpoint {
  url: string;
  authHeader: () => string | undefined;
}

const ENDPOINTS: Record<ApiProvider, ProviderEndpoint> = {
  'openai': {
    url: 'https://api.openai.com/v1/chat/completions',
    authHeader: () => process.env.OPENAI_API_KEY ? `Bearer ${process.env.OPENAI_API_KEY}` : undefined,
  },
  'gemini-api': {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    authHeader: () => {
      const key = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
      return key ? `Bearer ${key}` : undefined;
    },
  },
  'openrouter': {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    authHeader: () => process.env.OPENROUTER_API_KEY ? `Bearer ${process.env.OPENROUTER_API_KEY}` : undefined,
  },
  'ollama': {
    url: `${process.env.OLLAMA_HOST ?? 'http://localhost:11434'}/v1/chat/completions`,
    authHeader: () => undefined, // Ollama doesn't need auth
  },
};

export class ApiAdapter extends BaseAdapter {
  private provider: ApiProvider;
  private abortController: AbortController | null = null;
  private isKilled = false;
  private startTime = 0;

  constructor(config: AdapterConfig, provider: ApiProvider) {
    super(config);
    this.provider = provider;
  }

  start(): void {
    this.startTime = Date.now();
    this.abortController = new AbortController();

    // Run async — emit exit when done
    this.runStream().catch((err) => {
      if (!this.isKilled) {
        this.emit('error-output', `API request failed: ${err.message}`);
      }
      this.emit('exit', 1);
    });
  }

  kill(): void {
    this.isKilled = true;
    this.abortController?.abort();
  }

  get pid(): number | undefined {
    return undefined; // No child process
  }

  get killed(): boolean {
    return this.isKilled;
  }

  private async runStream(): Promise<void> {
    const endpoint = ENDPOINTS[this.provider];
    if (!endpoint) {
      this.emit('error-output', `Unknown API provider: ${this.provider}`);
      this.emit('exit', 1);
      return;
    }

    const auth = endpoint.authHeader();
    if (!auth && this.provider !== 'ollama') {
      const envVarName = this.provider === 'openai' ? 'OPENAI_API_KEY'
        : this.provider === 'gemini-api' ? 'GOOGLE_API_KEY'
        : this.provider === 'openrouter' ? 'OPENROUTER_API_KEY'
        : '';
      this.emit('error-output', `${envVarName} environment variable not set`);
      this.emit('exit', 1);
      return;
    }

    // Build messages
    const messages: Array<{ role: string; content: string }> = [];
    if (this.config.projectPrompt) {
      messages.push({ role: 'system', content: this.config.projectPrompt });
    }
    messages.push({ role: 'user', content: this.config.prompt });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (auth) headers['Authorization'] = auth;

    // OpenRouter-specific headers
    if (this.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/anvil-dev/anvil';
      headers['X-Title'] = 'Feature Factory';
    }

    const body = JSON.stringify({
      model: this.config.model,
      messages,
      stream: true,
      temperature: 0.1,
      max_tokens: 16384,
    });

    let response: Response;
    try {
      response = await fetch(endpoint.url, {
        method: 'POST',
        headers,
        body,
        signal: this.abortController!.signal,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        this.emit('exit', 0);
        return;
      }
      throw err;
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      this.emit('error-output', `API error ${response.status}: ${errBody.slice(0, 500)}`);
      this.emit('exit', 1);
      return;
    }

    // Parse SSE stream
    const reader = response.body?.getReader();
    if (!reader) {
      this.emit('error-output', 'No response body');
      this.emit('exit', 1);
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };

            // Extract content delta
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              this.emit('content', delta);
            }

            // Extract usage from final chunk (some providers include it)
            if (chunk.usage) {
              inputTokens = chunk.usage.prompt_tokens ?? 0;
              outputTokens = chunk.usage.completion_tokens ?? 0;
            }
          } catch {
            // Skip unparseable SSE lines
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        this.emit('exit', 0);
        return;
      }
      throw err;
    }

    const durationMs = Date.now() - this.startTime;

    // Emit activity for the full response
    if (fullContent) {
      this.emit('activity', {
        id: this.nextActivityId(),
        kind: 'text',
        summary: fullContent.slice(0, 200).replace(/\n/g, ' '),
        content: fullContent,
        timestamp: Date.now(),
      });
    }

    // Emit result
    const cost: AdapterCostInfo = {
      totalUsd: 0, // We don't have exact pricing
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs,
    };

    this.emit('result', {
      result: fullContent,
      cost,
      sessionId: this.config.sessionId,
    });

    this.emit('exit', 0);
  }
}
