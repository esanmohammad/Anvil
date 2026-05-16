// ---------------------------------------------------------------------------
// Reranker interface and implementations
// ---------------------------------------------------------------------------

import type { RerankerProviderConfig, RerankerProviderId } from './config.js';

export interface Reranker {
  rerank(
    query: string,
    documents: string[],
    topN?: number,
  ): Promise<Array<{ index: number; score: number }>>;
}

// ---------------------------------------------------------------------------
// Deprecation-warning seam (P2). Mirror of embedder.ts.
// ---------------------------------------------------------------------------

const WARNED_ENV_KEYS = new Set<string>();

function deprecatedEnv(key: string): string | undefined {
  const v = process.env[key];
  if (v && !WARNED_ENV_KEYS.has(key)) {
    WARNED_ENV_KEYS.add(key);
    process.stderr.write(
      `[knowledge-core] DEPRECATED: ${key} read from process.env. ` +
      `Pass via config.retrieval.reranker.{apiKey,baseUrl,model} instead. ` +
      `Library env reads will be removed in 1.0.\n`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Concurrency-limited parallel execution
// ---------------------------------------------------------------------------

async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Ollama Reranker (local, via Qwen3-Reranker chat endpoint)
// ---------------------------------------------------------------------------

/**
 * Default reranker model. Was `qwen3:0.6b`, but qwen3 silently returns
 * an empty string when the prompt ends with `/no_think` + low `num_predict`,
 * which made the reranker a no-op (every doc scored 0.5). `qwen2.5-coder:7b`
 * reliably emits "Yes"/"No" against the rerank prompt. Override per-install
 * via config.retrieval.reranker.model.
 */
const DEFAULT_OLLAMA_RERANKER_MODEL = 'qwen2.5-coder:7b';

/** One-shot warning so users notice a misconfigured reranker. */
let _emptyResponseWarned = false;

class OllamaReranker implements Reranker {
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(opts?: { baseUrl?: string; model?: string; timeoutMs?: number }) {
    this.baseUrl = opts?.baseUrl ?? deprecatedEnv('OLLAMA_HOST') ?? 'http://localhost:11434';
    this.model = opts?.model ?? deprecatedEnv('RERANKER_MODEL') ?? DEFAULT_OLLAMA_RERANKER_MODEL;
    this.timeoutMs = opts?.timeoutMs ?? 30000;
  }

  private async scoreOne(query: string, doc: string, index: number): Promise<{ index: number; score: number }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'user',
              // F2 — no `/no_think` directive (qwen3-only; with num_predict
              // ≤ 10 it eats the response). num_predict raised to 32 so
              // thinking-style models have room to emit yes/no after any
              // wrapping. Generic across qwen2.5, qwen3, llama3, gemma.
              content: `Given a code search query, evaluate whether the following code document is relevant. Answer ONLY "yes" or "no", nothing else.\n\nQuery: ${query}\n\nDocument:\n${doc.slice(0, 1500)}\n\nRelevant?`,
            },
          ],
          stream: false,
          options: { temperature: 0, num_predict: 32 },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) return { index, score: 0.5 };

      const json = (await response.json()) as {
        message?: { content?: string };
      };
      const raw = (json.message?.content ?? '').toLowerCase().trim();
      // Strip any <think>...</think> tags from Qwen3 / reasoning models.
      const answer = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      // F2 — one-shot warning when the reranker is silently producing
      // empty output. Without this, every doc gets 0.5 and the user
      // sees a flat ranking with no signal that anything's wrong.
      if (!answer && !_emptyResponseWarned) {
        _emptyResponseWarned = true;
        process.stderr.write(
          `[knowledge-core] WARNING: Ollama reranker model "${this.model}" returned empty content. ` +
          `Falling back to neutral 0.5 score per doc — reranker is effectively disabled. ` +
          `Switch to a model that follows yes/no instructions ` +
          `(e.g. set CODE_SEARCH_RERANKER_MODEL=qwen2.5-coder:7b or use reranker.provider=none).\n`,
        );
      }

      let score = 0.5;
      if (answer.startsWith('yes')) score = 1.0;
      else if (answer.startsWith('no')) score = 0.0;
      // Also check if the raw response contains yes/no anywhere (Qwen3 sometimes wraps)
      else if (raw.includes('yes')) score = 0.8;
      else if (raw.includes('no')) score = 0.2;

      return { index, score };
    } catch {
      return { index, score: 0.5 };
    }
  }

  async rerank(
    query: string,
    documents: string[],
    topN?: number,
  ): Promise<Array<{ index: number; score: number }>> {
    if (documents.length === 0) return [];

    // Sequential execution — one at a time. Slow but guaranteed stable.
    // Ollama can only load one model instance; concurrent requests cause 500 errors.
    const scores: Array<{ index: number; score: number }> = [];
    for (let i = 0; i < documents.length; i++) {
      const result = await this.scoreOne(query, documents[i], i);
      scores.push(result);
    }

    scores.sort((a, b) => b.score - a.score);
    return topN ? scores.slice(0, topN) : scores;
  }
}

// ---------------------------------------------------------------------------
// Cohere Reranker
// ---------------------------------------------------------------------------

