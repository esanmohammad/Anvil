/**
 * Unified CodeSearchConfig — defaults → file → env → CLI flags.
 *
 * The single source of truth for every code-search-mcp setting. Every
 * downstream surface (server, daemon, CLI, MCP) reads this object; nothing
 * else reads `process.env` or YAML files at runtime.
 *
 * Resolution order (lowest → highest precedence):
 *   1. compiled-in DEFAULTS
 *   2. ~/.code-search/config.yaml      (user-global)
 *   3. <workspaceDir>/.code-search.yaml (per-workspace override)
 *   4. CODE_SEARCH_* environment variables
 *   5. CLI flags
 *
 * See packages/dashboard/../docs/CODE-SEARCH-MCP-STANDALONE-PLAN.md §3.4.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  EmbeddingProviderConfig,
  EmbeddingProviderId,
  KnowledgeConfig,
  RerankerProviderConfig,
  RerankerProviderId,
} from '@esankhan3/anvil-knowledge-core';

// ---------------------------------------------------------------------------
// Public schema
// ---------------------------------------------------------------------------

export interface CodeSearchConfig {
  server: {
    transport: 'stdio' | 'streamable-http' | 'sse';
    port: number;
    host: string;
  };
  auth: {
    mode: 'none' | 'api-key' | 'jwt';
    apiKeys: string[];
    jwtSecret?: string;
    jwtIssuer: string;
    rateLimitPerMinute: number;
  };
  storage: {
    dataDir: string;
  };
  embedding: EmbeddingProviderConfig;
  reranker: RerankerProviderConfig;
  retrieval: {
    maxChunks: number;
    maxTokens: number;
    hybridWeights: { vector: number; bm25: number; graph: number };
  };
  indexing: {
    autoIndex: boolean;
    reindexIntervalMs: number;
    chunking: { maxTokens: number; contextEnrichment: 'structural' | 'llm' | 'none' };
    respectGitignore: boolean;
    debounceMs: number;
    /** Glob-style patterns to ignore in addition to .gitignore */
    ignorePatterns: string[];
  };
  llm: {
    mode: 'cli' | 'api' | 'none';
    provider: 'anthropic' | 'openai' | 'openai-compatible' | 'custom';
    model: string;
    apiKey?: string;
    baseUrl?: string;
    claudeBin: string;
  };
  github: {
    token?: string;
  };
  telemetry: {
    otelEndpoint?: string;
    otelHeaders?: Record<string, string>;
    metricsEnabled: boolean;
    structuredLogs: boolean;
    recordQueries: boolean;
  };
  daemon: {
    /** Spawn an in-process daemon if no socket is found, or fall back to in-process index */
    autoSpawn: boolean;
    /** Disable daemon entirely; force in-process backend */
    disabled: boolean;
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultDataDir(): string {
  return process.env.CODE_SEARCH_DATA_DIR
    ?? join(homedir(), '.code-search', 'index');
}

export const DEFAULTS: CodeSearchConfig = {
  server: {
    transport: 'stdio',
    port: 3100,
    host: '127.0.0.1',
  },
  auth: {
    mode: 'none',
    apiKeys: [],
    jwtSecret: undefined,
    jwtIssuer: 'code-search-mcp',
    rateLimitPerMinute: 100,
  },
  storage: {
    dataDir: defaultDataDir(),
  },
  embedding: {
    provider: 'auto',
    dimensions: 1024,
  },
  reranker: {
    provider: 'ollama',
  },
  retrieval: {
    maxChunks: 8,
    maxTokens: 12000,
    hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 },
  },
  indexing: {
    autoIndex: true,
    reindexIntervalMs: 0,
    chunking: { maxTokens: 500, contextEnrichment: 'structural' },
    respectGitignore: true,
    debounceMs: 500,
    ignorePatterns: ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'vendor', 'target'],
  },
  llm: {
    mode: 'none',
    provider: 'anthropic',
    model: 'sonnet',
    apiKey: undefined,
    baseUrl: undefined,
    claudeBin: 'claude',
  },
  github: {
    token: undefined,
  },
  telemetry: {
    otelEndpoint: undefined,
    otelHeaders: undefined,
    metricsEnabled: false,
    structuredLogs: false,
    recordQueries: false,
  },
  daemon: {
    autoSpawn: false,
    disabled: false,
  },
};

// ---------------------------------------------------------------------------
// Deep-merge helper (partial-config layering)
// ---------------------------------------------------------------------------

