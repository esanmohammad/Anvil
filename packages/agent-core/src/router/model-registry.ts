/**
 * Model registry — capability/complexity-tagged catalog of models the
 * resolver picks from. Source-of-truth file is `~/.anvil/models.yaml`.
 *
 * The registry holds CURATED facts (capabilities, tier, complexity_max,
 * VRAM, exclusive_slot) loaded from yaml. Live state (availability,
 * pricing) is augmented at runtime by the discovery pass — the loader
 * itself never makes network calls.
 *
 * Resolution order for the yaml file:
 *   1. process.env.ANVIL_MODELS_CONFIG (full path)
 *   2. <workspaceRoot>/.anvil/models.yaml
 *   3. ${ANVIL_HOME or $HOME/.anvil}/models.yaml
 *   4. (no file) → returns { models: [] } and the resolver throws on use.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as YAML from 'yaml';
import type { ProviderName } from '../types.js';
import type { ErrorClass, RetryPolicy, CircuitBreakerConfig } from './types.js';
import { ALL_ERROR_CLASSES } from './types.js';

// — Vocabulary (closed) —
export type ModelCapability = 'embed' | 'rerank' | 'code' | 'reasoning' | 'vision';
export type ModelComplexity = 'S' | 'M' | 'L';
export type ModelTier = 'local' | 'cheap' | 'premium';
export type ModelConsumer = 'agent-core' | 'knowledge-core';

const PROVIDERS: readonly ProviderName[] = [
  'claude', 'openai', 'gemini', 'openrouter', 'ollama', 'gemini-cli', 'adk', 'opencode',
];
const CAPABILITIES: readonly ModelCapability[] = ['embed', 'rerank', 'code', 'reasoning', 'vision'];
const COMPLEXITIES: readonly ModelComplexity[] = ['S', 'M', 'L'];
const TIERS: readonly ModelTier[] = ['local', 'cheap', 'premium'];
const CONSUMERS: readonly ModelConsumer[] = ['agent-core', 'knowledge-core'];

export interface ModelEntry {
  id: string;
  provider: ProviderName;
  tier: ModelTier;
  capabilities: ModelCapability[];
  complexity_max: ModelComplexity;
  vram_gb: number;
  exclusive_slot: boolean;
  context_tokens?: number;
  /**
   * Ollama `num_ctx` cap — bounds VRAM cost of context. Set to a value
   * smaller than the model's max so context tokens don't eat the GPU
   * headroom needed by weights. Ignored for cloud providers.
   */
  context_window?: number;
  consumed_by?: ModelConsumer;
  /** Optional non-Ollama HTTP endpoint. Reserved for future providers. */
  endpoint?: string;
}

/**
 * Walker tunables — controls how the dashboard's chain walker behaves.
 *
 * Lives at the top level of `models.yaml` so end users can adjust the
 * routing/fallback policy in the same place they manage models. All
 * fields are optional; missing values fall back to compiled-in defaults.
 *
 * ```yaml
 * walker:
 *   liveness_ttl_ms: 30000   # provider-liveness cache TTL (ms)
 *   max_attempts: 5          # max chain-fallback attempts per stage
 *   # Optional reliability tuning (consumed by LlmRouter.runAgent). Omit
 *   # for the well-tuned compiled defaults. This is the single place to
 *   # tune retry/backoff + circuit breaking — `llm-router.yaml` is no
 *   # longer read for the agentic path.
 *   retry:                   # per-error-class backoff overrides
 *     rate_limit: { attempts: 5, baseMs: 1000, maxMs: 30000 }
 *     timeout:    { attempts: 3, baseMs: 500 }
 *   circuit_breaker:         # per-provider breaker thresholds
 *     failureThreshold: 5
 *     cooldownMs: 30000
 * ```
 */
export interface WalkerConfig {
  /**
   * How long a per-provider liveness verdict is cached. Default 30000.
   * Lower values catch a recovering provider faster but cost more
   * probes per run. Set to 0 to disable caching entirely.
   */
  liveness_ttl_ms: number;
  /**
   * Max chain-fallback attempts per stage entry. Default 5. After this
   * many UpstreamError(retryable) burns the runner gives up and bubbles
   * the last error to the user.
   */
  max_attempts: number;
  /**
   * Optional per-error-class retry/backoff overrides, shallow-merged onto
   * `DEFAULT_RETRY_POLICY`. Only the classes/fields you specify change.
   * Consumed by the shared `LlmRouter.runAgent`.
   */
  retry?: Partial<Record<ErrorClass, Partial<RetryPolicy>>>;
  /**
   * Optional circuit-breaker threshold overrides, shallow-merged onto
   * `DEFAULT_CIRCUIT_BREAKER`.
   */
  circuit_breaker?: Partial<CircuitBreakerConfig>;
}

