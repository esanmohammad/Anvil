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
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { Logger } from '../observability/logger.js';
import type {
  KnowledgeStorageConfig,
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
    transport: 'stdio' | 'streamable-http';
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
    /** Backend selection for the knowledge stores (blob/vector/graph/cache).
     *  Omit ⇒ local fs/LanceDB/sqlite defaults. Passed through verbatim as
     *  KnowledgeConfig.storage (resolveStorage owns interpretation). */
    backends?: KnowledgeStorageConfig;
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
    /** Never route CLI queries to a running daemon; force the in-process backend */
    disabled: boolean;
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** knowledge-core's own fallback when CODE_SEARCH_DATA_DIR is unset
 *  (`getKnowledgeBasePath`), so the default reported here is where KBs live. */
function defaultDataDir(): string {
  return process.env.CODE_SEARCH_DATA_DIR
    ?? join(process.env.ANVIL_HOME || join(homedir(), '.anvil'), 'knowledge-base');
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
    disabled: false,
  },
};

// ---------------------------------------------------------------------------
// Deep-merge helper (partial-config layering)
// ---------------------------------------------------------------------------

export type DeepPartial<T> = { [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P] };

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

/**
 * Reindex interval from any layer → ms. Accepts `0` / `none` (off), `<n>m`,
 * `<n>h`, or a plain millisecond count of at least one minute. Returns null
 * for anything else (the resolver warns and disables auto-reindex).
 */
export function parseReindexInterval(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '' || raw === 0 || raw === '0' || raw === 'none') return 0;
  const s = String(raw).trim();
  const unit = s.match(/^(\d+)(m|h)$/);
  if (unit) return parseInt(unit[1], 10) * (unit[2] === 'h' ? 3_600_000 : 60_000);
  if (/^\d+$/.test(s)) {
    const ms = parseInt(s, 10);
    return ms >= 60_000 ? ms : null;
  }
  return null;
}

/**
 * Storage-backend selection from env — the deployment-friendly subset of
 * KnowledgeStorageConfig (full shapes go via the YAML layers). Returns
 * undefined when no CODE_SEARCH_STORAGE_* var is set so the env layer never
 * clobbers a file-configured block. Env vars:
 *   STORAGE_BLOB_BACKEND=fs|mongo, STORAGE_MONGO_URI, STORAGE_MONGO_DB,
 *   STORAGE_VECTOR_URI (s3://bucket/prefix), STORAGE_S3_ENDPOINT,
 *   STORAGE_S3_REGION, STORAGE_S3_ALLOW_HTTP, STORAGE_CACHE_MAX_BYTES,
 *   STORAGE_CACHE_DIR.
 */
