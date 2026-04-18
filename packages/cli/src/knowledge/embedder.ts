import { execSync as execSyncCmd } from 'node:child_process';
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { homedir as osHomedir } from 'node:os';
import type { EmbeddingProvider } from './types.js';

// ---------------------------------------------------------------------------
// 1. Codestral (Mistral) Embedder
// ---------------------------------------------------------------------------

export class CodestralEmbedder implements EmbeddingProvider {
  readonly name = 'codestral';
  readonly dimensions: number;
  private readonly model: string;

  constructor(options?: { model?: string; dimensions?: number }) {
    this.model = options?.model ?? 'codestral-embed-2505';
    this.dimensions = options?.dimensions ?? 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
      throw new Error('MISTRAL_API_KEY environment variable is not set');
    }

    const response = await fetch('https://api.mistral.ai/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        encoding_format: 'float',
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Codestral embedding request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return json.data.map((d) => d.embedding);
  }

  async embedSingle(text: string): Promise<number[]> {
    const [result] = await this.embed([text]);
    return result;
  }
}

// ---------------------------------------------------------------------------
// 2. Voyage Embedder
// ---------------------------------------------------------------------------

export class VoyageEmbedder implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly dimensions: number;
  private readonly model: string;

  constructor(options?: { model?: string; dimensions?: number }) {
    this.model = options?.model ?? 'voyage-code-3';
    this.dimensions = options?.dimensions ?? 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) {
      throw new Error('VOYAGE_API_KEY environment variable is not set');
    }

    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        input_type: 'document',
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Voyage embedding request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return json.data.map((d) => d.embedding);
  }

  async embedSingle(text: string): Promise<number[]> {
    const [result] = await this.embed([text]);
    return result;
  }
}

// ---------------------------------------------------------------------------
// 3. OpenAI Embedder
// ---------------------------------------------------------------------------

export class OpenAIEmbedder implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions: number;
  private readonly model: string;

  constructor(options?: { model?: string; dimensions?: number }) {
    this.model = options?.model ?? 'text-embedding-3-large';
    this.dimensions = options?.dimensions ?? 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI embedding request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return json.data.map((d) => d.embedding);
  }

  async embedSingle(text: string): Promise<number[]> {
    const [result] = await this.embed([text]);
    return result;
  }
}

// ---------------------------------------------------------------------------
// 4. Ollama Embedder (local, free)
// ---------------------------------------------------------------------------

/** Models that require task-specific prefixes for best performance */
const OLLAMA_PREFIX_MODELS: Record<string, { document: string; query: string }> = {
  'nomic-embed-text': { document: 'search_document: ', query: 'search_query: ' },
};

/** Default dimensions per known model (used when not explicitly configured) */
const OLLAMA_MODEL_DIMS: Record<string, number> = {
  'bge-m3': 1024,
  'nomic-embed-text': 768,
  'snowflake-arctic-embed:l': 1024,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
};

export class OllamaEmbedder implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly dimensions: number;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly prefixes: { document: string; query: string } | null;

  constructor(options?: { model?: string; dimensions?: number }) {
    this.model = options?.model ?? 'bge-m3';
    this.dimensions = options?.dimensions ?? OLLAMA_MODEL_DIMS[this.model] ?? 1024;
    this.baseUrl = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
    this.prefixes = OLLAMA_PREFIX_MODELS[this.model] ?? null;
  }

  /** Embed texts as documents (for indexing) */
  async embed(texts: string[]): Promise<number[][]> {
    const prefixed = this.prefixes
      ? texts.map((t) => `${this.prefixes!.document}${t}`)
      : texts;
    return this._rawEmbed(prefixed);
  }

  /** Embed a single text as a query (for search) */
  async embedSingle(text: string): Promise<number[]> {
    const prefixed = this.prefixes ? `${this.prefixes.query}${text}` : text;
    const [result] = await this._rawEmbed([prefixed]);
    return result;
  }

  private async _rawEmbed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embedding request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as { embeddings: number[][] };
    return json.embeddings;
  }
}

