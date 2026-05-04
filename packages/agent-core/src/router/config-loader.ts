/**
 * `llm-router.yaml` discovery + parsing.
 *
 * Search order (locked in ADR R5):
 *   1. process.env.ANVIL_ROUTER_CONFIG (full path)
 *   2. <workspaceRoot>/.anvil/llm-router.yaml
 *   3. $HOME/.anvil/llm-router.yaml (or $ANVIL_HOME/llm-router.yaml)
 *   4. compiled-in defaults (router still works without any config file)
 *
 * `${env:VAR}` expansions inside string values are resolved against
 * `process.env` — same convention as the MCP config-loader.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as YAML from 'yaml';
import type { RouterConfig, RouteConfig, BudgetConfig } from './types.js';
import { DEFAULT_RETRY_POLICY } from './retry.js';
import { DEFAULT_RATE_LIMITS } from './rate-limiter.js';
import { DEFAULT_CIRCUIT_BREAKER } from './circuit-breaker.js';

export interface LoadRouterConfigOptions {
  /** Absolute workspace root used for the workspace-scoped lookup. */
  workspaceRoot?: string;
  /** Override `process.env`; supports both `ANVIL_ROUTER_CONFIG` and `${env:VAR}`. */
  env?: NodeJS.ProcessEnv;
  /** Override `$HOME` (test seam). */
  homeDir?: string;
  /** If true, never fall back to compiled-in defaults — throw if no file found. */
  requireFile?: boolean;
}

/** Returns the path of the canonical `llm-router.yaml`, or undefined. */
export function findRouterConfigPath(opts: LoadRouterConfigOptions = {}): string | undefined {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();
  const anvilHome = env.ANVIL_HOME ?? join(home, '.anvil');

  const candidates: string[] = [];
  if (env.ANVIL_ROUTER_CONFIG) candidates.push(env.ANVIL_ROUTER_CONFIG);
  if (opts.workspaceRoot) {
    candidates.push(join(opts.workspaceRoot, '.anvil', 'llm-router.yaml'));
  }
  candidates.push(join(anvilHome, 'llm-router.yaml'));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

const ENV_VAR_RE = /\$\{env:([A-Z_][A-Z0-9_]*)\}/g;

function expandEnv(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_VAR_RE, (_m, name: string) => env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v, env);
    return out;
  }
  return value;
}

/**
 * Compiled-in defaults that ensure the router functions out-of-the-box
 * when no YAML file is found. Routes default to common Anthropic +
 * OpenAI tags — callers can still pin via `opts.model` if they don't
 * have a matching tag.
 */
export function defaultRouterConfig(): RouterConfig {
  const routes: RouteConfig[] = [
    {
      tag: 'planner',
      primary: 'claude-sonnet-4-6',
      fallbacks: [
        { model: 'claude-haiku-4-5-20251001', on: ['rate_limit', 'server_5xx', 'timeout'] },
        { model: 'gpt-4o', on: ['server_5xx', 'timeout'] },
      ],
    },
    {
      tag: 'code-gen',
      primary: 'claude-sonnet-4-6',
      fallbacks: [
        { model: 'claude-haiku-4-5-20251001', on: ['rate_limit', 'server_5xx', 'timeout'] },
      ],
    },
    {
      tag: 'reviewer',
      primary: 'claude-sonnet-4-6',
      fallbacks: [
        { model: 'gpt-4o', on: ['server_5xx', 'timeout', 'rate_limit'] },
      ],
    },
  ];
  return {
    routes,
    retryPolicy: { ...DEFAULT_RETRY_POLICY },
    rateLimit: { ...DEFAULT_RATE_LIMITS },
    circuitBreaker: { ...DEFAULT_CIRCUIT_BREAKER },
    onRateLimit: 'wait',
    maxFallbackCostUsd: 1.0,
  };
}

/**
 * Load + parse the active router config. Returns compiled-in defaults
 * if no YAML file is found (unless `requireFile: true`).
 */
export function loadRouterConfig(opts: LoadRouterConfigOptions = {}): RouterConfig {
  const env = opts.env ?? process.env;
  const path = findRouterConfigPath(opts);
  if (!path) {
    if (opts.requireFile) {
      throw new Error('LlmRouter: no router config file found and requireFile=true');
    }
    return defaultRouterConfig();
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = YAML.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`LlmRouter: ${path} is empty or invalid YAML`);
  }
  const expanded = expandEnv(parsed, env) as Record<string, unknown>;
  return mergeWithDefaults(expanded);
}

/**
 * Merge a user config object over the compiled-in defaults. Top-level
 * fields (`routes`, `retryPolicy`, etc.) replace; sub-fields layer.
 */
export function mergeWithDefaults(input: Record<string, unknown>): RouterConfig {
  const defaults = defaultRouterConfig();
  const out: RouterConfig = { ...defaults };

  if (Array.isArray(input.routes)) {
    out.routes = input.routes as RouteConfig[];
  }
  if (input.retryPolicy && typeof input.retryPolicy === 'object') {
    out.retryPolicy = {
      ...defaults.retryPolicy,
      ...(input.retryPolicy as RouterConfig['retryPolicy']),
    };
  }
  if (input.rateLimit && typeof input.rateLimit === 'object') {
    out.rateLimit = {
      ...defaults.rateLimit,
      ...(input.rateLimit as RouterConfig['rateLimit']),
    };
  }
  if (input.circuitBreaker && typeof input.circuitBreaker === 'object') {
    out.circuitBreaker = {
      ...(defaults.circuitBreaker ?? DEFAULT_CIRCUIT_BREAKER),
      ...(input.circuitBreaker as Partial<typeof DEFAULT_CIRCUIT_BREAKER>),
    };
  }
  if (input.budgets && typeof input.budgets === 'object') {
    out.budgets = input.budgets as BudgetConfig;
  }
  if (typeof input.maxFallbackCostUsd === 'number') {
    out.maxFallbackCostUsd = input.maxFallbackCostUsd;
  }
  if (
    input.onRateLimit === 'wait' ||
    input.onRateLimit === 'fail' ||
    input.onRateLimit === 'fallback'
  ) {
    out.onRateLimit = input.onRateLimit;
  }
  return out;
}