class CohereReranker implements Reranker {
  private readonly apiKey: string | undefined;
  private readonly model: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = opts?.apiKey;
    this.model = opts?.model ?? 'rerank-v3.5';
  }

  async rerank(
    query: string,
    documents: string[],
    topN?: number,
  ): Promise<Array<{ index: number; score: number }>> {
    const apiKey = this.apiKey ?? deprecatedEnv('COHERE_API_KEY');
    if (!apiKey) {
      throw new Error('COHERE_API_KEY (or config.retrieval.reranker.apiKey) is not set');
    }

    const response = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents,
        top_n: topN ?? documents.length,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Cohere rerank request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as {
      results: Array<{ index: number; relevance_score: number }>;
    };

    return json.results.map((r) => ({ index: r.index, score: r.relevance_score }));
  }
}

// ---------------------------------------------------------------------------
// Voyage Reranker
// ---------------------------------------------------------------------------

class VoyageReranker implements Reranker {
  private readonly apiKey: string | undefined;
  private readonly model: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = opts?.apiKey;
    this.model = opts?.model ?? 'rerank-2';
  }

  async rerank(
    query: string,
    documents: string[],
    topN?: number,
  ): Promise<Array<{ index: number; score: number }>> {
    const apiKey = this.apiKey ?? deprecatedEnv('VOYAGE_API_KEY');
    if (!apiKey) {
      throw new Error('VOYAGE_API_KEY (or config.retrieval.reranker.apiKey) is not set');
    }

    const response = await fetch('https://api.voyageai.com/v1/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents,
        top_k: topN ?? documents.length,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Voyage rerank request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as {
      data: Array<{ index: number; relevance_score: number }>;
    };

    return json.data.map((r) => ({ index: r.index, score: r.relevance_score }));
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible Reranker (works with any chat completions API)
// ---------------------------------------------------------------------------

class OpenAICompatibleReranker implements Reranker {
  private baseUrl: string;
  private model: string;
  private apiKey: string | undefined;
  private timeoutMs: number;

  constructor(opts?: { baseUrl?: string; model?: string; apiKey?: string; timeoutMs?: number }) {
    this.baseUrl = opts?.baseUrl ?? deprecatedEnv('CODE_SEARCH_RERANKER_BASE_URL') ?? '';
    this.model = opts?.model ?? deprecatedEnv('CODE_SEARCH_RERANKER_MODEL') ?? '';
    this.apiKey = opts?.apiKey ?? deprecatedEnv('CODE_SEARCH_RERANKER_API_KEY');
    this.timeoutMs = opts?.timeoutMs ?? 30000;

    if (!this.baseUrl) throw new Error('Reranker base URL required. Pass config.retrieval.reranker.baseUrl or set CODE_SEARCH_RERANKER_BASE_URL');
    if (!this.model) throw new Error('Reranker model required. Pass config.retrieval.reranker.model or set CODE_SEARCH_RERANKER_MODEL');
  }

  private async scoreOne(query: string, doc: string, index: number): Promise<{ index: number; score: number }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'user',
              content: `Given a code search query, evaluate whether the following code document is relevant. Answer ONLY "yes" or "no", nothing else.\n\nQuery: ${query}\n\nDocument:\n${doc.slice(0, 1500)}\n\nRelevant?`,
            },
          ],
          temperature: 0,
          max_tokens: 5,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);
      if (!response.ok) return { index, score: 0.5 };

      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const answer = (json.choices?.[0]?.message?.content ?? '').toLowerCase().trim();

      let score = 0.5;
      if (answer.startsWith('yes')) score = 1.0;
      else if (answer.startsWith('no')) score = 0.0;
      else if (answer.includes('yes')) score = 0.8;
      else if (answer.includes('no')) score = 0.2;

      return { index, score };
    } catch {
      return { index, score: 0.5 };
    }
  }

  async rerank(
    query: string,
    documents: string[],
    topN?: number,
  ): Promise<Array<{ index: number; score: number }>> {
    if (documents.length === 0) return [];

    // Run with concurrency of 5 for API-based providers
    const scores = await parallelMap(
      documents,
      (doc, i) => this.scoreOne(query, doc, i),
      5,
    );

    scores.sort((a, b) => b.score - a.score);
    return topN ? scores.slice(0, topN) : scores;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a reranker from either a struct config (P2+) or a bare provider id
 * (P1 back-compat). String form is normalized to a struct, then the
 * appropriate provider class is constructed. `none` → null. Returns null on
 * unknown providers (caller falls back to RRF order).
 */
export function createReranker(
  cfg: RerankerProviderConfig | RerankerProviderId,
): Reranker | null {
  const config: RerankerProviderConfig = typeof cfg === 'string' ? { provider: cfg } : cfg;

  switch (config.provider) {
    case 'ollama':
      return new OllamaReranker({
        baseUrl: config.baseUrl,
        model: config.model,
        timeoutMs: config.timeoutMs,
      });
    case 'cohere':
      return new CohereReranker({ apiKey: config.apiKey, model: config.model });
    case 'voyage':
      return new VoyageReranker({ apiKey: config.apiKey, model: config.model });
    case 'openai-compatible':
    case 'custom':
      return new OpenAICompatibleReranker({
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
      });
    case 'none':
      return null;
    default: {
      // Backwards-compat: an unknown provider id with a CODE_SEARCH_RERANKER_BASE_URL
      // env var set → assume custom. Otherwise fall through to Ollama.
      if (deprecatedEnv('CODE_SEARCH_RERANKER_BASE_URL')) {
        return new OpenAICompatibleReranker({
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey: config.apiKey,
          timeoutMs: config.timeoutMs,
        });
      }
      return new OllamaReranker({
        baseUrl: config.baseUrl,
        model: config.model,
        timeoutMs: config.timeoutMs,
      });
    }
  }
}
