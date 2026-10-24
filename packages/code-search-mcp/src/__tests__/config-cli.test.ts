/**
 * Unified-config surface used by every entry point: CLI flag parsing (dotted
 * paths, root aliases, unknown-flag detection), --print-config redaction, and
 * reindex-interval normalisation.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCliFlags, resolveCodeSearchConfig, printConfig, DEFAULTS } from '../core/config.js';
import { loadServerConfig, resetServerConfig } from '../core/env-config.js';
import { validateProjectName } from '../core/project-name.js';

const saved = { ...process.env };
let noConfig: string;

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CODE_SEARCH_') || k.startsWith('ANVIL_') || k === 'OPENAI_API_KEY' || k === 'ANTHROPIC_API_KEY') delete process.env[k];
  }
  const home = mkdtempSync(join(tmpdir(), 'cs-cfg-'));
  process.env.HOME = home;
  noConfig = join(home, 'none.yaml');
  resetServerConfig();
});
afterEach(() => {
  process.env = { ...saved };
  resetServerConfig();
});

describe('parseCliFlags', () => {
  it('maps the root aliases into the config tree (no junk top-level keys)', () => {
    const { patch, unknown } = parseCliFlags(['--port', '3200', '--host', '0.0.0.0', '--auth', 'jwt', '--transport', 'streamable-http']);
    assert.deepEqual(unknown, []);
    assert.equal(patch.server?.port, 3200);
    assert.equal(patch.server?.host, '0.0.0.0');
    assert.equal(patch.server?.transport, 'streamable-http');
    assert.equal(patch.auth?.mode, 'jwt');
    assert.equal((patch as Record<string, unknown>).port, undefined);
  });

  it('accepts dotted config paths and reports unknown ones', () => {
    const ok = parseCliFlags(['--retrieval.max-chunks', '12', '--no-indexing.auto-index', '--storage.backends.blob.backend', 'fs']);
    assert.deepEqual(ok.unknown, []);
    assert.equal(ok.patch.retrieval?.maxChunks, 12);
    assert.equal(ok.patch.indexing?.autoIndex, false);

    const bad = parseCliFlags(['--retrieval.max-chunkz', '3', '--daemon.auto-spawn', '--language', 'ts', '--config', 'x.yaml']);
    assert.deepEqual(bad.unknown, ['--retrieval.max-chunkz', '--daemon.auto-spawn', '--language', '--config']);
  });
});

describe('--print-config redaction', () => {
  it('redacts credentials in URIs, OTEL headers and secret-named keys', () => {
    process.env.CODE_SEARCH_STORAGE_MONGO_URI = 'mongodb://admin:PASSWORD1@db:27017/x';
    process.env.CODE_SEARCH_STORAGE_MONGO_DB = 'kb';
    process.env.CODE_SEARCH_OTEL_HEADERS = 'Authorization=Bearer OTELTOKEN,x-honeycomb-team=HONEYKEY';
    process.env.CODE_SEARCH_EMBEDDING_BASE_URL = 'https://user:URLPASS@embed.example.com/v1';
    process.env.CODE_SEARCH_AUTH_JWT_SECRET = 'JWTSECRET';
    const cfg = resolveCodeSearchConfig({ configPath: noConfig });
    (cfg.storage as Record<string, unknown>).extra = { password: 'PW2', clientSecret: 'CS2', accessToken: 'AT2', authorization: 'Basic AU2' };
    const out = printConfig(cfg);
    for (const secret of ['PASSWORD1', 'OTELTOKEN', 'HONEYKEY', 'URLPASS', 'JWTSECRET', 'PW2', 'CS2', 'AT2', 'AU2']) {
      assert.ok(!out.includes(secret), `${secret} leaked:\n${out}`);
    }
    assert.match(out, /mongodb:\/\/admin:\*\*\*@db:27017\/x/);
    assert.match(out, /https:\/\/user:\*\*\*@embed\.example\.com\/v1/);
  });
});

describe('reindex interval', () => {
  it('normalises env / CLI values the same way the server applies them', () => {
    const at = (raw: string, cli = false) => {
      delete process.env.CODE_SEARCH_REINDEX_INTERVAL;
      if (!cli) process.env.CODE_SEARCH_REINDEX_INTERVAL = raw;
      const patch = cli ? parseCliFlags(['--indexing.reindex-interval-ms', raw]).patch : undefined;
      return resolveCodeSearchConfig({ configPath: noConfig, cli: patch }).indexing.reindexIntervalMs;
    };
    assert.equal(at('30m'), 30 * 60_000);
    assert.equal(at('2h'), 2 * 3_600_000);
    assert.equal(at('0'), 0);
    assert.equal(at('none'), 0);
    assert.equal(at('90s'), 0, 'unsupported unit → disabled, not 90 ms');
    assert.equal(at('abc'), 0);
    assert.equal(at('30m', true), 30 * 60_000);
    assert.equal(at('3600000', true), 3_600_000);
    assert.equal(at('5', true), 0, 'sub-minute interval → disabled');
  });
});

describe('server config', () => {
  it('honours an explicit LLM mode none even with an API key around', () => {
    process.env.CODE_SEARCH_LLM_MODE = 'none';
    process.env.OPENAI_API_KEY = 'sk-test';
    assert.equal(loadServerConfig().llmMode, 'none');
  });

  it('binds 0.0.0.0 by default when auth is enabled from any layer', () => {
    const cfg = resolveCodeSearchConfig({ configPath: noConfig, cli: parseCliFlags(['--auth', 'api-key']).patch });
    assert.equal(cfg.server.host, '0.0.0.0');
    const explicit = resolveCodeSearchConfig({ configPath: noConfig, cli: parseCliFlags(['--auth', 'api-key', '--host', '127.0.0.1']).patch });
    assert.equal(explicit.server.host, '127.0.0.1');
    assert.equal(resolveCodeSearchConfig({ configPath: noConfig }).server.host, DEFAULTS.server.host);
  });

  it('applies the workspace .code-search.yaml layer', () => {
    const ws = mkdtempSync(join(tmpdir(), 'cs-ws-'));
    writeFileSync(join(ws, '.code-search.yaml'), 'retrieval:\n  max_chunks: 21\n');
    try {
      assert.equal(resolveCodeSearchConfig({ configPath: noConfig, workspaceDir: ws }).retrieval.maxChunks, 21);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('validateProjectName', () => {
  it('rejects names that would escape or collide inside the data dir', () => {
    for (const bad of ['', '.', '..', 'a/b', '..\\x', 'daemon', 'projects', 'x\0y']) {
      assert.throws(() => validateProjectName(bad), /project name/i, JSON.stringify(bad));
    }
    for (const good of ['ws', 'my-project', 'org_1.2']) validateProjectName(good);
  });
});
