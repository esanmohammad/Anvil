/**
 * Phase 7 tests for the YAML config loader.
 *
 * Each test seeds an isolated temp dir to avoid disturbing the user's
 * actual `~/.anvil/llm-router.yaml`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadRouterConfig,
  defaultRouterConfig,
  findRouterConfigPath,
  mergeWithDefaults,
} from '../router/index.js';

let root = '';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'anvil-router-cfg-'));
});
after(() => {
  rmSync(root, { recursive: true, force: true });
});

const SAMPLE_YAML = `
routes:
  - tag: planner
    primary: claude-sonnet-4-6
    fallbacks:
      - model: claude-haiku-4-5-20251001
        on: [rate_limit, server_5xx]
      - model: gpt-4o
        on: [timeout]

retryPolicy:
  rate_limit:
    attempts: 7
    backoff: exponential
    baseMs: 500
    maxMs: 60000

rateLimit:
  claude:
    rpm: 100
    tpm: 200000

budgets:
  dailyUsd: 50.0
  perRunUsd: 5.0
  onBreach: fail

circuitBreaker:
  failureThreshold: 8
  cooldownMs: 60000
  halfOpenAttempts: 2

maxFallbackCostUsd: 0.5
onRateLimit: wait

note: "user is \${env:TEST_FAKE_USER}"
`;

describe('defaultRouterConfig', () => {
  it('produces a usable RouterConfig without any file', () => {
    const cfg = defaultRouterConfig();
    assert.ok(cfg.routes.length >= 1);
    assert.ok(cfg.retryPolicy.rate_limit !== undefined);
    assert.equal(cfg.onRateLimit, 'wait');
  });
});

describe('findRouterConfigPath', () => {
  it('returns ANVIL_ROUTER_CONFIG when set', () => {
    const file = join(root, 'env-config.yaml');
    writeFileSync(file, 'routes: []\n');
    const found = findRouterConfigPath({
      env: { ANVIL_ROUTER_CONFIG: file },
      homeDir: root,
    });
    assert.equal(found, file);
  });

  it('falls back to <workspace>/.anvil/llm-router.yaml', () => {
    const ws = join(root, 'ws1');
    const cfgDir = join(ws, '.anvil');
    mkdirSync(cfgDir, { recursive: true });
    const cfgPath = join(cfgDir, 'llm-router.yaml');
    writeFileSync(cfgPath, 'routes: []\n');
    const found = findRouterConfigPath({
      workspaceRoot: ws,
      env: {},
      homeDir: join(root, 'no-such-home'),
    });
    assert.equal(found, cfgPath);
  });

  it('falls back to ~/.anvil/llm-router.yaml', () => {
    const home = join(root, 'home2');
    mkdirSync(join(home, '.anvil'), { recursive: true });
    const cfgPath = join(home, '.anvil', 'llm-router.yaml');
    writeFileSync(cfgPath, 'routes: []\n');
    const found = findRouterConfigPath({ env: {}, homeDir: home });
    assert.equal(found, cfgPath);
  });

  it('returns undefined when nothing matches', () => {
    const found = findRouterConfigPath({
      env: {},
      homeDir: join(root, 'definitely-not-real'),
    });
    assert.equal(found, undefined);
  });
});

describe('loadRouterConfig', () => {
  it('returns defaults when no file exists', () => {
    const cfg = loadRouterConfig({
      env: {},
      homeDir: join(root, 'empty-home'),
    });
    assert.deepEqual(cfg.routes, defaultRouterConfig().routes);
  });

  it('throws when requireFile=true + no file', () => {
    assert.throws(
      () =>
        loadRouterConfig({
          env: {},
          homeDir: join(root, 'still-empty'),
          requireFile: true,
        }),
      /no router config file/,
    );
  });

  it('parses a sample YAML and merges with defaults', () => {
    const file = join(root, 'sample.yaml');
    writeFileSync(file, SAMPLE_YAML);
    const cfg = loadRouterConfig({
      env: { ANVIL_ROUTER_CONFIG: file, TEST_FAKE_USER: 'esanm' },
      homeDir: root,
    });
    // routes overridden
    assert.equal(cfg.routes.length, 1);
    assert.equal(cfg.routes[0].tag, 'planner');
    // retryPolicy.rate_limit overridden, others default
    assert.equal(cfg.retryPolicy.rate_limit.attempts, 7);
    assert.equal(cfg.retryPolicy.auth.attempts, 0); // unchanged default
    // rateLimit override
    assert.equal(cfg.rateLimit?.claude.rpm, 100);
    // budgets layered
    assert.equal(cfg.budgets?.onBreach, 'fail');
    assert.equal(cfg.budgets?.dailyUsd, 50);
    // circuitBreaker overridden
    assert.equal(cfg.circuitBreaker?.failureThreshold, 8);
    // scalar overrides
    assert.equal(cfg.maxFallbackCostUsd, 0.5);
    assert.equal(cfg.onRateLimit, 'wait');
  });

  it('throws on empty/invalid YAML', () => {
    const file = join(root, 'empty.yaml');
    writeFileSync(file, '');
    assert.throws(
      () => loadRouterConfig({ env: { ANVIL_ROUTER_CONFIG: file }, homeDir: root }),
      /empty or invalid/,
    );
  });

  it('expands ${env:VAR} substitutions inside string values', () => {
    const file = join(root, 'env-sub.yaml');
    writeFileSync(file, "routes:\n  - tag: \"hi-${env:WHO}\"\n    primary: m\n");
    const cfg = loadRouterConfig({
      env: { ANVIL_ROUTER_CONFIG: file, WHO: 'alice' },
      homeDir: root,
    });
    assert.equal(cfg.routes[0].tag, 'hi-alice');
  });
});

describe('mergeWithDefaults', () => {
  it('layers a partial override over defaults', () => {
    const merged = mergeWithDefaults({
      maxFallbackCostUsd: 2.5,
      retryPolicy: {
        rate_limit: { attempts: 99, backoff: 'constant', baseMs: 100 },
      },
    });
    assert.equal(merged.maxFallbackCostUsd, 2.5);
    assert.equal(merged.retryPolicy.rate_limit.attempts, 99);
    // unchanged defaults
    assert.equal(merged.retryPolicy.auth.attempts, 0);
  });
});
