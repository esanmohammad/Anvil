/**
 * Back-compat shim over the unified CodeSearchConfig resolver (P3).
 *
 * @deprecated Internal callers should switch to `resolveCodeSearchConfig()`
 * from `./config.js`. This shim derives the legacy `ServerConfig` shape from
 * the unified config so existing handlers / middlewares can keep working
 * until they're migrated.
 */

import { execSync as _execSync } from 'node:child_process';
import {
  resolveCodeSearchConfig,
  type CodeSearchConfig,
  parseCliFlags,
} from './config.js';
import { normalizeRerankerConfig } from '@esankhan3/anvil-knowledge-core';

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

  // LLM inference
  llmMode: 'cli' | 'api' | 'none';
  llmProvider: string;
  llmModel: string;
  llmApiKey: string | undefined;
  llmBaseUrl: string | undefined;
  claudeBin: string;

  /** Underlying unified config — preferred for new code. */
  __unified: CodeSearchConfig;
}

let _config: ServerConfig | null = null;

function resolveLlmMode(
  explicit: CodeSearchConfig['llm']['mode'] | undefined,
  apiKey: string | undefined,
  claudeBin: string,
): ServerConfig['llmMode'] {
  if (explicit && explicit !== 'none') {
    if (explicit === 'api' && !apiKey) {
      console.error(
        `[code-search-mcp] WARNING: LLM_MODE=api but no API key found. ` +
        `Set CODE_SEARCH_LLM_API_KEY or ANTHROPIC_API_KEY. Falling back to LLM_MODE=none.`,
      );
      return 'none';
    }
    return explicit;
  }

  if (apiKey) return 'api';

  try {
    _execSync(`which ${claudeBin}`, { stdio: 'pipe', timeout: 3000 });
    return 'cli';
  } catch {
    /* No CLI binary found */
  }

  console.error(
    `[code-search-mcp] No LLM configured — repo profiling and service mesh inference disabled. ` +
    `Set CODE_SEARCH_LLM_API_KEY for API mode, or install Claude CLI for CLI mode.`,
  );
  return 'none';
}

export function loadServerConfig(opts?: { argv?: string[]; workspaceDir?: string }): ServerConfig {
  if (_config) return _config;

  const cli = opts?.argv ? parseCliFlags(opts.argv).patch : undefined;
  const c = resolveCodeSearchConfig({ cli, workspaceDir: opts?.workspaceDir });

  const rerankerStruct = normalizeRerankerConfig(c.reranker);
  const llmMode = resolveLlmMode(c.llm.mode, c.llm.apiKey, c.llm.claudeBin);

  _config = {
    port: c.server.port,
    host: c.server.host,
    transport: c.server.transport,
    dataDir: c.storage.dataDir,

    embeddingProvider: c.embedding.provider,
    embeddingModel: c.embedding.model,
    embeddingDimensions: c.embedding.dimensions ?? 1024,
    embeddingApiKey: c.embedding.apiKey,
    embeddingBaseUrl: c.embedding.baseUrl,
    ollamaHost: c.embedding.ollamaHost ?? 'http://localhost:11434',

    rerankerProvider: rerankerStruct.provider,
    rerankerModel: rerankerStruct.model,
    rerankerApiKey: rerankerStruct.apiKey,
    rerankerBaseUrl: rerankerStruct.baseUrl,

    githubToken: c.github.token,

    authEnabled: c.auth.mode !== 'none',
    authMode: c.auth.mode,
    authApiKeys: c.auth.apiKeys,
    authJwtSecret: c.auth.jwtSecret,
    authJwtIssuer: c.auth.jwtIssuer,

    rateLimitPerMinute: c.auth.rateLimitPerMinute,

    llmMode,
    llmProvider: c.llm.provider,
    llmModel: c.llm.model,
    llmApiKey: c.llm.apiKey,
    llmBaseUrl: c.llm.baseUrl,
    claudeBin: c.llm.claudeBin,

    __unified: c,
  };

  // Bridge unified credentials into provider-specific env vars so legacy
  // knowledge-core code paths (auto-detect + deprecation seam) keep working
  // for one release cycle. New code reads from `__unified` directly.
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
  if (_config.rerankerApiKey) {
    if (_config.rerankerProvider === 'cohere') process.env.COHERE_API_KEY ??= _config.rerankerApiKey;
    if (_config.rerankerProvider === 'voyage') process.env.VOYAGE_API_KEY ??= _config.rerankerApiKey;
  }
  process.env.OLLAMA_HOST ??= _config.ollamaHost;

  // F1 — CODE_SEARCH_LLM_* → ANVIL_LLM_* bridging is handled inside
  // resolveCodeSearchConfig() so the CLI / daemon / serve paths all
  // benefit. Nothing further to do here.

  return _config;
}

export function resetServerConfig(): void {
  _config = null;
}
