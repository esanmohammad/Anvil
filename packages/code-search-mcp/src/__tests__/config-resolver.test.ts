import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

import {
  resolveCodeSearchConfig,
  parseCliFlags,
  toKnowledgeConfig,
  redactSecrets,
  DEFAULTS,
} from '../core/config.js';

const ENV_KEYS = [
  'CODE_SEARCH_EMBEDDING_PROVIDER',
  'CODE_SEARCH_EMBEDDING_MODEL',
  'CODE_SEARCH_EMBEDDING_DIMENSIONS',
  'CODE_SEARCH_EMBEDDING_API_KEY',
  'CODE_SEARCH_RERANKER_PROVIDER',
  'CODE_SEARCH_PORT',
  'CODE_SEARCH_AUTH_MODE',
  'CODE_SEARCH_AUTH_API_KEYS',
  'CODE_SEARCH_DATA_DIR',
  'CODE_SEARCH_REINDEX_INTERVAL',
];

let tmp = '';
const STASH: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    STASH[k] = process.env[k];
    delete process.env[k];
  }
  tmp = mkdtempSync(join(tmpdir(), 'cs-cfg-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (STASH[k] === undefined) delete process.env[k];
    else process.env[k] = STASH[k];
  }
});

describe('resolveCodeSearchConfig precedence (P3)', () => {
  it('returns DEFAULTS when no file / env / CLI is present', () => {
    // Point at an empty config file so we don't accidentally read the user's.
    const cfg = resolveCodeSearchConfig({ configPath: join(tmp, 'missing.yaml') });
    assert.equal(cfg.embedding.provider, 'auto');
    assert.equal(cfg.server.port, 3100);
    assert.equal(cfg.indexing.autoIndex, true);
  });

  it('env overrides defaults', () => {
    process.env.CODE_SEARCH_EMBEDDING_PROVIDER = 'codestral';
    process.env.CODE_SEARCH_EMBEDDING_MODEL = 'codestral-embed-2505';
    process.env.CODE_SEARCH_EMBEDDING_API_KEY = 'sk-abc';
    process.env.CODE_SEARCH_PORT = '4242';

    const cfg = resolveCodeSearchConfig({ configPath: join(tmp, 'missing.yaml') });
    assert.equal(cfg.embedding.provider, 'codestral');
    assert.equal(cfg.embedding.model, 'codestral-embed-2505');
    assert.equal(cfg.embedding.apiKey, 'sk-abc');
    assert.equal(cfg.server.port, 4242);
  });

  it('YAML config file overrides defaults', () => {
    const configPath = join(tmp, 'config.yaml');
    writeFileSync(
      configPath,
      `server:\n  port: 5500\nembedding:\n  provider: voyage\n  model: voyage-code-3\n`,
      'utf-8',
    );
    const cfg = resolveCodeSearchConfig({ configPath });
    assert.equal(cfg.server.port, 5500);
    assert.equal(cfg.embedding.provider, 'voyage');
    assert.equal(cfg.embedding.model, 'voyage-code-3');
  });

  it('CLI flags override env vars', () => {
    process.env.CODE_SEARCH_EMBEDDING_PROVIDER = 'voyage';
    const { patch } = parseCliFlags(['--embedding.provider', 'codestral', '--server.port', '6000']);
    const cfg = resolveCodeSearchConfig({ configPath: join(tmp, 'missing.yaml'), cli: patch });
    assert.equal(cfg.embedding.provider, 'codestral');
    assert.equal(cfg.server.port, 6000);
  });

  it('per-workspace .code-search.yaml overrides ~/.code-search/config.yaml', () => {
    const globalPath = join(tmp, 'global.yaml');
    writeFileSync(globalPath, `embedding:\n  provider: voyage\n`, 'utf-8');
    const workspace = join(tmp, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, '.code-search.yaml'), `embedding:\n  provider: openai\n`, 'utf-8');
    const cfg = resolveCodeSearchConfig({ configPath: globalPath, workspaceDir: workspace });
    assert.equal(cfg.embedding.provider, 'openai');
  });
});

describe('toKnowledgeConfig (P3 adapter)', () => {
  it('maps unified config to KnowledgeConfig shape', () => {
    const cfg = resolveCodeSearchConfig({ configPath: join(tmp, 'missing.yaml') });
    const k = toKnowledgeConfig(cfg);
    assert.equal(k.embedding.provider, cfg.embedding.provider);
    assert.equal(k.retrieval.maxChunks, cfg.retrieval.maxChunks);
    assert.deepEqual(k.chunking, cfg.indexing.chunking);
    // Reranker is a struct on both sides now.
    const r = typeof k.retrieval.reranker === 'string' ? { provider: k.retrieval.reranker } : k.retrieval.reranker;
    assert.equal(r.provider, cfg.reranker.provider);
  });
});

describe('redactSecrets (P3 --print-config)', () => {
  it('redacts apiKey/jwtSecret/token fields, preserves shape', () => {
    const input = {
      embedding: { apiKey: 'sk-super-secret', model: 'x' },
      auth: { apiKeys: ['key-1', 'key-2'], jwtSecret: 'jwt-super-secret' },
      github: { token: 'gh-token' },
      server: { port: 3100 },
    };
    const out = redactSecrets(input);
    assert.match(out.embedding.apiKey!, /redacted/);
    assert.equal(out.embedding.model, 'x');
    assert.match(out.auth.apiKeys[0], /redacted/);
    assert.match(out.auth.jwtSecret!, /redacted/);
    assert.match(out.github.token!, /redacted/);
    assert.equal(out.server.port, 3100);
  });

  it('keeps DEFAULTS shape redaction-safe (no secrets exposed)', () => {
    const redacted = redactSecrets(DEFAULTS);
    // No literal API-key-looking strings in the redacted output.
    const json = JSON.stringify(redacted);
    assert.equal(/sk-[a-zA-Z0-9]+/.test(json), false);
  });
});

describe('parseCliFlags', () => {
  it('handles dotted paths and value coercion', () => {
    const { patch } = parseCliFlags([
      '--embedding.provider', 'voyage',
      '--retrieval.max-chunks', '20',
      '--telemetry.metrics-enabled', 'true',
    ]);
    assert.equal((patch as any).embedding.provider, 'voyage');
    assert.equal((patch as any).retrieval.maxChunks, 20);
    assert.equal((patch as any).telemetry.metricsEnabled, true);
  });

  it('treats reserved subcommand flags as rest', () => {
    const { rest } = parseCliFlags(['--local', '/some/path', '--embedding.provider', 'codestral']);
    assert.ok(rest.includes('--local'));
  });

  it('--no-x.y sets boolean false', () => {
    const { patch } = parseCliFlags(['--no-indexing.auto-index']);
    assert.equal((patch as any).indexing.autoIndex, false);
  });
});

// Bind `homedir` so the linter doesn't trip on the unused import.
void homedir;
