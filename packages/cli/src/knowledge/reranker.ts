// ---------------------------------------------------------------------------
// Reranker interface and implementations
// ---------------------------------------------------------------------------

export interface Reranker {
  rerank(
    query: string,
    documents: string[],
    topN?: number,
  ): Promise<Array<{ index: number; score: number }>>;
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

class OllamaReranker implements Reranker {
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(opts?: { baseUrl?: string; model?: string; timeoutMs?: number }) {
    this.baseUrl = opts?.baseUrl || process.env.OLLAMA_HOST || 'http://localhost:11434';
    this.model = opts?.model || process.env.RERANKER_MODEL || 'qwen3:0.6b';
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
              content: `Given a code search query, evaluate whether the following code document is relevant. Answer ONLY "yes" or "no", nothing else.\n\nQuery: ${query}\n\nDocument:\n${doc.slice(0, 1500)}\n\nRelevant? /no_think`,
            },
          ],
          stream: false,
          options: { temperature: 0, num_predict: 10 },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) return { index, score: 0.5 };

      const json = (await response.json()) as {
        message?: { content?: string };
      };
      const raw = (json.message?.content ?? '').toLowerCase().trim();
      // Strip any <think>...</think> tags from Qwen3
      const answer = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

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
  async rerank(
    query: string,
    documents: string[],
    topN?: number,
  ): Promise<Array<{ index: number; score: number }>> {
    const apiKey = process.env.COHERE_API_KEY;
    if (!apiKey) {
      throw new Error('COHERE_API_KEY environment variable is not set');
    }

    const response = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'rerank-v3.5',
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
  async rerank(
    query: string,
    documents: string[],
    topN?: number,
  ): Promise<Array<{ index: number; score: number }>> {
    const apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) {
      throw new Error('VOYAGE_API_KEY environment variable is not set');
    }

    const response = await fetch('https://api.voyageai.com/v1/rerank', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'rerank-2',
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
// Factory
// ---------------------------------------------------------------------------

export function createReranker(provider: 'cohere' | 'voyage' | 'ollama' | 'none'): Reranker | null {
  switch (provider) {
    case 'ollama':
      return new OllamaReranker();
    case 'cohere':
      return new CohereReranker();
    case 'voyage':
      return new VoyageReranker();
    case 'none':
      return null;
    default:
      return new OllamaReranker();
  }
}