/** Compiled-in defaults — used when models.yaml omits the walker block. */
export const DEFAULT_WALKER_CONFIG: Readonly<WalkerConfig> = Object.freeze({
  liveness_ttl_ms: 30_000,
  max_attempts: 5,
});

export interface ModelRegistry {
  models: ModelEntry[];
  /** Walker tunables — always populated; defaults applied at load time. */
  walker: WalkerConfig;
  /** Live availability annotation; populated by Phase 5 discovery, never by the loader. */
  availability?: Map<string, ModelAvailability>;
}

export interface ModelAvailability {
  available: boolean;
  lastChecked: number;
  error?: string;
}

export class ModelRegistryParseError extends Error {
  constructor(public readonly path: string, public readonly cause: unknown) {
    super(`Failed to parse models.yaml at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ModelRegistryParseError';
  }
}

export class ModelRegistryValidationError extends Error {
  constructor(message: string) {
    super(`models.yaml validation failed: ${message}`);
    this.name = 'ModelRegistryValidationError';
  }
}

export interface LoadModelRegistryOptions {
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function findModelsConfigPath(opts: LoadModelRegistryOptions = {}): string | undefined {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();
  const anvilHome = env.ANVIL_HOME ?? join(home, '.anvil');

  const candidates: string[] = [];
  if (env.ANVIL_MODELS_CONFIG) candidates.push(env.ANVIL_MODELS_CONFIG);
  if (opts.workspaceRoot) candidates.push(join(opts.workspaceRoot, '.anvil', 'models.yaml'));
  candidates.push(join(anvilHome, 'models.yaml'));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/**
 * Load + validate the models registry. Missing file → empty registry.
 * Malformed yaml or invalid schema throws.
 */
export function loadModelRegistry(opts: LoadModelRegistryOptions = {}): ModelRegistry {
  const path = findModelsConfigPath(opts);
  if (!path) return { models: [], walker: { ...DEFAULT_WALKER_CONFIG } };

  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ModelRegistryParseError(path, err);
  }

  return parseModelRegistry(raw, path);
}

/**
 * Parse a previously-deserialized yaml object. Exposed for tests so they
 * can feed in-memory yaml strings without touching the filesystem.
 */
export function parseModelRegistry(raw: unknown, sourcePath = '<inline>'): ModelRegistry {
  if (raw === null || raw === undefined) return { models: [], walker: { ...DEFAULT_WALKER_CONFIG } };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelRegistryValidationError(`expected top-level object, got ${describe(raw)} (${sourcePath})`);
  }

  const top = raw as Record<string, unknown>;
  const walker = parseWalkerConfig(top.walker);

  const modelsRaw = top.models;
  if (modelsRaw === undefined) return { models: [], walker };
  if (!Array.isArray(modelsRaw)) {
    throw new ModelRegistryValidationError(`'models' must be an array, got ${describe(modelsRaw)}`);
  }

  const models: ModelEntry[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < modelsRaw.length; i++) {
    const entry = validateEntry(modelsRaw[i], i);
    if (seenIds.has(entry.id)) {
      throw new ModelRegistryValidationError(`duplicate model id "${entry.id}" at index ${i}`);
    }
    seenIds.add(entry.id);
    enforceExclusiveSlotInvariant(entry, i);
    models.push(entry);
  }

  return { models, walker };
}

/**
 * Parse the optional `walker:` block. Missing block → defaults; partial
 * block → defaults filled in for unspecified keys. Unknown keys throw
 * (catches typos like `livenessTTL` or `maxRetries` early).
 */
function parseWalkerConfig(raw: unknown): WalkerConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_WALKER_CONFIG };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelRegistryValidationError(`'walker' must be an object, got ${describe(raw)}`);
  }
  const w = raw as Record<string, unknown>;
  const allowed = new Set<string>(['liveness_ttl_ms', 'max_attempts', 'retry', 'circuit_breaker']);
  for (const k of Object.keys(w)) {
    if (!allowed.has(k)) {
      throw new ModelRegistryValidationError(
        `walker.${k}: unknown key. Supported: [${[...allowed].join(', ')}]`,
      );
    }
  }
  const out: WalkerConfig = { ...DEFAULT_WALKER_CONFIG };
  if (w.liveness_ttl_ms !== undefined) {
    out.liveness_ttl_ms = requireNumber(w.liveness_ttl_ms, 'walker.liveness_ttl_ms', { min: 0 });
  }
  if (w.max_attempts !== undefined) {
    const n = requireNumber(w.max_attempts, 'walker.max_attempts', { min: 1 });
    if (!Number.isInteger(n)) {
      throw new ModelRegistryValidationError(`walker.max_attempts: expected integer, got ${n}`);
    }
    out.max_attempts = n;
  }
  if (w.retry !== undefined) out.retry = parseRetryOverrides(w.retry);
  if (w.circuit_breaker !== undefined) out.circuit_breaker = parseCircuitBreakerOverrides(w.circuit_breaker);
  return out;
}

/** Parse `walker.retry` — a map of ErrorClass → partial RetryPolicy. */
function parseRetryOverrides(raw: unknown): Partial<Record<ErrorClass, Partial<RetryPolicy>>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ModelRegistryValidationError(`walker.retry must be an object, got ${describe(raw)}`);
  }
  const validClasses = new Set<string>(ALL_ERROR_CLASSES);
  const out: Partial<Record<ErrorClass, Partial<RetryPolicy>>> = {};
  for (const [cls, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!validClasses.has(cls)) {
      throw new ModelRegistryValidationError(
        `walker.retry.${cls}: unknown error class. Supported: [${[...validClasses].join(', ')}]`,
      );
    }
    if (typeof val !== 'object' || val === null || Array.isArray(val)) {
      throw new ModelRegistryValidationError(`walker.retry.${cls} must be an object, got ${describe(val)}`);
    }
    const p = val as Record<string, unknown>;
    const policy: Partial<RetryPolicy> = {};
    if (p.attempts !== undefined) policy.attempts = requireNumber(p.attempts, `walker.retry.${cls}.attempts`, { min: 0, integer: true });
    if (p.baseMs !== undefined) policy.baseMs = requireNumber(p.baseMs, `walker.retry.${cls}.baseMs`, { min: 0 });
    if (p.maxMs !== undefined) policy.maxMs = requireNumber(p.maxMs, `walker.retry.${cls}.maxMs`, { min: 0 });
    if (p.jitter !== undefined) {
      if (typeof p.jitter !== 'boolean') throw new ModelRegistryValidationError(`walker.retry.${cls}.jitter must be boolean`);
      policy.jitter = p.jitter;
    }
    if (p.backoff !== undefined) {
      if (p.backoff !== 'exponential' && p.backoff !== 'linear' && p.backoff !== 'constant') {
        throw new ModelRegistryValidationError(`walker.retry.${cls}.backoff must be exponential|linear|constant`);
      }
      policy.backoff = p.backoff;
    }
    out[cls as ErrorClass] = policy;
  }
  return out;
}

/** Parse `walker.circuit_breaker` — partial CircuitBreakerConfig. */
function parseCircuitBreakerOverrides(raw: unknown): Partial<CircuitBreakerConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ModelRegistryValidationError(`walker.circuit_breaker must be an object, got ${describe(raw)}`);
  }
  const c = raw as Record<string, unknown>;
  const allowed = new Set(['failureThreshold', 'cooldownMs', 'halfOpenAttempts']);
  for (const k of Object.keys(c)) {
    if (!allowed.has(k)) {
      throw new ModelRegistryValidationError(
        `walker.circuit_breaker.${k}: unknown key. Supported: [${[...allowed].join(', ')}]`,
      );
    }
  }
  const out: Partial<CircuitBreakerConfig> = {};
  if (c.failureThreshold !== undefined) out.failureThreshold = requireNumber(c.failureThreshold, 'walker.circuit_breaker.failureThreshold', { min: 1, integer: true });
  if (c.cooldownMs !== undefined) out.cooldownMs = requireNumber(c.cooldownMs, 'walker.circuit_breaker.cooldownMs', { min: 0 });
  if (c.halfOpenAttempts !== undefined) out.halfOpenAttempts = requireNumber(c.halfOpenAttempts, 'walker.circuit_breaker.halfOpenAttempts', { min: 1, integer: true });
  return out;
}

/**
 * Big GPU-resident models MUST set `exclusive_slot: true` so the
 * `LocalExecutor` FIFO can serialize them. Co-resident utility models
 * (embed, rerank consumed by knowledge-core) are exempt — they share VRAM
 * with the held big-slot model by design.
 */
const EXCLUSIVE_SLOT_VRAM_THRESHOLD_GB = 5;

function enforceExclusiveSlotInvariant(entry: ModelEntry, index: number): void {
  if (entry.provider !== 'ollama') return;          // cloud providers don't use the slot
  if (entry.consumed_by === 'knowledge-core') return; // co-residents are exempt
  if (entry.vram_gb < EXCLUSIVE_SLOT_VRAM_THRESHOLD_GB) return;
  if (entry.exclusive_slot) return;
  throw new ModelRegistryValidationError(
    `models[${index}] (${entry.id}): vram_gb=${entry.vram_gb} ≥ ${EXCLUSIVE_SLOT_VRAM_THRESHOLD_GB} requires exclusive_slot:true ` +
    `to prevent VRAM thrashing. Set exclusive_slot:true, or mark consumed_by:knowledge-core if it is a co-resident utility model.`,
  );
}

function validateEntry(rawEntry: unknown, index: number): ModelEntry {
  const ctx = `models[${index}]`;
  if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
    throw new ModelRegistryValidationError(`${ctx}: expected object, got ${describe(rawEntry)}`);
  }
  const e = rawEntry as Record<string, unknown>;

  const id = requireString(e.id, `${ctx}.id`);
  const provider = requireEnum(e.provider, PROVIDERS, `${ctx}.provider`);
  const tier = requireEnum(e.tier, TIERS, `${ctx}.tier`);

  if (!Array.isArray(e.capabilities) || e.capabilities.length === 0) {
    throw new ModelRegistryValidationError(`${ctx}.capabilities: must be a non-empty array`);
  }
  const capabilities: ModelCapability[] = [];
  for (let j = 0; j < e.capabilities.length; j++) {
    capabilities.push(requireEnum(e.capabilities[j], CAPABILITIES, `${ctx}.capabilities[${j}]`));
  }

  const complexity_max = requireEnum(e.complexity_max, COMPLEXITIES, `${ctx}.complexity_max`);
  const vram_gb = requireNumber(e.vram_gb, `${ctx}.vram_gb`, { min: 0 });
  const exclusive_slot = requireBoolean(e.exclusive_slot, `${ctx}.exclusive_slot`);

  const out: ModelEntry = {
    id,
    provider,
    tier,
    capabilities,
    complexity_max,
    vram_gb,
    exclusive_slot,
  };

  if (e.context_tokens !== undefined) {
    out.context_tokens = requireNumber(e.context_tokens, `${ctx}.context_tokens`, { min: 1, integer: true });
  }
  if (e.context_window !== undefined) {
    out.context_window = requireNumber(e.context_window, `${ctx}.context_window`, { min: 256, integer: true });
  }
  if (e.consumed_by !== undefined) {
    out.consumed_by = requireEnum(e.consumed_by, CONSUMERS, `${ctx}.consumed_by`);
  }
  if (e.endpoint !== undefined) {
    out.endpoint = requireString(e.endpoint, `${ctx}.endpoint`);
  }

  return out;
}

// — Validation primitives —

function requireString(v: unknown, ctx: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ModelRegistryValidationError(`${ctx}: expected non-empty string, got ${describe(v)}`);
  }
  return v;
}

function requireEnum<T extends string>(v: unknown, allowed: readonly T[], ctx: string): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new ModelRegistryValidationError(`${ctx}: expected one of [${allowed.join(', ')}], got ${describe(v)}`);
  }
  return v as T;
}

function requireNumber(v: unknown, ctx: string, opts: { min?: number; integer?: boolean } = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ModelRegistryValidationError(`${ctx}: expected number, got ${describe(v)}`);
  }
  if (opts.integer && !Number.isInteger(v)) {
    throw new ModelRegistryValidationError(`${ctx}: expected integer, got ${v}`);
  }
  if (opts.min !== undefined && v < opts.min) {
    throw new ModelRegistryValidationError(`${ctx}: must be >= ${opts.min}, got ${v}`);
  }
  return v;
}

function requireBoolean(v: unknown, ctx: string): boolean {
  if (typeof v !== 'boolean') {
    throw new ModelRegistryValidationError(`${ctx}: expected boolean, got ${describe(v)}`);
  }
  return v;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