function envStorageBackends(env: (k: string) => string | undefined): KnowledgeStorageConfig | undefined {
  const blobBackend = env('STORAGE_BLOB_BACKEND') as 'fs' | 's3' | 'mongo' | undefined;
  const mongoUri = env('STORAGE_MONGO_URI');
  const mongoDb = env('STORAGE_MONGO_DB');
  const vectorUri = env('STORAGE_VECTOR_URI');
  const s3Endpoint = env('STORAGE_S3_ENDPOINT');
  const s3Region = env('STORAGE_S3_REGION');
  const s3AllowHttp = env('STORAGE_S3_ALLOW_HTTP');
  const cacheMaxBytes = env('STORAGE_CACHE_MAX_BYTES');
  const cacheDir = env('STORAGE_CACHE_DIR');

  if (!blobBackend && !mongoUri && !vectorUri && !cacheMaxBytes && !cacheDir) return undefined;

  const out: KnowledgeStorageConfig = {};
  if (blobBackend || mongoUri) {
    out.blob = {
      ...(blobBackend ? { backend: blobBackend } : {}),
      ...(mongoUri && mongoDb ? { mongo: { uri: mongoUri, db: mongoDb } } : {}),
    };
  }
  if (vectorUri) {
    const s3 =
      s3Endpoint || s3Region || s3AllowHttp
        ? {
            ...(s3Endpoint ? { endpoint: s3Endpoint } : {}),
            ...(s3Region ? { region: s3Region } : {}),
            ...(s3AllowHttp ? { allowHttp: s3AllowHttp === 'true' || s3AllowHttp === '1' } : {}),
            virtualHostedStyle: false, // MinIO is path-style
          }
        : undefined;
    out.vector = { lancedb: { uri: vectorUri, ...(s3 ? { s3 } : {}) } };
  }
  // CACHE_DIR (sqlite graph pull target) and CACHE_MAX_BYTES (LanceDB RAM
  // Session bound) are independent knobs — a reader pod mounting an emptyDir
  // cache sets the dir without necessarily bounding the RAM cache.
  const max = cacheMaxBytes ? parseInt(cacheMaxBytes, 10) : NaN;
  if (cacheDir || (Number.isFinite(max) && max > 0)) {
    out.cache = {
      dir: cacheDir ?? join(tmpdir(), 'code-search-cache'),
      ...(Number.isFinite(max) && max > 0 ? { maxBytes: max, mode: 'ram' as const } : {}),
    };
  }
  return out;
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
      host: env('HOST'),
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
      backends: envStorageBackends(env),
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
      // Raw string; normalised (and validated) by the resolver for every layer.
      reindexIntervalMs: env('REINDEX_INTERVAL') as unknown as number | undefined,
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
 * `--port` / `--host` / `--transport` / `--auth` are shorthands for
 * `server.port` / `server.host` / `server.transport` / `auth.mode`.
 * Reserved subcommand-style flags (`--local`, `--remote`, `--serve`, etc.)
 * and their values are passed back to the caller as `rest`. Flags naming no
 * config leaf land in `unknown` — callers reject them (a typo must not be
 * silently ignored).
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
  '--format',
  '--top-k',
  '--mode',
  '--repo',
]);

const ROOT_ALIASES: Record<string, string[]> = {
  '--port': ['server', 'port'],
  '--host': ['server', 'host'],
  '--transport': ['server', 'transport'],
  '--auth': ['auth', 'mode'],
};

/** Settable leaves with no compiled-in default. */
const OPTIONAL_LEAVES = [
  'auth.jwtSecret',
  'embedding.model', 'embedding.apiKey', 'embedding.baseUrl', 'embedding.ollamaHost',
  'reranker.model', 'reranker.apiKey', 'reranker.baseUrl', 'reranker.timeoutMs',
  'llm.apiKey', 'llm.baseUrl',
  'github.token',
  'telemetry.otelEndpoint',
];
/** Subtrees passed through verbatim — any key below them is accepted. */
const OPEN_SUBTREES = ['storage.backends.', 'telemetry.otelHeaders.'];

function leafPaths(obj: Record<string, unknown>, prefix: string, out: Set<string>): Set<string> {
  for (const [k, v] of Object.entries(obj)) {
    if (isPlainObject(v)) leafPaths(v, `${prefix}${k}.`, out);
    else out.add(`${prefix}${k}`);
  }
  return out;
}
const KNOWN_LEAVES = leafPaths(DEFAULTS as unknown as Record<string, unknown>, '', new Set(OPTIONAL_LEAVES));

function isKnownPath(path: string): boolean {
  return KNOWN_LEAVES.has(path) || OPEN_SUBTREES.some((p) => path.startsWith(p));
}

export interface CliParseResult {
  patch: DeepPartial<CodeSearchConfig>;
  rest: string[];
  /** Flags that name no config leaf (as typed, e.g. `--retrieval.max-chunkz`). */
  unknown: string[];
}