type DeepPartial<T> = { [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T extends Record<string, unknown>>(base: T, ...patches: Array<DeepPartial<T>>): T {
  const out: Record<string, unknown> = { ...base };
  for (const p of patches) {
    if (!p) continue;
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      if (isPlainObject(v) && isPlainObject(out[k])) {
        out[k] = deepMerge(out[k] as Record<string, unknown>, v as DeepPartial<Record<string, unknown>>);
      } else {
        out[k] = v;
      }
    }
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Layer 2: YAML file (~/.code-search/config.yaml, .code-search.yaml)
// ---------------------------------------------------------------------------

/**
 * Minimal YAML parser — flat key:value, nested via 2-space indent, scalars
 * (string/number/bool), arrays via inline `[a, b, c]` syntax. Sufficient for
 * the CodeSearchConfig surface; full YAML is intentionally out of scope to
 * keep zero deps.
 */
function parseYaml(src: string): Record<string, unknown> {
  const lines = src.split(/\r?\n/);
  const root: Record<string, unknown> = {};
  // Stack of { obj, indent } so we know where to write.
  const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [{ obj: root, indent: -1 }];

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const valRaw = trimmed.slice(colon + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;

    if (!valRaw) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ obj: child, indent });
      continue;
    }

    parent[key] = coerce(valRaw);
  }
  return root;
}

function coerce(raw: string): unknown {
  // Strip surrounding quotes
  let v = raw;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  // Inline array
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((s) => coerce(s.trim()));
  }
  // Inline object: `{a: 1, b: 2}`
  if (v.startsWith('{') && v.endsWith('}')) {
    const o: Record<string, unknown> = {};
    for (const part of v.slice(1, -1).split(',')) {
      const [k, x] = part.split(':');
      if (k && x !== undefined) o[k.trim()] = coerce(x.trim());
    }
    return o;
  }
  // Tilde expansion for paths
  if (v.startsWith('~')) return v.replace(/^~/, homedir());
  return v;
}

