/**
 * Loads stage-policy.yaml — the per-stage routing requirement map. The
 * yaml file ships with the cli package; consumers can override via
 * ANVIL_STAGE_POLICY (full path) or by placing a file at
 * <workspaceRoot>/.anvil/stage-policy.yaml.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type {
  ModelCapability,
  ModelComplexity,
  ModelTier,
} from '@anvil/agent-core';

export interface StagePolicy {
  capability: ModelCapability;
  complexity: ModelComplexity;
  prefer: ModelTier[];
}

export interface StagePolicyMap {
  stages: Record<string, StagePolicy>;
}

export class StagePolicyLoadError extends Error {
  constructor(public readonly path: string, public readonly cause: unknown) {
    super(`Failed to load stage-policy.yaml at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'StagePolicyLoadError';
  }
}

export class StagePolicyValidationError extends Error {
  constructor(message: string) {
    super(`stage-policy.yaml validation failed: ${message}`);
    this.name = 'StagePolicyValidationError';
  }
}

const CAPABILITIES: readonly ModelCapability[] = ['embed', 'rerank', 'code', 'reasoning', 'vision'];
const COMPLEXITIES: readonly ModelComplexity[] = ['S', 'M', 'L'];
const TIERS: readonly ModelTier[] = ['local', 'cheap', 'premium'];

export interface LoadStagePolicyOptions {
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
}

/** Returns the path of the canonical stage-policy.yaml. */
export function findStagePolicyPath(opts: LoadStagePolicyOptions = {}): string {
  const env = opts.env ?? process.env;

  if (env.ANVIL_STAGE_POLICY) return env.ANVIL_STAGE_POLICY;

  if (opts.workspaceRoot) {
    const ws = join(opts.workspaceRoot, '.anvil', 'stage-policy.yaml');
    if (existsSync(ws)) return ws;
  }

  // Bundled default: shipped alongside this module after build (cli copies
  // src/routing/*.yaml into dist/routing/ via the build script). Fall back
  // to the source path during local dev.
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(here, 'stage-policy.yaml');
  if (existsSync(bundled)) return bundled;

  // Source-tree fallback (when consumed from packages/cli/src/...):
  const sourceFallback = resolve(here, '..', '..', 'src', 'routing', 'stage-policy.yaml');
  if (existsSync(sourceFallback)) return sourceFallback;

  return bundled; // surfaces a clear error in load*
}

export function loadStagePolicy(opts: LoadStagePolicyOptions = {}): StagePolicyMap {
  const path = findStagePolicyPath(opts);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new StagePolicyLoadError(path, err);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new StagePolicyLoadError(path, err);
  }
  return validateStagePolicy(parsed, path);
}

export function validateStagePolicy(raw: unknown, sourcePath = '<inline>'): StagePolicyMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StagePolicyValidationError(`expected object at top level (${sourcePath})`);
  }
  const top = raw as Record<string, unknown>;
  const stagesRaw = top.stages;
  if (!stagesRaw || typeof stagesRaw !== 'object' || Array.isArray(stagesRaw)) {
    throw new StagePolicyValidationError(`'stages' must be an object`);
  }
  const out: Record<string, StagePolicy> = {};
  for (const [stageName, entryRaw] of Object.entries(stagesRaw)) {
    out[stageName] = validateStagePolicyEntry(entryRaw, stageName);
  }
  return { stages: out };
}

function validateStagePolicyEntry(rawEntry: unknown, stageName: string): StagePolicy {
  const ctx = `stages.${stageName}`;
  if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
    throw new StagePolicyValidationError(`${ctx}: expected object`);
  }
  const e = rawEntry as Record<string, unknown>;
  const capability = requireEnum(e.capability, CAPABILITIES, `${ctx}.capability`);
  const complexity = requireEnum(e.complexity, COMPLEXITIES, `${ctx}.complexity`);
  if (!Array.isArray(e.prefer) || e.prefer.length === 0) {
    throw new StagePolicyValidationError(`${ctx}.prefer: must be a non-empty array`);
  }
  const prefer: ModelTier[] = [];
  for (let i = 0; i < e.prefer.length; i++) {
    prefer.push(requireEnum(e.prefer[i], TIERS, `${ctx}.prefer[${i}]`));
  }
  return { capability, complexity, prefer };
}

function requireEnum<T extends string>(v: unknown, allowed: readonly T[], ctx: string): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new StagePolicyValidationError(`${ctx}: expected one of [${allowed.join(', ')}], got ${describe(v)}`);
  }
  return v as T;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