export function parseCliFlags(argv: string[]): CliParseResult {
  const patch: Record<string, unknown> = {};
  const rest: string[] = [];
  const unknown: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--') || RESERVED_FLAGS.has(arg)) {
      rest.push(arg);
      continue;
    }
    let path = ROOT_ALIASES[arg];
    let negate = false;
    if (!path) {
      let key = arg.slice(2);
      if (key.startsWith('no-')) {
        negate = true;
        key = key.slice(3);
      }
      // Map kebab-case to camelCase per segment.
      path = key.split('.').map((seg) => seg.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
    }
    let val: unknown;
    if (negate) {
      val = false;
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      val = coerce(argv[++i]);
    } else {
      val = true;
    }
    if (!isKnownPath(path.join('.'))) {
      unknown.push(arg);
      continue;
    }
    setDeep(patch, path, val);
  }
  return { patch: patch as DeepPartial<CodeSearchConfig>, rest, unknown };
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
  const layers: Array<DeepPartial<CodeSearchConfig>> = [yaml1, yaml2, env, cli];
  const cfg = deepMerge(
    structuredClone(DEFAULTS) as unknown as Record<string, unknown>,
    ...(layers as Array<DeepPartial<Record<string, unknown>>>),
  ) as unknown as CodeSearchConfig;
  // Auth on and no layer chose a host → listen publicly (auth protects it).
  if (cfg.auth.mode !== 'none' && !layers.some((l) => l.server?.host !== undefined)) {
    cfg.server.host = '0.0.0.0';
  }
  const rawInterval = cfg.indexing.reindexIntervalMs as unknown;
  const intervalMs = parseReindexInterval(rawInterval);
  if (intervalMs === null) {
    warnOnce(cfg, `[code-search] invalid reindex interval ${JSON.stringify(String(rawInterval))} ` +
      `(use 30m, 1h, … — at least one minute — or 0); auto-reindex disabled`);
  }
  cfg.indexing.reindexIntervalMs = intervalMs ?? 0;
  cfg.storage.dataDir = resolve(cfg.storage.dataDir);
  bridgeLegacyEnvVars(cfg);
  return cfg;
}

const warned = new Set<string>();
function warnOnce(cfg: CodeSearchConfig, msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  new Logger({ structured: cfg.telemetry.structuredLogs }).warn(msg);
}

/**
 * knowledge-core reads its data dir from CODE_SEARCH_DATA_DIR only. Entry
 * points call this with the resolved config so a `storage.dataDir` from YAML
 * or the CLI actually moves the KB (and daemon sockets / pid files, which
 * live under the same dir).
 */
export function exportDataDir(cfg: CodeSearchConfig): void {
  process.env.CODE_SEARCH_DATA_DIR = cfg.storage.dataDir;
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
    chunking: { ...c.indexing.chunking, ignorePatterns: c.indexing.ignorePatterns },
    retrieval: {
      maxChunks: c.retrieval.maxChunks,
      maxTokens: c.retrieval.maxTokens,
      hybridWeights: { ...c.retrieval.hybridWeights },
      reranker: { ...c.reranker },
    },
    autoIndex: c.indexing.autoIndex,
    ...(c.storage.backends ? { storage: c.storage.backends } : {}),
  };
}

// ---------------------------------------------------------------------------
// --print-config — debuggability
// ---------------------------------------------------------------------------

const SECRET_KEY = /pass(word)?|secret|token|authorization|api[-_]?keys?|credential/i;
/** `scheme://userinfo@` — keep the user name, drop whatever authenticates it. */
const URI_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi;

function redactString(v: string): string {
  return `***redacted (${v.length} chars)`;
}

/**
 * --print-config redaction: values of secret-named keys (password, secret,
 * token, authorization, api key, credential — any nesting), every OTEL header
 * value (they carry auth), and credentials embedded in URIs
 * (`mongodb://user:pass@`, `https://token@`).
 */
export function redactSecrets<T>(value: T, parentKey = ''): T {
  if (typeof value === 'string') {
    return value.replace(URI_USERINFO, (_m, scheme: string, info: string) => {
      const colon = info.indexOf(':');
      return `${scheme}${colon >= 0 ? info.slice(0, colon + 1) : ''}***@`;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, parentKey)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const secret = SECRET_KEY.test(k) || parentKey === 'otelHeaders';
      if (secret && typeof v === 'string' && v.length > 0) {
        out[k] = redactString(v);
      } else if (secret && Array.isArray(v)) {
        out[k] = v.map((s) => (typeof s === 'string' ? redactString(s) : redactSecrets(s, k)));
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