function snakeToCamel(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(snakeToCamel);
  if (!isPlainObject(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = snakeToCamel(v);
  }
  return out;
}

function loadYamlFile(path: string): DeepPartial<CodeSearchConfig> | null {
  if (!existsSync(path)) return null;
  try {
    const src = readFileSync(path, 'utf-8');
    const raw = parseYaml(src);
    return snakeToCamel(raw) as DeepPartial<CodeSearchConfig>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Layer 4: env vars
// ---------------------------------------------------------------------------

function parseHeaders(s: string | undefined): Record<string, string> | undefined {
  if (!s) return undefined;
  const out: Record<string, string> = {};
  for (const pair of s.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function parseReindexMs(raw: string | undefined): number {
  if (!raw || raw === '0' || raw === 'none') return 0;
  const m = raw.match(/^(\d+)(m|h)$/);
  if (!m) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return m[2] === 'h' ? parseInt(m[1], 10) * 60 * 60_000 : parseInt(m[1], 10) * 60_000;
}

function envLayer(): DeepPartial<CodeSearchConfig> {
  const env = (k: string): string | undefined => process.env[`CODE_SEARCH_${k}`];
  const authMode = env('AUTH_MODE') as CodeSearchConfig['auth']['mode'] | undefined;
  const transport = env('TRANSPORT') as CodeSearchConfig['server']['transport'] | undefined;
  const port = env('PORT');
  const rateLimit = env('RATE_LIMIT_PER_MINUTE');
  const maxChunks = env('RETRIEVAL_MAX_CHUNKS');
  const maxTokens = env('RETRIEVAL_MAX_TOKENS');
  const chunkMaxTokens = env('CHUNKING_MAX_TOKENS');
  const debounce = env('INDEXING_DEBOUNCE_MS');
  const embedDims = env('EMBEDDING_DIMENSIONS');

  return {
    server: {
      transport: transport,
      port: port ? parseInt(port, 10) : undefined,
      host: env('HOST') ?? (authMode === 'none' || !authMode ? undefined : '0.0.0.0'),
    },
    auth: {
      mode: authMode,
      apiKeys: env('AUTH_API_KEYS')?.split(',').map((s) => s.trim()).filter(Boolean),
      jwtSecret: env('AUTH_JWT_SECRET'),
      jwtIssuer: env('AUTH_JWT_ISSUER'),
      rateLimitPerMinute: rateLimit ? parseInt(rateLimit, 10) : undefined,
    },
    storage: {
      dataDir: env('DATA_DIR'),
    },
    embedding: {
      provider: env('EMBEDDING_PROVIDER') as EmbeddingProviderId | undefined,
      model: env('EMBEDDING_MODEL'),
      dimensions: embedDims ? parseInt(embedDims, 10) : undefined,
      apiKey: env('EMBEDDING_API_KEY'),
      baseUrl: env('EMBEDDING_BASE_URL'),
      ollamaHost: env('OLLAMA_HOST') ?? process.env.OLLAMA_HOST,
    },
    reranker: {
      provider: env('RERANKER_PROVIDER') as RerankerProviderId | undefined,
      model: env('RERANKER_MODEL'),
      apiKey: env('RERANKER_API_KEY'),
      baseUrl: env('RERANKER_BASE_URL'),
    },
    retrieval: {
      maxChunks: maxChunks ? parseInt(maxChunks, 10) : undefined,
      maxTokens: maxTokens ? parseInt(maxTokens, 10) : undefined,
    },
    indexing: {
      autoIndex: env('AUTO_INDEX') !== undefined ? env('AUTO_INDEX') !== 'false' && env('AUTO_INDEX') !== '0' : undefined,
      reindexIntervalMs: env('REINDEX_INTERVAL') !== undefined ? parseReindexMs(env('REINDEX_INTERVAL')) : undefined,
      chunking: {
        maxTokens: chunkMaxTokens ? parseInt(chunkMaxTokens, 10) : undefined,
      },
      debounceMs: debounce ? parseInt(debounce, 10) : undefined,
    },
    llm: {
      mode: env('LLM_MODE') as CodeSearchConfig['llm']['mode'] | undefined,
      provider: env('LLM_PROVIDER') as CodeSearchConfig['llm']['provider'] | undefined,
      model: env('LLM_MODEL'),
      apiKey: env('LLM_API_KEY') ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY,
      baseUrl: env('LLM_BASE_URL'),
      claudeBin: env('CLAUDE_BIN') ?? process.env.CLAUDE_BIN,
    },
    github: {
      token: env('GITHUB_TOKEN') ?? process.env.GITHUB_TOKEN,
    },
    telemetry: {
      otelEndpoint: env('OTEL_ENDPOINT') ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      otelHeaders: parseHeaders(env('OTEL_HEADERS') ?? process.env.OTEL_EXPORTER_OTLP_HEADERS),
      metricsEnabled: env('METRICS_ENABLED') === '1' || env('METRICS_ENABLED') === 'true' ? true : undefined,
      structuredLogs: env('STRUCTURED_LOGS') === '1' || env('STRUCTURED_LOGS') === 'true' ? true : undefined,
      recordQueries: env('TELEMETRY_RECORD_QUERIES') === '1' || env('TELEMETRY_RECORD_QUERIES') === 'true' ? true : undefined,
    },
    daemon: {
      autoSpawn: env('DAEMON_AUTO_SPAWN') === '1' || env('DAEMON_AUTO_SPAWN') === 'true' ? true : undefined,
      disabled: env('DAEMON_DISABLED') === '1' || env('DAEMON_DISABLED') === 'true' ? true : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Layer 5: CLI flags
// ---------------------------------------------------------------------------

/**
 * Parse `--<dotted.path> <value>` flags into a DeepPartial<CodeSearchConfig>.
 * `--no-x.y` sets a boolean false. Boolean flags without a value are `true`.
 * Reserved subcommand-style flags (`--local`, `--remote`, `--serve`, etc.)
 * are passed back to the caller as `rest`.
 */
const RESERVED_FLAGS = new Set([
  '--local',
  '--remote',
  '--serve',
  '--help',
  '-h',
  '--print-config',
  '--api-key',
  '--project',
  '--token',
  '--force',
  '--workspace',
  '--no-daemon',
  '--auto-spawn-daemon',
  '--config',
  '--format',
  '--top-k',
  '--mode',
  '--repo',
  '--language',
]);

export interface CliParseResult {
  patch: DeepPartial<CodeSearchConfig>;
  rest: string[];
}

export function parseCliFlags(argv: string[]): CliParseResult {
  const patch: Record<string, unknown> = {};
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--') || RESERVED_FLAGS.has(arg)) {
      rest.push(arg);
      continue;
    }
    let key = arg.slice(2);
    let negate = false;
    if (key.startsWith('no-')) {
      negate = true;
      key = key.slice(3);
    }
    // Map kebab-case to camelCase per segment.
    const path = key.split('.').map((seg) => seg.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
    let val: unknown;
    if (negate) {
      val = false;
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      val = coerce(argv[++i]);
    } else {
      val = true;
    }
    setDeep(patch, path, val);
  }
  return { patch: patch as DeepPartial<CodeSearchConfig>, rest };
}

function setDeep(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

// ---------------------------------------------------------------------------
// Resolver (the public entry point)
// ---------------------------------------------------------------------------

export interface ResolveOpts {
  /** Path to per-workspace `.code-search.yaml` (override file). */
  workspaceDir?: string;
  /** Pre-parsed CLI patch (from parseCliFlags). */
  cli?: DeepPartial<CodeSearchConfig>;
  /** Override the global config file path. */
  configPath?: string;
}

export function resolveCodeSearchConfig(opts: ResolveOpts = {}): CodeSearchConfig {
  const globalConfigPath = opts.configPath ?? join(homedir(), '.code-search', 'config.yaml');
  const yaml1 = loadYamlFile(globalConfigPath) ?? {};
  const yaml2 = opts.workspaceDir ? (loadYamlFile(join(opts.workspaceDir, '.code-search.yaml')) ?? {}) : {};
  const env = envLayer();
  const cli = opts.cli ?? {};
  const cfg = deepMerge(DEFAULTS, yaml1, yaml2, env, cli);
  bridgeLegacyEnvVars(cfg);
  return cfg;
}

/**
 * F1 — pre-promote CODE_SEARCH_LLM_* env vars to ANVIL_LLM_* before
 * agent-core (loaded lazily inside knowledge-core's indexer) reads them
 * via `readAliased`. Without this bridge, agent-core sees only the
 * legacy name and emits a one-shot stderr deprecation warning, which is
 * pure noise for a user who is using code-search standalone.
 *
 * Only writes when the canonical name is unset, so an explicit ANVIL_*
 * still wins.
 */
function bridgeLegacyEnvVars(cfg: CodeSearchConfig): void {
  process.env.ANVIL_LLM_MODE     ??= process.env.CODE_SEARCH_LLM_MODE     ?? cfg.llm.mode;
  process.env.ANVIL_LLM_PROVIDER ??= process.env.CODE_SEARCH_LLM_PROVIDER ?? cfg.llm.provider;
  process.env.ANVIL_LLM_MODEL    ??= process.env.CODE_SEARCH_LLM_MODEL    ?? cfg.llm.model;
  if (cfg.llm.apiKey)   process.env.ANVIL_LLM_API_KEY  ??= cfg.llm.apiKey;
  if (cfg.llm.baseUrl)  process.env.ANVIL_LLM_BASE_URL ??= cfg.llm.baseUrl;
  if (cfg.llm.claudeBin) process.env.ANVIL_CLAUDE_BIN  ??= cfg.llm.claudeBin;
}

// ---------------------------------------------------------------------------
// Adapter to KnowledgeConfig
// ---------------------------------------------------------------------------

export function toKnowledgeConfig(c: CodeSearchConfig): KnowledgeConfig {
  return {
    embedding: { ...c.embedding },
    chunking: { ...c.indexing.chunking },
    retrieval: {
      maxChunks: c.retrieval.maxChunks,
      maxTokens: c.retrieval.maxTokens,
      hybridWeights: { ...c.retrieval.hybridWeights },
      reranker: { ...c.reranker },
    },
    autoIndex: c.indexing.autoIndex,
  };
}

// ---------------------------------------------------------------------------
// --print-config — debuggability
// ---------------------------------------------------------------------------

const SECRET_KEYS = new Set([
  'apiKey',
  'jwtSecret',
  'token',
  'githubToken',
]);

export function redactSecrets<T>(value: T, parentKey = ''): T {
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, parentKey)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k) && typeof v === 'string' && v.length > 0) {
        out[k] = `***redacted (${v.length} chars)`;
      } else if (k === 'apiKeys' && Array.isArray(v)) {
        out[k] = v.map((s) => `***redacted (${(s as string).length} chars)`);
      } else {
        out[k] = redactSecrets(v, k);
      }
    }
    return out as T;
  }
  return value;
}

export function printConfig(c: CodeSearchConfig): string {
  return JSON.stringify(redactSecrets(c), null, 2);
}
