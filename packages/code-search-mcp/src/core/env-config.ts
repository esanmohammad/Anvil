/**
 * Unified environment-based configuration for production deployments.
 * All values sourced from CODE_SEARCH_* env vars, falling back to defaults.
 */

import { execSync as _execSync } from 'node:child_process';

export interface ServerConfig {
  // Server
  port: number;
  host: string;
  transport: 'stdio' | 'sse' | 'streamable-http';

  // Storage
  dataDir: string;

  // Embedding
  embeddingProvider: string;
  embeddingModel: string | undefined;
  embeddingDimensions: number;
  embeddingApiKey: string | undefined;
  embeddingBaseUrl: string | undefined;
  ollamaHost: string;

  // Reranking
  rerankerProvider: string;
  rerankerModel: string | undefined;
  rerankerApiKey: string | undefined;
  rerankerBaseUrl: string | undefined;

  // GitHub
  githubToken: string | undefined;

  // Auth
  authEnabled: boolean;
  authMode: 'api-key' | 'jwt' | 'none';
  authApiKeys: string[];
  authJwtSecret: string | undefined;
  authJwtIssuer: string;

  // Rate limiting
  rateLimitPerMinute: number;

  // LLM inference (profiling + service mesh)
  llmMode: 'cli' | 'api' | 'none';
  llmProvider: string;       // 'anthropic' | 'openai' | 'ollama' | 'custom'
  llmModel: string;
  llmApiKey: string | undefined;
  llmBaseUrl: string | undefined;
  claudeBin: string;
}

let _config: ServerConfig | null = null;

/**
 * Resolve LLM mode with smart defaults:
 *   - Explicit env var wins
 *   - If API key is available → 'api'
 *   - If claude CLI binary exists → 'cli'
 *   - Otherwise → 'none' (LLM features disabled, indexing still works without profiling)
 */
function resolveLlmMode(
  explicit: string | undefined,
  apiKey: string | undefined,
): ServerConfig['llmMode'] {
  if (explicit) {
    const mode = explicit as ServerConfig['llmMode'];
    if (mode === 'api' && !apiKey) {
      console.error(
        `[code-search-mcp] WARNING: LLM_MODE=api but no API key found. ` +
        `Set CODE_SEARCH_LLM_API_KEY or ANTHROPIC_API_KEY. Falling back to LLM_MODE=none.`
      );
      return 'none';
    }
    return mode;
  }

  // Auto-detect: prefer API if key exists (works in Docker), then CLI, then none
  if (apiKey) return 'api';

  try {
    const bin = process.env.ANVIL_AGENT_CMD ?? process.env.FF_AGENT_CMD ?? process.env.CLAUDE_BIN ?? 'claude';
    _execSync(`which ${bin}`, { stdio: 'pipe', timeout: 3000 });
    return 'cli';
  } catch {
    // No CLI binary found
  }

  console.error(
    `[code-search-mcp] No LLM configured — repo profiling and service mesh inference disabled. ` +
    `Set CODE_SEARCH_LLM_API_KEY for API mode, or install Claude CLI for CLI mode.`
  );
  return 'none';
}

export function loadServerConfig(): ServerConfig {
  if (_config) return _config;

  const env = (key: string): string | undefined => process.env[`CODE_SEARCH_${key}`];

  const authMode = (env('AUTH_MODE') ?? 'none') as ServerConfig['authMode'];

  _config = {
    port: parseInt(env('PORT') ?? '3100', 10),
    host: env('HOST') ?? (authMode === 'none' ? '127.0.0.1' : '0.0.0.0'),
    transport: (env('TRANSPORT') ?? 'stdio') as ServerConfig['transport'],

    dataDir: env('DATA_DIR') ?? '',

    embeddingProvider: env('EMBEDDING_PROVIDER') ?? 'auto',
    embeddingModel: env('EMBEDDING_MODEL'),
    embeddingDimensions: parseInt(env('EMBEDDING_DIMENSIONS') ?? '1024', 10),
    embeddingApiKey: env('EMBEDDING_API_KEY'),
    embeddingBaseUrl: env('EMBEDDING_BASE_URL'),
    ollamaHost: env('OLLAMA_HOST') ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434',

    rerankerProvider: env('RERANKER_PROVIDER') ?? 'ollama',
    rerankerModel: env('RERANKER_MODEL'),
    rerankerApiKey: env('RERANKER_API_KEY'),
    rerankerBaseUrl: env('RERANKER_BASE_URL'),

    githubToken: env('GITHUB_TOKEN') ?? process.env.GITHUB_TOKEN,

    authEnabled: authMode !== 'none',
    authMode,
    authApiKeys: (env('AUTH_API_KEYS') ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    authJwtSecret: env('AUTH_JWT_SECRET'),
    authJwtIssuer: env('AUTH_JWT_ISSUER') ?? 'code-search-mcp',

    rateLimitPerMinute: parseInt(env('RATE_LIMIT_PER_MINUTE') ?? '100', 10),

    llmMode: resolveLlmMode(env('LLM_MODE'), env('LLM_API_KEY') ?? process.env.ANTHROPIC_API_KEY),
    llmProvider: env('LLM_PROVIDER') ?? 'anthropic',
    llmModel: env('LLM_MODEL') ?? 'sonnet',
    llmApiKey: env('LLM_API_KEY') ?? process.env.ANTHROPIC_API_KEY,
    llmBaseUrl: env('LLM_BASE_URL'),
    claudeBin: env('CLAUDE_BIN') ?? process.env.CLAUDE_BIN ?? 'claude',
  };

  // Bridge unified embedding API key to provider-specific env vars
  if (_config.embeddingApiKey) {
    const provider = _config.embeddingProvider;
    if (provider === 'codestral' || provider === 'mistral') {
      process.env.MISTRAL_API_KEY ??= _config.embeddingApiKey;
    } else if (provider === 'openai') {
      process.env.OPENAI_API_KEY ??= _config.embeddingApiKey;
    } else if (provider === 'voyage') {
      process.env.VOYAGE_API_KEY ??= _config.embeddingApiKey;
    }
  }

  // Bridge reranker API key
  if (_config.rerankerApiKey) {
    const reranker = _config.rerankerProvider;
    if (reranker === 'cohere') {
      process.env.COHERE_API_KEY ??= _config.rerankerApiKey;
    } else if (reranker === 'voyage') {
      process.env.VOYAGE_API_KEY ??= _config.rerankerApiKey;
    }
  }

  // Bridge Ollama host
  process.env.OLLAMA_HOST ??= _config.ollamaHost;

  return _config;
}

/** Reset config (for testing) */
export function resetServerConfig(): void {
  _config = null;
}