// ---------------------------------------------------------------------------
// 5. Gemini OAuth Embedder (uses Gemini CLI's stored OAuth token)
// ---------------------------------------------------------------------------

export class GeminiOAuthEmbedder implements EmbeddingProvider {
  readonly name = 'gemini-oauth';
  readonly dimensions: number;
  private readonly model: string;

  constructor(options?: { model?: string; dimensions?: number }) {
    this.model = options?.model ?? 'text-embedding-004';
    this.dimensions = options?.dimensions ?? 768;
  }

  private getAccessToken(): string {
    const oauthPath = pathJoin(osHomedir(), '.gemini', 'oauth_creds.json');
    if (!fsExistsSync(oauthPath)) {
      throw new Error('Gemini CLI not authenticated. Run: gemini auth login');
    }
    const creds = JSON.parse(fsReadFileSync(oauthPath, 'utf-8'));
    if (!creds.access_token) {
      throw new Error('Gemini OAuth token not found. Run: gemini auth login');
    }
    return creds.access_token;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const token = this.getAccessToken();
    const results: number[][] = [];

    // Gemini embedding API processes one text at a time via batchEmbedContents
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
            taskType: 'RETRIEVAL_DOCUMENT',
          })),
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini embedding request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as { embeddings: Array<{ values: number[] }> };
    for (const emb of json.embeddings) {
      results.push(emb.values);
    }
    return results;
  }

  async embedSingle(text: string): Promise<number[]> {
    const [result] = await this.embed([text]);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Check if Ollama is running locally.
 */
function isOllamaRunning(): boolean {
  try {
    const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
    execSyncCmd(`curl -s --max-time 2 ${host}/api/tags`, { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Gemini CLI is authenticated and has a valid OAuth token.
 */
function isGeminiCliAuthenticated(): boolean {
  try {
    const oauthPath = pathJoin(osHomedir(), '.gemini', 'oauth_creds.json');
    if (!fsExistsSync(oauthPath)) return false;
    const creds = JSON.parse(fsReadFileSync(oauthPath, 'utf-8'));
    return !!creds.access_token;
  } catch {
    return false;
  }
}

export function createEmbeddingProvider(config: {
  provider: string;
  model?: string;
  dimensions?: number;
}): EmbeddingProvider {
  const opts = { model: config.model, dimensions: config.dimensions };

  switch (config.provider) {
    case 'codestral':
    case 'mistral':
      return new CodestralEmbedder(opts);
    case 'voyage':
      return new VoyageEmbedder(opts);
    case 'openai':
      return new OpenAIEmbedder(opts);
    case 'ollama':
      return new OllamaEmbedder(opts);
    case 'gemini-oauth':
    case 'gemini':
      return new GeminiOAuthEmbedder(opts);
    case 'auto': {
      // Auto-detect: try local first (free), then API keys, then CLI OAuth
      if (isOllamaRunning()) return new OllamaEmbedder(opts);
      if (process.env.MISTRAL_API_KEY) return new CodestralEmbedder(opts);
      if (process.env.OPENAI_API_KEY) return new OpenAIEmbedder(opts);
      if (process.env.VOYAGE_API_KEY) return new VoyageEmbedder(opts);
      if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
        return new GeminiOAuthEmbedder(opts);
      }
      if (isGeminiCliAuthenticated()) return new GeminiOAuthEmbedder(opts);
      throw new Error(
        'No embedding provider available. Install Ollama (brew install ollama && ollama pull nomic-embed-text), ' +
        'or set an API key (MISTRAL_API_KEY, OPENAI_API_KEY).',
      );
    }
    default:
      throw new Error(
        `Unknown embedding provider "${config.provider}". ` +
          'Supported: codestral, mistral, voyage, openai, ollama, gemini, auto',
      );
  }
}

// ---------------------------------------------------------------------------
// Batch helper
// ---------------------------------------------------------------------------

export async function batchEmbed(
  provider: EmbeddingProvider,
  texts: string[],
  batchSize: number = 50,
  delayMs: number = 100,
): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const embeddings = await provider.embed(batch);
    results.push(...embeddings);

    // Delay between batches to respect rate limits (skip after last batch)
    if (i + batchSize < texts.length && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}
