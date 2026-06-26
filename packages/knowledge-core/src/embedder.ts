import { execSync as execSyncCmd } from 'node:child_process';
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { homedir as osHomedir } from 'node:os';
import type { EmbeddingProvider } from './types.js';
import type { EmbeddingProviderConfig } from './config.js';

// ---------------------------------------------------------------------------
// Deprecation-warning seam (P2). Provider classes still read env when the
// caller didn't pass an explicit credential — but each fallback fires a
// single stderr warning so consumers know what to migrate. Cleared in 1.0.
// ---------------------------------------------------------------------------

const WARNED_ENV_KEYS = new Set<string>();

function deprecatedEnv(key: string): string | undefined {
  const v = process.env[key];
  if (v && !WARNED_ENV_KEYS.has(key)) {
    WARNED_ENV_KEYS.add(key);
    process.stderr.write(
      `[knowledge-core] DEPRECATED: ${key} read from process.env. ` +
      `Pass via config.embedding.apiKey / .baseUrl / .ollamaHost instead. ` +
      `Library env reads will be removed in 1.0.\n`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Resilient fetch for cloud embedding providers.
//
// A bare fetch() with no timeout/retry turns any transient network blip into a
// fatal error that aborts a multi-hour indexing run: undici "fetch failed" /
// ECONNRESET from a recycled keep-alive socket, a stalled request with no
// timeout, a 429, or a 5xx. embedFetch wraps fetch with a per-request timeout
// plus exponential backoff + jitter (honoring Retry-After on 429), retrying
// network errors and 429/5xx. Tunable via env:
//   CODE_SEARCH_EMBEDDING_TIMEOUT_MS  (default 60000)
//   CODE_SEARCH_EMBEDDING_MAX_RETRIES (default 5)
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function embedBackoffMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt); // 0.5s, 1s, 2s, ... cap 30s
  return base + Math.random() * base * 0.25; // +0-25% jitter
}

function isRetryableNetworkError(err: unknown): boolean {
  // Do NOT gate on `instanceof Error`: AbortSignal.timeout rejects with a
  // DOMException, which is not an Error subclass on Node < ~22, so a timeout
  // would silently fail to retry on the deployment runtime. Inspect any object.
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true; // AbortSignal.timeout / abort
  const haystack = `${e.message ?? ''} ${e.code ?? ''} ${e.cause?.code ?? ''}`;
  return /fetch failed|terminated|socket hang up|other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR/i.test(
    haystack,
  );
}

async function embedFetch(opts: {
  url: string;
  apiKey?: string;
  body: unknown;
  provider: string;
}): Promise<Response> {
  const timeoutMs = parseInt(process.env.CODE_SEARCH_EMBEDDING_TIMEOUT_MS ?? '', 10) || 60_000;
  const maxRetries = parseInt(process.env.CODE_SEARCH_EMBEDDING_MAX_RETRIES ?? '', 10) || 5;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const payload = JSON.stringify(opts.body);

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(opts.url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return response;
      // Retry 429 (rate limit) and 5xx (transient server) — but not 4xx (our bug).
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : embedBackoffMs(attempt);
        await response.text().catch(() => {}); // drain body so the socket is released
        await sleep(wait);
        continue;
      }
      const body = await response.text().catch(() => '');
      throw new Error(`${opts.provider} embedding request failed (${response.status}): ${body.slice(0, 500)}`);
    } catch (err) {
      if (isRetryableNetworkError(err) && attempt < maxRetries) {
        await sleep(embedBackoffMs(attempt));
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Codestral (Mistral) Embedder
// ---------------------------------------------------------------------------

export class CodestralEmbedder implements EmbeddingProvider {
  readonly name = 'codestral';
  readonly dimensions: number;
  private readonly model: string;
  private readonly apiKey: string | undefined;

  constructor(options?: { model?: string; dimensions?: number; apiKey?: string }) {
    this.model = options?.model ?? 'codestral-embed-2505';
    this.dimensions = options?.dimensions ?? 1024;
    this.apiKey = options?.apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const apiKey = this.apiKey ?? deprecatedEnv('MISTRAL_API_KEY');
    if (!apiKey) {
      throw new Error('MISTRAL_API_KEY (or config.embedding.apiKey) is not set');
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
  private readonly apiKey: string | undefined;

  constructor(options?: { model?: string; dimensions?: number; apiKey?: string }) {
    this.model = options?.model ?? 'voyage-code-3';
    this.dimensions = options?.dimensions ?? 1024;
    this.apiKey = options?.apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const apiKey = this.apiKey ?? deprecatedEnv('VOYAGE_API_KEY');
    if (!apiKey) {
      throw new Error('VOYAGE_API_KEY (or config.embedding.apiKey) is not set');
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
  private readonly apiKey: string | undefined;

  constructor(options?: { model?: string; dimensions?: number; apiKey?: string }) {
    this.model = options?.model ?? 'text-embedding-3-large';
    this.dimensions = options?.dimensions ?? 1024;
    this.apiKey = options?.apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const apiKey = this.apiKey ?? deprecatedEnv('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY (or config.embedding.apiKey) is not set');
    }

    const response = await embedFetch({
      url: 'https://api.openai.com/v1/embeddings',
      apiKey,
      provider: 'OpenAI',
      body: { model: this.model, input: texts, dimensions: this.dimensions },
    });

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

  constructor(options?: { model?: string; dimensions?: number; ollamaHost?: string }) {
    this.model = options?.model ?? 'bge-m3';
    this.dimensions = options?.dimensions ?? OLLAMA_MODEL_DIMS[this.model] ?? 1024;
    this.baseUrl = options?.ollamaHost ?? deprecatedEnv('OLLAMA_HOST') ?? 'http://localhost:11434';
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

/**
 * Auto-refresh requires the OAuth client credentials gemini-cli used to
 * mint the user's `~/.gemini/oauth_creds.json`. We do NOT bundle these —
 * they belong to whoever owns the gemini-cli install. Users opt-in by
 * exporting:
 *
 *   GEMINI_OAUTH_CLIENT_ID=...
 *   GEMINI_OAUTH_CLIENT_SECRET=...
 *
 * before running the embedder. When unset, the refresh path throws a
 * clear actionable error pointing at `gemini auth login`, which the CLI
 * uses to re-mint the creds file end-to-end.
 */

interface GeminiOAuthCreds {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
  /** Milliseconds-since-epoch (Google's standard). */
  expiry_date?: number;
}

/**
 * Refresh an expired gemini-cli access token in place. Persists the new
 * tokens back to `oauth_creds.json` so subsequent calls (and the CLI
 * itself) pick them up. Returns the fresh `access_token`.
 *
 * F3 — without this, the embedder would 401 forever once the user's
 * first token aged out (~1h). Mirrors gemini-cli's refresh logic.
 */
async function refreshGeminiAccessToken(
  oauthPath: string,
  creds: GeminiOAuthCreds,
): Promise<string> {
  if (!creds.refresh_token) {
    throw new Error(
      'Gemini OAuth access_token expired and no refresh_token is present. ' +
      'Run: gemini auth login',
    );
  }

  // No literal client id / secret is baked in — the consumer must supply
  // them via env if they want non-interactive refresh. Otherwise the user
  // re-auths via the gemini CLI itself.
  const clientId = process.env.GEMINI_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GEMINI_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Gemini OAuth access_token expired. Auto-refresh requires ' +
      'GEMINI_OAUTH_CLIENT_ID + GEMINI_OAUTH_CLIENT_SECRET env vars ' +
      '(use the values your gemini-cli install uses), or just re-auth: ' +
      'gemini auth login',
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    // F3 — when the configured OAuth client doesn't match the one that
    // minted the user's creds file, Google returns `invalid_client`. The
    // correct fallback is to re-auth via the gemini CLI, which
    // re-mints the creds file using its own client config.
    const hint = text.includes('invalid_client')
      ? 'GEMINI_OAUTH_CLIENT_ID/SECRET don\'t match the client your gemini-cli is using. '
      : '';
    throw new Error(
      `Gemini OAuth refresh failed (${response.status}): ${text.slice(0, 200)}. ` +
      `${hint}Run: gemini auth login`,
    );
  }

  const next = (await response.json()) as {
    access_token: string;
    expires_in: number;
    scope?: string;
    token_type?: string;
    id_token?: string;
    refresh_token?: string;
  };

  const updated: GeminiOAuthCreds = {
    ...creds,
    access_token: next.access_token,
    expiry_date: Date.now() + next.expires_in * 1000,
    scope: next.scope ?? creds.scope,
    token_type: next.token_type ?? creds.token_type,
    id_token: next.id_token ?? creds.id_token,
    // Google usually omits a fresh refresh_token; keep the old one.
    refresh_token: next.refresh_token ?? creds.refresh_token,
  };

  try {
    fsWriteFileSync(oauthPath, JSON.stringify(updated, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Persistence failure isn't fatal — we still have a valid token in memory.
  }
  return updated.access_token;
}

export class GeminiOAuthEmbedder implements EmbeddingProvider {
  readonly name = 'gemini-oauth';
  readonly dimensions: number;
  private readonly model: string;

  constructor(options?: { model?: string; dimensions?: number }) {
    this.model = options?.model ?? 'text-embedding-004';
    this.dimensions = options?.dimensions ?? 768;
  }

  private async getAccessToken(): Promise<string> {
    const oauthPath = pathJoin(osHomedir(), '.gemini', 'oauth_creds.json');
    if (!fsExistsSync(oauthPath)) {
      throw new Error('Gemini CLI not authenticated. Run: gemini auth login');
    }
    const creds = JSON.parse(fsReadFileSync(oauthPath, 'utf-8')) as GeminiOAuthCreds;
    if (!creds.access_token) {
      throw new Error('Gemini OAuth token not found. Run: gemini auth login');
    }

    // F3 — auto-refresh when expired (or within the 5-minute clock-skew
    // buffer). Without this the embedder dies with 401 after ~1h.
    const REFRESH_BUFFER_MS = 5 * 60 * 1000;
    if (typeof creds.expiry_date === 'number' && creds.expiry_date - REFRESH_BUFFER_MS < Date.now()) {
      return refreshGeminiAccessToken(oauthPath, creds);
    }
    return creds.access_token;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const token = await this.getAccessToken();
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
// 6. OpenAI-compatible Embedder (works with any embeddings API)
//
// Supports: OpenAI, Mistral, Together, Fireworks, OpenRouter, Jina,
//           local vLLM, LM Studio, llama.cpp, text-embeddings-inference, etc.
//
// Constructor takes config; falls back to CODE_SEARCH_EMBEDDING_* env vars
// only when the field is omitted (one-shot deprecation warning per key).
// ---------------------------------------------------------------------------

export class OpenAICompatibleEmbedder implements EmbeddingProvider {
  readonly name = 'openai-compatible';
  readonly dimensions: number;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(options?: { model?: string; dimensions?: number; baseUrl?: string; apiKey?: string }) {
    this.baseUrl = options?.baseUrl ?? deprecatedEnv('CODE_SEARCH_EMBEDDING_BASE_URL') ?? '';
    this.model = options?.model ?? deprecatedEnv('CODE_SEARCH_EMBEDDING_MODEL') ?? '';
    this.apiKey = options?.apiKey ?? deprecatedEnv('CODE_SEARCH_EMBEDDING_API_KEY');
    this.dimensions = options?.dimensions ?? 1024;

    if (!this.baseUrl) throw new Error('Embedding base URL required. Pass config.embedding.baseUrl or set CODE_SEARCH_EMBEDDING_BASE_URL');
    if (!this.model) throw new Error('Embedding model required. Pass config.embedding.model or set CODE_SEARCH_EMBEDDING_MODEL');
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await embedFetch({
      url: `${this.baseUrl.replace(/\/$/, '')}/v1/embeddings`,
      apiKey: this.apiKey,
      provider: 'Embedding',
      body: {
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
        encoding_format: 'float',
      },
    });

    const json = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return json.data.map((d) => d.embedding);
  }

  async embedSingle(text: string): Promise<number[]> {
    const [result] = await this.embed([text]);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Check if Ollama is running locally. */
function isOllamaRunning(host: string): boolean {
  try {
    execSyncCmd(`curl -s --max-time 2 ${host}/api/tags`, { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** Check if Gemini CLI is authenticated and has a valid OAuth token. */
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

/**
 * Build an embedding provider from an explicit config struct.
 * Accepts the legacy `{ provider, model, dimensions }` shape too — extra
 * struct fields (`apiKey`, `baseUrl`, `ollamaHost`) just flow through when
 * present.
 */
export function createEmbeddingProvider(
  config: EmbeddingProviderConfig | { provider: string; model?: string; dimensions?: number },
): EmbeddingProvider {
  // Allow legacy `{ provider, model, dimensions }` callers to keep working
  // while P2 migration is in flight.
  const cfg = config as EmbeddingProviderConfig;
  const baseOpts = {
    model: cfg.model,
    dimensions: cfg.dimensions,
    apiKey: cfg.apiKey,
  };

  switch (cfg.provider) {
    case 'codestral':
    case 'mistral':
      return new CodestralEmbedder(baseOpts);
    case 'voyage':
      return new VoyageEmbedder(baseOpts);
    case 'openai':
      return new OpenAIEmbedder(baseOpts);
    case 'ollama':
      return new OllamaEmbedder({
        model: cfg.model,
        dimensions: cfg.dimensions,
        ollamaHost: cfg.ollamaHost ?? cfg.baseUrl,
      });
    case 'gemini-oauth':
    case 'gemini':
      return new GeminiOAuthEmbedder({ model: cfg.model, dimensions: cfg.dimensions });
    case 'openai-compatible':
    case 'custom':
      return new OpenAICompatibleEmbedder({
        model: cfg.model,
        dimensions: cfg.dimensions,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
      });
    case 'auto': {
      // Auto-detect: explicit baseUrl → openai-compatible; local Ollama →
      // ollama; API keys → cloud; fall through to Gemini CLI OAuth.
      const host = cfg.ollamaHost ?? deprecatedEnv('OLLAMA_HOST') ?? 'http://localhost:11434';
      if (cfg.baseUrl || process.env.CODE_SEARCH_EMBEDDING_BASE_URL) {
        return new OpenAICompatibleEmbedder({
          model: cfg.model,
          dimensions: cfg.dimensions,
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
        });
      }
      if (isOllamaRunning(host)) {
        return new OllamaEmbedder({ model: cfg.model, dimensions: cfg.dimensions, ollamaHost: host });
      }
      if (cfg.apiKey || process.env.MISTRAL_API_KEY) {
        return new CodestralEmbedder(baseOpts);
      }
      if (process.env.OPENAI_API_KEY) return new OpenAIEmbedder(baseOpts);
      if (process.env.VOYAGE_API_KEY) return new VoyageEmbedder(baseOpts);
      if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
        return new GeminiOAuthEmbedder({ model: cfg.model, dimensions: cfg.dimensions });
      }
      if (isGeminiCliAuthenticated()) {
        return new GeminiOAuthEmbedder({ model: cfg.model, dimensions: cfg.dimensions });
      }
      throw new Error(
        'No embedding provider available. Install Ollama (brew install ollama && ollama pull bge-m3), ' +
        'set an API key (MISTRAL_API_KEY, OPENAI_API_KEY, VOYAGE_API_KEY) — or pass ' +
        'config.embedding.apiKey + config.embedding.baseUrl for a custom provider.',
      );
    }
    default:
      throw new Error(
        `Unknown embedding provider "${cfg.provider}". ` +
          'Supported: codestral, mistral, voyage, openai, ollama, gemini, gemini-oauth, ' +
          'openai-compatible, custom, auto. Removed: nomic-local.',
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
