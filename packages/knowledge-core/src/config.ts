import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Embedding provider identifier. Aliases listed for ergonomics; canonical
 * forms are `mistral`, `gemini-oauth`, `openai-compatible`.
 *   - `codestral` ≡ `mistral`
 *   - `gemini`    ≡ `gemini-oauth`
 *   - `custom`    ≡ `openai-compatible`
 */
export type EmbeddingProviderId =
  | 'codestral'         // alias for 'mistral'
  | 'mistral'           // canonical
  | 'voyage'
  | 'openai'
  | 'ollama'
  | 'gemini'            // alias for 'gemini-oauth'
  | 'gemini-oauth'      // canonical
  | 'openai-compatible' // canonical
  | 'custom'            // alias for 'openai-compatible'
  | 'auto';

/**
 * Reranker provider identifier. `custom` ≡ `openai-compatible`. `none`
 * disables reranking entirely (vector + BM25 RRF order is final).
 */
export type RerankerProviderId =
  | 'cohere'
  | 'voyage'
  | 'ollama'
  | 'openai-compatible'
  | 'custom'
  | 'none';

/**
 * Per-provider embedding config. apiKey/baseUrl/ollamaHost are optional —
 * provider classes fall back to documented env vars when omitted (deprecation
 * cycle in effect; consumer code should pass these explicitly).
 */
export interface EmbeddingProviderConfig {
  provider: EmbeddingProviderId;
  model?: string;
  dimensions?: number;
  apiKey?: string;
  baseUrl?: string;
  ollamaHost?: string;
  /** @deprecated Use `apiKey` directly. Kept for back-compat of older configs. */
  apiKeyEnv?: string;
}

/**
 * Per-provider reranker config. Pass-through to the factory; factory falls
 * back to `CODE_SEARCH_RERANKER_*` env vars when struct fields are omitted.
 */
export interface RerankerProviderConfig {
  provider: RerankerProviderId;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface KnowledgeConfig {
  embedding: EmbeddingProviderConfig;
  chunking: {
    maxTokens: number;
    contextEnrichment: 'structural' | 'llm' | 'none';
  };
  retrieval: {
    maxChunks: number;
    maxTokens: number;
    hybridWeights: { vector: number; bm25: number; graph: number };
    /**
     * Reranker config — either a struct (P2+) or a bare provider id (P1
     * back-compat). String form is normalized to a struct at factory time.
     */
    reranker: RerankerProviderConfig | RerankerProviderId;
  };
  autoIndex: boolean;
}

export const DEFAULT_CONFIG: KnowledgeConfig = {
  embedding: { provider: 'auto', dimensions: 1024 },
  chunking: { maxTokens: 500, contextEnrichment: 'structural' },
  retrieval: {
    // Phase 6 — with the cross-encoder rerank default-on, the retriever can
    // emit a much tighter top-K with equal precision: the reranker picks the
    // best 8 from the larger fused+AST candidate pool (~15+ chunks). Override
    // via project.yaml when callers want a wider window.
    maxChunks: 8,
    maxTokens: 12000,
    hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 },
    reranker: { provider: 'ollama' },
  },
  autoIndex: true,
};

/** Deep-clone a KnowledgeConfig — used by env-override layer (P1). */
export function cloneKnowledgeConfig(c: KnowledgeConfig): KnowledgeConfig {
  return {
    embedding: { ...c.embedding },
    chunking: { ...c.chunking },
    retrieval: {
      maxChunks: c.retrieval.maxChunks,
      maxTokens: c.retrieval.maxTokens,
      hybridWeights: { ...c.retrieval.hybridWeights },
      reranker:
        typeof c.retrieval.reranker === 'string'
          ? c.retrieval.reranker
          : { ...c.retrieval.reranker },
    },
    autoIndex: c.autoIndex,
  };
}

/** Normalize the legacy string-shape reranker config into a struct. */
export function normalizeRerankerConfig(
  r: RerankerProviderConfig | RerankerProviderId,
): RerankerProviderConfig {
  return typeof r === 'string' ? { provider: r } : r;
}

/**
 * Load knowledge config from factory.yaml, merging with defaults.
 *
 * P1 — applies `CODE_SEARCH_*` env-var overrides on top of the YAML/defaults
 * so the env vars documented by code-search-mcp actually reach the indexer.
 * Tracked in {@link https://github.com/esanmohammad/Anvil/issues/6}.
 *
 * P2 will move this function into `config-helpers.ts` and make
 * knowledge-core's public entry points require an explicit
 * KnowledgeConfig — see CODE-SEARCH-MCP-STANDALONE-PLAN.md.
 */
export function loadKnowledgeConfig(project: string): KnowledgeConfig {
  const anvilHome = process.env.ANVIL_HOME || join(homedir(), '.anvil');
  const paths = [
    join(anvilHome, 'projects', project, 'factory.yaml'),
    join(anvilHome, 'projects', project, 'project.yaml'),
  ];

  let baseConfig: KnowledgeConfig | null = null;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf-8');
      baseConfig = parseKnowledgeSection(raw);
      break;
    } catch { /* use defaults */ }
  }
  return applyEnvOverrides(baseConfig ?? cloneKnowledgeConfig(DEFAULT_CONFIG));
}

/**
 * Overlay `CODE_SEARCH_*` env vars onto a KnowledgeConfig. Last-write
 * semantics per field. Bridges the unified `EMBEDDING_API_KEY` /
 * `RERANKER_API_KEY` env vars to the per-provider struct fields so the
 * provider classes can consume them without re-reading the env themselves.
 */
