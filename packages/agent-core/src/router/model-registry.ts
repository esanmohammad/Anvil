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

// — Vocabulary (closed) —
export type ModelCapability = 'embed' | 'rerank' | 'code' | 'reasoning' | 'vision';
export type ModelComplexity = 'S' | 'M' | 'L';
export type ModelTier = 'local' | 'cheap' | 'premium';
export type ModelConsumer = 'agent-core' | 'knowledge-core';

const PROVIDERS: readonly ProviderName[] = [
  'claude', 'openai', 'gemini', 'openrouter', 'ollama', 'gemini-cli', 'adk',
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
  consumed_by?: ModelConsumer;
  /** Optional non-Ollama HTTP endpoint. Reserved for future providers. */
  endpoint?: string;
}

export interface ModelRegistry {
  models: ModelEntry[];
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
  if (!path) return { models: [] };

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
  if (raw === null || raw === undefined) return { models: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelRegistryValidationError(`expected top-level object, got ${describe(raw)} (${sourcePath})`);
  }

  const top = raw as Record<string, unknown>;
  const modelsRaw = top.models;
  if (modelsRaw === undefined) return { models: [] };
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
    models.push(entry);
  }

  return { models };
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