export function applyEnvOverrides(config: KnowledgeConfig): KnowledgeConfig {
  const next = cloneKnowledgeConfig(config);
  const env = (k: string): string | undefined => process.env[`CODE_SEARCH_${k}`];

  // Embedding
  const embedProvider = env('EMBEDDING_PROVIDER');
  if (embedProvider) next.embedding.provider = embedProvider as EmbeddingProviderId;
  const embedModel = env('EMBEDDING_MODEL');
  if (embedModel) next.embedding.model = embedModel;
  const embedDims = env('EMBEDDING_DIMENSIONS');
  if (embedDims) {
    const n = parseInt(embedDims, 10);
    if (Number.isFinite(n)) next.embedding.dimensions = n;
  }
  const embedKey = env('EMBEDDING_API_KEY');
  if (embedKey && !next.embedding.apiKey) next.embedding.apiKey = embedKey;
  const embedBase = env('EMBEDDING_BASE_URL');
  if (embedBase && !next.embedding.baseUrl) next.embedding.baseUrl = embedBase;
  const ollamaHost = env('OLLAMA_HOST') ?? process.env.OLLAMA_HOST;
  if (ollamaHost && !next.embedding.ollamaHost) next.embedding.ollamaHost = ollamaHost;

  // Reranker
  const rerankerStruct = normalizeRerankerConfig(next.retrieval.reranker);
  const rerankerProvider = env('RERANKER_PROVIDER');
  if (rerankerProvider) rerankerStruct.provider = rerankerProvider as RerankerProviderId;
  const rerankerModel = env('RERANKER_MODEL') ?? process.env.RERANKER_MODEL;
  if (rerankerModel && !rerankerStruct.model) rerankerStruct.model = rerankerModel;
  const rerankerKey = env('RERANKER_API_KEY');
  if (rerankerKey && !rerankerStruct.apiKey) rerankerStruct.apiKey = rerankerKey;
  const rerankerBase = env('RERANKER_BASE_URL');
  if (rerankerBase && !rerankerStruct.baseUrl) rerankerStruct.baseUrl = rerankerBase;
  next.retrieval.reranker = rerankerStruct;

  // Retrieval tuning
  const maxChunks = env('RETRIEVAL_MAX_CHUNKS');
  if (maxChunks) {
    const n = parseInt(maxChunks, 10);
    if (Number.isFinite(n)) next.retrieval.maxChunks = n;
  }
  const maxTokens = env('RETRIEVAL_MAX_TOKENS');
  if (maxTokens) {
    const n = parseInt(maxTokens, 10);
    if (Number.isFinite(n)) next.retrieval.maxTokens = n;
  }

  // Indexing toggles
  const autoIndex = env('AUTO_INDEX');
  if (autoIndex !== undefined) next.autoIndex = autoIndex !== 'false' && autoIndex !== '0';

  return next;
}

function parseKnowledgeSection(yaml: string): KnowledgeConfig {
  // Minimal YAML parsing for knowledge section
  const config = cloneKnowledgeConfig(DEFAULT_CONFIG);

  // Parse embedding provider
  const providerMatch = yaml.match(/^\s{4}provider:\s+(\S+)/m);
  if (providerMatch) {
    config.embedding = { ...config.embedding, provider: providerMatch[1] as EmbeddingProviderId };
  }

  // Parse embedding model
  const modelMatch = yaml.match(/^\s{4}model:\s+(\S+)/m);
  if (modelMatch) config.embedding.model = modelMatch[1];

  // Parse dimensions
  const dimMatch = yaml.match(/^\s{4}dimensions:\s+(\d+)/m);
  if (dimMatch) config.embedding.dimensions = parseInt(dimMatch[1], 10);

  // Parse chunking max_tokens
  const chunkMatch = yaml.match(/^\s{4}max_tokens:\s+(\d+)/m);
  if (chunkMatch) config.chunking.maxTokens = parseInt(chunkMatch[1], 10);

  // Parse context_enrichment
  const enrichMatch = yaml.match(/^\s{4}context_enrichment:\s+(\S+)/m);
  if (enrichMatch) config.chunking.contextEnrichment = enrichMatch[1] as KnowledgeConfig['chunking']['contextEnrichment'];

  // Parse auto_index
  const autoMatch = yaml.match(/^\s{2}auto_index:\s+(true|false)/m);
  if (autoMatch) config.autoIndex = autoMatch[1] === 'true';

  // Parse reranker provider
  const rerankerMatch = yaml.match(/^\s{4}reranker:\s+(\S+)/m);
  if (rerankerMatch) {
    config.retrieval.reranker = { provider: rerankerMatch[1] as RerankerProviderId };
  }

  return config;
}

/**
 * Get the knowledge base storage path for a project.
 *
 * Resolution order (matches both consumer behaviors):
 *   1. CODE_SEARCH_DATA_DIR — used by mcp's docker / production deployments
 *   2. ANVIL_HOME / 'knowledge-base' — cli's default
 *   3. ~/.anvil/knowledge-base — fallback when neither env var is set
 */
export function getKnowledgeBasePath(project: string): string {
  // CODE_SEARCH_DATA_DIR takes priority (Docker / production)
  const dataDir = process.env.CODE_SEARCH_DATA_DIR;
  if (dataDir) return join(dataDir, project);

  const anvilHome = process.env.ANVIL_HOME || join(homedir(), '.anvil');
  return join(anvilHome, 'knowledge-base', project);
}
